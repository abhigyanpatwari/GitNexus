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
 *  `cppScopeResolver.loadResolutionConfig` at the start of every pass. */
export function clearCppInlineNamespaces(): void {
  inlineNamespaceRangesByFile.clear();
  inlineNamespaceScopeIds.clear();
  qualifiedNsIndex = undefined;
  qualifiedNsIndexSource = undefined;
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
 * to two Map lookups.
 *
 * `byReceiver`: namespace simple name → member simple name → callable defs,
 * in the exact order the legacy linear scan produced them (file-major; within
 * a file, `parsed.scopes` declaration order; within a namespace, own
 * `ownedDefs` before inline-namespace children, depth-first). Ordering is
 * load-bearing: the caller returns `allHits[0]` for the single-hit case and
 * `narrowOverloadCandidates` is first-wins.
 */
interface QualifiedNsMemberIndex {
  readonly byReceiver: ReadonlyMap<string, ReadonlyMap<string, readonly SymbolDefinition[]>>;
}

type NsScope = ParsedFile['scopes'][number];

let qualifiedNsIndex: QualifiedNsMemberIndex | undefined;
let qualifiedNsIndexSource: readonly ParsedFile[] | undefined;

/** Build the index in a single pass over the workspace. Visitation order
 *  mirrors the legacy scan exactly (see {@link QualifiedNsMemberIndex}). */
function buildQualifiedNsMemberIndex(parsedFiles: readonly ParsedFile[]): QualifiedNsMemberIndex {
  const byReceiver = new Map<string, Map<string, SymbolDefinition[]>>();
  // Legacy dedup was a per-call `seenNodeId` set spanning all files; since a
  // def only ever lands in one `(receiver, member)` bucket, a per-receiver set
  // keyed `member \0 nodeId` reproduces it. Only reachable at all via
  // same-name inline nesting (`namespace ns { inline namespace ns { … } }`),
  // but kept so a def is never double-counted into `'ambiguous'`.
  const seenByReceiver = new Map<string, Set<string>>();

  for (const parsed of parsedFiles) {
    // parent → inline-namespace children. The legacy transitive walk filtered
    // `scopesById.values()` by `parent` per recursion step — O(scopes) each,
    // and O(scopes²) per file overall; this is the same order, built once.
    const inlineChildrenByParent = new Map<ScopeId, (typeof parsed.scopes)[number][]>();
    for (const sc of parsed.scopes) {
      if (sc.parent === null) continue;
      if (sc.kind !== 'Namespace') continue;
      if (!inlineNamespaceScopeIds.has(sc.id)) continue;
      let kids = inlineChildrenByParent.get(sc.parent);
      if (kids === undefined) {
        kids = [];
        inlineChildrenByParent.set(sc.parent, kids);
      }
      kids.push(sc);
    }

    for (const scope of parsed.scopes) {
      if (scope.kind !== 'Namespace') continue;
      const nsDef = findNamespaceDefInScope(scope);
      if (nsDef === undefined) continue;
      const nsName = nsDef.qualifiedName?.split('.').pop() ?? nsDef.qualifiedName ?? '';
      let byMember = byReceiver.get(nsName);
      if (byMember === undefined) {
        byMember = new Map();
        byReceiver.set(nsName, byMember);
      }
      let seen = seenByReceiver.get(nsName);
      if (seen === undefined) {
        seen = new Set();
        seenByReceiver.set(nsName, seen);
      }
      collectNamespaceMembers(scope, inlineChildrenByParent, byMember, seen);
    }
  }
  return { byReceiver };
}

/** Bucket a namespace scope's callable `ownedDefs` by member simple name,
 *  then descend into inline-namespace children — the index-build twin of the
 *  legacy `findMemberInNamespaceTransitive`, collecting every member name in
 *  one walk instead of one walk per `(call site, member name)`. */
function collectNamespaceMembers(
  scope: NsScope,
  inlineChildrenByParent: ReadonlyMap<ScopeId, readonly NsScope[]>,
  byMember: Map<string, SymbolDefinition[]>,
  seen: Set<string>,
): void {
  for (const def of scope.ownedDefs) {
    if (def.type !== 'Function' && def.type !== 'Method' && def.type !== 'Constructor') continue;
    const simple = def.qualifiedName?.split('.').pop() ?? def.qualifiedName ?? '';
    const dedupKey = `${simple}\u0000${def.nodeId}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    let arr = byMember.get(simple);
    if (arr === undefined) {
      arr = [];
      byMember.set(simple, arr);
    }
    arr.push(def);
  }
  for (const child of inlineChildrenByParent.get(scope.id) ?? []) {
    collectNamespaceMembers(child, inlineChildrenByParent, byMember, seen);
  }
}

/** Build the index on first use of a given `parsedFiles` set; reuse it for
 *  every subsequent call site in the same pipeline run.
 *
 *  The index is a function of TWO inputs: `parsedFiles` and the module-level
 *  `inlineNamespaceScopeIds` (which inline children get descended into).
 *  Reference identity on `parsedFiles` alone is sound here because
 *  `populateCppInlineNamespaceScopes` fills `inlineNamespaceScopeIds` during
 *  `populateOwners` — strictly before any resolution pass calls in — and
 *  {@link clearCppInlineNamespaces} drops the index at the start of every
 *  pass. Any future caller that mutates `inlineNamespaceScopeIds` mid-pass
 *  while reusing the same `parsedFiles` reference MUST call
 *  `clearCppInlineNamespaces` in between. Same contract as `ensureAdlIndex`. */
function qualifiedNsMemberIndex(parsedFiles: readonly ParsedFile[]): QualifiedNsMemberIndex {
  if (qualifiedNsIndex === undefined || qualifiedNsIndexSource !== parsedFiles) {
    qualifiedNsIndex = buildQualifiedNsMemberIndex(parsedFiles);
    qualifiedNsIndexSource = parsedFiles;
  }
  return qualifiedNsIndex;
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
 */
export function resolveCppQualifiedNamespaceMember(
  receiverName: string,
  memberName: string,
  parsedFiles: readonly ParsedFile[],
  _scopes: ScopeResolutionIndexes,
  callsite?: Callsite,
): SymbolDefinition | 'ambiguous' | undefined {
  const allHits =
    qualifiedNsMemberIndex(parsedFiles).byReceiver.get(receiverName)?.get(memberName) ?? [];
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
