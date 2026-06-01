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
  walkNamedTree,
  type SyntaxNode,
} from '../../utils/ast-helpers.js';
import { splitSwiftImport } from './import-decomposer.js';
import { swiftQualifiedBaseTail } from './base-type.js';
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
      if (stmtNode !== null) {
        for (const synth of synthesizeOptionalBindings(stmtNode)) out.push(synth);
      }
      continue;
    }

    // ── Field accesses: a `navigation_expression` (`obj.field`) is one of
    // three things. Drop it when it's a call's callee (`u.save` in
    // `u.save()` — the @reference.call.member query already covers that).
    // Re-tag it as a write when it's the LHS of an assignment
    // (`obj.field = x`) so a `write` ACCESSES edge emits (mirrors
    // Kotlin/PHP `@reference.write.member`); otherwise keep it as a
    // genuine read (`u.address`) and dedup identical spans. ───────────
    if (grouped['@reference.read.member'] !== undefined) {
      const navNode = nodeIfType(nodeMap['@reference.read.member'], 'navigation_expression');
      if (navNode === null) continue;
      if (isSwiftMemberCallCallee(navNode)) continue;
      if (isSwiftMemberWriteLhs(navNode)) {
        // Re-tag the read anchor as a write. The extractor's anchor
        // classifier reads the capture's `.name` (not the map key —
        // `referenceKindFromAnchor` derives the site kind from
        // `@reference.<kind>`), so we build a FRESH capture whose `.name`
        // is the write tag rather than aliasing the read capture object
        // (which would still classify as a read — a silent no-op). The
        // sibling `@reference.name` / `@reference.receiver` captures carry
        // over unchanged so the field + receiver still resolve. (Mirrors
        // the constructor re-tag below and PHP's write re-tag.)
        const reKeyed: Record<string, Capture> = { ...grouped };
        delete reKeyed['@reference.read.member'];
        reKeyed['@reference.write.member'] = nodeToCapture('@reference.write.member', navNode);
        out.push(reKeyed);
        continue;
      }
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
        // For a nested type `extension Foo.Bar`, the name is
        // `(user_type (type_identifier Foo) (type_identifier Bar))`; the
        // EXTENDED type is the trailing identifier `Bar` (lastNamedChild),
        // not `Foo`. For a single `extension Foo`, first === last, so this
        // is unchanged. Members must hoist onto `Bar`, not `Foo`.
        const bare =
          nameNode?.type === 'user_type'
            ? (nameNode.lastNamedChild?.text ?? nameNode.text)
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

  // ── Emit inheritance references for scope-resolution EXTENDS / IMPLEMENTS ──
  // Walk every class/struct/enum/actor/extension and protocol declaration's
  // inheritance specifiers and synthesize `@reference.inherits` captures so
  // the registry-primary path emits EXTENDS / IMPLEMENTS (mirrors C++ /
  // C# / Java). Without this, Swift inheritance edges came only from the
  // legacy `@heritage.*` path, which the worker pipeline drops for
  // registry-primary languages (issue #1951).
  out.push(...synthesizeSwiftInheritanceReferences(tree.rootNode));

  return out;
}

/**
 * Synthesize `@reference.inherits` captures from Swift inheritance
 * specifiers so the registry-primary scope-resolution path emits
 * EXTENDS / IMPLEMENTS edges (mirrors `synthesizeCsharpInheritanceReferences`
 * / `emitCppInheritanceCaptures`). Without this, Swift inheritance edges came
 * only from the legacy `@heritage.*` path, dropped for registry-primary
 * languages in the worker pipeline (issue #1951).
 *
 * Scope matches the legacy SWIFT_QUERIES `@heritage` blocks exactly: a
 * `class_declaration` (class / struct / enum / actor / extension all share
 * this node) or a `protocol_declaration`, each with an
 * `(inheritance_specifier inherits_from: (user_type (type_identifier)))`.
 * The EXTENDS-vs-IMPLEMENTS split is decided downstream from the resolved
 * target's symbol kind (`preEmitInheritanceEdges` → Interface = IMPLEMENTS,
 * else EXTENDS), so every base is emitted with the same `inherits` kind here.
 * The base lookup name is normalized to its bare simple identifier
 * (`SomeProtocol<T>` → `SomeProtocol`, `Outer.Inner` → `Inner`) to match the
 * V1 simple-name `findClassBindingInScope` contract.
 */
function synthesizeSwiftInheritanceReferences(root: SyntaxNode): CaptureMatch[] {
  const out: CaptureMatch[] = [];
  walkNamedTree(root, (node) => {
    if (node.type !== 'class_declaration' && node.type !== 'protocol_declaration') return;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child === null || child.type !== 'inheritance_specifier') continue;
      const inheritsFrom = child.childForFieldName('inherits_from') ?? child.firstNamedChild;
      if (inheritsFrom === null) continue;
      const nameNode = swiftBaseTypeIdentifier(inheritsFrom);
      if (nameNode === null) continue;
      out.push({
        '@reference.inherits': nodeToCapture('@reference.inherits', child),
        '@reference.name': nodeToCapture('@reference.name', nameNode),
      });
    }
  });
  return out;
}

/** Normalize an `inherits_from` node to its bare simple identifier node.
 *  Only a `user_type`-shaped base contributes an edge; its trailing
 *  `type_identifier` (the actual base — see `swiftQualifiedBaseTail`) is
 *  returned. Returns null for any other base shape (e.g. a tuple /
 *  function-type conformance), so no edge is synthesized — matching the legacy
 *  query's `user_type` gate. */
function swiftBaseTypeIdentifier(inheritsFrom: SyntaxNode): SyntaxNode | null {
  if (inheritsFrom.type === 'type_identifier') return inheritsFrom;
  if (inheritsFrom.type !== 'user_type') return null;
  return swiftQualifiedBaseTail(inheritsFrom);
}

/** Pre-order walk over named children (mirrors C#'s `visit`). */
/** Synthesize a `@type-binding.constructor` for EACH clause of an
 *  if-let / guard-let optional binding:
 *    `if let u = getUser()` → one binding `u: getUser`
 *    `if let a = makeA(), let b = makeB()` → two bindings `a: makeA`, `b: makeB`
 *  (chain-follow resolves each callee → its return type).
 *
 *  The statement has a FLAT child list (verified, tree-sitter-swift 0.7.1):
 *  each clause is `value_binding_pattern` · `simple_identifier` (the bound
 *  name) · `=` · value, where value is a `call_expression` directly, or an
 *  `await_expression` / `try_expression` wrapping one. NOTE: every bound
 *  name carries the `bound_identifier` field, but `childForFieldName`
 *  returns only the FIRST — so we walk the children in order instead.
 *
 *  Clauses whose value isn't a call (`if let a = optionalVar`) are skipped
 *  WITHOUT consuming the following clause's call. Single-clause output is
 *  byte-identical to the prior single-binding implementation. `if_statement`
 *  and `guard_statement` share this shape and are handled identically. */
function synthesizeOptionalBindings(stmtNode: SyntaxNode): CaptureMatch[] {
  const out: CaptureMatch[] = [];

  // State machine over the flat clause list. `pendingName` is the bound
  // name of the clause currently awaiting its value; `awaitingName` is set
  // right after a `value_binding_pattern` so the next `simple_identifier`
  // is taken as the name (not as a value).
  let pendingName: SyntaxNode | null = null;
  let awaitingName = false;

  for (let i = 0; i < stmtNode.childCount; i++) {
    const child = stmtNode.child(i);
    if (child === null) continue;

    // The clause list ends at the body / else / statements.
    if (child.type === 'statements' || child.type === '{' || child.text === 'else') break;

    if (child.type === 'value_binding_pattern') {
      // A new clause begins; any prior clause whose value never arrived was
      // a non-call clause — drop it without consuming this one.
      pendingName = null;
      awaitingName = true;
      continue;
    }

    if (awaitingName) {
      if (child.type === 'simple_identifier') {
        pendingName = child;
        awaitingName = false;
      }
      continue;
    }

    if (pendingName === null) continue;
    if (child.text === '=' || child.text === ',') continue;

    // First non-`=` node after the name is the clause value. Take a binding
    // only when it's a call; clear pendingName either way so a non-call
    // clause doesn't steal the next clause's call.
    const callee = optionalBindingCallee(child);
    if (callee !== null) {
      out.push({
        '@type-binding.constructor': nodeToCapture('@type-binding.constructor', stmtNode),
        '@type-binding.name': syntheticCapture('@type-binding.name', pendingName, pendingName.text),
        '@type-binding.type': syntheticCapture('@type-binding.type', callee, callee.text),
      });
    }
    pendingName = null;
  }

  return out;
}

/** Resolve an optional-binding clause VALUE node to its call callee
 *  (`simple_identifier`), unwrapping a single `await`/`try` layer. Returns
 *  null when the value isn't a bare-identifier call (e.g. `optionalVar`,
 *  or `obj.method()` — which must NOT bind to `obj`). */
function optionalBindingCallee(value: SyntaxNode): SyntaxNode | null {
  let call: SyntaxNode | null = null;
  if (value.type === 'call_expression') {
    call = value;
  } else if (value.type === 'await_expression' || value.type === 'try_expression') {
    for (let j = 0; j < value.namedChildCount; j++) {
      const inner = value.namedChild(j);
      if (inner !== null && inner.type === 'call_expression') {
        call = inner;
        break;
      }
    }
  }
  if (call === null) return null;
  const callee = call.namedChild(0);
  return callee !== null && callee.type === 'simple_identifier' ? callee : null;
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

/** Is this navigation_expression the callee of a call (`a.b` in `a.b()`)?
 *  That is a member call, already captured by @reference.call.member, so
 *  the read.member emission must be dropped. */
function isSwiftMemberCallCallee(navNode: SyntaxNode): boolean {
  return navNode.parent?.type === 'call_expression';
}

/** Is this navigation_expression the LHS of an assignment (`a.b = …` — a
 *  field write)? tree-sitter-swift wraps the assignment target in a
 *  `directly_assignable_expression`, so the write discriminator is the
 *  GRANDPARENT `assignment` reached via that wrapper — NOT a direct
 *  `parent.type === 'assignment'` (which never matches; the old guard was
 *  dead). The inner `obj.a` of `obj.a.b = x` has parent
 *  `navigation_expression` (the outer access), so it is correctly NOT a
 *  write — only the outermost nav under `directly_assignable_expression`
 *  is the write target. */
function isSwiftMemberWriteLhs(navNode: SyntaxNode): boolean {
  const parent = navNode.parent;
  if (parent === null || parent.type !== 'directly_assignable_expression') return false;
  return parent.parent?.type === 'assignment';
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
