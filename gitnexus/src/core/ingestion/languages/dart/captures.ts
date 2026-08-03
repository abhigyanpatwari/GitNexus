/**
 * `emitDartScopeCaptures` — the Dart scope-capture orchestrator (mirror of
 * `languages/swift/captures.ts`, adapted for tree-sitter-dart's grammar).
 *
 * It runs `DART_SCOPE_QUERY` for the constructs that map cleanly to a single
 * node (module/class scopes, type/method/field declarations, imports), then
 * synthesizes the Dart-specific streams the grammar can't express as a single
 * query node:
 *
 *   1. Function/method/constructor SCOPES — `function_signature`/`function_body`
 *      are SIBLINGS, so each Function scope is synthesized to span
 *      `signature.start .. body.end` (composed range); a constructor's body is
 *      a sibling of the wrapping `method_signature`.
 *   2. Receiver (`this`/`super`) + parameter + return type bindings, anchored
 *      inside the body so they land in the Function scope.
 *   3. Arity metadata on function-like declarations.
 *   4. Field type bindings (for receiver-chain resolution).
 *   5. References — calls (free/member/cascade) and member reads — from Dart's
 *      postfix `identifier (selector …)` chains, which have no
 *      `call_expression` node.
 *   6. Local-variable constructor/call-result type inference.
 *   7. Heritage — `extends` → `@reference.inherits` (the generic
 *      EXTENDS-by-target-kind pre-pass); `implements`/`with` → side-effect
 *      `__heritage__:` import markers consumed by `emitDartHeritageEdges`
 *      (Dart `implements <class>` must be IMPLEMENTS regardless of the
 *      target's symbol kind).
 */

import Parser from 'tree-sitter';
import type { Capture, CaptureMatch } from 'gitnexus-shared';
import {
  nodeToCapture,
  syntheticCapture,
  walkNamedTree,
  findChild,
  type SyntaxNode,
} from '../../utils/ast-helpers.js';
import { computeDartArityMetadata } from './arity-metadata.js';
import { synthesizeDartReceiverBinding } from './receiver-binding.js';
import { synthesizeDartSignatureBindings } from './signature-bindings.js';
import { getDartParser, getDartScopeQuery } from './query.js';
import { preprocessDartExtensionTypes } from './extension-type-preprocess.js';
import { recordCacheHit, recordCacheMiss } from './cache-stats.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';
import { encodeMarker } from '../../utils/heritage-marker.js';
import { DART_BUILT_INS } from './built-ins.js';
import { synthesizeCallableFlowCaptures } from '../../utils/callable-flow-captures.js';
import { synthesizeReceiverChainCapture } from '../../utils/receiver-chain-captures.js';

const FUNCTION_DECL_TAGS = [
  '@declaration.function',
  '@declaration.method',
  '@declaration.constructor',
] as const;

const DART_CALLABLE_CAPTURE_OPTIONS = {
  functionNodeTypes: new Set(['function_signature', 'function_expression']),
  callNodeTypes: new Set(['selector']),
  parameterListNodeTypes: new Set(['formal_parameter_list', 'arguments']),
  parameterNodeTypes: new Set(['formal_parameter']),
  // `initialized_identifier` covers TOP-LEVEL `var` bindings and the second and
  // later declarators of a multi-name local; `static_final_declaration` covers
  // top-level `final`/`const`, which parse into a different list node entirely.
  // Dart wraps only the FIRST local declarator in `initialized_variable_
  // definition`, so without the other two a top-level `var f = (x) => x;`, a
  // `final f = …`, and the `g` of `var f = …, g = …;` all emitted no flow
  // captures at all and never resolved (#2693).
  bindingNodeTypes: new Set([
    'initialized_variable_definition',
    'initialized_identifier',
    'static_final_declaration',
  ]),
  assignmentNodeTypes: new Set(['assignment_expression']),
  identifierNodeTypes: new Set(['identifier', 'type_identifier']),
  // `initialized_identifier` and `static_final_declaration` are FIELDLESS, so
  // the shared field-based fallback (`left`/`name`/`value`/…) decomposes
  // nothing and those bindings produced no flow facts at all — the same shape
  // as Kotlin's fieldless `assignment` node. Positional: first named child is
  // the bound name, last is the initializer.
  // `initialized_variable_definition` carries real `name:` / `value:` fields,
  // so it is left to the shared path by returning undefined.
  extractAssignment: (node: SyntaxNode) => {
    if (node.type !== 'initialized_identifier' && node.type !== 'static_final_declaration') {
      return undefined;
    }
    const named = node.namedChildren.filter((child): child is SyntaxNode => child !== null);
    if (named.length < 2) return undefined;
    return { destination: named[0]!, source: named[named.length - 1]! };
  },
  lexicalFunctionOwner: (node: SyntaxNode) => dartLexicalFunctionOwner(node),
  isCallNode: (node: SyntaxNode) => node.namedChild(0)?.type === 'argument_part',
  extractCallCallee: (node: SyntaxNode) => dartCallableCallee(node) ?? undefined,
  callSiteNode: (node: SyntaxNode) => dartCallableCallee(node) ?? undefined,
  callableProtocolMethods: new Set(['call']),
} as const;

function dartLexicalFunctionOwner(input: SyntaxNode): SyntaxNode | undefined {
  let node: SyntaxNode | null = input;
  while (node !== null) {
    if (node.type === 'function_signature' || node.type === 'function_expression') return node;
    if (node.type === 'function_body') {
      const signature = node.previousNamedSibling;
      if (signature?.type === 'function_signature') return signature;
    }
    node = node.parent;
  }
  return undefined;
}

export function emitDartScopeCaptures(
  sourceText: string,
  _filePath: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  // Idempotent re-application: `extractParsedFile` already preprocesses, but
  // direct emitter callers (benchmarks, capture goldens) must see the same
  // program the pipeline does.
  const parseText = preprocessDartExtensionTypes(sourceText);
  let tree: Parser.Tree;
  if (cachedTree !== undefined && cachedTree !== null) {
    tree = cachedTree as Parser.Tree;
    recordCacheHit();
  } else {
    tree = parseSourceSafe(getDartParser(), parseText, undefined, {
      bufferSize: getTreeSitterBufferSize(parseText),
    });
    recordCacheMiss();
  }

  const root = tree.rootNode;
  const out: CaptureMatch[] = [];

  // A named constructor (`A.named()`) parses as ONE `constructor_signature`
  // carrying multiple `name:` fields, so the `@declaration.constructor` query
  // pattern matches it more than once. Each match would synthesize an
  // identical-range `@scope.function`, producing duplicate scope ids that make
  // `buildScopeTree` throw and the whole file get dropped. Dedup function-like
  // declarations by their statement node so each is emitted exactly once.
  const seenFnDeclNodes = new Set<string>();

  // ── Pass A: query-driven scopes / declarations / imports ────────────────
  for (const match of getDartScopeQuery().matches(root)) {
    const grouped: Record<string, Capture> = {};
    const nodeMap: Record<string, SyntaxNode> = {};
    for (const c of match.captures) {
      const tag = '@' + c.name;
      grouped[tag] = nodeToCapture(tag, c.node);
      nodeMap[tag] = c.node;
    }
    if (Object.keys(grouped).length === 0) continue;

    const declTag = FUNCTION_DECL_TAGS.find((t) => grouped[t] !== undefined);
    if (declTag !== undefined) {
      const declNode = nodeMap[declTag]!;
      const declKey = `${declNode.startIndex}:${declNode.endIndex}`;
      if (seenFnDeclNodes.has(declKey)) continue; // dedup named-ctor double-match
      seenFnDeclNodes.add(declKey);
      const bodyNode = findFunctionBody(declNode);

      attachArityMetadata(grouped, declNode);
      // Structural receiver chain for a call whose receiver is itself an
      // expression, so resolution can type it by folding over structure
      // instead of re-parsing the receiver's source text. Self-gating: a
      // non-call match, an absent receiver, or a chain with no nameable base
      // all leave `grouped` untouched.
      synthesizeReceiverChainCapture(grouped, nodeMap['@reference.receiver']);
      out.push(grouped);

      if (bodyNode !== null) {
        out.push({ '@scope.function': spanCapture('@scope.function', declNode, bodyNode) });
        for (const cm of synthesizeDartReceiverBinding(declNode, bodyNode)) out.push(cm);
      }
      for (const cm of synthesizeDartSignatureBindings(declNode, bodyNode)) out.push(cm);
      continue;
    }

    // Class fields: emit the Property declaration AND a class-scope type
    // binding (so `receiver.field.method()` chains resolve the field type).
    if (
      grouped['@declaration.property'] !== undefined &&
      grouped['@declaration.name'] !== undefined
    ) {
      const propNode = nodeMap['@declaration.property']!;
      const fieldType = extractFieldType(propNode);
      const fieldName = grouped['@declaration.name'].text;
      if (fieldType !== null) {
        grouped['@declaration.field-type'] = syntheticCapture(
          '@declaration.field-type',
          propNode,
          fieldType,
        );
      }
      // Structural receiver chain for a call whose receiver is itself an
      // expression, so resolution can type it by folding over structure
      // instead of re-parsing the receiver's source text. Self-gating: a
      // non-call match, an absent receiver, or a chain with no nameable base
      // all leave `grouped` untouched.
      synthesizeReceiverChainCapture(grouped, nodeMap['@reference.receiver']);
      out.push(grouped);
      if (fieldType !== null) {
        out.push({
          '@type-binding.annotation': nodeToCapture('@type-binding.annotation', propNode),
          '@type-binding.name': syntheticCapture('@type-binding.name', propNode, fieldName),
          '@type-binding.type': syntheticCapture('@type-binding.type', propNode, fieldType),
        });
      } else {
        // No written type, so the field's type comes from the constructor its
        // initializer calls (#2807). `constructor-inferred` is the weakest
        // source, and the annotated branch above already returned, so an
        // annotated field is untouched either way.
        const callee = dartFieldConstructorCallee(propNode);
        if (callee !== null) {
          out.push({
            '@type-binding.constructor': nodeToCapture('@type-binding.constructor', propNode),
            '@type-binding.name': syntheticCapture('@type-binding.name', propNode, fieldName),
            '@type-binding.type': syntheticCapture('@type-binding.type', propNode, callee.text),
          });
        }
      }
      continue;
    }

    // Structural receiver chain for a call whose receiver is itself an
    // expression, so resolution can type it by folding over structure
    // instead of re-parsing the receiver's source text. Self-gating: a
    // non-call match, an absent receiver, or a chain with no nameable base
    // all leave `grouped` untouched.
    synthesizeReceiverChainCapture(grouped, nodeMap['@reference.receiver']);
    out.push(grouped);
  }

  // ── Pass B: tree-walked references, type inference, heritage ────────────
  const seenReadSpans = new Set<string>();
  walkNamedTree(root, (node) => {
    if (node.type === 'selector') {
      emitSelectorReference(node, out, seenReadSpans);
      return;
    }
    if (node.type === 'cascade_section') {
      emitCascadeReference(node, out);
      return;
    }
    if (node.type === 'initialized_variable_definition') {
      emitVarTypeBinding(node, out);
      return;
    }
    if (node.type === 'class_definition') {
      emitHeritage(node, out);
      emitDartFieldAssignmentBindings(node, out);
      return;
    }
    if (node.type === 'extension_declaration') {
      emitExtensionImplementsHeritage(node, out);
      return;
    }
  });

  out.push(...synthesizeCallableFlowCaptures(root, DART_CALLABLE_CAPTURE_OPTIONS));

  return out;
}

function dartCallableCallee(selector: SyntaxNode): SyntaxNode | null {
  if (selector.namedChild(0)?.type !== 'argument_part') return null;
  const previous = selector.previousNamedSibling;
  if (previous?.type === 'identifier') return previous;
  if (previous?.type !== 'selector') return null;
  const inner = previous.namedChild(0);
  return inner !== null && ASSIGNABLE_SELECTORS.has(inner.type) ? selectorName(inner) : null;
}

// ─── Function scope synthesis ───────────────────────────────────────────────

/**
 * The sibling `function_body` of a declaration, or null (abstract/bodyless).
 *
 * The body is the next named sibling of the declaration's *statement-level*
 * node. For methods/operators the `@declaration` anchor IS the `method_signature`
 * (body is its sibling). For a constructor the anchor is the INNER
 * `constructor_signature`, whose body is a sibling of the WRAPPING
 * `method_signature` (AST: `class_body > method_signature > constructor_signature`,
 * then `function_body`) — so walk up to the `method_signature` wrapper first.
 * Top-level `function_signature` (parent `program`) and abstract `declaration`
 * nodes are unaffected.
 */
function findFunctionBody(declNode: SyntaxNode): SyntaxNode | null {
  // A closure literal carries its body as a CHILD (function_expression_body),
  // unlike a Dart declaration whose body is the next named SIBLING. Without
  // this branch the caller synthesizes no @scope.function for a closure at all,
  // so a closure binding has no scope to own its callable def and can never be
  // a call SOURCE (#2699 S4 — this is why Dart alone showed zero child scopes).
  if (declNode.type === 'function_expression') {
    const body = declNode.namedChildren.find((c) => c.type === 'function_expression_body');
    return body ?? null;
  }
  const node =
    declNode.parent !== null && declNode.parent.type === 'method_signature'
      ? declNode.parent
      : declNode;
  const next = node.nextNamedSibling;
  return next !== null && next.type === 'function_body' ? next : null;
}

/** A capture whose range spans two nodes (Dart has no node wrapping both a
 *  signature and its sibling body). */
function spanCapture(name: string, startNode: SyntaxNode, endNode: SyntaxNode): Capture {
  return {
    name,
    range: {
      startLine: startNode.startPosition.row + 1,
      startCol: startNode.startPosition.column,
      endLine: endNode.endPosition.row + 1,
      endCol: endNode.endPosition.column,
    },
    text: '',
  };
}

function attachArityMetadata(grouped: Record<string, Capture>, declNode: SyntaxNode): void {
  const meta = computeDartArityMetadata(declNode);
  if (meta.parameterCount !== undefined) {
    grouped['@declaration.parameter-count'] = syntheticCapture(
      '@declaration.parameter-count',
      declNode,
      String(meta.parameterCount),
    );
  }
  if (meta.requiredParameterCount !== undefined) {
    grouped['@declaration.required-parameter-count'] = syntheticCapture(
      '@declaration.required-parameter-count',
      declNode,
      String(meta.requiredParameterCount),
    );
  }
  if (meta.parameterTypes !== undefined) {
    grouped['@declaration.parameter-types'] = syntheticCapture(
      '@declaration.parameter-types',
      declNode,
      JSON.stringify(meta.parameterTypes),
    );
  }
}

/** The declared type of a class field (`Address address = …` → `Address`). */
function extractFieldType(declNode: SyntaxNode): string | null {
  for (let i = 0; i < declNode.namedChildCount; i++) {
    const c = declNode.namedChild(i);
    if (c !== null && (c.type === 'type_identifier' || c.type === 'nullable_type')) {
      return c.text.replace(/\?+$/, '');
    }
  }
  return null;
}

// ─── References: calls + member reads (postfix chains) ──────────────────────

const ASSIGNABLE_SELECTORS = new Set([
  'unconditional_assignable_selector',
  'conditional_assignable_selector',
]);

/** Last named `identifier` child of an assignable/cascade selector. */
function selectorName(inner: SyntaxNode): SyntaxNode | null {
  for (let i = inner.namedChildCount - 1; i >= 0; i--) {
    const c = inner.namedChild(i);
    if (c !== null && c.type === 'identifier') return c;
  }
  return null;
}

/** Count call arguments under a `selector(argument_part(arguments(…)))`. */
function countArgs(argPart: SyntaxNode): number {
  const args = argPart.namedChild(0);
  if (args === null) return 0;
  let n = 0;
  for (let i = 0; i < args.namedChildCount; i++) {
    const c = args.namedChild(i);
    if (c !== null && (c.type === 'argument' || c.type === 'named_argument')) n++;
  }
  return n;
}

/** Receiver text preceding a member-call/read selector (the postfix chain
 *  head plus any intermediate selectors): `user.address.save()` → `user.address`. */
function computeReceiverText(nameSelector: SyntaxNode): string | null {
  const selectors: SyntaxNode[] = [];
  let cur = nameSelector.previousNamedSibling;
  let head: SyntaxNode | null = null;
  while (cur !== null) {
    if (cur.type === 'selector') {
      selectors.push(cur);
      cur = cur.previousNamedSibling;
      continue;
    }
    head = cur;
    break;
  }
  if (head === null) return null;
  if (head.type !== 'identifier' && head.type !== 'this' && head.type !== 'super') return null;
  selectors.reverse();
  let text = head.text;
  for (const s of selectors) text += s.text;
  return text;
}

function emitSelectorReference(
  selector: SyntaxNode,
  out: CaptureMatch[],
  seenReadSpans: Set<string>,
): void {
  const inner = selector.namedChild(0);
  if (inner === null) return;

  // A `selector(argument_part)` is the call marker; the callee is the
  // immediately-preceding sibling.
  if (inner.type === 'argument_part') {
    const prev = selector.previousNamedSibling;
    if (prev === null) return;
    const arity = countArgs(inner);

    if (prev.type === 'identifier') {
      const name = prev.text;
      if (DART_BUILT_INS.has(name)) return; // legacy suppresses built-in-named calls
      // Dart has no `new`: an UpperCamelCase callee is a constructor call by
      // convention (types are UpperCamelCase) — tag it so `constructorCallTargetsClass`
      // links `Foo()` to the Class node (the legacy DAG emits that edge even for an
      // implicit constructor). A lowercase callee is an ordinary free function call.
      const tag = /^[A-Z]/.test(name) ? '@reference.call.constructor' : '@reference.call.free';
      out.push({
        [tag]: nodeToCapture(tag, prev),
        '@reference.name': nodeToCapture('@reference.name', prev),
        '@reference.arity': syntheticCapture('@reference.arity', prev, String(arity)),
      });
      return;
    }
    if (prev.type === 'selector') {
      const prevInner = prev.namedChild(0);
      if (prevInner === null) return;
      if (ASSIGNABLE_SELECTORS.has(prevInner.type)) {
        const nameId = selectorName(prevInner);
        if (nameId === null) return;
        if (DART_BUILT_INS.has(nameId.text)) return; // legacy suppresses built-in-named calls
        const recv = computeReceiverText(prev);
        const cm: CaptureMatch = {
          '@reference.call.member': nodeToCapture('@reference.call.member', nameId),
          '@reference.name': nodeToCapture('@reference.name', nameId),
          '@reference.arity': syntheticCapture('@reference.arity', nameId, String(arity)),
          ...(recv !== null
            ? { '@reference.receiver': syntheticCapture('@reference.receiver', prev, recv) }
            : {}),
        };
        out.push(cm);
      }
    }
    return;
  }

  // A member access selector that is NOT immediately followed by a call is a
  // field read (`user.address` in `user.address.save()`).
  if (ASSIGNABLE_SELECTORS.has(inner.type)) {
    const next = selector.nextNamedSibling;
    const isCall =
      next !== null && next.type === 'selector' && next.namedChild(0)?.type === 'argument_part';
    if (isCall) return;

    const nameId = selectorName(inner);
    if (nameId === null) return;
    const recv = computeReceiverText(selector);
    if (recv === null) return;

    const spanKey = `${nameId.startIndex}-${nameId.endIndex}`;
    if (seenReadSpans.has(spanKey)) return;
    seenReadSpans.add(spanKey);

    out.push({
      '@reference.read.member': nodeToCapture('@reference.read.member', nameId),
      '@reference.name': nodeToCapture('@reference.name', nameId),
      '@reference.receiver': syntheticCapture('@reference.receiver', selector, recv),
    });
  }
}

/**
 * Cascade call `receiver..method(args)` — Dart's `cascade_section` holds a
 * `cascade_selector` + `argument_part` as DIRECT children (no `selector`
 * wrapper, so `emitSelectorReference` never sees it). The legacy DAG matches
 * `(cascade_section (cascade_selector (identifier)) (argument_part))` and
 * classifies cascade calls as FREE calls — mirror that for parity. A property
 * cascade (`..field = x`, no `argument_part`) is not a call and is skipped.
 */
function emitCascadeReference(cascade: SyntaxNode, out: CaptureMatch[]): void {
  let selectorNode: SyntaxNode | null = null;
  let argPart: SyntaxNode | null = null;
  for (let i = 0; i < cascade.namedChildCount; i++) {
    const c = cascade.namedChild(i);
    if (c === null) continue;
    if (c.type === 'cascade_selector') selectorNode = c;
    else if (c.type === 'argument_part') argPart = c;
  }
  if (selectorNode === null || argPart === null) return;
  const nameId = selectorName(selectorNode);
  if (nameId === null || DART_BUILT_INS.has(nameId.text)) return;
  const arity = countArgs(argPart);
  out.push({
    '@reference.call.free': nodeToCapture('@reference.call.free', nameId),
    '@reference.name': nodeToCapture('@reference.name', nameId),
    '@reference.arity': syntheticCapture('@reference.arity', nameId, String(arity)),
  });
}

// ─── Local-variable constructor / call-result type inference ────────────────

/** Find the callee identifier of a `var x = Callee(…)` / `await Callee(…)`
 *  initializer (a direct free-call / constructor); returns null for member
 *  calls or non-call values. */
function findDirectCallValue(initVarDef: SyntaxNode): SyntaxNode | null {
  const firstValue = initVarDef.childForFieldName('value');
  if (firstValue === null) return null;

  if (firstValue.type === 'identifier') {
    const next = firstValue.nextNamedSibling;
    if (next !== null && next.type === 'selector' && next.namedChild(0)?.type === 'argument_part') {
      return firstValue;
    }
    return null;
  }
  if (firstValue.type === 'unary_expression' || firstValue.type === 'await_expression') {
    let aw = firstValue;
    if (aw.type === 'unary_expression') {
      const inner = aw.namedChild(0);
      if (inner === null) return null;
      aw = inner;
    }
    if (aw.type === 'await_expression') {
      const id = aw.namedChild(0);
      const sel = aw.namedChild(1);
      if (
        id !== null &&
        id.type === 'identifier' &&
        sel !== null &&
        sel.type === 'selector' &&
        sel.namedChild(0)?.type === 'argument_part'
      ) {
        return id;
      }
    }
  }
  return null;
}

/**
 * Callee identifier of a class field initialized by a direct constructor call —
 * `var b = Outer();` / `final b = Outer();` — or `null` for anything else.
 *
 * Dart spells a class field as `declaration(<keyword>, initialized_identifier_list(
 * initialized_identifier))`, NOT the `initialized_variable_definition` that
 * `emitVarTypeBinding` handles — that is the LOCAL form. So an unannotated field
 * had no type binding and could not act as a call receiver (#2807), even though
 * its annotated twin resolved fine.
 *
 * Accepts the same construction shape `findDirectCallValue` accepts for locals:
 * a bare identifier followed by a `selector` carrying an `argument_part`.
 * Anything else — a literal, a member call, an await — is left alone rather than
 * guessed at.
 */
function dartFieldConstructorCallee(propNode: SyntaxNode): SyntaxNode | null {
  const initialized = firstDescendantOfType(propNode, 'initialized_identifier');
  if (initialized === null) return null;
  // namedChild(0) is the field NAME; the initializer starts after it.
  const value = initialized.namedChild(1);
  if (value === null || value.type !== 'identifier') return null;
  const next = value.nextNamedSibling;
  if (next === null || next.type !== 'selector') return null;
  return next.namedChild(0)?.type === 'argument_part' ? value : null;
}

/** First strict descendant of `type`, breadth-first, or `null`. */
function firstDescendantOfType(root: SyntaxNode, type: string): SyntaxNode | null {
  const queue: SyntaxNode[] = [root];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (node !== root && node.type === type) return node;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child !== null) queue.push(child);
    }
  }
  return null;
}

function emitVarTypeBinding(initVarDef: SyntaxNode, out: CaptureMatch[]): void {
  const nameNode = initVarDef.childForFieldName('name');
  if (nameNode === null) return;
  const calleeId = findDirectCallValue(initVarDef);
  if (calleeId === null) return;

  out.push({
    '@type-binding.constructor': nodeToCapture('@type-binding.constructor', initVarDef),
    '@type-binding.name': syntheticCapture('@type-binding.name', initVarDef, nameNode.text),
    '@type-binding.type': syntheticCapture('@type-binding.type', initVarDef, calleeId.text),
  });
}

// ─── Heritage ───────────────────────────────────────────────────────────────

/**
 * Type an inference-typed field from a constructor call ASSIGNED to it —
 * `var r; C() { r = Outer(); }` and `this.r = Outer();` (#2807).
 *
 * Dart is the one language here that writes a field with NO receiver prefix, so
 * `r = Outer()` is syntactically identical to assigning a constructor-local. The
 * discriminator is the class's own declared field set: a bare name binds only
 * when the enclosing class declares it AND the enclosing member binds no name of
 * its own that would shadow it (`collectDartBodyShadows` — parameters, locals,
 * closure parameters, catch bindings, loop variables), which is exactly when
 * Dart itself resolves `r` to the field. A `this.`-prefixed write is unambiguous
 * and needs neither test.
 *
 * Emitted as `constructor-inferred`, the weakest source, so a field that also
 * carries an annotation keeps it. The narrow `@type-binding.dart-field` marker
 * rides the name node for `dartBindingScopeFor` to hoist on — the binding has to
 * land on the Class scope, since the assignment sits inside a constructor's own
 * Function scope where `typeOfMemberOnClass` never looks.
 */
function emitDartFieldAssignmentBindings(classNode: SyntaxNode, out: CaptureMatch[]): void {
  const body = classNode.namedChildren.find((c) => c !== null && c.type === 'class_body');
  if (body === undefined || body === null) return;

  // Field names this class declares, from `declaration(... initialized_identifier)`.
  const fields = new Set<string>();
  for (const member of body.namedChildren) {
    if (member === null || member.type !== 'declaration') continue;
    const list = member.namedChildren.find((c) => c?.type === 'initialized_identifier_list');
    if (list === undefined || list === null) continue;
    for (const init of list.namedChildren) {
      if (init === null || init.type !== 'initialized_identifier') continue;
      const nameNode = init.namedChild(0);
      if (nameNode !== null && nameNode.type === 'identifier') fields.add(nameNode.text);
    }
  }
  if (fields.size === 0) return;

  for (const member of body.namedChildren) {
    if (member === null || member.type !== 'function_body') continue;
    const locals = collectDartBodyShadows(member);

    walkNamedTree(member, (node) => {
      if (node.type !== 'assignment_expression') return;
      const target = node.namedChild(0);
      if (target === null || target.type !== 'assignable_expression') return;

      const first = target.namedChild(0);
      if (first === null) return;
      let fieldNameNode: SyntaxNode | null = null;
      if (first.type === 'identifier' && target.namedChildCount === 1) {
        // Bare `r = …`: a field only when declared here and not shadowed.
        if (!fields.has(first.text) || locals.has(first.text)) return;
        fieldNameNode = first;
      } else if (first.type === 'this') {
        const selector = target.namedChild(1);
        if (selector === null || selector.type !== 'unconditional_assignable_selector') return;
        const nameNode = selector.namedChild(0);
        if (nameNode === null || nameNode.type !== 'identifier') return;
        fieldNameNode = nameNode;
      } else {
        return;
      }
      if (fieldNameNode === null) return;

      // RHS must be a direct construction: `Outer()` is an identifier followed
      // by a `selector` carrying an `argument_part`. Anything else is left
      // alone rather than guessed at.
      const callee = node.namedChild(1);
      if (callee === null || callee.type !== 'identifier') return;
      const selector = node.namedChild(2);
      if (selector === null || selector.type !== 'selector') return;
      if (selector.namedChild(0)?.type !== 'argument_part') return;

      out.push({
        '@type-binding.constructor': nodeToCapture('@type-binding.constructor', node),
        '@type-binding.dart-field': syntheticCapture(
          '@type-binding.dart-field',
          fieldNameNode,
          '1',
        ),
        '@type-binding.name': syntheticCapture(
          '@type-binding.name',
          fieldNameNode,
          fieldNameNode.text,
        ),
        '@type-binding.type': syntheticCapture('@type-binding.type', callee, callee.text),
      });
    });
  }
}

/**
 * Every name BOUND by one class-member body — the shadow set the bare-name
 * branch of `emitDartFieldAssignmentBindings` tests against.
 *
 * A local `var` is only ONE of Dart's binders, and a bare `r = Outer()` writes
 * whichever binder wins, so a set built from local declarations alone made a
 * write to any OTHER binder look like a field write. `void reset(Alpha r) { r =
 * Alpha(); }` in a class with a field `r` retyped the FIELD to `Alpha` —
 * fabricating an edge and displacing the type the constructor had correctly
 * given it. Formal parameters are the sharpest case because they are not even
 * inside the body: `function_body` is a SIBLING of the `method_signature` that
 * carries them, so no walk of the body can ever see one.
 *
 * Deliberately over-approximate in the shadow direction. The set is body-wide
 * (a binder in a nested closure shadows for the whole body) and a parameter
 * shape whose name cannot be read contributes nothing rather than being guessed
 * at. Both err toward DECLINING to bind, which is the right error: a missed
 * field type costs an edge, a wrong one produces an edge to the wrong class and
 * destroys a correct binding — the failure mode this whole line of work exists
 * to avoid (see `scope-resolution/passes/compound-receiver.ts`).
 */
function collectDartBodyShadows(bodyNode: SyntaxNode): Set<string> {
  const shadows = new Set<string>();
  // The enclosing function's own formal parameters live OUTSIDE the body, on
  // the `method_signature` sibling that precedes it — the shape every class
  // member takes (method, constructor, factory, static, getter, setter,
  // operator, `async`/`async*`).
  const signature = bodyNode.previousNamedSibling;
  if (signature !== null && signature.type === 'method_signature') {
    walkNamedTree(signature, (n) => addDartBinderName(n, shadows));
  }
  walkNamedTree(bodyNode, (n) => addDartBinderName(n, shadows));
  return shadows;
}

/** Record the name `node` binds, if it binds one. */
function addDartBinderName(node: SyntaxNode, out: Set<string>): void {
  switch (node.type) {
    // `var s;`, `final r = 1;`, and the FIRST declarator of `var a = 1, b = 2;`.
    // `for_loop_parts` carries the for-IN variable on the same `name` field
    // (`for (var r in xs)`); the C-style form instead nests a
    // `local_variable_declaration` the walk reaches on its own.
    case 'initialized_variable_definition':
    case 'for_loop_parts': {
      const nameNode = node.childForFieldName('name');
      if (nameNode !== null) out.add(nameNode.text);
      return;
    }
    // Formal parameters — of the enclosing member, of a closure
    // (`function_expression`), and of a nested `local_function_declaration`.
    case 'formal_parameter': {
      const name = dartParameterName(node);
      if (name !== null) out.add(name);
      return;
    }
    // `on E catch (e, stack)` — every identifier in the list is a binding.
    case 'catch_parameters': {
      for (const child of node.namedChildren) {
        if (child !== null && child.type === 'identifier') out.add(child.text);
      }
      return;
    }
    // Second and later declarators of `var a = 1, b = 2;` — fieldless, so the
    // name is the first named child. (A class field is this node type too, but
    // only ever under `initialized_identifier_list`, which no body contains.)
    case 'initialized_identifier': {
      const first = node.namedChild(0);
      if (first !== null && first.type === 'identifier') out.add(first.text);
      return;
    }
    default:
      return;
  }
}

/** The name a `formal_parameter` binds, across every shape the grammar gives it. */
function dartParameterName(param: SyntaxNode): string | null {
  // `Alpha r`, `final Alpha r`, `void Function(int) r`, `{required Beta r}`,
  // `[Delta r]` — all carry an explicit `name` field.
  const named = param.childForFieldName('name');
  if (named !== null) return named.text;

  const only = param.namedChild(0);
  if (only === null) return null;
  // An untyped closure parameter (`(r) { … }`) is a bare identifier with no
  // field to read it from.
  if (only.type === 'identifier') return only.text;
  // `this.r` / `super.r` bind a parameter NAMED `r` that is initialized from
  // the field — a later bare `r = …` writes that parameter, not the field, so
  // these shadow exactly like any other.
  if (only.type === 'constructor_param' || only.type === 'super_formal_parameter') {
    for (let i = only.namedChildCount - 1; i >= 0; i--) {
      const child = only.namedChild(i);
      if (child !== null && child.type === 'identifier') return child.text;
    }
  }
  return null;
}

function emitHeritage(classNode: SyntaxNode, out: CaptureMatch[]): void {
  const nameNode = classNode.childForFieldName('name');
  if (nameNode === null) return;
  const className = nameNode.text;

  const superclass = classNode.childForFieldName('superclass');
  if (superclass !== null) {
    // `extends Base` — the direct `type_identifier` child of `superclass`
    // (the `mixins` node, if present, nests separately). Routed through the
    // generic inherits pre-pass → EXTENDS (the base resolves to a class).
    for (let i = 0; i < superclass.namedChildCount; i++) {
      const c = superclass.namedChild(i);
      if (c !== null && c.type === 'type_identifier') {
        out.push({
          '@reference.inherits': nodeToCapture('@reference.inherits', c),
          '@reference.name': nodeToCapture('@reference.name', c),
        });
        break;
      }
    }
    // `with M1, M2` — mixin application → IMPLEMENTS (Dart mixin dispatch).
    const mixins = findChild(superclass, 'mixins');
    if (mixins !== null) {
      emitHeritageMarkers(mixins, 'with', className, out);
    }
  }

  // `implements I1, I2` — Dart `implements <class>` is IMPLEMENTS regardless
  // of the target's symbol kind, so it cannot use the target-kind pre-pass.
  const interfaces = classNode.childForFieldName('interfaces');
  if (interfaces !== null) {
    emitHeritageMarkers(interfaces, 'implements', className, out);
  }
}

function emitExtensionImplementsHeritage(extensionNode: SyntaxNode, out: CaptureMatch[]): void {
  const nameNode = extensionNode.childForFieldName('name');
  if (nameNode === null) return;

  const bodyStart = extensionNode.text.indexOf('{');
  const header = bodyStart === -1 ? extensionNode.text : extensionNode.text.slice(0, bodyStart);
  const implementsIndex = header.indexOf('implements');
  if (implementsIndex === -1) return;

  const className = nameNode.text;
  const interfaces = header.slice(implementsIndex + 'implements'.length);
  for (const rawInterface of splitTopLevelCommaList(interfaces)) {
    const target = /^[ \t]*([A-Za-z_$][A-Za-z0-9_$]*)/.exec(rawInterface)?.[1];
    if (target === undefined) continue;
    const payload = encodeMarker('heritage', ['implements', target, className]);
    out.push({ '@import.heritage': syntheticCapture('@import.heritage', nameNode, payload) });
  }
}

function splitTopLevelCommaList(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let angleDepth = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '<') {
      angleDepth++;
      continue;
    }
    if (ch === '>' && angleDepth > 0) {
      angleDepth--;
      continue;
    }
    if (ch === ',' && angleDepth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }

  parts.push(text.slice(start));
  return parts;
}

function emitHeritageMarkers(
  container: SyntaxNode,
  kind: 'implements' | 'with',
  className: string,
  out: CaptureMatch[],
): void {
  for (let i = 0; i < container.namedChildCount; i++) {
    const c = container.namedChild(i);
    if (c === null || c.type !== 'type_identifier') continue;
    const payload = encodeMarker('heritage', [kind, c.text, className]);
    out.push({ '@import.heritage': syntheticCapture('@import.heritage', c, payload) });
  }
}
