// Express/Hono route extraction
// Extracted from parse-worker.ts (#70). Pure AST-walk implementation; the
// tree-sitter Tree is passed in and its `Parser.SyntaxNode`s are walked.
//
// Followups (MINORs deferred from code review): the magic number `2` in
// the chain-length rule could become a named constant; the `?? -1`
// fallback in the AD-3 post-process step is defensive noise; the
// `Parser.SyntaxNode` casts on `obj`/`prop` lookups are redundant once
// `childForFieldName` returns the right type; and the case-sensitivity
// policy differs between `NON_EXPRESS_OBJECTS` (lowercased) and
// `EXPRESS_METHODS` (raw). Out of scope for this batch.

import type Parser from 'tree-sitter';

/** Decorator-based route (Express/Hono/NestJS route handlers) */
export interface ExtractedDecoratorRoute {
  filePath: string;
  decorator: string;
  method?: string;
  path?: string;
  lineNumber?: number;
}

/**
 * Extract Express/Hono route registrations from JavaScript/TypeScript files via AST walk.
 * Handles: app.get('/path', handler), app.post('/path', handler), router.get('/path', handler), etc.
 */
export function extractExpressRoutes(tree: Parser.Tree, filePath: string): ExtractedDecoratorRoute[] {
  const routes: ExtractedDecoratorRoute[] = [];
  const EXPRESS_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'all', 'use', 'route', 'head', 'options']);

  // Non-Express objects that have .get()/.post() etc. methods - these are NOT route registrations
  const NON_EXPRESS_OBJECTS = new Set([
    'headers', 'request', 'response', 'req', 'res',  // HTTP request/response
    'map', 'set', 'weakmap', 'weakset',  // Collections
    'cache', 'storage',  // Storage APIs
    'formdata', 'urlsearchparams',  // Form APIs
    'promise', 'observable',  // Async APIs
  ]);

  // Tracks line numbers where a chained verb call used its own
  // string arg that differs from the inherited `route()` path. On
  // those lines, the bare `route()` emission is redundant and is
  // suppressed (AD-3 subsumption). Declared before `walk` so the
  // closure can capture and mutate it.
  const routeSubsumedLines: Set<number> = new Set();

  /**
   * Returns true when the given member_expression (the `function`
   * of a call_expression) sits at the tail of a chain rooted in a
   * non-Express pattern. Walks down through intermediate
   * call_expressions until it finds an identifier or
   * member_expression whose terminal property is in
   * NON_EXPRESS_OBJECTS. Catches direct cases
   * (`headers.get('x')`), member-of-member
   * (`request.headers.get('x')`), and chained
   * (`headers.map().get('x')`,
   * `headers.route('/x').get(h)`).
   */
  function isNonExpressChain(func: Parser.SyntaxNode): boolean {
    let cursor: Parser.SyntaxNode | null = func;
    while (cursor?.type === 'member_expression') {
      const obj = cursor.childForFieldName('object') ?? cursor.children[0];
      // Step into the next layer. If `obj` is a call_expression,
      // descend into ITS `function` so we can keep walking down the
      // member_expression chain. If it's a bare identifier or
      // member_expression, this is the chain's root — check it.
      if (obj?.type === 'call_expression') {
        const innerFunc = obj.childForFieldName('function') ?? obj.children[0];
        if (!innerFunc) return false;
        cursor = innerFunc;
        continue;
      }
      if (obj?.type === 'identifier') {
        return NON_EXPRESS_OBJECTS.has(obj.text.toLowerCase());
      }
      if (obj?.type === 'member_expression') {
        const prop = obj.childForFieldName('property') ?? obj.children[obj.childCount - 1];
        if (prop?.type === 'property_identifier' && NON_EXPRESS_OBJECTS.has(prop.text.toLowerCase())) {
          return true;
        }
      }
      return false;
    }
    return false;
  }

  function walk(node: Parser.SyntaxNode, verbChainDepth: number = 0): void {
    if (!node) {
      return;
    }

    // Recurse children FIRST so the innermost call_expression (e.g.
    // `app.route('/x')` inside a `app.route('/x').get(g)` chain) emits
    // BEFORE its outer verb call. This matches the design doc's
    // expected emission order: `route` first, then `get`/`post`.
    //
    // Children of any Express method call see a fresh walker
    // invocation (we deliberately do NOT inherit the parent state
    // across siblings to prevent path leakage; e.g.
    // `app.route('/x').get(g); app.post('/y', h)` must not
    // attribute `/x` to the sibling `.post('/y')`). The chain-
    // inheritance below (look at the object of the member_expression)
    // is the correct way to thread the path for chained verbs.
    //
    // `verbChainDepth` tracks the position of the current node in a
    // chain of verb calls (0 = outermost verb, 1 = next verb down,
    // etc.). The depth is incremented when descending from a
    // member_expression (that is the function of a verb call) into
    // its object child (which is the parent verb call in the chain).
    for (const child of node.children) {
      let childDepth = verbChainDepth;
      if (node.type === 'member_expression') {
        const prop = node.childForFieldName('property') ?? node.children[node.childCount - 1];
        const obj = node.childForFieldName('object') ?? node.children[0];
        if (
          prop?.type === 'property_identifier' &&
          EXPRESS_METHODS.has(prop.text) &&
          obj &&
          child === obj
        ) {
          // Descending from `.verb` member_expression into the obj
          // call_expression (the next verb in the chain).
          childDepth = verbChainDepth + 1;
        }
      }
      walk(child, childDepth);
    }

    // Check if this is a call_expression with a member_expression function (e.g., app.get)
    if (node.type === 'call_expression') {
      const func = node.childForFieldName('function') ?? node.children[0];
      if (func?.type === 'member_expression') {
        const prop = func.childForFieldName('property') ?? func.children[func.childCount - 1];
        if (prop?.type === 'property_identifier' && EXPRESS_METHODS.has(prop.text)) {
          // Skip non-Express patterns: direct (`headers.get('x')`),
          // member-of-member (`request.headers.get('x')`), and
          // chained (`headers.map().get('x')`).
          if (isNonExpressChain(func)) {
            return;
          }

          // Found an Express route registration
          const obj = func.childForFieldName('object') ?? func.children[0];
          const args = node.childForFieldName('arguments') ?? node.children.find((c: Parser.SyntaxNode) => c.type === 'arguments');
          let routePathFromArg: string | undefined;
          if (args) {
            for (const arg of args.children) {
              if (arg.type === 'string') {
                routePathFromArg = arg.text.replace(/^["']|["']$/g, '');
                break;
              }
            }
          }

          // Chained-route path inheritance (#D145, AD-2: support up to 2
          // verbs after route(); 3+ verbs is the documented limitation).
          //
          // AST shape: `app.route('/x').get(g).post(c)` parses as
          //   call_expression(post)  ← outermost verb, depth=0
          //     function: member_expression(property='post',
          //       object=call_expression(get))  ← depth=1
          //     arguments: (c)
          //   call_expression(get)   ← depth=1
          //     function: member_expression(property='get',
          //       object=call_expression(route))  ← depth=2
          //     arguments: (g)
          //   call_expression(route) ← depth=2
          //     function: member_expression(property='route', object='app')
          //     arguments: ('/x')
          //
          // The walker follows the call_expression chain DOWN from the
          // current verb call to find the `route()` call. For each
          // intermediate verb in the chain, we count it.
          // `verbChainDepth` tracks the verbs ABOVE the current call
          // (0 = outermost verb).
          //
          // Simplified emission rule: emit if EITHER
          //   (a) the current verb's obj IS the route() call
          //       (`chainBelowCount === 0` on the first walk step), OR
          //   (b) the current verb is the OUTERMOST in the chain
          //       (`verbChainDepth === 0`) AND exactly one
          //       intermediate verb sits between it and the route
          //       (`chainBelowCount === 1`).
          // This covers the 2-level chain (case a) and the 3-level
          // chain (both a and b), and explicitly suppresses 4+-level
          // chains beyond the innermost verb.
          let inheritedFromChain: string | undefined;
          let chainBelowCount = 0;
          // Compute inheritedFromChain regardless of whether the
          // current verb has its own string arg. We need it for the
          // AD-3 subsumption check below (to know if the chained
          // verb's path differs from the inherited route path).
          if (obj?.type === 'call_expression') {
            let cursor: Parser.SyntaxNode | null = obj;
            // Walk down the obj chain. cursor starts at the immediate
            // parent (the call_expression that is the obj of our
            // member_expression). For each intermediate verb call we
            // encounter (not the route call), increment chainBelowCount.
            // Stop when we hit a route() call (with string arg) or a
            // non-verb-call node.
            while (cursor?.type === 'call_expression') {
              const innerFunc = cursor.childForFieldName('function') ?? cursor.children[0];
              if (innerFunc?.type !== 'member_expression') break;
              const innerProp = innerFunc.childForFieldName('property') ?? innerFunc.children[innerFunc.childCount - 1];
              if (innerProp?.type !== 'property_identifier') break;
              if (innerProp.text === 'route') {
                // Found the route() call. Extract the path string.
                const innerArgs = cursor.childForFieldName('arguments') ?? cursor.children.find((c: Parser.SyntaxNode) => c.type === 'arguments');
                if (innerArgs) {
                  for (const arg of innerArgs.children) {
                    if (arg.type === 'string') {
                      inheritedFromChain = arg.text.replace(/^["']|["']$/g, '');
                      break;
                    }
                  }
                }
                break;
              }
              if (!EXPRESS_METHODS.has(innerProp.text)) break;
              // Intermediate verb call — count it and continue down.
              chainBelowCount++;
              cursor = innerFunc.childForFieldName('object') ?? innerFunc.children[0];
            }
          }

          // Simplified emission rule: (a) this verb's obj IS the
          // route() call (innermost verb, regardless of its depth in
          // the chain), OR (b) this verb is the outermost in the
          // chain (`verbChainDepth === 0`) AND exactly one
          // intermediate verb separates it from the route.
          const isInnermost = chainBelowCount === 0 && inheritedFromChain !== undefined;
          const isOutermostWithOneHop = verbChainDepth === 0 && chainBelowCount === 1;
          const shouldEmit = isInnermost || isOutermostWithOneHop;

          // For verbs past the supported limit (3+ verb chain) that
          // are not the innermost, the emission is suppressed. We
          // also suppress by clearing inheritedFromChain so the
          // path-resolution line treats this as a no-string-arg case
          // (so effectivePath becomes undefined).
          if (inheritedFromChain !== undefined && !shouldEmit) {
            inheritedFromChain = undefined;
          }

          // AD-3: explicit string arg wins over inherited chain path.
          // Path resolution order:
          //   1. routePathFromArg  (this call's first string arg, e.g. `/y`)
          //   2. inheritedFromChain (parent `route()` call's first string arg)
          // For chained verb calls (e.g. `.get(g)` after `.route('/x')`),
          // item 1 is undefined so we use item 2. For the outer
          // non-chained case (e.g. `app.get(handler)`), both are
          // undefined → 0 routes emitted (invariant 2:
          // first-arg-must-be-string for outer call).
          const effectivePath = routePathFromArg ?? inheritedFromChain;
          if (effectivePath) {
            routes.push({
              filePath,
              decorator: prop.text,
              path: effectivePath,
              lineNumber: node.startPosition.row,
            });
          }

          // AD-3 subsumption: if this chained verb call uses its own
          // string arg (routePathFromArg is set) AND differs from the
          // inherited path, mark the outer `route()` emission for
          // suppression. The chained verb's path overrides the route
          // chain, so the bare `route()` registration is redundant.
          // The actual suppression happens in post-processing below
          // (we can't suppress eagerly because the route() call
          // processes first via recurse-first order).
          if (
            routePathFromArg !== undefined &&
            inheritedFromChain !== undefined &&
            routePathFromArg !== inheritedFromChain
          ) {
            routeSubsumedLines.add(node.startPosition.row);
          }
        }
      }
    }
  }

  if (!tree || !tree.rootNode) return routes;
  walk(tree.rootNode);

  // Post-process: remove `decorator: 'route'` emissions whose line is
  // in `routeSubsumedLines` (a chained verb on the same line has its
  // own path, so the route registration is subsumed).
  return routes.filter(
    (r) => !(r.decorator === 'route' && routeSubsumedLines.has(r.lineNumber ?? -1))
  );
}
