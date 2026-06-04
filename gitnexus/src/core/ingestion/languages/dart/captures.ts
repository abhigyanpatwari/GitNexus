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
import { recordCacheHit, recordCacheMiss } from './cache-stats.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';
import { encodeMarker } from '../../utils/heritage-marker.js';
import { DART_BUILT_INS } from './built-ins.js';

const FUNCTION_DECL_TAGS = [
  '@declaration.function',
  '@declaration.method',
  '@declaration.constructor',
] as const;

export function emitDartScopeCaptures(
  sourceText: string,
  _filePath: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  let tree: Parser.Tree;
  if (cachedTree !== undefined && cachedTree !== null) {
    tree = cachedTree as Parser.Tree;
    recordCacheHit();
  } else {
    tree = parseSourceSafe(getDartParser(), sourceText, undefined, {
      bufferSize: getTreeSitterBufferSize(sourceText),
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
      out.push(grouped);
      if (fieldType !== null) {
        out.push({
          '@type-binding.annotation': nodeToCapture('@type-binding.annotation', propNode),
          '@type-binding.name': syntheticCapture('@type-binding.name', propNode, fieldName),
          '@type-binding.type': syntheticCapture('@type-binding.type', propNode, fieldType),
        });
      }
      continue;
    }

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
      return;
    }
  });

  return out;
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
