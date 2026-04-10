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
  global: 0.5,
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

    // Tier 2b: Package-scoped — iterate all indexed files, keeping only those
    // that live inside one of the caller's imported package directories.
    // O(totalIndexedFiles) × O(1) lookupExactAll — avoids a global name scan
    // at the cost of a linear file-path scan (acceptable: called only after
    // Tier 2a misses, and most repos have far fewer files than named defs).
    const importedPackages = packageMap.get(fromFile);
    if (importedPackages) {
      const packageDefs: SymbolDefinition[] = [];
      for (const file of symbols.getFiles()) {
        for (const dirSuffix of importedPackages) {
          if (isFileInPackageDir(file, dirSuffix)) {
            packageDefs.push(...symbols.lookupExactAll(file, name));
            break; // a file can only be in one package dir per caller
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
    const classDefs = symbols.lookupClassByName(name);
    const implDefs = symbols.lookupImplByName(name);
    const callableDefs = symbols.lookupFuzzyCallable(name);

    // Avoid allocation when only one group has results (the common case).
    let globalDefs: SymbolDefinition[];
    const hasClass = classDefs.length > 0;
    const hasImpl = implDefs.length > 0;
    const hasCallable = callableDefs.length > 0;
    if (hasClass && !hasImpl && !hasCallable) {
      globalDefs = classDefs;
    } else if (!hasClass && !hasImpl && hasCallable) {
      globalDefs = callableDefs;
    } else if (!hasClass && hasImpl && !hasCallable) {
      globalDefs = implDefs;
    } else {
      globalDefs = [...classDefs, ...implDefs, ...callableDefs];
    }

    if (globalDefs.length === 0) return null;
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
