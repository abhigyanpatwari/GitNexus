/**
 * Resolution Context
 *
 * Single implementation of tiered name resolution. Replaces the duplicated
 * tier-selection logic previously split between symbol-resolver.ts and
 * call-processor.ts.
 *
 * Resolution tiers (highest confidence first):
 * 1. Same file (lookupExactAll — authoritative)
 * 2a-named. Named binding chain (walkBindingChain via NamedImportMap)
 * 2a. Import-scoped (iterate importedFiles with lookupExactAll per file)
 * 2b. Package-scoped (iterate indexed files matching package dir with lookupExactAll)
 * 3. Global (lookupClassByName + lookupImplByName + lookupFuzzyCallable — consumers must check count)
 *
 * SM-16: resolveUncached no longer calls lookupFuzzy. Each tier queries the
 * minimum necessary scope directly:
 * - Tier 2a iterates the caller's import set (O(imports) × O(1) lookupExactAll).
 * - Tier 2b iterates all indexed files filtered by package dir
 *   (O(files) × O(1) lookupExactAll — avoids a global name scan).
 * - Tier 3 combines lookupClassByName + lookupImplByName + lookupFuzzyCallable
 *   (three O(1) index lookups vs one O(1) lookupFuzzy, with a narrower result set).
 */

import type { SymbolTable, SymbolDefinition } from './symbol-table.js';
import { createSymbolTable } from './symbol-table.js';
import type { NamedImportMap } from './import-processor.js';
import { isFileInPackageDir } from './import-processor.js';
import { walkBindingChain } from './named-binding-processor.js';

/** Resolution tier for tracking, logging, and test assertions. */
export type ResolutionTier = 'same-file' | 'import-scoped' | 'global';

/** Tier-selected candidates with metadata. */
export interface TieredCandidates {
  readonly candidates: readonly SymbolDefinition[];
  readonly tier: ResolutionTier;
}

/** Confidence scores per resolution tier. */
export const TIER_CONFIDENCE: Record<ResolutionTier, number> = {
  'same-file': 0.95,
  'import-scoped': 0.9,
  global: 0.5,
};

// --- Map types ---
export type ImportMap = Map<string, Set<string>>;
export type PackageMap = Map<string, Set<string>>;
/** Maps callerFile → (moduleAlias → sourceFilePath) for Python namespace imports.
 *  e.g. `import models` in app.py → moduleAliasMap.get('app.py')?.get('models') === 'models.py' */
export type ModuleAliasMap = Map<string, Map<string, string>>;

export interface ResolutionContext {
  /**
   * The only resolution API. Returns all candidates at the winning tier.
   *
   * Tier 3 ('global') returns ALL candidates regardless of count —
   * consumers must check candidates.length and refuse ambiguous matches.
   */
  resolve(name: string, fromFile: string): TieredCandidates | null;

  // --- Data access (for pipeline wiring, not resolution) ---
  /** Symbol table — used by parsing-processor to populate symbols. */
  readonly symbols: SymbolTable;
  /** Raw maps — used by import-processor to populate import data. */
  readonly importMap: ImportMap;
  readonly packageMap: PackageMap;
  readonly namedImportMap: NamedImportMap;
  /** Module-alias map for Python namespace imports: callerFile → (alias → sourceFile). */
  readonly moduleAliasMap: ModuleAliasMap;

  // --- Per-file cache lifecycle ---
  enableCache(filePath: string): void;
  clearCache(): void;

  // --- Operational ---
  getStats(): {
    fileCount: number;
    globalSymbolCount: number;
    fuzzyCallCount: number;
    fuzzyCallableCallCount: number;
    cacheHits: number;
    cacheMisses: number;
  };
  clear(): void;
}

export const createResolutionContext = (): ResolutionContext => {
  const symbols = createSymbolTable();
  const importMap: ImportMap = new Map();
  const packageMap: PackageMap = new Map();
  const namedImportMap: NamedImportMap = new Map();
  const moduleAliasMap: ModuleAliasMap = new Map();

  // Inverted index: packageDirSuffix → Set<filePath>.
  // Built lazily on first Tier 2b hit — one-time cost of O(totalFiles ×
  // allUniqueDirSuffixes) isFileInPackageDir calls across the entire
  // packageMap, amortized over the pipeline run. Subsequent Tier 2b
  // resolutions are O(callerPackages × filesInPackage × O(1)).
  let packageDirIndex: Map<string, Set<string>> | null = null;

  // Per-file cache state
  let cacheFile: string | null = null;
  let cache: Map<string, TieredCandidates | null> | null = null;
  let cacheHits = 0;
  let cacheMisses = 0;

  // --- Core resolution (single implementation of tier logic) ---

  const resolveUncached = (name: string, fromFile: string): TieredCandidates | null => {
    // Tier 1: Same file — authoritative match (returns all overloads)
    const localDefs = symbols.lookupExactAll(fromFile, name);
    if (localDefs.length > 0) {
      return { candidates: localDefs, tier: 'same-file' };
    }

    // Tier 2a-named: Named binding chain (aliased / re-exported imports)
    // Checked before import-scoped so that `import { User as U }` resolves
    // correctly even when lookupExactAll on the alias name returns nothing.
    const chainResult = walkBindingChain(name, fromFile, symbols, namedImportMap);
    if (chainResult && chainResult.length > 0) {
      return { candidates: chainResult, tier: 'import-scoped' };
    }

    // Tier 2a: Import-scoped — iterate the caller's imported files directly.
    // O(importedFiles) × O(1) lookupExactAll — no global name scan needed.
    const importedFiles = importMap.get(fromFile);
    if (importedFiles) {
      const importedDefs: SymbolDefinition[] = [];
      for (const file of importedFiles) {
        importedDefs.push(...symbols.lookupExactAll(file, name));
      }
      if (importedDefs.length > 0) {
        return { candidates: importedDefs, tier: 'import-scoped' };
      }
    }

    // Tier 2b: Package-scoped — look up files in the caller's imported package
    // directories via an inverted index (packageDirSuffix → Set<filePath>),
    // then do O(1) lookupExactAll per file. The inverted index is built lazily
    // on first Tier 2b hit by scanning symbols.getFiles() once, making
    // subsequent Tier 2b resolutions O(packages × filesInPackage) instead of
    // O(allFiles × packages).
    const importedPackages = packageMap.get(fromFile);
    if (importedPackages) {
      // Lazily build the inverted index on first use. For each indexed file,
      // test it against isFileInPackageDir for all known dirSuffixes collected
      // from packageMap. This scans all files once (instead of per-resolution)
      // and produces a dirSuffix → Set<filePath> map.
      if (!packageDirIndex) {
        // Collect all unique dir suffixes across the entire packageMap
        const allDirSuffixes = new Set<string>();
        for (const dirs of packageMap.values()) {
          for (const d of dirs) allDirSuffixes.add(d);
        }
        packageDirIndex = new Map();
        for (const file of symbols.getFiles()) {
          for (const dirSuffix of allDirSuffixes) {
            if (isFileInPackageDir(file, dirSuffix)) {
              let files = packageDirIndex.get(dirSuffix);
              if (!files) {
                files = new Set();
                packageDirIndex.set(dirSuffix, files);
              }
              files.add(file);
            }
          }
        }
      }

      const packageDefs: SymbolDefinition[] = [];
      for (const dirSuffix of importedPackages) {
        const filesInDir = packageDirIndex.get(dirSuffix);
        if (filesInDir) {
          for (const file of filesInDir) {
            packageDefs.push(...symbols.lookupExactAll(file, name));
          }
        }
      }
      if (packageDefs.length > 0) {
        return { candidates: packageDefs, tier: 'import-scoped' };
      }
    }

    // Tier 3: Global — three targeted O(1) index lookups replace the single
    // lookupFuzzy global scan. Class-like symbols (Class, Struct, Interface,
    // Enum, Record, Trait) are covered by lookupClassByName; Rust impl blocks
    // by lookupImplByName (separate to avoid polluting heritage resolution);
    // callables (Function, Method, Constructor) by lookupFuzzyCallable.
    // The three indexes cover disjoint symbol types so no dedup is needed.
    // Consumers must check candidates.length and refuse ambiguous matches.
    //
    // Known exclusion: TypeAlias, Const, and Variable are NOT reachable at
    // Tier 3 — they don't belong to any of the three indexes. The old
    // lookupFuzzy returned them, but in practice they were never useful as
    // Tier 3 candidates: TypeAlias is not a call target, Const/Variable
    // are resolved via import or same-file tiers. If a future language
    // needs them at Tier 3, add a dedicated index.
    // Macro (C/C++) and Delegate (C#) ARE included in callableIndex
    // since call-processor.ts treats them as callable targets.
    //
    // Note: lookupFuzzy is still called directly in call-processor.ts
    // (D2 module-alias widen path at ~line 1506/1588). Those callers
    // bypass resolveUncached entirely and are tracked for separate removal
    // in the roadmap. fuzzyCallCount only reflects resolveUncached usage.
    const classDefs = symbols.lookupClassByName(name);
    const implDefs = symbols.lookupImplByName(name);
    const callableDefs = symbols.lookupFuzzyCallable(name);

    if (classDefs.length === 0 && implDefs.length === 0 && callableDefs.length === 0) return null;
    const globalDefs = [...classDefs, ...implDefs, ...callableDefs];
    return { candidates: globalDefs, tier: 'global' };
  };

  const resolve = (name: string, fromFile: string): TieredCandidates | null => {
    // Check cache (only when enabled AND fromFile matches cached file)
    if (cache && cacheFile === fromFile) {
      if (cache.has(name)) {
        cacheHits++;
        return cache.get(name)!;
      }
      cacheMisses++;
    }

    const result = resolveUncached(name, fromFile);

    // Store in cache if active and file matches
    if (cache && cacheFile === fromFile) {
      cache.set(name, result);
    }

    return result;
  };

  // --- Cache lifecycle ---

  const enableCache = (filePath: string): void => {
    cacheFile = filePath;
    if (!cache) cache = new Map();
    else cache.clear();
  };

  const clearCache = (): void => {
    cacheFile = null;
    // Reuse the Map instance — just clear entries to reduce GC pressure at scale.
    cache?.clear();
    // Note: packageDirIndex is NOT invalidated here. It is built lazily on
    // first Tier 2b hit and remains valid across file boundaries because
    // packageMap and the symbol file set are append-only during the calls
    // phase (all parsing/import processing completes before resolution).
    // Invalidating per-file would destroy the amortization benefit — the
    // O(files × dirs) rebuild would run per-file instead of once.
    // Full invalidation happens in clear() (pipeline reset).
  };

  const getStats = () => ({
    ...symbols.getStats(),
    cacheHits,
    cacheMisses,
  });

  const clear = (): void => {
    symbols.clear();
    importMap.clear();
    packageMap.clear();
    namedImportMap.clear();
    moduleAliasMap.clear();
    packageDirIndex = null; // invalidate — will rebuild on next Tier 2b hit
    clearCache();
    cacheHits = 0;
    cacheMisses = 0;
  };

  return {
    resolve,
    symbols,
    importMap,
    packageMap,
    namedImportMap,
    moduleAliasMap,
    enableCache,
    clearCache,
    getStats,
    clear,
  };
};
