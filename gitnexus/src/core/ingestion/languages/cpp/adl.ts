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
 * The current implementation covers ONE associated-entity rule: an argument that's a directly-named
 * class type (`audit::Event e`) contributes its **direct enclosing
 * namespace** to the candidate set. V2 extends that one step to
 * pointer-typed class args (`audit::Event* p`, `audit::Event** pp`):
 * they contribute the pointee class's enclosing namespace too. Reference
 * arguments, function-pointer arguments, template specializations,
 * base-class associated namespaces, and the rest of the full closure are
 * still deliberately excluded.
 *
 * The current implementation also short-circuits to ADL only when ordinary lookup is empty
 * (`findCallableBindingInScope` returned undefined). ISO C++ would
 * normally merge ADL candidates with ordinary-lookup candidates and
 * run overload resolution over the union; V1 defers that merge to V2.
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
 * Three module-level maps populated per pipeline invocation, cleared via
 * `clearCppAdlState()` (called from `clearFileLocalNames`):
 *
 *   - `argInfoBySite` — per-call-site argument shape (capture-time)
 *   - `noAdlSites` — call sites with parenthesized function (capture-time)
 *   - `classToNamespaceQualifiedName` — class def → its enclosing namespace
 *     qualified name (`populateCppAssociatedNamespaces` time)
 *
 * The class→namespace map uses qualified names (not scope IDs) because
 * C++ namespaces are open: `namespace N { ... }` in file A and
 * `namespace N { ... }` in file B produce two distinct Namespace scopes
 * but logically share the same namespace. ADL must consider candidates
 * declared in either file.
 */

import type { ParsedFile, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import {
  isOverloadAmbiguousAfterNormalization,
  narrowOverloadCandidates,
} from '../../scope-resolution/passes/overload-narrowing.js';

/**
 * Per-argument shape information collected at capture time. ADL fires for
 * arguments where `simpleClassName !== ''` AND `!isReference`, including
 * class pointers whose declarator chain resolves to a named class type.
 */
export interface CppAdlArgInfo {
  /** Simple class-like type name (last segment of qualified name); empty
   *  for primitives, literals, function pointers, template specs, etc. */
  readonly simpleClassName: string;
  /** True when the variable's declarator contained one or more
   *  `pointer_declarator` wrappers. */
  readonly isPointer: boolean;
  /** True when the variable's declarator was a `reference_declarator`. */
  readonly isReference: boolean;
}

const argInfoBySite = new Map<string, readonly CppAdlArgInfo[]>();
const noAdlSites = new Set<string>();
const classToNamespaceQualifiedName = new Map<string, string>();

/** Sentinel returned by `pickCppAdlCandidates` when ADL surfaces multiple
 *  candidates that share normalized parameter types — the caller MUST
 *  suppress (zero edges) rather than pick arbitrarily. Mirrors the
 *  OVERLOAD_AMBIGUOUS contract from the receiver-bound path. */
export const ADL_AMBIGUOUS = Symbol('ADL_AMBIGUOUS');
export type AdlResult = SymbolDefinition | typeof ADL_AMBIGUOUS | undefined;

function siteKey(filePath: string, line: number, col: number): string {
  return `${filePath}:${line}:${col}`;
}

/** Record per-call-site argument info. Called once per call site from
 *  `emitCppScopeCaptures`. */
export function markCppAdlSiteArgs(
  filePath: string,
  line: number,
  col: number,
  args: readonly CppAdlArgInfo[],
): void {
  argInfoBySite.set(siteKey(filePath, line, col), args);
}

/** Mark a call site as ADL-suppressed (function child wrapped in
 *  `parenthesized_expression`, e.g. `(f)(s)`). */
export function markCppAdlSiteNoAdl(filePath: string, line: number, col: number): void {
  noAdlSites.add(siteKey(filePath, line, col));
}

/** Clear ADL state. Called from `clearFileLocalNames` so all C++ resolver
 *  per-pipeline state is reset together. */
export function clearCppAdlState(): void {
  argInfoBySite.clear();
  noAdlSites.clear();
  classToNamespaceQualifiedName.clear();
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
}

/**
 * V1 ADL candidate picker. Returns:
 *   - `SymbolDefinition` — exactly one ADL candidate (or unique survivor
 *     after narrowing); caller emits the CALLS edge.
 *   - `ADL_AMBIGUOUS` — multiple candidates with no disambiguator;
 *     caller MUST suppress (zero edges).
 *   - `undefined` — no ADL candidates; caller falls through to ordinary
 *     `pickUniqueGlobalCallable` fallback.
 *
 * Fires only when:
 *   - the call site is not in `noAdlSites` (parenthesized form), AND
 *   - at least one argument resolves to a named class type (value or
 *     pointer, but not reference, function pointer, literal, or primitive).
 */
export function pickCppAdlCandidates(
  site: {
    readonly name: string;
    readonly arity?: number;
    readonly argumentTypes?: readonly string[];
    readonly atRange: { startLine: number; startCol: number };
  },
  callerParsed: ParsedFile,
  scopes: ScopeResolutionIndexes,
  parsedFiles: readonly ParsedFile[],
): AdlResult {
  const key = siteKey(callerParsed.filePath, site.atRange.startLine, site.atRange.startCol);
  if (noAdlSites.has(key)) return undefined;
  const args = argInfoBySite.get(key);
  if (args === undefined || args.length === 0) return undefined;

  // Collect associated namespace QNames from every participating class-typed arg.
  const associatedNamespaces = new Set<string>();
  for (const arg of args) {
    if (arg.simpleClassName === '') continue;
    if (arg.isReference) continue;
    const classDef = findCppClassDefBySimpleName(arg.simpleClassName, scopes);
    if (classDef === undefined) continue;
    const nsQName = classToNamespaceQualifiedName.get(classDef.nodeId);
    if (nsQName !== undefined) associatedNamespaces.add(nsQName);
  }
  if (associatedNamespaces.size === 0) return undefined;

  // Walk every namespace scope in every parsed file; collect callable
  // ownedDefs whose enclosing namespace matches one of the associated
  // QNames AND whose simple name matches the call's name.
  const candidates: SymbolDefinition[] = [];
  const seenKey = new Set<string>();
  for (const parsed of parsedFiles) {
    const scopesById = new Map<ScopeId, (typeof parsed.scopes)[number]>();
    for (const sc of parsed.scopes) scopesById.set(sc.id, sc);
    for (const scope of parsed.scopes) {
      if (scope.kind !== 'Namespace') continue;
      const qName = computeNamespaceQName(scope, scopesById);
      if (!associatedNamespaces.has(qName)) continue;
      for (const def of scope.ownedDefs) {
        if (def.type !== 'Function' && def.type !== 'Method' && def.type !== 'Constructor') {
          continue;
        }
        const simple = def.qualifiedName?.split('.').pop() ?? def.qualifiedName ?? '';
        if (simple !== site.name) continue;
        // Dedup by nodeId — using normalized parameter-types as the key
        // would collapse `process(int)`/`process(long)`-style overloads
        // (both normalize to `['int']`) before
        // `isOverloadAmbiguousAfterNormalization` can detect them.
        if (seenKey.has(def.nodeId)) continue;
        seenKey.add(def.nodeId);
        candidates.push(def);
      }
    }
  }
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  // Multi-candidate: narrow then check ambiguity. Reuses the OVERLOAD_AMBIGUOUS
  // sentinel contract from `overload-narrowing.ts` so int/long-collision-style
  // ambiguity also suppresses on the ADL path.
  const narrowed = narrowOverloadCandidates(candidates, site.arity, site.argumentTypes);
  if (narrowed.length === 1) return narrowed[0];
  if (narrowed.length === 0) return undefined;
  if (isOverloadAmbiguousAfterNormalization(narrowed, site.arity)) return ADL_AMBIGUOUS;
  // Multiple surviving candidates that aren't normalization-ambiguous —
  // ISO C++ would run overload resolution; V1 lacks conversion ranking so
  // suppress rather than pick arbitrarily. Mirrors `pickImplicitThisOverload`'s
  // unique-survivor requirement (see `pick-implicit-this-overload.test.ts`).
  return ADL_AMBIGUOUS;
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

/** Find a class-like def by simple name across the workspace. V1
 *  arbitrary-pick on collisions (multiple classes share the simple name);
 *  C++ ADL strictness would require full type-driven lookup, but V1
 *  trades that for simplicity. */
function findCppClassDefBySimpleName(
  simpleName: string,
  scopes: ScopeResolutionIndexes,
): SymbolDefinition | undefined {
  for (const def of scopes.defs.byId.values()) {
    if (def.type !== 'Class' && def.type !== 'Struct' && def.type !== 'Interface') continue;
    const simple = def.qualifiedName?.split('.').pop() ?? def.qualifiedName ?? '';
    if (simple === simpleName) return def;
  }
  return undefined;
}
