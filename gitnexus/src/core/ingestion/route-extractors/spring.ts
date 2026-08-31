/**
 * Spring route annotation extractor for the ingestion pipeline.
 *
 * Extracts `@GetMapping`, `@PostMapping`, `@PutMapping`, `@DeleteMapping`,
 * `@PatchMapping`, and `@RequestMapping` annotations from Java source files
 * and returns `ExtractedDecoratorRoute[]` with class-level `@RequestMapping`
 * prefixes already resolved per-class.
 *
 * This module is the ingestion-layer counterpart of
 * `group/extractors/http-patterns/java.ts` (which extracts HTTP contracts
 * for cross-repo matching). It uses the same tree-sitter capture approach:
 * a single predicate-free query matches all route annotations generically,
 * then a for-loop discriminates class-level prefixes from method-level routes
 * by reading `@node.type` and the annotation name.
 *
 * The query is predicate-free to avoid the tree-sitter 0.21.x hazard where
 * `#match?` / `#eq?` predicates in a top-level `[...]` alternation silently
 * drop sibling-branch matches (see group-layer `JAVA_ROUTE_ANNOTATION_PATTERNS`
 * header comment for details).
 */

import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import type { ExtractedDecoratorRoute } from '../workers/parse-worker.js';
import {
  intersectSpringHttpMethods,
  springAnnotationHttpMethods,
  isRouteMemberKey,
  findEnclosingType,
  isClassLevelMappingAnnotation,
  unquoteSpringLiteral,
  type SharedSpringType,
} from './spring-shared.js';
import { parseJavaConstOperands } from './java-const-resolver.js';

/**
 * Single predicate-free tree-sitter query that captures all route annotations
 * on classes and methods. Discrimination by annotation name and node type
 * happens in the loop below.
 *
 * Captures:
 *   @ann   → annotation name identifier (RequestMapping, GetMapping, etc.)
 *   @node  → enclosing declaration (class_declaration | method_declaration)
 *   @value → the string-literal argument
 *   @key   → the named-argument member key (absent for positional form)
 *
 * Method-level routes accept both the bare string form `@GetMapping("/x")` and
 * the array form `@GetMapping({"/a","/b"})` (positional or `path =`/`value =`):
 * a multi-element array yields one match per element, so the Phase 2 loop emits
 * one route per path with no special-casing. This mirrors the group-layer
 * `java.ts` query so the two Spring extractors stay in parity (#2138 follow-up;
 * the divergence here was the root of the #2265 array-form gap). The class-level
 * `@RequestMapping` branches also match the array form, but only to *detect* it:
 * an array-form class prefix can't be resolved to a single string, so Phase 2
 * suppresses that class's method-level array routes rather than emit them with a
 * dropped prefix (a wrong route). Full class-array cross-product support is left
 * to a follow-up (#2280).
 *
 * The class-level `@value_expr` branches exist for the same reason: a
 * CONSTANT-valued class prefix (`@RequestMapping(ApiPaths.BASE)`) cannot be
 * folded here — the repo-wide constant map only exists in the parse phase — so
 * they only DETECT it, and Phase 2 suppresses every method route under such a
 * class. Without them the prefix was invisible and the method route was emitted
 * unprefixed, i.e. at a path the application does not serve.
 */
const ROUTE_ANNOTATION_QUERY = new Parser.Query(
  Java,
  `
  [
    (class_declaration
      (modifiers
        (annotation
          name: [(identifier) (scoped_identifier)] @ann
          arguments: (annotation_argument_list
            [(string_literal) @value
             (element_value_array_initializer (string_literal) @value)])))) @node
    (class_declaration
      (modifiers
        (annotation
          name: [(identifier) (scoped_identifier)] @ann
          arguments: (annotation_argument_list
            (element_value_pair
              key: (identifier) @key
              value: [(string_literal) @value
                      (element_value_array_initializer (string_literal) @value)]))))) @node
    (method_declaration
      (modifiers
        (annotation
          name: [(identifier) (scoped_identifier)] @ann
          arguments: (annotation_argument_list
            [(string_literal) @value
             (element_value_array_initializer (string_literal) @value)])))) @node
    (method_declaration
      (modifiers
        (annotation
          name: [(identifier) (scoped_identifier)] @ann
          arguments: (annotation_argument_list
            (element_value_pair
              key: (identifier) @key
              value: [(string_literal) @value
                      (element_value_array_initializer (string_literal) @value)]))))) @node
    (class_declaration
      (modifiers
        (annotation
          name: [(identifier) (scoped_identifier)] @ann
          arguments: (annotation_argument_list
            [(identifier) @value_expr
             (field_access) @value_expr
             (binary_expression) @value_expr])))) @node
    (class_declaration
      (modifiers
        (annotation
          name: [(identifier) (scoped_identifier)] @ann
          arguments: (annotation_argument_list
            (element_value_pair
              key: (identifier) @key
              value: [(identifier) @value_expr
                      (field_access) @value_expr
                      (binary_expression) @value_expr]))))) @node
    (method_declaration
      (modifiers
        (annotation
          name: [(identifier) (scoped_identifier)] @ann
          arguments: (annotation_argument_list
            [(identifier) @value_expr
             (field_access) @value_expr
             (binary_expression) @value_expr])))) @node
    (method_declaration
      (modifiers
        (annotation
          name: [(identifier) (scoped_identifier)] @ann
          arguments: (annotation_argument_list
            (element_value_pair
              key: (identifier) @key
              value: [(identifier) @value_expr
                      (field_access) @value_expr
                      (binary_expression) @value_expr]))))) @node
  ]
`,
);

/**
 * Extract Spring route annotations from a parsed Java file.
 *
 * Uses a single tree-sitter query pass to capture all annotations, then
 * discriminates class-level prefixes from method-level routes in a loop.
 * Handles multiple classes per file, each with its own prefix.
 *
 * @param tree - tree-sitter parse tree
 * @param filePath - relative file path (for `ExtractedDecoratorRoute.filePath`)
 * @param lineOffset - line offset for pre-processing (usually 0)
 * @returns Decorator routes with prefix already set per-class
 */
export function extractSpringRoutes(
  tree: Parser.Tree,
  filePath: string,
  lineOffset = 0,
): ExtractedDecoratorRoute[] {
  const matches = ROUTE_ANNOTATION_QUERY.matches(tree.rootNode);

  // Phase 1: collect class-level @RequestMapping prefixes keyed by node id.
  // A scalar prefix (`@RequestMapping("/base")`) is stored in prefixByClassId.
  // A class whose @RequestMapping uses the array form (`@RequestMapping({...})`)
  // is instead recorded in classesWithArrayPrefix: there is no single prefix to
  // store, and Phase 2 uses this to suppress that class's method-level array
  // routes rather than emit them unprefixed (a wrong route — see #2280). Full
  // class-array cross-product support is out of scope here.
  const prefixByClassId = new Map<number, string>();
  const classesWithArrayPrefix = new Set<number>();
  // Classes whose `@RequestMapping` prefix is a constant reference or concat.
  // Same treatment as the array form, for the same reason: no single prefix
  // string is knowable at extraction time, so emitting the methods below would
  // publish them at a WRONG (unprefixed) path rather than not at all.
  const classesWithUnfoldablePrefix = new Set<number>();
  const classHttpMethodsById = new Map<number, readonly string[]>();
  for (const match of TYPE_DECLARATION_QUERY.matches(tree.rootNode)) {
    const typeNode = match.captures.find((capture) => capture.name === 'type')?.node;
    if (typeNode?.type === 'class_declaration') {
      classHttpMethodsById.set(typeNode.id, typeRequestMethods(typeNode));
    }
  }

  for (const match of matches) {
    const caps: Record<string, Parser.SyntaxNode> = {};
    for (const { name, node } of match.captures) {
      caps[name] = node;
    }
    const annNode = caps['ann'];
    const node = caps['node'];
    const valueNode = caps['value'];
    const keyNode = caps['key'];
    const valueExprNode = caps['value_expr'];
    if (!annNode || !node || (!valueNode && !valueExprNode)) continue;

    const capturedAnnotationName = annNode.text.split('.').pop() ?? annNode.text;
    if (node.type === 'class_declaration' && isClassLevelMappingAnnotation(capturedAnnotationName)) {
      if (!isRouteMemberKey(keyNode)) continue;
      if (!valueNode) {
        classesWithUnfoldablePrefix.add(node.id);
        continue;
      }
      if (valueNode.parent?.type === 'element_value_array_initializer') {
        classesWithArrayPrefix.add(node.id);
        continue;
      }
      const prefix = unquoteSpringLiteral(valueNode.text);
      if (prefix !== null) prefixByClassId.set(node.id, prefix);
    }
  }

  // Phase 2: collect method-level routes and resolve their class prefix
  const routes: ExtractedDecoratorRoute[] = [];
  const httpMethodsByAnnotationId = new Map<number, readonly string[]>();

  for (const match of matches) {
    const caps: Record<string, Parser.SyntaxNode> = {};
    for (const { name, node } of match.captures) {
      caps[name] = node;
    }
    const annNode = caps['ann'];
    const node = caps['node'];
    const valueNode = caps['value'];
    const keyNode = caps['key'];
    // A constant-referencing value arrives as @value_expr, not @value — the
    // match carries exactly one of the two. Require @value only when no
    // @value_expr is present; the operand branch below folds the expression.
    const valueExprCapture = match.captures.find((c) => c.name === 'value_expr')?.node ?? null;
    if (!annNode || !node || (!valueNode && !valueExprCapture)) continue;

    if (node.type !== 'method_declaration') continue;

    const ann = annNode.text.split('.').pop() ?? annNode.text;
    const annotationNode = annNode.parent;
    if (!annotationNode) continue;
    let methodMethods = httpMethodsByAnnotationId.get(annotationNode.id);
    if (!methodMethods) {
      methodMethods = springAnnotationHttpMethods(ann, annotationNode.text);
      httpMethodsByAnnotationId.set(annotationNode.id, methodMethods);
    }
    if (methodMethods.length === 0) continue;
    if (!isRouteMemberKey(keyNode)) continue;

    // #2391-style non-literal path (constant ref or `+`-concat): emit with
    // operands for cross-file folding in the parse phase. The match carries
    // either @value (literal) or @value_expr (non-literal) — never both.
    const valueExprNode = valueExprCapture;
    const routePath = valueNode ? unquoteSpringLiteral(valueNode.text) : null;
    if (routePath === null && !valueExprNode) continue;
    const enclosingType = findEnclosingType(node);

    // Interface-declared `@*Mapping`s are not concrete routes on their own — the
    // implementing controller inherits them. Skip here; the cross-file
    // inheritance pass (#2288) re-emits them attributed to the controller, with
    // both the interface's and the controller's class prefixes resolved. Emitting
    // the interface route directly would be wrong (unprefixed, wrong owner).
    if (enclosingType?.kind === 'interface') continue;
    const enclosingClass = enclosingType?.kind === 'class' ? enclosingType.node : null;

    const httpMethods = intersectSpringHttpMethods(
      enclosingClass ? (classHttpMethodsById.get(enclosingClass.id) ?? ['*']) : ['*'],
      methodMethods,
    );
    if (httpMethods.length === 0) continue;
    // Suppress a method-level *array-form* route nested under a class-level
    // array-form @RequestMapping. The class prefix is one of several values that
    // cannot be resolved to a single string here, so emitting the route would
    // drop the prefix and yield a wrong unprefixed Route (a false signal, worse
    // than a missing one). Skipping keeps ingestion a strict subset of the group
    // scan — safe under routeCoverage:'partial'. Full class-array cross-product
    // support is tracked in #2280. (Scalar method paths under an array class
    // prefix are left unchanged: that pre-existing divergence is out of scope.)
    const isArrayElement = valueNode?.parent?.type === 'element_value_array_initializer';
    if (isArrayElement && enclosingClass && classesWithArrayPrefix.has(enclosingClass.id)) {
      continue;
    }
    // Same rule for a CONSTANT-valued class prefix (`@RequestMapping(ApiPaths.BASE)`),
    // and for every method route under it — not just array-form ones. The prefix
    // needs the repo-wide constant map, which does not exist at extraction time,
    // so the prefix would simply be dropped and the route emitted at a path the
    // application never serves. On base such a route was not emitted at all;
    // turning a missing fact into a wrong one is the failure this module's skip
    // floor exists to prevent. Folding class prefixes cross-file is a follow-up.
    if (enclosingClass && classesWithUnfoldablePrefix.has(enclosingClass.id)) {
      continue;
    }

    const classPrefix = enclosingClass ? (prefixByClassId.get(enclosingClass.id) ?? '') : '';
    // `node` is the annotated `method_declaration`; its name field is the
    // handler method name (resolved to a symbol UID later by the routes phase).
    const handlerName = node.childForFieldName('name')?.text;

    for (const httpMethod of httpMethods) {
      if (routePath === null && valueExprNode) {
        // Non-literal annotation value: parse operands now; the parse phase
        // folds them against the repo-wide Java constant map (KTD5 skip floor
        // on failure — never a phantom `POST /`).
        const operands = parseJavaConstOperands(valueExprNode);
        if (operands === null) continue;
        routes.push({
          filePath,
          routePath: '',
          routePathExpr: valueExprNode.text,
          routePathOperands: operands,
          httpMethod,
          decoratorName: ann,
          lineNumber: annNode.startPosition.row + lineOffset,
          ...(classPrefix ? { prefix: classPrefix } : {}),
          ...(handlerName ? { handlerName } : {}),
        });
        continue;
      }
      routes.push({
        filePath,
        routePath,
        httpMethod,
        decoratorName: ann,
        lineNumber: annNode.startPosition.row + lineOffset,
        ...(classPrefix ? { prefix: classPrefix } : {}),
        ...(handlerName ? { handlerName } : {}),
      });
    }
  }

  // Mapping annotations without a path bind to the enclosing class prefix.
  for (const match of TYPE_DECLARATION_QUERY.matches(tree.rootNode)) {
    const typeNode = match.captures.find((capture) => capture.name === 'type')?.node;
    if (typeNode?.type !== 'class_declaration') continue;
    // A no-argument `@GetMapping` IS the class prefix, so a class prefix that
    // cannot be folded here leaves nothing to emit — the route would ship with
    // `routePath: ''` and no prefix, i.e. an empty-path Route. The Phase 2 loop
    // above already suppresses these classes; this loop needs the same guard, or
    // the suppression is one-sided and the group side (which routes both shapes
    // through `methodRoutes`) disagrees with ingestion.
    if (classesWithUnfoldablePrefix.has(typeNode.id)) continue;
    const classPrefix = prefixByClassId.get(typeNode.id) ?? '';
    const classMethods = classHttpMethodsById.get(typeNode.id) ?? ['*'];
    for (const methodNode of directMethods(typeNode)) {
      const handlerName = methodNode.childForFieldName('name')?.text;
      if (!handlerName) continue;
      for (const annotationNode of declarationAnnotations(methodNode)) {
        const ann = annotationName(annotationNode) ?? '';
        if (annotationHasRouteMember(annotationNode)) continue;
        const methodMethods = springAnnotationHttpMethods(ann, annotationNode.text);
        const httpMethods = intersectSpringHttpMethods(classMethods, methodMethods);
        if (httpMethods.length === 0) continue;
        for (const httpMethod of httpMethods) {
          routes.push({
            filePath,
            routePath: '',
            httpMethod,
            decoratorName: ann,
            lineNumber: annotationNode.startPosition.row + lineOffset,
            ...(classPrefix ? { prefix: classPrefix } : {}),
            handlerName,
          });
        }
      }
    }
  }

  return routes;
}

/**
 * Tree-sitter query capturing every Java type declaration (class + interface),
 * used by `extractSpringTypes` to build the project-wide `SharedSpringType`
 * view the cross-file interface-inheritance pass consumes (#2288).
 */
const TYPE_DECLARATION_QUERY = new Parser.Query(
  Java,
  `[(class_declaration) @type (interface_declaration) @type]`,
);

/** Direct annotations on a type/method declaration (reads its `modifiers` child). */
function declarationAnnotations(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  // `modifiers` is a NAMED CHILD of the declaration (not a named field) in
  // tree-sitter-java — matching the group layer's `hasAnnotation`.
  const modifiers = node.namedChildren.find((c) => c.type === 'modifiers');
  if (!modifiers) return [];
  return modifiers.namedChildren.filter(
    (c) => c.type === 'annotation' || c.type === 'marker_annotation',
  );
}

const annotationName = (ann: Parser.SyntaxNode): string | undefined => {
  // Trailing segment of a possibly fully-qualified annotation name
  // (`org.springframework.web.bind.annotation.GetMapping` → `GetMapping`), so a
  // FQN annotation is classified the same as its simple form — matching the
  // group layer's `simpleName` normalization. A simple name maps to itself.
  const text = ann.childForFieldName('name')?.text;
  return text?.split('.').pop() ?? text;
};

/**
 * Collect the route path(s) carried by an annotation's argument list, honoring
 * both positional and `path =`/`value =` named arguments and both the bare
 * string and array forms. Non-route named args (`consumes`, `produces`, …) are
 * dropped via `isRouteMemberKey`. Returns one entry per string element.
 */
function annotationRoutePaths(ann: Parser.SyntaxNode): string[] {
  const args = ann.childForFieldName('arguments');
  if (!args) return [];
  const out: string[] = [];
  const pushLiteral = (lit: Parser.SyntaxNode): void => {
    const v = unquoteSpringLiteral(lit.text);
    if (v !== null) out.push(v);
  };
  const pushFromValue = (valueNode: Parser.SyntaxNode): void => {
    if (valueNode.type === 'string_literal') pushLiteral(valueNode);
    else if (valueNode.type === 'element_value_array_initializer') {
      for (const el of valueNode.namedChildren) if (el.type === 'string_literal') pushLiteral(el);
    }
  };
  for (const child of args.namedChildren) {
    if (child.type === 'string_literal' || child.type === 'element_value_array_initializer') {
      pushFromValue(child); // positional
    } else if (child.type === 'element_value_pair') {
      const key = child.childForFieldName('key');
      if (!isRouteMemberKey(key ?? undefined)) continue;
      const value = child.childForFieldName('value');
      if (value) pushFromValue(value);
    }
  }
  return out;
}

/** Whether an annotation explicitly supplies a positional or path/value member. */
function annotationHasRouteMember(ann: Parser.SyntaxNode): boolean {
  const args = ann.childForFieldName('arguments');
  if (!args) return false;
  for (const child of args.namedChildren) {
    if (child.type !== 'element_value_pair') return true;
    const key = child.childForFieldName('key');
    if (isRouteMemberKey(key ?? undefined)) return true;
  }
  return false;
}

/** Static class/interface-level RequestMapping method constraint, or wildcard by default. */
function typeRequestMethods(typeNode: Parser.SyntaxNode): readonly string[] {
  const mappings = declarationAnnotations(typeNode).filter((ann) =>
    isClassLevelMappingAnnotation(annotationName(ann)),
  );
  if (mappings.length === 0) return ['*'];
  if (mappings.length !== 1) return [];
  return springAnnotationHttpMethods(annotationName(mappings[0]), mappings[0].text);
}

function annotationRoutePathsOrDefault(ann: Parser.SyntaxNode): string[] {
  const paths = annotationRoutePaths(ann);
  if (paths.length > 0) return paths;
  return annotationHasRouteMember(ann) ? [] : [''];
}

/** Class-level `@RequestMapping` prefixes for a type (array-aware; may be []). */
function typeClassPrefixes(typeNode: Parser.SyntaxNode): string[] {
  const prefixes: string[] = [];
  for (const ann of declarationAnnotations(typeNode)) {
    if (isClassLevelMappingAnnotation(annotationName(ann))) prefixes.push(...annotationRoutePaths(ann));
  }
  return prefixes;
}

/** The simple names of the interfaces a class declares via `implements`. */
function implementedInterfaceNames(typeNode: Parser.SyntaxNode): string[] {
  const interfacesNode = typeNode.childForFieldName('interfaces');
  if (!interfacesNode) return [];
  const out: string[] = [];
  const visit = (node: Parser.SyntaxNode): void => {
    if (node.type === 'type_identifier' || node.type === 'scoped_type_identifier') {
      out.push(node.text.split('.').pop() ?? node.text);
      return;
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(interfacesNode);
  return out;
}

/** Direct `method_declaration` children of a type (not methods of nested types). */
function directMethods(typeNode: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const out: Parser.SyntaxNode[] = [];
  const visit = (node: Parser.SyntaxNode): void => {
    for (const child of node.namedChildren) {
      if (child.type === 'method_declaration') {
        out.push(child);
        continue;
      }
      // Don't descend into a nested type — its methods aren't this type's.
      if (
        child !== typeNode &&
        (child.type === 'class_declaration' || child.type === 'interface_declaration')
      ) {
        continue;
      }
      visit(child);
    }
  };
  visit(typeNode);
  return out;
}

/**
 * Build the project-wide `SharedSpringType` view for one Java file: every class
 * and interface with its class prefixes, implemented interfaces, controller
 * flag, and per-method route annotations. The cross-file inheritance pass
 * (#2288) feeds these into the shared `resolveInheritedSpringRoutes` so a
 * concrete controller inherits the `@*Mapping`s declared on its interfaces.
 *
 * This is the ingestion counterpart of the group layer's `collectSpringTypes`
 * (`group/extractors/http-patterns/java.ts`); both produce the same neutral
 * shape so the two layers resolve inheritance identically (#2078 parity).
 */
export function extractSpringTypes(tree: Parser.Tree, filePath: string): SharedSpringType[] {
  const out: SharedSpringType[] = [];
  for (const match of TYPE_DECLARATION_QUERY.matches(tree.rootNode)) {
    const typeNode = match.captures.find((c) => c.name === 'type')?.node;
    if (!typeNode) continue;
    const name = typeNode.childForFieldName('name')?.text;
    if (!name) continue;
    const kind = typeNode.type === 'interface_declaration' ? 'interface' : 'class';

    const annNames = declarationAnnotations(typeNode).map(annotationName);
    const isController =
      kind === 'class' && (annNames.includes('RestController') || annNames.includes('Controller'));
    const classMethods = typeRequestMethods(typeNode);

    const methods = directMethods(typeNode)
      .map((methodNode) => {
        const methodName = methodNode.childForFieldName('name')?.text;
        if (!methodName) return null;
        const routes: Array<{ method: string; path: string }> = [];
        for (const ann of declarationAnnotations(methodNode)) {
          const methodMethods = springAnnotationHttpMethods(annotationName(ann) ?? '', ann.text);
          const verbs = intersectSpringHttpMethods(classMethods, methodMethods);
          for (const verb of verbs) {
            for (const path of annotationRoutePathsOrDefault(ann))
              routes.push({ method: verb, path });
          }
        }
        return { name: methodName, routes };
      })
      .filter(
        (m): m is { name: string; routes: Array<{ method: string; path: string }> } => m !== null,
      );

    out.push({
      filePath,
      kind,
      name,
      classPrefixes: typeClassPrefixes(typeNode),
      implementedInterfaces: kind === 'class' ? implementedInterfaceNames(typeNode) : [],
      isController,
      methods,
    });
  }
  return out;
}
