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
import { hasKeyword } from '../../field-extractors/configs/helpers.js';

/**
 * `LanguageProvider.scopeOwnsReceivers` for Dart — the read side of
 * `dartShadowedFieldsCapture`, which is where the full rationale lives.
 *
 * Reads the marker rather than re-deriving anything: the names were computed at
 * capture time, where the AST is, and a `CaptureMatch` carries only
 * name/range/text. Kept beside the emitter so the tag string has exactly one
 * producer and one consumer, both in this file's line of sight.
 */
export function dartScopeOwnsReceivers(match: CaptureMatch): ReadonlySet<string> | undefined {
  const raw = match['@receiver-owner.shadowed-fields']?.text;
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const names = parsed.filter(
    (name): name is string => typeof name === 'string' && name.length > 0,
  );
  return names.length > 0 ? new Set(names) : undefined;
}

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

  // Shared, per-file. Pass A (the receiver mask below) and Pass B
  // (`emitDartFieldAssignmentBindings`) ask the SAME two questions of the same
  // nodes — "what does this class declare as a field" and "what does this
  // member body bind" — so the memo makes each answer cost one walk per node
  // for the whole file instead of one per consumer.
  const memo: DartClassMemo = { fieldsByClassBody: new Map(), shadowsByBody: new Map() };

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
        // The READ-side half of the bare-name field discipline (#2807 review).
        // Rides the SAME synthesized match as `@scope.function` so the mask
        // lands on this member's Function scope; outside the `@scope.`
        // namespace so `anchorCaptureFor` cannot mistake it for the anchor.
        const mask = dartShadowedFieldsCapture(bodyNode, memo);
        out.push({
          '@scope.function': spanCapture('@scope.function', declNode, bodyNode),
          ...(mask === undefined ? {} : { '@receiver-owner.shadowed-fields': mask }),
        });
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
        const callee = dartFieldConstructorCallee(nodeMap['@declaration.name']!);
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
      emitDartFieldAssignmentBindings(node, out, memo);
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

/**
 * Is `node` the callee of a construction / free call written directly at this
 * position — a bare identifier whose next named sibling is a `selector`
 * carrying an `argument_part` (`Outer()`)?
 *
 * Dart has no `new` keyword, so a constructor call and a free call are the same
 * shape; the resolver decides which by looking the name up. Anything else — a
 * literal, a member call, an index — is NOT this shape and is left alone rather
 * than guessed at.
 */
function isDirectConstruction(node: SyntaxNode | null): node is SyntaxNode {
  if (node === null || node.type !== 'identifier') return false;
  const next = node.nextNamedSibling;
  return next !== null && next.type === 'selector' && next.namedChild(0)?.type === 'argument_part';
}

/** Find the callee identifier of a `var x = Callee(…)` / `await Callee(…)`
 *  initializer (a direct free-call / constructor); returns null for member
 *  calls or non-call values. */
function findDirectCallValue(initVarDef: SyntaxNode): SyntaxNode | null {
  const firstValue = initVarDef.childForFieldName('value');
  if (firstValue === null) return null;

  if (firstValue.type === 'identifier') {
    return isDirectConstruction(firstValue) ? firstValue : null;
  }
  if (firstValue.type === 'unary_expression' || firstValue.type === 'await_expression') {
    let aw = firstValue;
    if (aw.type === 'unary_expression') {
      const inner = aw.namedChild(0);
      if (inner === null) return null;
      aw = inner;
    }
    if (aw.type === 'await_expression') {
      // `namedChild(0)` is the awaited callee; its next named sibling is
      // `namedChild(1)`, so `isDirectConstruction` asks exactly the same
      // question this branch used to spell out.
      const id = aw.namedChild(0);
      if (isDirectConstruction(id)) return id;
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
 * Takes the field's own `@declaration.name` node, whose next named sibling IS
 * the initializer — `initialized_identifier(<name> <value> …)`. Deliberately NOT
 * a search down from the `@declaration.property` node: one `declaration` can
 * hold SEVERAL declarators (`var a = X(), b = Y();`), which the query matches
 * once each with the same property node, so a first-descendant search hands
 * every declarator the FIRST one's initializer and types `b` as `X`.
 */
function dartFieldConstructorCallee(nameNode: SyntaxNode): SyntaxNode | null {
  const value = nameNode.nextNamedSibling;
  return isDirectConstruction(value) ? value : null;
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
function emitDartFieldAssignmentBindings(
  classNode: SyntaxNode,
  out: CaptureMatch[],
  memo: DartClassMemo,
): void {
  const body = findChild(classNode, 'class_body');
  if (body === null) return;

  // `namedChildren` allocates a fresh wrapper array on every access
  // (node-tree-sitter), and the loop below walks the same list — read it once.
  const members = body.namedChildren;

  const fields = dartClassFieldNames(body, memo);
  if (fields.size === 0) return;

  for (const member of members) {
    if (member === null || member.type !== 'function_body') continue;

    // A STATIC member's body can never write this class's INSTANCE fields.
    // Dart's static scope holds only the class's static members, so a bare
    // `z = Outer()` inside `static void make()` binds a LIBRARY-level `z` (or is
    // a compile error) — never the same-named instance field. Binding it anyway
    // did not merely add an edge: the write landed on the Class scope at the
    // same `constructor-inferred` strength as the constructor's own, and the
    // `>=` tie-break in `scope-extractor` let it DISPLACE the correct type, so
    // `z.inner()` resolved to the wrong class (#2807 review). The instance
    // static-vs-instance collision TypeScript and JavaScript allow cannot arise
    // in Dart — one class may not declare a static and an instance member of the
    // same name — so this is the only shape the defect takes here.
    //
    // Grammar: every class-member body is a `function_body` whose PREVIOUS named
    // sibling is a `method_signature` (method, constructor, factory, getter,
    // setter, operator, `async`), and `static` is an anonymous direct child of
    // that signature, ahead of the inner `*_signature` node. Detection is the
    // shared `hasKeyword` on child TEXT, never `child.type === 'static'`, which
    // a grammar bump silently breaks — the same rule TypeScript's
    // `isStaticMethodThis` follows.
    //
    // A body whose signature cannot be read at all (a null or unexpected
    // previous sibling — parse recovery) DECLINES to bind: staticness is
    // undecidable there, and a missed field type costs an edge while a wrong one
    // destroys a correct binding.
    const signature = member.previousNamedSibling;
    if (signature === null || signature.type !== 'method_signature') continue;
    if (hasKeyword(signature, 'static')) continue;

    // Still lazy per assignment, but the memo is now FILE-wide and shared with
    // Pass A's read-side mask, which asks the same question of the same body.
    // The laziness that used to matter here (87-100% of eagerly built sets were
    // discarded, ~15% of total Dart emission) no longer buys much for a class
    // that declares fields — Pass A has already forced those bodies — so this
    // reads the memo rather than paying a second walk. It still short-circuits
    // for a body whose class declares no fields, since `fields.size === 0`
    // returned above before either pass touched it.
    //
    // Not visible to `bench/scope-capture`, which is a RATIO gate — this work is
    // linear, so a constant factor leaves the ratio at 1.0.
    const shadowsOf = (): ReadonlySet<string> => dartBodyShadows(member, memo);

    walkNamedTree(member, (node) => {
      if (node.type !== 'assignment_expression') return;
      const target = node.namedChild(0);
      if (target === null || target.type !== 'assignable_expression') return;

      const first = target.namedChild(0);
      if (first === null) return;
      let fieldNameNode: SyntaxNode | null = null;
      if (first.type === 'identifier' && target.namedChildCount === 1) {
        // Bare `r = …`: a field only when declared here and not shadowed. The
        // `fields` test runs FIRST so the shadow set is only ever built for a
        // name the class actually declares.
        if (!fields.has(first.text) || shadowsOf().has(first.text)) return;
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

      // RHS must be a direct construction; anything else is left alone rather
      // than guessed at.
      const callee = node.namedChild(1);
      if (!isDirectConstruction(callee)) return;

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
 * Per-file memo for the two class-shaped questions the passes share, keyed by
 * node span. `emitDartScopeCaptures` owns one and threads it; nothing survives
 * the call, so a re-parse cannot serve a stale answer.
 */
interface DartClassMemo {
  readonly fieldsByClassBody: Map<string, ReadonlySet<string>>;
  readonly shadowsByBody: Map<string, ReadonlySet<string>>;
}

const nodeSpanKey = (node: SyntaxNode): string => `${node.startIndex}:${node.endIndex}`;

/**
 * The names a `class_body` declares as INSTANCE-or-static fields, from
 * `declaration(… initialized_identifier_list … initialized_identifier)` — the
 * shape every stored Dart field takes, annotated or not.
 */
function dartClassFieldNames(classBody: SyntaxNode, memo: DartClassMemo): ReadonlySet<string> {
  const key = nodeSpanKey(classBody);
  const cached = memo.fieldsByClassBody.get(key);
  if (cached !== undefined) return cached;

  const fields = new Set<string>();
  for (const member of classBody.namedChildren) {
    if (member === null || member.type !== 'declaration') continue;
    const list = findChild(member, 'initialized_identifier_list');
    if (list === null) continue;
    for (const init of list.namedChildren) {
      if (init === null || init.type !== 'initialized_identifier') continue;
      const nameNode = init.namedChild(0);
      if (nameNode !== null && nameNode.type === 'identifier') fields.add(nameNode.text);
    }
  }
  memo.fieldsByClassBody.set(key, fields);
  return fields;
}

function dartBodyShadows(bodyNode: SyntaxNode, memo: DartClassMemo): ReadonlySet<string> {
  const key = nodeSpanKey(bodyNode);
  const cached = memo.shadowsByBody.get(key);
  if (cached !== undefined) return cached;
  const shadows = collectDartBodyShadows(bodyNode);
  memo.shadowsByBody.set(key, shadows);
  return shadows;
}

/**
 * The READ half of the bare-name field discipline: the field names a member
 * body REBINDS, published on that member's Function scope as
 * `Scope.ownsReceivers` (#2701) so the receiver walk stops there instead of
 * reaching the Class scope (#2807 review).
 *
 * `emitDartFieldAssignmentBindings` above declines to WRITE a binding for a name
 * the body shadows, but the shadow set gated writes only. A bare-name READ of a
 * shadowing binder the resolver cannot type — `for (final conn in xs) {
 * conn.inner(); }`, where the element type of `xs` is not modelled — therefore
 * walked straight past the local and hit the class field binding this same
 * feature mints, resolving `conn.inner()` to the CONSTRUCTOR's type. That turns
 * "no edge" into a WRONG edge, the one failure mode
 * `scope-resolution/passes/compound-receiver.ts` says must never happen, and it
 * was introduced by the write side rather than pre-existing: delete the
 * constructor and the same read emits nothing.
 *
 * `ownsReceivers` is the right primitive because the walk consults
 * `typeBindings` FIRST at every scope (`scope/walkers.ts`) and only then honours
 * the mask. A shadow the resolver CAN type still wins — an annotated parameter
 * `void probe(Beta conn)` keeps `Beta`, because
 * `synthesizeDartSignatureBindings` anchors parameter bindings on this same
 * body node, so they land on this same Function scope. The mask only fires
 * where the alternative was a fabricated type.
 *
 * ── SCOPE OF THE MASK, AND ITS ACCEPTED COSTS ────────────────────────────────
 *
 * `shadows ∩ fields`, and nothing wider. Three consequences are taken knowingly
 * rather than hidden:
 *
 *  1. NOT every locally bound name is masked — only ones the enclosing class
 *     also declares as a field. A library-level `var logger = Logger();`
 *     shadowed by a loop variable of the same name still resolves against the
 *     library binding and can still produce the wrong edge. That is the general
 *     form of the same defect and arguably the more correct fix, but it changes
 *     resolution for code this feature never touched; it is recorded here as a
 *     known limitation rather than implemented.
 *  2. The mask is BODY-WIDE, exactly as `collectDartBodyShadows` is on the write
 *     side. A member that binds `conn` anywhere — a nested closure, one `case`
 *     arm — masks `conn` for the whole member, so a read of the genuine field
 *     elsewhere in that member loses its edge. Deliberate symmetry: the write
 *     side already declines body-wide, and losing an edge is the error this
 *     whole line of work chooses over inventing one.
 *  3. `fields` is EVERY field the class declares, not only the ones the
 *     constructor-write feature types. An ANNOTATED field shadowed by a binder
 *     is masked too, so this reaches resolution that predates #2807 — and it is
 *     meant to: which name a body's bare read refers to is a fact about Dart, not
 *     about how the field acquired its type. `mixin` bodies are reached for the
 *     same reason (the grammar gives a mixin a `class_body` as well), even though
 *     `emitDartFieldAssignmentBindings` mints nothing for them. `extension`
 *     bodies are a different node (`extension_body`) and are left alone.
 *
 * Returns `undefined` — not an empty marker — when nothing is masked, so the
 * emitted capture set is unchanged for every body that does not shadow a field.
 * Names are sorted so the capture text (and every fingerprint over it) is
 * order-stable.
 */
function dartShadowedFieldsCapture(bodyNode: SyntaxNode, memo: DartClassMemo): Capture | undefined {
  // Only a CLASS-MEMBER body can shadow a field: `function_body` whose parent is
  // the `class_body`. A closure's `function_expression_body` and a top-level
  // function are both excluded, and neither needs the mask — a closure's binders
  // are already in its enclosing member's body-wide shadow set, and the walk
  // passes through the enclosing member's Function scope on its way out.
  if (bodyNode.type !== 'function_body') return undefined;
  const classBody = bodyNode.parent;
  if (classBody === null || classBody.type !== 'class_body') return undefined;

  const fields = dartClassFieldNames(classBody, memo);
  if (fields.size === 0) return undefined;
  const shadows = dartBodyShadows(bodyNode, memo);
  if (shadows.size === 0) return undefined;

  const masked: string[] = [];
  for (const name of fields) {
    if (shadows.has(name)) masked.push(name);
  }
  if (masked.length === 0) return undefined;
  masked.sort();
  return syntheticCapture('@receiver-owner.shadowed-fields', bodyNode, JSON.stringify(masked));
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
 * Dart 3 patterns are the SAME defect a second time: `var (r, n) = …;`,
 * `if (o case Beta r)`, `case Beta r:`, `for (var (r, _) in xs)`, list / map /
 * object / rest / cast / null-check / null-assert patterns and pattern
 * assignments all bind `r` through node types no earlier list named, so each of
 * them let a write retype the field. `addDartBinderName` now enumerates the
 * pattern family from the grammar rather than from reported shapes.
 *
 * Deliberately over-approximate in the shadow direction. The set is body-wide
 * (a binder in a nested closure, a `case` arm or a collection-literal element
 * shadows for the whole body), a parameter shape whose name cannot be read
 * contributes nothing rather than being guessed at, and a bare name inside a
 * pattern shadows whether it binds or merely references a constant. All err
 * toward DECLINING to bind, which is the right error: a missed field type costs
 * an edge, a wrong one produces an edge to the wrong class and destroys a
 * correct binding — the failure mode this whole line of work exists to avoid
 * (see `scope-resolution/passes/compound-receiver.ts`).
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

/**
 * Record the name `node` binds, if it binds one.
 *
 * The `case` list is the whole point of this function and the reason it is
 * separate: an INCOMPLETE list of binder forms is the exact defect this file has
 * now shipped twice (formal parameters, then every Dart 3 pattern). It is
 * enumerated against `vendor/tree-sitter-dart/grammar.js`, not against the
 * shapes a bug report happened to carry.
 */
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
    // ── Dart 3 patterns ──────────────────────────────────────────────────────
    //
    // EVERY pattern node the grammar emits, and every one of them takes its
    // DIRECT `identifier` children. The grammar rules that would carry a binder
    // are `_pattern_field`, `_map_pattern_entry`, `_list_pattern_element`,
    // `_parenthesized_pattern`, `_outer_pattern`, `_guarded_pattern` and the
    // logical/relational tiers — ALL hidden (`_`-prefixed), so they emit no node
    // of their own and inline their children onto whichever visible pattern node
    // encloses them. Reading direct children is therefore what actually sees a
    // binder; there is no field to ask for (`variable_pattern`,
    // `pattern_variable_declaration` and `constant_pattern` declare none).
    //
    // The first two are where a binder truly lands, and are alone sufficient:
    //   `variable_pattern` — `Beta s` / `final s` / `var s`.
    //   `constant_pattern` — a BARE name (`(s, n)`, `[s, t]`, `{'k': s}`,
    //      `Point(:s)`, `...s`, `(s)`). Dart itself decides bare-name-binds-vs-
    //      references-a-constant from the enclosing `final`/`var`, and
    //      tree-sitter gives both the same node, so `case kLimit:` shadows too.
    //      Over-shadowing a constant reference costs an edge; the other
    //      direction fabricates one.
    // The containers after them are DEFENCE, not routing — the walk reaches
    // nested patterns on its own. They matter because the hidden `_pattern_field`
    // already drops a NON-binder label identifier straight onto `record_pattern`
    // / `object_pattern` (and a key onto `map_pattern`), which is proof that this
    // grammar inlines identifiers onto containers. If a grammar revision ever
    // inlines a real binder the same way, it is shadowed here on arrival instead
    // of becoming the third instance of this bug.
    //
    // DELIBERATELY EXCLUDED — `pattern_variable_declaration`, `pattern_assignment`
    // and `for_loop_parts` hold the pattern and the `=`/`in` RHS at the SAME
    // child level (`var [s, t] = xs` → `identifier xs` is a direct child), so
    // taking their direct identifiers would shadow the SOURCE expression's name,
    // which binds nothing. Their pattern child is a case below. Also excluded:
    // `type_identifier` (never an `identifier`, so `Beta` in `Beta s` and `Point`
    // in `Point(…)` cannot be mistaken for binders), `qualified` inside a
    // `constant_pattern` (`Colors.red` nests one level deeper — a qualified name
    // is always a constant reference), and relational/equality operands
    // (`case > kLimit`), which the hidden tier drops onto the enclosing
    // STATEMENT rather than any pattern node.
    case 'variable_pattern':
    case 'constant_pattern':
    case 'record_pattern':
    case 'list_pattern':
    case 'map_pattern':
    case 'object_pattern':
    case 'rest_pattern':
    case 'cast_pattern':
    case 'null_check_pattern':
    case 'null_assert_pattern': {
      for (const child of node.namedChildren) {
        if (child !== null && child.type === 'identifier') out.add(child.text);
      }
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
