/**
 * C++ inline namespace support (U5 of plan 2026-05-13-001).
 *
 * `inline namespace v1 { void foo(); }` has two ISO C++ semantics that
 * GitNexus must model:
 *
 *   1. **Transitive unqualified visibility.** Names declared in an inline
 *      namespace are reachable by unqualified lookup from the enclosing
 *      namespace's scope, as if they were declared directly there.
 *      `populateCppNonGloballyVisible` (file-local-linkage.ts) treats
 *      inline-namespace members as globally visible for cross-file
 *      unqualified lookup.
 *
 *   2. **Transitive qualified visibility.** `outer::foo()` resolves to
 *      `outer::v1::foo()` when `v1` is inline. The qualified-namespace
 *      receiver resolver (`resolveCppQualifiedNamespaceMember`) walks
 *      inline-namespace children transitively when collecting candidates —
 *      once per pipeline run, into {@link QualifiedNsMemberIndex} (#2788).
 *
 * State lifecycle: capture-time `markCppInlineNamespaceRange` records each
 * inline namespace's source range; `populateCppInlineNamespaceScopes`
 * resolves ranges to `ScopeId`s during `populateOwners`. Cleared via
 * `clearCppInlineNamespaces`, called from
 * `cppScopeResolver.loadResolutionConfig` at the start of every pass.
 *
 * STL idiom this enables: `std::__1::vector` (libc++) and `std::__cxx11`
 * (libstdc++) are inline namespaces of `std`. With this support,
 * `std::vector` qualified calls resolve to the inline-namespace
 * declaration transparently.
 */

import type { Callsite, ParsedFile, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import {
  isOverloadAmbiguousAfterNormalization,
  narrowOverloadCandidates,
} from '../../scope-resolution/passes/overload-narrowing.js';
import { CPP_CONVERSION_ONLY_ARG_TYPE_PREFIXES, cppConversionRank } from './conversion-rank.js';

interface RangeKey {
  readonly startLine: number;
  readonly startCol: number;
  readonly endLine: number;
  readonly endCol: number;
}

const inlineNamespaceRangesByFile = new Map<string, Set<string>>();
const inlineNamespaceScopeIds = new Set<ScopeId>();

function rangeKey(r: RangeKey): string {
  return `${r.startLine}:${r.startCol}:${r.endLine}:${r.endCol}`;
}

/** Capture-time: record a namespace_definition's range as inline.
 *  Called from `emitCppScopeCaptures` when the tree-sitter AST shows an
 *  `inline` keyword child on `namespace_definition`. */
export function markCppInlineNamespaceRange(filePath: string, range: RangeKey): void {
  let set = inlineNamespaceRangesByFile.get(filePath);
  if (set === undefined) {
    set = new Set();
    inlineNamespaceRangesByFile.set(filePath, set);
  }
  set.add(rangeKey(range));
}

/** Snapshot this file's captured inline-namespace ranges for the worker→main
 *  side-channel (#1983). `populateCppInlineNamespaceScopes` (in `populateOwners`)
 *  later resolves these range keys to ScopeIds on the main thread, so only the
 *  capture-time ranges need to cross the boundary. Returns the rangeKey strings
 *  as a plain array (empty when this file recorded none). */
export function collectCppInlineNamespaceSideChannel(filePath: string): readonly string[] {
  const set = inlineNamespaceRangesByFile.get(filePath);
  return set === undefined ? [] : [...set];
}

/** Restore this file's captured inline-namespace ranges from the side-channel. */
export function applyCppInlineNamespaceSideChannel(
  filePath: string,
  ranges: readonly string[],
): void {
  if (ranges.length === 0) return;
  let set = inlineNamespaceRangesByFile.get(filePath);
  if (set === undefined) {
    set = new Set();
    inlineNamespaceRangesByFile.set(filePath, set);
  }
  for (const r of ranges) set.add(r);
}

/** Clear all inline-namespace state. Called from
 *  `cppScopeResolver.loadResolutionConfig` at the start of every pass.
 *
 *  The qualified-namespace index is dropped by REASSIGNING a fresh `WeakMap`:
 *  `WeakMap` has no `.clear()`, and swapping the instance discards every
 *  memoized entry at once — the exact invalidation the previous
 *  `qualifiedNsIndex = undefined` provided. Required even though the map is
 *  keyed on `parsedFiles` identity, because the index also depends on
 *  `inlineNamespaceScopeIds`, which the key cannot observe (see
 *  {@link qualifiedNsMemberIndex}). */
export function clearCppInlineNamespaces(): void {
  inlineNamespaceRangesByFile.clear();
  inlineNamespaceScopeIds.clear();
  qualifiedNsIndexByPass = new WeakMap();
}

/** Resolve captured ranges to actual ScopeIds by matching scope ranges
 *  against the inline-namespace ranges recorded for this file. Run from
 *  the cpp resolver's `populateOwners` hook so the per-pipeline Set is
 *  populated before any resolution pass consults it. */
export function populateCppInlineNamespaceScopes(parsed: ParsedFile): void {
  const ranges = inlineNamespaceRangesByFile.get(parsed.filePath);
  if (ranges === undefined || ranges.size === 0) return;
  for (const scope of parsed.scopes) {
    if (scope.kind !== 'Namespace') continue;
    if (ranges.has(rangeKey(scope.range))) {
      inlineNamespaceScopeIds.add(scope.id);
    }
  }
}

/** Predicate consumed by `populateCppNonGloballyVisible` to exempt
 *  inline-namespace members from cross-file unqualified-lookup
 *  exclusion (they remain reachable as if declared at the enclosing
 *  namespace's level). */
export function isCppInlineNamespaceScope(scopeId: ScopeId): boolean {
  return inlineNamespaceScopeIds.has(scopeId);
}

/**
 * Qualified-namespace member index — built **once** per pipeline run from
 * `parsedFiles` and reused by every qualified call site.
 *
 * The legacy lookup re-scanned every parsed file (rebuilding a per-file
 * `scopesById` map each time) once **per qualified call site**, making the
 * scope-resolution emit phase O(callsites × scopes): 25.3 min of a 33-min
 * analyze on a 1,473-file C++ repo, 75% of total self-time in this one
 * function (#2788). Mirrors the same fix #1990 applied to ADL
 * (`pickCppAdlCandidates` → {@link AdlCandidateIndex}); per-site cost drops
 * to a Map lookup once a `(receiver, member)` pair has been resolved.
 *
 * **Why the index is a graph and not a flattened member table.** Every
 * `Namespace` scope is a legal qualified receiver on its own — in
 * `outer { inline v1 { inline v2 { … } } }`, `v2::foo()` is valid C++ — so an
 * eager table has to record, for every namespace, every member of every inline
 * descendant. On a chain of depth D that is D + (D−1) + … + 1 entries: quadratic
 * in **both** time and memory, and materializing it recursively also recursed D
 * deep. Neither bound was theoretical — a generated chain 6,000 deep with one
 * function per level exhausted a 4 GB heap, and a member-less one 8,000 deep
 * threw `RangeError: Maximum call stack size exceeded`. Nothing on the analyze
 * path catches either (`run.ts` only wraps the CFG/PDG emit block; `phase.ts`'s
 * `try` has a `finally` and no `catch`), so one pathological generated file
 * aborted the whole `analyze` — the failure class of #2769.
 *
 * Storing the *shape* instead — each namespace's own members plus links to its
 * inline children — makes the build linear in scopes+defs, and a call site pays
 * one iterative pre-order walk of the receiver's inline subtree, memoized per
 * `(receiver, member)`. Real inline nesting is 1–2 deep (`std::__1`,
 * `std::__cxx11`), so that walk is 2–3 nodes.
 */
interface QualifiedNsMemberIndex {
  /**
   * Namespace simple name → the scopes declaring it, in the exact order the
   * legacy linear scan visited them (file-major, then `parsed.scopes`
   * declaration order).
   *
   * Order is preserved for byte-identity with the pre-#2788 walker, NOT
   * because {@link resolveCppQualifiedNamespaceMember}'s return contract can
   * observe it. That contract is order-blind today: `allHits[0]` is reached
   * only under `allHits.length === 1`, and every multi-candidate path either
   * narrows to a unique survivor (unique by definition) or falls into the two
   * tail branches, which BOTH return `'ambiguous'`. In particular
   * `narrowOverloadCandidates` is not acting first-wins here — on the
   * callsite-less `resolveAdlCandidates` path its arity and type filters are
   * pass-throughs, so a multi-hit pair always ends `'ambiguous'`. Keep the
   * order anyway: it is free, and a future contract that does pick among ties
   * should inherit the legacy order rather than Map insertion happenstance.
   */
  readonly rootsByReceiver: ReadonlyMap<string, readonly QualifiedNsNode[]>;
  /**
   * Memo of resolved candidate lists, receiver → member → defs. Filled on
   * demand by {@link qualifiedNsMembers}; only pairs a call site actually asks
   * for are ever materialized, which is what keeps the deep-chain case linear.
   */
  readonly membersByReceiver: Map<string, Map<string, readonly SymbolDefinition[]>>;
}

/** One `Namespace` scope as the qualified-lookup walk sees it. */
interface QualifiedNsNode {
  /** This scope's OWN callable defs bucketed by member simple name, in
   *  `ownedDefs` order. Computed once at build time, so a namespace with many
   *  members costs one pass no matter how many distinct members are queried. */
  readonly ownMembers: ReadonlyMap<string, readonly SymbolDefinition[]>;
  /** Inline-namespace children in `parsed.scopes` declaration order. Direct
   *  object links rather than `ScopeId` lookups, so the walk needs no scope
   *  table and ids that repeat across files can never splice one file's
   *  children under another file's namespace. */
  readonly inlineChildren: readonly QualifiedNsNode[];
}

/** Build-time view of {@link QualifiedNsNode}: `inlineChildren` is appended to
 *  as the build's second pass links each child, then only ever read. */
interface MutableNsNode extends QualifiedNsNode {
  readonly inlineChildren: QualifiedNsNode[];
}

type NsScope = ParsedFile['scopes'][number];

/** Shared empties: most namespace scopes declare no callables, and most
 *  qualified receivers name no namespace at all. */
const NO_MEMBERS: ReadonlyMap<string, readonly SymbolDefinition[]> = new Map();
/** Frozen at declaration rather than lazily by the memo's `Object.freeze`, so
 *  this process-wide shared array is never observably mutable — it is also
 *  returned directly for receivers that name no namespace at all. */
const NO_DEFS: readonly SymbolDefinition[] = Object.freeze([]);

/** Simple (last-segment) name of a def, matching the legacy scan exactly —
 *  including the empty-string fallback for a def with no `qualifiedName`. */
function simpleNameOf(def: SymbolDefinition): string {
  return def.qualifiedName?.split('.').pop() ?? def.qualifiedName ?? '';
}

/**
 * Per-pass memo: `parsedFiles` array identity → the built index. `WeakMap`-keyed
 * so the entry lives only as long as the caller's `parsedFiles` array does, and
 * is reclaimed with the pass — mirrors `moduleScopeIndexByPass` in
 * `file-local-linkage.ts`.
 *
 * Weak keying is load-bearing, not stylistic: the index holds
 * `SymbolDefinition` references reaching into every ParsedFile's scopes, so a
 * module-level strong `let` pair (index + source array) kept the whole C/C++
 * ParsedFile set alive past the point `scope-resolution/pipeline/phase.ts`
 * evicts `files`/`contents`/`preExtractedByPath` and calls `forceGc()` to
 * reclaim it — C++ is 7th of 16 `SCOPE_RESOLVERS` entries, so the retention
 * survived nine later language passes plus emit (104.2 MB measured).
 */
let qualifiedNsIndexByPass = new WeakMap<readonly ParsedFile[], QualifiedNsMemberIndex>();

/** Build the index in two linear passes per file: one to make a node per
 *  `Namespace` scope, one to link inline children and register receivers.
 *  Linking needs both endpoints to exist and `parsed.scopes` does not promise
 *  parents precede children, hence two passes rather than one. */
function buildQualifiedNsMemberIndex(parsedFiles: readonly ParsedFile[]): QualifiedNsMemberIndex {
  const rootsByReceiver = new Map<string, QualifiedNsNode[]>();

  for (const parsed of parsedFiles) {
    const nodesByScope = new Map<ScopeId, MutableNsNode>();
    for (const sc of parsed.scopes) {
      if (sc.kind !== 'Namespace') continue;
      nodesByScope.set(sc.id, { ownMembers: bucketOwnMembers(sc), inlineChildren: [] });
    }

    for (const sc of parsed.scopes) {
      if (sc.kind !== 'Namespace') continue;
      const node = nodesByScope.get(sc.id);
      if (node === undefined) continue;
      // A non-`Namespace` parent (a Module scope, say) has no node, so the
      // inline child links to nothing — the same dead entry the legacy
      // `inlineChildrenByParent` map recorded under that parent and never read.
      if (sc.parent !== null && inlineNamespaceScopeIds.has(sc.id)) {
        nodesByScope.get(sc.parent)?.inlineChildren.push(node);
      }
      const nsDef = findNamespaceDefInScope(sc);
      if (nsDef === undefined) continue;
      const nsName = simpleNameOf(nsDef);
      let roots = rootsByReceiver.get(nsName);
      if (roots === undefined) {
        roots = [];
        rootsByReceiver.set(nsName, roots);
      }
      roots.push(node);
    }
  }
  return { rootsByReceiver, membersByReceiver: new Map() };
}

/** Bucket a namespace scope's own callable `ownedDefs` by member simple name.
 *  No descent: inline children are separate nodes reached by the walk. */
function bucketOwnMembers(scope: NsScope): ReadonlyMap<string, readonly SymbolDefinition[]> {
  let members: Map<string, SymbolDefinition[]> | undefined;
  for (const def of scope.ownedDefs) {
    if (def.type !== 'Function' && def.type !== 'Method' && def.type !== 'Constructor') continue;
    const simple = simpleNameOf(def);
    members ??= new Map();
    let arr = members.get(simple);
    if (arr === undefined) {
      arr = [];
      members.set(simple, arr);
    }
    arr.push(def);
  }
  return members ?? NO_MEMBERS;
}

/** Candidates for `receiver::member`, memoized on the index per pair so a
 *  repeated call site costs two Map lookups. */
function qualifiedNsMembers(
  index: QualifiedNsMemberIndex,
  receiverName: string,
  memberName: string,
): readonly SymbolDefinition[] {
  const roots = index.rootsByReceiver.get(receiverName);
  // No namespace by that name — the most common outcome in real source. Left
  // unmemoized deliberately: it is already O(1), and memoizing would grow the
  // index by an entry per unresolved receiver name in the workspace.
  if (roots === undefined) return NO_DEFS;
  let byMember = index.membersByReceiver.get(receiverName);
  if (byMember === undefined) {
    byMember = new Map();
    index.membersByReceiver.set(receiverName, byMember);
  }
  let hits = byMember.get(memberName);
  if (hits === undefined) {
    // Frozen at insertion. `resolveCppQualifiedNamespaceMember` hands this
    // exact array to `narrowOverloadCandidates`, and memoization means it is
    // now shared by every call site in the pass rather than rebuilt per call.
    // `overload-narrowing.ts` only derives (`.filter`/`.map`/`.some`) today, so
    // nothing mutates it — but if an in-place `.sort()`/`.splice()` is ever
    // added there it would silently corrupt every LATER resolution of the same
    // pair, not just its own call. Freezing turns that into a loud `TypeError`
    // (modules are strict mode) at the offending line.
    hits = Object.freeze(gatherQualifiedNsMember(roots, memberName));
    byMember.set(memberName, hits);
  }
  return hits;
}

/** Pre-order depth-first walk of every scope named `receiverName` and its
 *  transitive inline-namespace children, collecting callables named
 *  `memberName` — the index twin of the legacy
 *  `findMemberInNamespaceTransitive`.
 *
 *  Iterative, not recursive: nesting depth is whatever the input file says, and
 *  a recursive descent threw `RangeError` past ~8k levels on a path nothing
 *  catches (see {@link QualifiedNsMemberIndex}). */
function gatherQualifiedNsMember(
  roots: readonly QualifiedNsNode[],
  memberName: string,
): readonly SymbolDefinition[] {
  const hits: SymbolDefinition[] = [];
  const stack: QualifiedNsNode[] = [];
  // `visited` spans ALL roots, reproducing the legacy per-receiver `seenNodeId`
  // dedup: `namespace ns { inline namespace ns { … } }` registers both scopes
  // under receiver `ns`, and the outer walk already collected the inner's defs.
  // Node identity is equivalent to the legacy nodeId key because a node always
  // contributes the same defs. It doubles as the guard that a malformed parent
  // cycle terminates instead of spinning — the one regression an explicit stack
  // could otherwise introduce over recursion's `RangeError`.
  const visited = new Set<QualifiedNsNode>();
  for (const root of roots) {
    stack.push(root);
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined || visited.has(node)) continue;
      visited.add(node);
      const own = node.ownMembers.get(memberName);
      if (own !== undefined) for (const def of own) hits.push(def);
      // Reverse push so children pop in declaration order: the legacy walk was
      // pre-order depth-first, and this reproduces its candidate order (kept
      // for byte-identity, not observed by the return contract — see
      // {@link QualifiedNsMemberIndex}).
      const kids = node.inlineChildren;
      for (let i = kids.length - 1; i >= 0; i--) {
        const kid = kids[i];
        if (kid !== undefined) stack.push(kid);
      }
    }
  }
  return hits.length === 0 ? NO_DEFS : hits;
}

/** Build the index on first use of a given `parsedFiles` set; reuse it for
 *  every subsequent call site that passes the same array reference.
 *
 *  Lifetime: the memoized entry is reachable only while the caller still holds
 *  the `parsedFiles` array. Once the pipeline drops it, the entry — and the
 *  `SymbolDefinition` references it holds into those files' scopes — becomes
 *  collectable; nothing here pins it (see {@link qualifiedNsIndexByPass}).
 *
 *  The index is a function of TWO inputs: `parsedFiles` and the module-level
 *  `inlineNamespaceScopeIds` (which inline children get descended into). The
 *  WeakMap key covers only the first, so the explicit clear is still REQUIRED
 *  for the second: a later pass may hand back the same `parsedFiles` reference
 *  with different inline-namespace state, and identity alone would serve the
 *  stale index. Reference identity is sufficient within a pass because
 *  `populateCppInlineNamespaceScopes` fills `inlineNamespaceScopeIds` during
 *  `populateOwners` — strictly before any resolution pass calls in — and
 *  {@link clearCppInlineNamespaces} swaps in a fresh WeakMap at the start of
 *  every pass. Any future caller that mutates `inlineNamespaceScopeIds`
 *  mid-pass while reusing the same `parsedFiles` reference MUST call
 *  `clearCppInlineNamespaces` in between.
 *
 *  Same STALENESS contract as `ensureAdlIndex` in `adl.ts` — but without that
 *  sibling's dev-gated `validateAdlSeqCoverage` invariant guard, and none is
 *  needed: that guard exists because `pickCppAdlCandidates` reads
 *  `idx.seqByNodeId.get(def.nodeId) ?? 0`, so a def bucketed without a seq
 *  silently collapses onto slot 0 and evicts another candidate. This index has
 *  no analogous defaulting read — a member is either bucketed under its simple
 *  name or absent — so there is no silent-collision mode for a guard to catch. */
function qualifiedNsMemberIndex(parsedFiles: readonly ParsedFile[]): QualifiedNsMemberIndex {
  let index = qualifiedNsIndexByPass.get(parsedFiles);
  if (index === undefined) {
    index = buildQualifiedNsMemberIndex(parsedFiles);
    qualifiedNsIndexByPass.set(parsedFiles, index);
  }
  return index;
}

/**
 * Find the Namespace scopes whose simple name matches `receiverName` and
 * return their callable members matching `memberName`, transitively
 * including inline-namespace children (since they're members of the
 * enclosing namespace under ISO C++). Served from a per-pipeline index
 * ({@link QualifiedNsMemberIndex}), not a per-call-site workspace scan.
 *
 * Returns the most specific (innermost) match — for `outer::foo()`
 * where `inline namespace v1` declares `foo`, returns `v1::foo`. When
 * multiple inline-namespace children declare the same name, ISO C++
 * leaves the call ambiguous; returns `'ambiguous'` so the caller
 * suppresses edge emission rather than picking arbitrarily (#1564).
 *
 * Two production call sites, both in `scope-resolver.ts`:
 *   - `resolveQualifiedReceiverMember` — the `outer::foo()` qualified-receiver
 *     hook. Passes `callsite`, so a multi-candidate set can be narrowed by
 *     arity and argument types.
 *   - `resolveAdlCandidates` — resolving a `using ns::name;` named import back
 *     to its namespace member, for template-class method bodies where the
 *     lexical walk misses that visibility. Passes NO `callsite`, which makes
 *     the narrowing filters below pass-throughs: on that path any receiver
 *     whose member has more than one candidate returns `'ambiguous'` (and the
 *     caller then skips it) rather than being disambiguated.
 */
export function resolveCppQualifiedNamespaceMember(
  receiverName: string,
  memberName: string,
  parsedFiles: readonly ParsedFile[],
  _scopes: ScopeResolutionIndexes,
  callsite?: Callsite,
): SymbolDefinition | 'ambiguous' | undefined {
  const allHits = qualifiedNsMembers(qualifiedNsMemberIndex(parsedFiles), receiverName, memberName);
  if (allHits.length === 0) return undefined;
  if (allHits.length === 1) return allHits[0];

  // Multi-candidate: thread call-site arity/argument-types through the
  // `resolveQualifiedReceiverMember` contract so `narrowOverloadCandidates`
  // can disambiguate via exact-type match and, when available, conversion-rank
  // scoring (`cppConversionRank`). Same-signature ambiguity is still detected
  // by `isOverloadAmbiguousAfterNormalization` below.
  const narrowed = narrowOverloadCandidates(
    allHits,
    callsite?.arity,
    callsite?.argumentTypes,
    callsite !== undefined
      ? {
          conversionRankFn: cppConversionRank,
          conversionOnlyArgTypePrefixes: CPP_CONVERSION_ONLY_ARG_TYPE_PREFIXES,
        }
      : undefined,
  );
  if (narrowed.length === 1) return narrowed[0];
  if (narrowed.length === 0) return undefined;
  if (isOverloadAmbiguousAfterNormalization(narrowed, undefined)) return 'ambiguous';
  // Multiple surviving candidates (distinct signatures) — conservative
  // suppress because we lack call-site info to disambiguate.
  return 'ambiguous';
}

function findNamespaceDefInScope(scope: {
  readonly ownedDefs: readonly SymbolDefinition[];
}): SymbolDefinition | undefined {
  for (const def of scope.ownedDefs) {
    if (def.type === 'Namespace') return def;
  }
  return undefined;
}
