import type { ParsedFile, ScopeId, SymbolDefinition } from 'gitnexus-shared';

/**
 * Per-file set of function names declared with `static` storage class.
 * Populated during `emitCScopeCaptures` and consumed by `expandCWildcardNames`
 * to exclude file-local symbols from cross-file wildcard import visibility.
 *
 * NOTE: module-level state, single-process-single-repo use only.
 * For server-mode or multi-repo-in-one-process use cases, call
 * `clearStaticNames()` at the start of each resolution pass to avoid
 * stale static-linkage data from a previous invocation.
 *
 * Key: filePath, Value: Set of static function names.
 */
const staticNames = new Map<string, Set<string>>();

/** Record a symbol name as `static` (file-local linkage) for the given file. */
export function markStaticName(filePath: string, name: string): void {
  let names = staticNames.get(filePath);
  if (names === undefined) {
    names = new Set<string>();
    staticNames.set(filePath, names);
  }
  names.add(name);
}

/** Check whether a symbol name has `static` linkage in the given file. */
export function isStaticName(filePath: string, name: string): boolean {
  return staticNames.get(filePath)?.has(name) ?? false;
}

/**
 * Return the `static` (file-local) names recorded for the given file as a
 * plain array (empty when none). Used to snapshot the per-file slice of the
 * module-level `staticNames` map into `ParsedFile.captureSideChannel` so it
 * survives the worker→main boundary (#1983 — the worker is the sole parse
 * path). See `c/capture-side-channel.ts`.
 */
export function getStaticNamesForFile(filePath: string): string[] {
  const names = staticNames.get(filePath);
  return names === undefined ? [] : [...names];
}

/** Clear tracked static names (for testing). */
export function clearStaticNames(): void {
  staticNames.clear();
}

/**
 * Per-pass memo: `moduleScope` → owning `ParsedFile`, keyed on the
 * `parsedFiles` array identity.
 *
 * The shared finalize Phase-4 loop calls `expandsWildcardTo`
 * (→ `expandCWildcardNames`) ONCE PER RESOLVED `#include` edge, every time
 * with the SAME `parsedFiles` reference (wired at scope-resolution
 * `run.ts` — `allFilePaths`/`parsedFiles` are built once per pass). The old
 * `parsedFiles.find(...)` therefore did a full O(F) scan per edge →
 * O(R_include × F) overall; at Linux-kernel scale (F ≈ 63k C files, tens of
 * thousands of resolved includes) that is ~10^10+ comparisons on a single
 * thread — the dominant term in the scope-resolution finalize grind.
 *
 * Building the lookup once collapses it to O(R_include + F). `WeakMap`-keyed
 * on the array so the index is reclaimed with the pass — no cross-pass
 * staleness (mirrors the {@link clearStaticNames} discipline for server-mode
 * / multi-repo reuse), and a fresh array transparently rebuilds.
 */
const moduleScopeIndexByPass = new WeakMap<readonly ParsedFile[], Map<ScopeId, ParsedFile>>();

function moduleScopeIndex(parsedFiles: readonly ParsedFile[]): Map<ScopeId, ParsedFile> {
  let index = moduleScopeIndexByPass.get(parsedFiles);
  if (index === undefined) {
    index = new Map<ScopeId, ParsedFile>();
    // First-wins to preserve `Array.find` semantics (returns the first match).
    // `moduleScope` is unique per file in practice, so collisions are absent;
    // the guard only formalises identical behaviour to the prior `.find`.
    for (const p of parsedFiles) {
      if (!index.has(p.moduleScope)) index.set(p.moduleScope, p);
    }
    moduleScopeIndexByPass.set(parsedFiles, index);
  }
  return index;
}

/**
 * Return the names visible through a C wildcard import (`#include`).
 * All module-scope defs from the target file are visible EXCEPT those
 * declared with `static` storage class (file-local linkage in C).
 */
export function expandCWildcardNames(
  targetModuleScope: ScopeId,
  parsedFiles: readonly ParsedFile[],
): readonly string[] {
  const target = moduleScopeIndex(parsedFiles).get(targetModuleScope);
  if (target === undefined) return [];

  const seen = new Set<string>();
  const names: string[] = [];
  for (const def of target.localDefs) {
    const name = simpleName(def);
    if (name === '') continue;
    if (isStaticName(target.filePath, name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function simpleName(def: SymbolDefinition): string {
  return def.qualifiedName?.split('.').pop() ?? def.qualifiedName ?? '';
}
