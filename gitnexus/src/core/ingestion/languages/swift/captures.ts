/**
 * `emitScopeCaptures` for Swift.
 *
 * Drives the Swift scope query against tree-sitter-swift and groups raw
 * matches into `CaptureMatch[]` for the central extractor. Synthesizes
 * several streams on top of the raw query captures:
 *
 *   1. **Decomposed imports** — each `import_declaration` is re-emitted
 *      with `@import.kind/source/name` markers (and `@import.testable`
 *      when present) so `interpretSwiftImport` recovers the ParsedImport
 *      shape without re-parsing raw text (`import-decomposer.ts`).
 *   2. **Optional bindings** — `if let u = getUser()` / `guard let …`
 *      synthesize a `@type-binding.constructor` (name → callee) by
 *      walking the anchored statement (`@optional.binding`).
 *   3. **Receiver bindings** — `self` (+ `super`) `@type-binding.self`
 *      anchors on every instance method/init (`receiver-binding.ts`).
 *   4. **Signature bindings** — parameter-type and return-type
 *      `@type-binding.*` synthesized from the function node, because
 *      Swift's grammar reuses the `name:` field for func-name / param /
 *      return so a query can't disambiguate (`signature-bindings.ts`).
 *   5. **Arity metadata** — `@declaration.parameter-count` etc. on
 *      function-like declarations and `@reference.arity` on call sites,
 *      so the registry can narrow by arity (`arity-metadata.ts`).
 *
 * Extension handling: a `class_declaration` whose `name:` is a
 * `(user_type …)` is an `extension Foo { … }`. The query tags it
 * `@declaration.extension`; we re-key it to `@declaration.class` with a
 * synthesized `@declaration.name` of the extended type so its members
 * hoist onto `Foo`'s scope (`populateClassOwnedMembers` completes the
 * ownership stamp) — the same mechanism C# uses for `partial class`.
 *
 * Pure given the input source text. No I/O, no globals consulted.
 */

import type { Capture, CaptureMatch } from 'gitnexus-shared';
import {
  nodeIfType,
  nodeToCapture,
  syntheticCapture,
  type SyntaxNode,
} from '../../utils/ast-helpers.js';
import { splitSwiftImport } from './import-decomposer.js';
import { computeSwiftArityMetadata } from './arity-metadata.js';
import { synthesizeSwiftReceiverBinding } from './receiver-binding.js';
import { synthesizeSwiftSignatureBindings } from './signature-bindings.js';
import { getSwiftParser, getSwiftScopeQuery } from './query.js';
import { recordCacheHit, recordCacheMiss } from './cache-stats.js';
import { getTreeSitterBufferSize } from '../../constants.js';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';

/** Declaration anchors that carry function-like arity metadata. */
const FUNCTION_DECL_TAGS = ['@declaration.method', '@declaration.constructor'] as const;

/** tree-sitter-swift node types that carry arity. */
const FUNCTION_NODE_TYPES = [
  'function_declaration',
  'protocol_function_declaration',
  'init_declaration',
] as const;

/** Function-like nodes eligible for receiver-binding synthesis. */
const RECEIVER_NODE_TYPES = [
  'function_declaration',
  'init_declaration',
  'deinit_declaration',
] as const;

export function emitSwiftScopeCaptures(
  sourceText: string,
  _filePath: string,
  cachedTree?: unknown,
): readonly CaptureMatch[] {
  // Reuse the parse phase's cached Tree when available; otherwise parse.
  let tree = cachedTree as ReturnType<ReturnType<typeof getSwiftParser>['parse']> | undefined;
  if (tree === undefined) {
    tree = parseSourceSafe(getSwiftParser(), sourceText, undefined, {
      bufferSize: getTreeSitterBufferSize(sourceText),
    });
    recordCacheMiss();
  } else {
    recordCacheHit();
  }

  const rawMatches = getSwiftScopeQuery().matches(tree.rootNode);
  const out: CaptureMatch[] = [];
  // Dedup genuine field reads by span — tree-sitter-swift can match the
  // same navigation_expression twice (stacked nodes with identical spans).
  const seenReadSpans = new Set<string>();

  for (const m of rawMatches) {
    // Group captures by tag. Tree-sitter strips the leading `@`; put it
    // back so the central extractor's prefix lookups work. Keep a
    // parallel tag → node map so anchors resolve via nodeIfType (the
    // captured node IS the node at that range — no findNodeAtRange
    // root-walk, the O(matches × rootChildren) hot path fixed in #1918).
    const grouped: Record<string, Capture> = {};
    const nodeMap: Record<string, SyntaxNode> = {};
    for (const c of m.captures) {
      const tag = '@' + c.name;
      grouped[tag] = nodeToCapture(tag, c.node);
      nodeMap[tag] = c.node;
    }
    if (Object.keys(grouped).length === 0) continue;

    // ── Imports ──────────────────────────────────────────────────────
    if (grouped['@import.statement'] !== undefined) {
      const stmtNode = nodeIfType(nodeMap['@import.statement'], 'import_declaration');
      if (stmtNode !== null) {
        const decomposed = splitSwiftImport(stmtNode);
        if (decomposed !== null) {
          out.push(decomposed);
          continue;
        }
      }
      out.push(grouped); // defensive fallback
      continue;
    }

    // ── Optional bindings: if-let / guard-let. Synthesize a
    // @type-binding.constructor (name → callee); chain-follow resolves
    // the callee to its return type. ─────────────────────────────────
    if (grouped['@optional.binding'] !== undefined) {
      const stmtNode = nodeIfType(nodeMap['@optional.binding'], 'if_statement', 'guard_statement');
      const synth = stmtNode === null ? null : synthesizeOptionalBinding(stmtNode);
      if (synth !== null) out.push(synth);
      continue;
    }

    // ── Field reads: keep only genuine reads (`u.address`); drop the
    // navigation that is a call's callee (`u.save` in `u.save()`) or an
    // assignment LHS (a write). Dedup identical spans. ───────────────
    if (grouped['@reference.read.member'] !== undefined) {
      const navNode = nodeIfType(nodeMap['@reference.read.member'], 'navigation_expression');
      if (navNode === null || !shouldEmitSwiftReadMember(navNode)) continue;
      const span = `${navNode.startIndex}-${navNode.endIndex}`;
      if (seenReadSpans.has(span)) continue;
      seenReadSpans.add(span);
      out.push(grouped);
      continue;
    }

    // ── Extensions: re-key @declaration.extension → @declaration.class
    // with the extended type's bare name so members hoist onto it. ────
    if (grouped['@declaration.extension'] !== undefined) {
      const extNode = nodeIfType(nodeMap['@declaration.extension'], 'class_declaration');
      const reKeyed: Record<string, Capture> = { ...grouped };
      delete reKeyed['@declaration.extension'];
      reKeyed['@declaration.class'] = grouped['@declaration.extension'];
      if (extNode !== null) {
        const nameNode = extNode.childForFieldName('name');
        const bare =
          nameNode?.type === 'user_type'
            ? (nameNode.firstNamedChild?.text ?? nameNode.text)
            : (nameNode?.text ?? grouped['@declaration.name']?.text ?? '');
        if (bare !== '') {
          reKeyed['@declaration.name'] = syntheticCapture('@declaration.name', extNode, bare);
        }
      }
      out.push(reKeyed);
      continue;
    }

    // ── `let x = Type.init(...)` — explicit-initializer call. The
    // constructor type-binding query only matches a bare `Type(...)`
    // (simple_identifier callee); the `Type.init(...)` navigation form
    // needs a synthesized `x: Type` binding so a later `x.method()`
    // resolves. Emitted in ADDITION to the normal @declaration.property
    // match, which still flows through to the final push below. ───────
    if (grouped['@declaration.property'] !== undefined) {
      const propNode = nodeIfType(nodeMap['@declaration.property'], 'property_declaration');
      const synth = propNode === null ? null : synthesizeInitCtorBinding(propNode);
      if (synth !== null) out.push(synth);
    }

    // ── init: synthesize @declaration.name = "init" (no name field). ──
    if (
      grouped['@declaration.constructor'] !== undefined &&
      grouped['@declaration.name'] === undefined
    ) {
      const initNode = nodeIfType(nodeMap['@declaration.constructor'], 'init_declaration');
      if (initNode !== null) {
        grouped['@declaration.name'] = syntheticCapture('@declaration.name', initNode, 'init');
      }
    }

    // ── @scope.function: arity + receiver + signature bindings. ──────
    if (grouped['@scope.function'] !== undefined) {
      const fnNodeForArity = nodeIfType(
        nodeMap['@scope.function'] ??
          nodeMap['@declaration.method'] ??
          nodeMap['@declaration.constructor'],
        ...FUNCTION_NODE_TYPES,
      );
      if (fnNodeForArity !== null) attachArityMetadata(grouped, fnNodeForArity);
      out.push(grouped);

      const recvNode = nodeIfType(nodeMap['@scope.function'], ...RECEIVER_NODE_TYPES);
      if (recvNode !== null) {
        for (const synth of synthesizeSwiftReceiverBinding(recvNode)) out.push(synth);
      }
      const sigNode = nodeIfType(nodeMap['@scope.function'], ...FUNCTION_NODE_TYPES);
      if (sigNode !== null) {
        for (const synth of synthesizeSwiftSignatureBindings(sigNode)) out.push(synth);
      }
      continue;
    }

    // ── Arity metadata on function-like declarations (non-scope). ────
    const declTag = FUNCTION_DECL_TAGS.find((t) => grouped[t] !== undefined);
    if (declTag !== undefined) {
      const fnNode = nodeIfType(nodeMap[declTag], ...FUNCTION_NODE_TYPES);
      if (fnNode !== null) attachArityMetadata(grouped, fnNode);
    }

    // ── Constructor calls: Swift has no `new`, so `Foo()` is a free call
    // whose callee is a type. Re-tag an UpperCamelCase free-call callee as
    // a constructor reference so the resolver's constructor branch targets
    // the type's Constructor/Class (mirrors how other no-`new` languages
    // classify `Type(...)`). Types are UpperCamelCase by Swift convention;
    // functions are lowerCamelCase — so the first-letter test is a reliable
    // syntactic discriminator with no scope lookup. ──────────────────────
    if (grouped['@reference.call.free'] !== undefined) {
      const calleeName = grouped['@reference.name']?.text ?? '';
      const first = calleeName.charAt(0);
      if (first !== '' && first === first.toUpperCase() && first !== first.toLowerCase()) {
        // Build a fresh capture whose `.name` is the constructor tag — the
        // extractor's anchor classifier reads the capture's `.name`, not the
        // map key, so reusing the free-call capture object would keep
        // classifying it as a free call (silent no-op).
        const callNode = nodeMap['@reference.call.free'];
        grouped['@reference.call.constructor'] = nodeToCapture(
          '@reference.call.constructor',
          callNode,
        );
        nodeMap['@reference.call.constructor'] = callNode;
        delete grouped['@reference.call.free'];
      }
    }

    // ── @reference.arity on call sites. ──────────────────────────────
    const callTag = (
      ['@reference.call.free', '@reference.call.member', '@reference.call.constructor'] as const
    ).find((t) => grouped[t] !== undefined);
    if (callTag !== undefined && grouped['@reference.arity'] === undefined) {
      const callNode = nodeIfType(nodeMap[callTag], 'call_expression');
      if (callNode !== null) {
        grouped['@reference.arity'] = syntheticCapture(
          '@reference.arity',
          callNode,
          String(countCallArguments(callNode)),
        );
      }
    }

    out.push(grouped);
  }

  return out;
}

/** Synthesize a `@type-binding.constructor` for an if-let / guard-let
 *  optional binding: `if let u = getUser()` → `u: getUser` (chain-follow
 *  resolves getUser → its return type). The statement has a flat shape —
 *  a `bound_identifier:` field for the name and separate `condition:`
 *  children, one of which is the bound value (a call_expression, possibly
 *  wrapped in await/try). Returns null when the value isn't a call. */
function synthesizeOptionalBinding(stmtNode: SyntaxNode): CaptureMatch | null {
  const nameNode = stmtNode.childForFieldName('bound_identifier');
  if (nameNode === null) return null;

  let callee: SyntaxNode | null = null;
  for (let i = 0; i < stmtNode.childCount; i++) {
    const child = stmtNode.child(i);
    if (child === null) continue;
    if (child.type === 'call_expression') {
      callee = child.namedChild(0);
      break;
    }
    if (child.type === 'await_expression' || child.type === 'try_expression') {
      for (let j = 0; j < child.namedChildCount; j++) {
        const inner = child.namedChild(j);
        if (inner !== null && inner.type === 'call_expression') {
          callee = inner.namedChild(0);
          break;
        }
      }
      if (callee !== null) break;
    }
  }
  if (callee === null || callee.type !== 'simple_identifier') return null;

  const m: Record<string, Capture> = {
    '@type-binding.constructor': nodeToCapture('@type-binding.constructor', stmtNode),
    '@type-binding.name': syntheticCapture('@type-binding.name', nameNode, nameNode.text),
    '@type-binding.type': syntheticCapture('@type-binding.type', callee, callee.text),
  };
  return m;
}

/** Synthesize a `@type-binding.constructor` for `let x = Type.init(...)`.
 *  The property's `value:` is a call_expression whose callee is a
 *  navigation_expression `Type.init`; bind `x` to the navigation target
 *  `Type` (the explicit-initializer form of `let x = Type(...)`). Returns
 *  null for any other value shape (e.g. `let x = obj.method()`, which must
 *  NOT bind x to `obj`). */
function synthesizeInitCtorBinding(propNode: SyntaxNode): CaptureMatch | null {
  const namePattern = propNode.childForFieldName('name');
  const nameNode = namePattern?.childForFieldName('bound_identifier') ?? null;
  if (nameNode === null) return null;

  const value = propNode.childForFieldName('value');
  if (value === null || value.type !== 'call_expression') return null;

  const callee = value.namedChild(0);
  if (callee === null || callee.type !== 'navigation_expression') return null;

  const target = callee.childForFieldName('target');
  const suffix = callee.childForFieldName('suffix');
  const member = suffix?.childForFieldName('suffix') ?? null;
  if (
    target === null ||
    target.type !== 'simple_identifier' ||
    member === null ||
    member.text !== 'init'
  ) {
    return null;
  }

  const m: Record<string, Capture> = {
    '@type-binding.constructor': nodeToCapture('@type-binding.constructor', propNode),
    '@type-binding.name': syntheticCapture('@type-binding.name', nameNode, nameNode.text),
    '@type-binding.type': syntheticCapture('@type-binding.type', target, target.text),
  };
  return m;
}

/** A navigation_expression (`a.b`) is a genuine field read unless it is
 *  the callee of a call (`a.b()` — a member call) or the LHS of an
 *  assignment (`a.b = …` — a write). The receiver chain of a deeper
 *  access (`user.address` in `user.address.save()`) has parent
 *  navigation_expression (not call_expression), so it is correctly kept. */
function shouldEmitSwiftReadMember(navNode: SyntaxNode): boolean {
  const parent = navNode.parent;
  if (parent === null) return true;
  if (parent.type === 'call_expression') return false;
  if (parent.type === 'assignment') {
    const lhs = parent.childForFieldName('target') ?? parent.firstNamedChild;
    if (lhs !== null && lhs.id === navNode.id) return false;
  }
  return true;
}

/** Attach @declaration.parameter-count / required-parameter-count /
 *  parameter-types synthesized from a function-like node. */
function attachArityMetadata(grouped: Record<string, Capture>, fnNode: SyntaxNode): void {
  const arity = computeSwiftArityMetadata(fnNode);
  if (arity.parameterCount !== undefined) {
    grouped['@declaration.parameter-count'] = syntheticCapture(
      '@declaration.parameter-count',
      fnNode,
      String(arity.parameterCount),
    );
  }
  if (arity.requiredParameterCount !== undefined) {
    grouped['@declaration.required-parameter-count'] = syntheticCapture(
      '@declaration.required-parameter-count',
      fnNode,
      String(arity.requiredParameterCount),
    );
  }
  if (arity.parameterTypes !== undefined) {
    grouped['@declaration.parameter-types'] = syntheticCapture(
      '@declaration.parameter-types',
      fnNode,
      JSON.stringify(arity.parameterTypes),
    );
  }
}

/** Count call arguments: the `value_argument` named children of the
 *  call's `call_suffix > value_arguments`. */
function countCallArguments(callNode: SyntaxNode): number {
  for (let i = 0; i < callNode.namedChildCount; i++) {
    const child = callNode.namedChild(i);
    if (child === null || child.type !== 'call_suffix') continue;
    for (let j = 0; j < child.namedChildCount; j++) {
      const va = child.namedChild(j);
      if (va === null || va.type !== 'value_arguments') continue;
      let n = 0;
      for (let k = 0; k < va.namedChildCount; k++) {
        const arg = va.namedChild(k);
        if (arg !== null && arg.type === 'value_argument') n++;
      }
      return n;
    }
  }
  return 0;
}
