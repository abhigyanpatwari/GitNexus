/**
 * Resolution Context
 *
 * Single implementation of tiered name resolution. Replaces the duplicated
 * tier-selection logic previously split between symbol-resolver.ts and
 * call-processor.ts.
 *
 * Resolution tiers (highest confidence first):
 * 1. Same file (lookupExactFull — authoritative)
 * 2a-named. Named binding chain (walkBindingChain via NamedImportMap)
 * 2a. Import-scoped (lookupFuzzy filtered by ImportMap)
 * 2b. Package-scoped (lookupFuzzy filtered by PackageMap)
 * 3. Global (all candidates — consumers must check candidate count)
 */

import type { SymbolTable, SymbolDefinition } from './symbol-table.js';
import { createSymbolTable } from './symbol-table.js';
import type { NamedImportBinding } from './import-processor.js';
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
  'global': 0.5,
};

// --- Map types ---
export type ImportMap = Map<string, Set<string>>;
export type PackageMap = Map<string, Set<string>>;
export type NamedImportMap = Map<string, Map<string, NamedImportBinding>>;
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
  getStats(): { fileCount: number; globalSymbolCount: number; cacheHits: number; cacheMisses: number };
  clear(): void;
}

export const createResolutionContext = (): ResolutionContext => {
  const symbols = createSymbolTable();
  const importMap: ImportMap = new Map();
  const packageMap: PackageMap = new Map();
  const namedImportMap: NamedImportMap = new Map();
  const moduleAliasMap: ModuleAliasMap = new Map();

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

    // Get all global definitions for subsequent tiers
    const allDefs = symbols.lookupFuzzy(name);

    // Tier 2a-named: Check named bindings BEFORE empty-allDefs early return
    // because aliased imports mean lookupFuzzy('U') returns empty but we
    // can resolve via the exported name.
    const chainResult = walkBindingChain(name, fromFile, symbols, namedImportMap, allDefs);
    if (chainResult && chainResult.length > 0) {
      return { candidates: chainResult, tier: 'import-scoped' };
    }

    if (allDefs.length === 0) return null;

    // Tier 2a: Import-scoped — definition in a file imported by fromFile
    const importedFiles = importMap.get(fromFile);
    if (importedFiles) {
      const importedDefs = allDefs.filter(def => importedFiles.has(def.filePath));
      if (importedDefs.length > 0) {
        return { candidates: importedDefs, tier: 'import-scoped' };
      }
    }

    // Tier 2b: Package-scoped — definition in a package dir imported by fromFile
    const importedPackages = packageMap.get(fromFile);
    if (importedPackages) {
      const packageDefs = allDefs.filter(def => {
        for (const dirSuffix of importedPackages) {
          if (isFileInPackageDir(def.filePath, dirSuffix)) return true;
        }
        return false;
      });
      if (packageDefs.length > 0) {
        return { candidates: packageDefs, tier: 'import-scoped' };
      }
    }

    // Tier 3: Global — pass all candidates through.
    // Consumers must check candidate count and refuse ambiguous matches.
    return { candidates: allDefs, tier: 'global' };
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
