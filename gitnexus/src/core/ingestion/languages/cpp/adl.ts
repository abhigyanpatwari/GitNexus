/**
 * C++ argument-dependent lookup (ADL / Koenig lookup).
 *
 * When ordinary unqualified lookup fails for a free-call site, ADL also
 * considers candidates declared in the **associated namespaces** of the
 * call's argument types (ISO C++ `[basic.lookup.argdep]`). The canonical
 * pattern V1 unlocks:
 *
 *   namespace audit { struct Event; void record(Event); }
 *   namespace app   { void run() { audit::Event e; record(e); } }
 *
 * Without ADL: `record(e)` is unresolved because `app::run` doesn't
 * `using` anything. With V1 ADL: `audit::record` is discovered via
 * `audit::Event`'s associated namespace.
 *
 * ## Current boundary
 *
 * The current implementation covers class-typed arguments (value, pointer,
 * and reference) and template specializations with explicit type arguments:
 *   - `audit::Event e`, `audit::Event* p`, `audit::Event** pp`
 *   - `audit::Event& r`, `audit::Event&& rr`
 *   - `std::vector<audit::Event>` (template namespace + template-arg namespaces)
 *
 * V2 additionally walks class ancestors (via MRO), so base-class enclosing
 * namespaces also contribute associated namespaces.
 *
 * Function-reference arguments follow ISO C++ `[basic.lookup.argdep]`:
 * associated entities come from the parameter types and return type of each
 * referenced function in the overload set, not from the function's enclosing
 * namespace. For `void worker()`, the associated set is empty. For
 * `void worker(api::Token)` or `api::Token make_token()`, `api` is associated
 * through `Token`.
 *
 * For qualified refs (e.g. `utils::worker`) the workspace lookup is restricted
 * to functions/methods named `worker` in `utils`; for unqualified refs the
 * workspace is searched for matching functions/methods by simple name. Locally
 * declared function-pointer variables and function parameters are excluded
 * from this path.
 *
 * ADL candidates are merged with ordinary unqualified-lookup candidates
 * in the free-call fallback before overload narrowing.
 *
 * ## Parenthesized-name suppression
 *
 * `(f)(s)` MUST NOT trigger ADL — the parenthesized name forces ordinary
 * lookup only. `captures.ts` records sites whose `function` child is a
 * `parenthesized_expression` into `noAdlSites`; `pickCppAdlCandidates`
 * short-circuits when the site key is present.
 *
 * ## State lifecycle
 *
 * Five pieces of module-level state populated per pipeline invocation, all
 * reset together by `clearCppAdlState()` (called from
 * `cppScopeResolver.loadResolutionConfig`, alongside `clearFileLocalNames` —
 * NOT from `clearFileLocalNames` itself), grouped by when they fill:
 *
 *   - `argInfoBySite` — per-call-site argument shape (capture-time)
 *   - `noAdlSites` — call sites with parenthesized function (capture-time)
 *   - `classToNamespaceQualifiedName` — class def → its enclosing namespace
 *     qualified name (`populateCppAssociatedNamespaces` time)
 *   - `adlIndex` / `adlIndexSource` — the lazily-built candidate index and the
 *     `parsedFiles` reference it was built from (first-`pickCppAdlCandidates`
 *     time; see `ensureAdlIndex`)
 *
 * The class→namespace map uses qualified names (not scope IDs) because
 * C++ namespaces are open: `namespace N { ... }` in file A and
 * `namespace N { ... }` in file B produce two distinct Namespace scopes
 * but logically share the same namespace. ADL must consider candidates
 * declared in either file.
 */

import type { ParsedFile, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { normalizeCppParamType } from './arity-metadata.js';
import { isCppInlineNamespaceScope } from './inline-namespaces.js';

/**
 * Per-argument shape information collected at capture time. ADL fires for
 * arguments where `simpleClassName !== ''`, including class pointers and
 * references whose declarator chain resolves to a named class type.
 * Free-function reference arguments use `functionRefText`.
 */
export interface CppAdlArgInfo {
  /** Simple class-like type name (last segment of qualified name); empty
   *  for primitives, literals, function pointers, etc. */
  readonly simpleClassName: string;
  /** Template's own simple class-like name (e.g. `vector` for
   *  `std::vector<N::T>`), empty when arg type is not a template spec. */
  readonly templateSimpleClassName: string;
  /** Template's own enclosing namespace (dot-qualified, e.g. `std`), empty
   *  when unavailable / unqualified. */
  readonly templateNamespace: string;
  /** Class-like names extracted from explicit type template arguments,
   *  recursively bounded. */
  readonly templateArgClassNames: readonly string[];
  /** Enclosing namespaces extracted from explicit type template arguments,
   *  recursively bounded. */
  readonly templateArgNamespaces: readonly string[];
  /** When set, the arg is a potential free-function reference (not a locally-
   *  declared function-pointer variable or function parameter). Contains the
   *  identifier text as written in source (e.g. `"utils::worker"` or
   *  `"worker"`). Resolution contributes associated namespaces from each
   *  referenced Function/Method def's parameter and return types. */
  readonly functionRefText?: string;
}

const argInfoBySite = new Map<string, readonly CppAdlArgInfo[]>();
const noAdlSites = new Set<string>();
const classToNamespaceQualifiedName = new Map<string, string>();

/**
 * Per-`filePath` index of the site keys this file contributed to
 * `argInfoBySite` / `noAdlSites`, kept in **strict lockstep** with those two
 * maps (#1983 perf). Without it, `collectCppAdlSideChannel(filePath)` had to
 * scan the ENTIRE module-level maps (every site of every file the worker
 * parsed in the current sub-batch) and `parseSiteKey` each entry just to pick
 * out one file's slice — O(F²) per sub-batch (~100M `parseSiteKey` calls
 * across the Linux kernel). These indexes turn collect into
 * O(entries-for-this-file).
 *
 * Lockstep invariant: a key is pushed here at most once, exactly when it is
 * first inserted into the corresponding map, and both indexes are cleared
 * wherever `argInfoBySite` / `noAdlSites` are cleared (`clearCppAdlState` and
 * the per-file restore in `applyCppAdlSideChannel`). The "first insert only"
 * guard mirrors the maps' own de-dup (`Map.set` / `Set.add` are idempotent on
 * the key), so iterating an index yields each of this file's keys exactly once
 * — byte-identical to the old filtered full scan.
 */
const argInfoSiteKeysByFile = new Map<string, string[]>();
const noAdlSiteKeysByFile = new Map<string, string[]>();

/** Push `key` into the per-file index `idx[filePath]` (creating the bucket on
 *  first use). Callers guard against duplicate keys so each key appears once. */
function pushFileSiteKey(idx: Map<string, string[]>, filePath: string, key: string): void {
  let keys = idx.get(filePath);
  if (keys === undefined) {
    keys = [];
    idx.set(filePath, keys);
  }
  keys.push(key);
}

/**
 * ADL candidate index — built **once** per pipeline run from
 * `(scopes, parsedFiles)` and reused by every call site.
 *
 * The legacy `pickCppAdlCandidates` re-scanned all parsed files (rebuilding a
 * per-file `scopesById` map each time), all workspace defs (for the
 * class-by-simple-name lookup), and used an O(scopes²) child-scope walk for
 * hidden friends — once **per unresolved call site**. With hundreds of
 * thousands of unresolved C++ sites that made the scope-resolution emit phase
 * super-linear (observed ~6.7h on a large repo). This index moves all of that
 * work to a single pass; per-site cost drops to O(associated namespaces).
 */
export interface AdlCandidateIndex {
  /** simple name → class-like defs (Class/Struct/Interface/Enum), preserving
   *  `scopes.defs.byId` iteration order so first-match / ambiguous semantics
   *  match the legacy linear scan. */
  readonly classDefsBySimple: Map<string, SymbolDefinition[]>;
  /** namespace QName → simple name → callable defs owned by that namespace,
   *  with inline-namespace transparency (inline-ns defs are also registered
   *  under the parent namespace's QName). */
  readonly nsCandidates: Map<string, Map<string, SymbolDefinition[]>>;
  /** associated-class enclosing-namespace QName → simple name → hidden-friend
   *  and class-member callable defs. */
  readonly friendCandidates: Map<string, Map<string, SymbolDefinition[]>>;
  /** namespace QName (own) → simple name → Function/Method defs, for the
   *  qualified function-reference ADL path. */
  readonly nsFunctionsByQName: Map<string, Map<string, SymbolDefinition[]>>;
  /** simple name → Function/Method defs across all namespaces, for the
   *  unqualified function-reference ADL path. */
  readonly nsFunctionsBySimple: Map<string, SymbolDefinition[]>;
  /** nodeId → visitation sequence number, used to merge per-namespace buckets
   *  back into the exact legacy candidate order (file-major; namespace defs
   *  before friend/member defs within a file). */
  readonly seqByNodeId: Map<string, number>;
}

let adlIndex: AdlCandidateIndex | undefined;
let adlIndexSource: readonly ParsedFile[] | undefined;

function siteKey(filePath: string, line: number, col: number): string {
  return `${filePath}:${line}:${col}`;
}

/** Last segment of a dotted qualified name (matches legacy inline expression). */
function adlSimpleName(def: SymbolDefinition): string {
  return def.qualifiedName?.split('.').pop() ?? def.qualifiedName ?? '';
}

function isAdlCallableType(type: string): boolean {
  return type === 'Function' || type === 'Method' || type === 'Constructor';
}

function pushNested(
  map: Map<string, Map<string, SymbolDefinition[]>>,
  outerKey: string,
  innerKey: string,
  def: SymbolDefinition,
): void {
  let inner = map.get(outerKey);
  if (inner === undefined) {
    inner = new Map();
    map.set(outerKey, inner);
  }
  let arr = inner.get(innerKey);
  if (arr === undefined) {
    arr = [];
    inner.set(innerKey, arr);
  }
  arr.push(def);
}

function pushFlat(map: Map<string, SymbolDefinition[]>, key: string, def: SymbolDefinition): void {
  let arr = map.get(key);
  if (arr === undefined) {
    arr = [];
    map.set(key, arr);
  }
  arr.push(def);
}

/** Build the ADL candidate index in a single pass over the workspace. The
 *  visitation order (file-major; per file, all namespace scopes before all
 *  class scopes; ownedDefs in declaration order) mirrors the legacy push
 *  order so `seqByNodeId` reconstructs identical candidate ordering. */
function buildAdlIndex(
  scopes: ScopeResolutionIndexes,
  parsedFiles: readonly ParsedFile[],
): AdlCandidateIndex {
  const idx: AdlCandidateIndex = {
    classDefsBySimple: new Map(),
    nsCandidates: new Map(),
    friendCandidates: new Map(),
    nsFunctionsByQName: new Map(),
    nsFunctionsBySimple: new Map(),
    seqByNodeId: new Map(),
  };

  // (1) class-like defs by simple name — preserve byId order so arr[0] is the
  //     legacy `firstMatch` and `arr.length > 1` is the legacy `ambiguous`.
  for (const def of scopes.defs.byId.values()) {
    if (
      def.type !== 'Class' &&
      def.type !== 'Struct' &&
      def.type !== 'Interface' &&
      def.type !== 'Enum'
    )
      continue;
    pushFlat(idx.classDefsBySimple, adlSimpleName(def), def);
  }

  let seq = 0;
  for (const parsed of parsedFiles) {
    const scopesById = new Map<ScopeId, (typeof parsed.scopes)[number]>();
    for (const sc of parsed.scopes) scopesById.set(sc.id, sc);
    // parent → children, built once (replaces the legacy O(scopes²) walk).
    const childrenByParent = new Map<ScopeId, (typeof parsed.scopes)[number][]>();
    for (const sc of parsed.scopes) {
      if (sc.parent === null) continue;
      let kids = childrenByParent.get(sc.parent);
      if (kids === undefined) {
        kids = [];
        childrenByParent.set(sc.parent, kids);
      }
      kids.push(sc);
    }

    // PASS A — namespace-owned candidates (+ function-reference indexes).
    for (const scope of parsed.scopes) {
      if (scope.kind !== 'Namespace') continue;
      const qName = computeNamespaceQName(scope, scopesById);
      // Registration keys reproduce the legacy membership test: own QName
      // always; for an inline namespace child of a Namespace, also the parent
      // QName (ISO C++ inline-namespace transparency for ADL).
      const keys: string[] = [];
      if (qName !== '') keys.push(qName);
      if (isCppInlineNamespaceScope(scope.id)) {
        const parentScope = scope.parent !== null ? scopesById.get(scope.parent) : undefined;
        if (parentScope !== undefined && parentScope.kind === 'Namespace') {
          const parentQName = computeNamespaceQName(parentScope, scopesById);
          if (parentQName !== '' && parentQName !== qName) keys.push(parentQName);
        }
      }
      for (const def of scope.ownedDefs) {
        if (def.type === 'Function' || def.type === 'Method') {
          const sn = adlSimpleName(def);
          pushFlat(idx.nsFunctionsBySimple, sn, def);
          if (qName !== '') pushNested(idx.nsFunctionsByQName, qName, sn, def);
        }
        if (!isAdlCallableType(def.type)) continue;
        const s = seq++;
        idx.seqByNodeId.set(def.nodeId, s);
        const sn = adlSimpleName(def);
        for (const key of keys) pushNested(idx.nsCandidates, key, sn, def);
      }
    }

    // PASS B — hidden-friend + class-member candidates for associated classes.
    for (const scope of parsed.scopes) {
      if (scope.kind !== 'Class') continue;
      // Enclosing-namespace QName(s) of the class def(s) in this scope.
      const classNsKeys = new Set<string>();
      for (const def of scope.ownedDefs) {
        if (def.type !== 'Class' && def.type !== 'Struct' && def.type !== 'Interface') continue;
        const nsQName = classToNamespaceQualifiedName.get(def.nodeId);
        if (nsQName !== undefined) classNsKeys.add(nsQName);
      }
      if (classNsKeys.size === 0) continue;
      // Friend functions: callable defs in child Function scopes.
      for (const childScope of childrenByParent.get(scope.id) ?? []) {
        if (childScope.kind !== 'Function') continue;
        for (const def of childScope.ownedDefs) {
          if (!isAdlCallableType(def.type)) continue;
          const s = seq++;
          idx.seqByNodeId.set(def.nodeId, s);
          const sn = adlSimpleName(def);
          for (const key of classNsKeys) pushNested(idx.friendCandidates, key, sn, def);
        }
      }
      // Class-member callables.
      for (const def of scope.ownedDefs) {
        if (!isAdlCallableType(def.type)) continue;
        const s = seq++;
        idx.seqByNodeId.set(def.nodeId, s);
        const sn = adlSimpleName(def);
        for (const key of classNsKeys) pushNested(idx.friendCandidates, key, sn, def);
      }
    }
  }

  // Dev/test-only invariant guard: every def bucketed into nsCandidates/
  // friendCandidates must have a seqByNodeId entry, otherwise the `?? 0`
  // fallback in pickCppAdlCandidates could collapse two seq-0 candidates and
  // silently drop a CALLS edge. Gated like the rest of the resolver's opt-in
  // validation (see contract/scope-resolver.ts and reconcile-ownership.ts):
  // active in dev/test, off in production and when VALIDATE_SEMANTIC_MODEL=0.
  if (process.env.NODE_ENV !== 'production' && process.env.VALIDATE_SEMANTIC_MODEL !== '0') {
    const missing = validateAdlSeqCoverage(idx);
    if (missing.length > 0) {
      throw new Error(
        `[cpp-adl] seq-coverage invariant violated: ${missing.length} candidate def(s) ` +
          `bucketed without a seqByNodeId entry (e.g. ${missing.slice(0, 5).join(', ')}). ` +
          `Every def pushed into nsCandidates/friendCandidates must be seq-assigned in the ` +
          `same build block — see pickCppAdlCandidates' \`?? 0\` fallback.`,
      );
    }
  }

  return idx;
}

/**
 * Return the nodeIds present in the index's candidate buckets
 * (`nsCandidates` + `friendCandidates`) but missing from `seqByNodeId`, each
 * reported once. Empty array means the seq-coverage invariant holds — which it
 * must, since `buildAdlIndex` assigns a seq to every callable def in the same
 * block that buckets it. Exported for the dev-gated guard in `buildAdlIndex`
 * and its unit test.
 */
export function validateAdlSeqCoverage(idx: AdlCandidateIndex): string[] {
  const missing = new Set<string>();
  for (const buckets of [idx.nsCandidates, idx.friendCandidates]) {
    for (const bySimple of buckets.values()) {
      for (const defs of bySimple.values()) {
        for (const def of defs) {
          if (!idx.seqByNodeId.has(def.nodeId)) missing.add(def.nodeId);
        }
      }
    }
  }
  return [...missing];
}

/** Build the ADL index on first use of a given `parsedFiles` set; reuse it for
 *  all subsequent call sites in the same pipeline run. Reset by
 *  `clearCppAdlState`.
 *
 *  Staleness is keyed on `parsedFiles` reference identity ONLY, but the index
 *  is a function of THREE inputs: `parsedFiles` (namespace/friend candidates),
 *  `scopes` (`classDefsBySimple`, read from `scopes.defs.byId`), and the
 *  module-level `classToNamespaceQualifiedName` (friend-candidate keys). This
 *  is sound for the current pipeline because all three are built together once
 *  per `runScopeResolution` pass and `clearCppAdlState` runs in
 *  `loadResolutionConfig` at the start of every pass. Callers MUST call
 *  `clearCppAdlState` between any two passes that change `scopes` or
 *  `classToNamespaceQualifiedName` while reusing the same `parsedFiles` array
 *  reference — otherwise a stale index would be served. (No such caller exists
 *  today; widening the guard to also key on `scopes` is deferred until one
 *  does.) */
function ensureAdlIndex(scopes: ScopeResolutionIndexes, parsedFiles: readonly ParsedFile[]): void {
  if (adlIndex !== undefined && adlIndexSource === parsedFiles) return;
  adlIndex = buildAdlIndex(scopes, parsedFiles);
  adlIndexSource = parsedFiles;
}

/** Record per-call-site argument info. Called once per call site from
 *  `emitCppScopeCaptures`. */
export function markCppAdlSiteArgs(
  filePath: string,
  line: number,
  col: number,
  args: readonly CppAdlArgInfo[],
): void {
  const key = siteKey(filePath, line, col);
  // Lockstep with `argInfoSiteKeysByFile`: index the key only on first insert
  // (a re-mark overwrites the value but must NOT duplicate the index entry).
  if (!argInfoBySite.has(key)) pushFileSiteKey(argInfoSiteKeysByFile, filePath, key);
  argInfoBySite.set(key, args);
}

/** Mark a call site as ADL-suppressed (function child wrapped in
 *  `parenthesized_expression`, e.g. `(f)(s)`). */
export function markCppAdlSiteNoAdl(filePath: string, line: number, col: number): void {
  const key = siteKey(filePath, line, col);
  // Lockstep with `noAdlSiteKeysByFile`: index the key only on first insert.
  if (!noAdlSites.has(key)) pushFileSiteKey(noAdlSiteKeysByFile, filePath, key);
  noAdlSites.add(key);
}

/**
 * Plain-data, JSON-serializable snapshot of the per-file ADL capture state
 * (`argInfoBySite` entries for this file + `noAdlSites` keys for this file).
 * Carried on `ParsedFile.captureSideChannel` across the worker→main boundary
 * (#1983); the call-site key's `line:col` are stored per-entry so the full
 * `filePath:line:col` key can be reconstructed without parsing.
 */
export interface CppAdlSideChannel {
  /** Per-call-site arg info: `[line, col, args]` for sites in this file. */
  readonly argInfoBySite: readonly [number, number, readonly CppAdlArgInfo[]][];
  /** ADL-suppressed sites in this file: `[line, col]`. */
  readonly noAdlSites: readonly [number, number][];
}

const SITE_KEY_RE = /^(.*):(\d+):(\d+)$/;

/** Split a `filePath:line:col` site key, tolerating colons in the path. */
function parseSiteKey(key: string): { filePath: string; line: number; col: number } | undefined {
  const m = SITE_KEY_RE.exec(key);
  if (m === null) return undefined;
  return { filePath: m[1], line: Number(m[2]), col: Number(m[3]) };
}

/**
 * Snapshot this file's ADL capture state for the worker→main side-channel.
 *
 * Uses the per-file `argInfoSiteKeysByFile` / `noAdlSiteKeysByFile` indexes to
 * touch only THIS file's entries — O(entries-for-this-file) — instead of the
 * old O(all-entries) full scan over `argInfoBySite` / `noAdlSites` (#1983).
 * The output order, and therefore the serialized JSON shape, is byte-identical
 * to the old filtered scan: the index records keys in the same insertion order
 * the maps' own iteration would have yielded for this file, and each key is
 * indexed exactly once (mark guards on first insert), so the same per-file
 * subsequence is produced.
 *
 * `parseSiteKey` is still used to recover `line:col` from each key, but now
 * only for this file's keys (a bounded handful), never for the whole batch.
 */
export function collectCppAdlSideChannel(filePath: string): CppAdlSideChannel {
  const args: [number, number, readonly CppAdlArgInfo[]][] = [];
  for (const key of argInfoSiteKeysByFile.get(filePath) ?? []) {
    const value = argInfoBySite.get(key);
    const parsed = parseSiteKey(key);
    if (value !== undefined && parsed !== undefined) {
      args.push([parsed.line, parsed.col, value]);
    }
  }
  const noAdl: [number, number][] = [];
  for (const key of noAdlSiteKeysByFile.get(filePath) ?? []) {
    const parsed = parseSiteKey(key);
    if (parsed !== undefined) {
      noAdl.push([parsed.line, parsed.col]);
    }
  }
  return { argInfoBySite: args, noAdlSites: noAdl };
}

/** Restore this file's ADL capture state from the side-channel (no parse).
 *  Keeps the per-file site-key indexes in lockstep with `argInfoBySite` /
 *  `noAdlSites` (first-insert-only) so a later `collectCppAdlSideChannel` on
 *  the same process would still produce a correct, duplicate-free snapshot. */
export function applyCppAdlSideChannel(filePath: string, data: CppAdlSideChannel): void {
  for (const [line, col, value] of data.argInfoBySite) {
    const key = siteKey(filePath, line, col);
    if (!argInfoBySite.has(key)) pushFileSiteKey(argInfoSiteKeysByFile, filePath, key);
    argInfoBySite.set(key, value);
  }
  for (const [line, col] of data.noAdlSites) {
    const key = siteKey(filePath, line, col);
    if (!noAdlSites.has(key)) pushFileSiteKey(noAdlSiteKeysByFile, filePath, key);
    noAdlSites.add(key);
  }
}

/** Clear ADL state. Called from `cppScopeResolver.loadResolutionConfig`
 *  (alongside `clearFileLocalNames`) so all C++ resolver per-pipeline state is
 *  reset together at the start of each resolution pass. */
export function clearCppAdlState(): void {
  argInfoBySite.clear();
  noAdlSites.clear();
  // Lockstep: the per-file site-key indexes mirror argInfoBySite/noAdlSites and
  // MUST be cleared together — a stale index would resurrect a prior pass's
  // (or prior file's, after a re-key) keys into the next snapshot.
  argInfoSiteKeysByFile.clear();
  noAdlSiteKeysByFile.clear();
  classToNamespaceQualifiedName.clear();
  adlIndex = undefined;
  adlIndexSource = undefined;
}

/**
 * Walk `parsed.scopes` to record each Class def's enclosing namespace
 * qualified name. Run from the cpp resolver's `populateOwners` hook so
 * the index is available before any resolution pass consults it.
 *
 * Computes the namespace's qualified name by walking parent scope chain
 * and looking up Namespace defs in each parent's `ownedDefs`. The
 * resulting name is dot-joined (matching `populateClassOwnedMembers`'s
 * dotted convention; conversion to `::` is consumer-internal).
 */
export function populateCppAssociatedNamespaces(parsed: ParsedFile): void {
  const scopesById = new Map<ScopeId, (typeof parsed.scopes)[number]>();
  for (const scope of parsed.scopes) scopesById.set(scope.id, scope);

  for (const scope of parsed.scopes) {
    if (scope.kind !== 'Class') continue;
    const nsQName = computeEnclosingNamespaceQName(scope, scopesById);
    if (nsQName === '') continue;
    for (const def of scope.ownedDefs) {
      if (def.type !== 'Class' && def.type !== 'Struct' && def.type !== 'Interface') continue;
      classToNamespaceQualifiedName.set(def.nodeId, nsQName);
    }
  }

  // Enum defs live in Namespace scopes directly (not inside Class scopes).
  // Map each Enum def to its enclosing namespace so ADL on enum-typed
  // arguments contributes the correct associated namespace.
  for (const scope of parsed.scopes) {
    if (scope.kind !== 'Namespace') continue;
    const nsQName = computeNamespaceQName(scope, scopesById);
    if (nsQName === '') continue;
    for (const def of scope.ownedDefs) {
      if (def.type !== 'Enum') continue;
      classToNamespaceQualifiedName.set(def.nodeId, nsQName);
    }
  }
}

/**
 * ADL candidate collector. Returns:
 *   - `readonly SymbolDefinition[]` — ADL candidates to merge with
 *     ordinary unqualified lookup candidates.
 *   - `undefined` — no ADL candidates.
 *
 * Fires only when:
 *   - the call site is not in `noAdlSites` (parenthesized form), AND
 *   - at least one argument resolves to a named class type (value,
 *     pointer, or reference; but not function pointer, literal, or primitive).
 */
export function pickCppAdlCandidates(
  site: {
    readonly name: string;
    readonly atRange: { startLine: number; startCol: number };
  },
  callerParsed: ParsedFile,
  scopes: ScopeResolutionIndexes,
  parsedFiles: readonly ParsedFile[],
): readonly SymbolDefinition[] | undefined {
  const key = siteKey(callerParsed.filePath, site.atRange.startLine, site.atRange.startCol);
  if (noAdlSites.has(key)) return undefined;
  const args = argInfoBySite.get(key);
  if (args === undefined || args.length === 0) return undefined;

  // Build the workspace-wide ADL candidate index once; reuse for every site.
  ensureAdlIndex(scopes, parsedFiles);

  // Collect associated namespace QNames from every participating class-typed arg
  // and from function-reference args.
  const associatedNamespaces = new Set<string>();
  for (const arg of args) {
    collectAssociatedNamespacesForAdlArg(arg, scopes, associatedNamespaces);
    if (arg.functionRefText !== undefined) {
      collectFunctionTypeAssociatedNamespaces(arg.functionRefText, scopes, associatedNamespaces);
    }
  }
  if (associatedNamespaces.size === 0) return undefined;

  // Gather candidates from the prebuilt index instead of re-scanning every
  // parsed file. For each associated namespace, pull:
  //   - namespace-owned callables (`nsCandidates`, includes inline-namespace
  //     transparency), AND
  //   - hidden-friend / class-member callables of associated classes
  //     (`friendCandidates`, ISO C++ `[basic.lookup.argdep]` §2).
  // Dedup by nodeId and sort by visitation sequence so the candidate list is
  // byte-for-byte identical to the legacy file-major scan order.
  const idx = adlIndex;
  if (idx === undefined) return undefined;
  const bySeq = new Map<number, SymbolDefinition>();
  const seenKey = new Set<string>();
  const collectFrom = (buckets: Map<string, Map<string, SymbolDefinition[]>>): void => {
    for (const ns of associatedNamespaces) {
      const matches = buckets.get(ns)?.get(site.name);
      if (matches === undefined) continue;
      for (const def of matches) {
        if (seenKey.has(def.nodeId)) continue;
        seenKey.add(def.nodeId);
        // `?? 0` is unreachable: every bucketed def is seq-assigned in the same
        // block that buckets it in buildAdlIndex (PASS A / PASS B). The dev-gated
        // validateAdlSeqCoverage guard in buildAdlIndex fails loudly if that ever
        // breaks, rather than letting two seq-0 defs collide and drop a candidate.
        bySeq.set(idx.seqByNodeId.get(def.nodeId) ?? 0, def);
      }
    }
  };
  collectFrom(idx.nsCandidates);
  collectFrom(idx.friendCandidates);
  if (bySeq.size === 0) return undefined;
  return [...bySeq.entries()].sort((a, b) => a[0] - b[0]).map(([, def]) => def);
}

function collectAssociatedNamespacesForAdlArg(
  arg: CppAdlArgInfo,
  scopes: ScopeResolutionIndexes,
  associatedNamespaces: Set<string>,
): void {
  // For template args this may be the template name itself (e.g. `vector`);
  // simple-name lookup can match project classes with the same name (known
  // V1/V2 simplification).
  addAssociatedNamespaceForClassName(arg.simpleClassName, scopes, associatedNamespaces);

  // Includes template-owner namespaces (e.g. `std` in std::vector<T>). If
  // that surfaces extra candidates, merged-candidate overload narrowing in
  // free-call-fallback suppresses arbitrary edge emission.
  if (arg.templateNamespace.length > 0) associatedNamespaces.add(arg.templateNamespace);

  for (const ns of arg.templateArgNamespaces) {
    if (ns.length > 0) associatedNamespaces.add(ns);
  }
  for (const className of arg.templateArgClassNames) {
    addAssociatedNamespaceForClassName(className, scopes, associatedNamespaces);
  }
}

function addAssociatedNamespaceForClassName(
  simpleClassName: string,
  scopes: ScopeResolutionIndexes,
  associatedNamespaces: Set<string>,
): void {
  if (simpleClassName.length === 0) return;
  const classLookup = findCppClassDefBySimpleName(simpleClassName);
  if (classLookup === undefined) return;
  const { classDef, ambiguous } = classLookup;
  const nsQName = classToNamespaceQualifiedName.get(classDef.nodeId);
  if (nsQName !== undefined) associatedNamespaces.add(nsQName);
  // Preserve V1 collision behavior for the direct class namespace, but avoid
  // amplifying a same-simple-name collision by walking an arbitrary class's
  // full MRO chain.
  if (ambiguous) return;
  for (const ancestorDefId of scopes.methodDispatch.mroFor(classDef.nodeId)) {
    const ancestorNsQName = classToNamespaceQualifiedName.get(ancestorDefId);
    if (ancestorNsQName !== undefined) associatedNamespaces.add(ancestorNsQName);
  }
}

/** Walk upward from a Class scope, finding the innermost enclosing
 *  Namespace scope, and return that namespace's qualified name (dot-
 *  joined, outermost-first). Returns '' when the class has no enclosing
 *  namespace (e.g., declared at translation-unit scope). */
function computeEnclosingNamespaceQName(
  classScope: { readonly parent: ScopeId | null },
  scopesById: ReadonlyMap<
    ScopeId,
    {
      readonly parent: ScopeId | null;
      readonly kind: string;
      readonly ownedDefs: readonly SymbolDefinition[];
    }
  >,
): string {
  let parentId: ScopeId | null = classScope.parent;
  while (parentId !== null) {
    const parent = scopesById.get(parentId);
    if (parent === undefined) return '';
    if (parent.kind === 'Namespace') {
      return computeNamespaceQName(parent, scopesById);
    }
    parentId = parent.parent;
  }
  return '';
}

/** Walk upward from a Namespace scope collecting each enclosing
 *  Namespace's simple name (innermost last). Returns the dot-joined
 *  qualified name (e.g., `outer.inner`). The namespace's own def lives
 *  in its OWN scope's `ownedDefs` (the C++ extractor stamps the
 *  namespace-decl def into the namespace scope itself, not the parent
 *  module scope). */
function computeNamespaceQName(
  nsScope: { readonly parent: ScopeId | null; readonly ownedDefs: readonly SymbolDefinition[] },
  scopesById: ReadonlyMap<
    ScopeId,
    {
      readonly parent: ScopeId | null;
      readonly kind: string;
      readonly ownedDefs: readonly SymbolDefinition[];
    }
  >,
): string {
  const segments: string[] = [];
  let currentId: ScopeId | null = nsScope.parent;
  let current:
    | { readonly parent: ScopeId | null; readonly ownedDefs: readonly SymbolDefinition[] }
    | undefined = nsScope;
  // Outer guard against pathological cycles in malformed scope trees.
  let safety = 64;
  while (current !== undefined && safety-- > 0) {
    const nsDef = findNamespaceDefInScope(current);
    if (nsDef === undefined) {
      // No name found — bail out. Returning a partial QName would risk
      // false ADL associations.
      return '';
    }
    const simple = nsDef.qualifiedName?.split('.').pop() ?? nsDef.qualifiedName ?? '';
    segments.unshift(simple);
    // Walk up to next enclosing namespace (skipping non-namespace parents).
    let nextId: ScopeId | null = currentId;
    let nextNs: typeof current | undefined;
    while (nextId !== null) {
      const nx = scopesById.get(nextId);
      if (nx === undefined) break;
      if (nx.kind === 'Namespace') {
        nextNs = nx;
        currentId = nx.parent;
        break;
      }
      nextId = nx.parent;
    }
    current = nextNs;
  }
  return segments.join('.');
}

/** Find the Namespace def attached to this scope (the namespace's own
 *  decl, stamped into its own `ownedDefs` by the C++ extractor). Returns
 *  the first Namespace-type def encountered — for normal C++ the scope
 *  carries exactly one Namespace-typed self def. */
function findNamespaceDefInScope(scope: {
  readonly ownedDefs: readonly SymbolDefinition[];
}): SymbolDefinition | undefined {
  for (const def of scope.ownedDefs) {
    if (def.type === 'Namespace') return def;
  }
  return undefined;
}

/** Find a class-like or enum def by simple name across the workspace.
 *  V1 still arbitrary-picks the first match on collisions (multiple defs
 *  share the simple name), but reports the collision so callers can avoid
 *  amplifying that uncertainty (for example by skipping MRO expansion).
 *  C++ ADL strictness would require full type-driven lookup.
 *
 *  ISO C++ `[basic.lookup.argdep]` §2: enumerations contribute their
 *  enclosing namespace to the associated set, just like class types. */
function findCppClassDefBySimpleName(
  simpleName: string,
): { classDef: SymbolDefinition; ambiguous: boolean } | undefined {
  // `classDefsBySimple` preserves `scopes.defs.byId` order, so `[0]` is the
  // legacy first-match and `length > 1` is the legacy `ambiguous` flag.
  const matches = adlIndex?.classDefsBySimple.get(simpleName);
  if (matches === undefined) return undefined;
  const first = matches[0];
  if (first === undefined) return undefined;
  return { classDef: first, ambiguous: matches.length > 1 };
}

/**
 * Contribute associated namespaces for a function-reference argument by walking
 * the referenced overload set's parameter and return types.
 */
function collectFunctionTypeAssociatedNamespaces(
  refText: string,
  scopes: ScopeResolutionIndexes,
  out: Set<string>,
): void {
  const idx = adlIndex;
  if (idx === undefined) return;
  const colonIdx = refText.lastIndexOf('::');
  if (colonIdx !== -1) {
    // Qualified ref: extract namespace prefix and normalise :: → dot notation.
    const nsText = refText.slice(0, colonIdx).replace(/::/g, '.');
    if (nsText === '') return;
    const simpleName = refText.slice(colonIdx + 2);
    // Only Function/Method defs named `simpleName` in `nsText` contribute
    // (the index already restricts to those types); this guards against an
    // `a::b` arg that names a variable / enum value / type alias blindly
    // contributing `a` to the associated set (false-positive CALLS edge).
    const matches = idx.nsFunctionsByQName.get(nsText)?.get(simpleName);
    if (matches !== undefined) {
      for (const def of matches) collectAssociatedNamespacesForFunctionDef(def, scopes, out);
    }
    return;
  }

  // Unqualified function references are approximated workspace-wide, matching
  // the previous V1 lookup scope. The stricter part of this PR is what each
  // overload contributes: only namespaces from parameter/return types, never
  // the function's own enclosing namespace.
  const matches = idx.nsFunctionsBySimple.get(refText);
  if (matches !== undefined) {
    for (const def of matches) collectAssociatedNamespacesForFunctionDef(def, scopes, out);
  }
}

function collectAssociatedNamespacesForFunctionDef(
  def: SymbolDefinition,
  scopes: ScopeResolutionIndexes,
  out: Set<string>,
): void {
  const parameterTypes = def.parameterTypeClasses?.map((typeClass) => typeClass.base);
  for (const paramType of parameterTypes ?? def.parameterTypes ?? []) {
    collectAssociatedNamespacesForFunctionTypeText(paramType, scopes, out);
  }
  if (def.returnType !== undefined) {
    collectAssociatedNamespacesForFunctionTypeText(def.returnType, scopes, out);
  }
}

function collectAssociatedNamespacesForFunctionTypeText(
  typeText: string,
  scopes: ScopeResolutionIndexes,
  out: Set<string>,
): void {
  for (const token of extractCppTypeNameTokens(typeText)) {
    if (isIgnoredCppAdlNamespace(token.namespaceName)) continue;
    addAssociatedNamespaceForClassName(token.simpleName, scopes, out);
    if (token.namespaceName !== '') out.add(token.namespaceName);
  }
}

function extractCppTypeNameTokens(typeText: string): readonly {
  readonly simpleName: string;
  readonly namespaceName: string;
}[] {
  const cleaned = normalizeCppParamType(typeText);
  if (cleaned === '' || isPrimitiveCppAdlType(cleaned)) return [];
  const out: { simpleName: string; namespaceName: string }[] = [];
  const seen = new Set<string>();
  const tokenSource = typeText.includes('<') ? `${cleaned} ${typeText}` : cleaned;
  for (const rawToken of tokenSource.match(/[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*/g) ?? []) {
    if (isPrimitiveCppAdlType(rawToken)) continue;
    const segments = rawToken.split('::').filter((part) => part.length > 0);
    const simpleName = segments.at(-1) ?? '';
    if (simpleName === '' || isPrimitiveCppAdlType(simpleName)) continue;
    const namespaceName = segments.length > 1 ? segments.slice(0, -1).join('.') : '';
    const key = `${namespaceName}\0${simpleName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      simpleName,
      namespaceName,
    });
  }
  return out;
}

const CPP_ADL_PRIMITIVE_OR_KEYWORD_TYPES = new Set<string>([
  'alignas',
  'alignof',
  'auto',
  'bool',
  'char',
  'char8_t',
  'char16_t',
  'char32_t',
  'class',
  'const',
  'consteval',
  'constexpr',
  'constinit',
  'decltype',
  'double',
  'enum',
  'explicit',
  'extern',
  'float',
  'inline',
  'int',
  'long',
  'mutable',
  'noexcept',
  'null',
  'register',
  'short',
  'signed',
  'static',
  'string',
  'struct',
  'template',
  'thread_local',
  'typename',
  'union',
  'unknown',
  'unsigned',
  'void',
  'volatile',
  'wchar_t',
  '...',
]);

function isPrimitiveCppAdlType(typeText: string): boolean {
  return CPP_ADL_PRIMITIVE_OR_KEYWORD_TYPES.has(typeText);
}

function isIgnoredCppAdlNamespace(namespaceName: string): boolean {
  return namespaceName === 'std' || namespaceName.startsWith('std.');
}
