/**
 * Resolution Context
 *
 * Single implementation of tiered name resolution.
 *
 * Resolution tiers (highest confidence first):
 * 1. Same file (lookupExactAll — authoritative)
 * 2a-named. Named binding chain (walkBindingChain via NamedImportMap)
 * 2a. Import-scoped (iterate importedFiles with lookupExactAll per file)
 * 2b. Package-scoped (iterate indexed files matching package dir with lookupExactAll)
 * 3. Global (lookupClassByName + lookupImplByName + lookupCallableByName — consumers must check count)
 *
 * Each tier queries the minimum necessary scope directly:
 * - Tier 2a iterates the caller's import set (O(imports) × O(1) lookupExactAll).
 * - Tier 2b iterates all indexed files filtered by package dir
 *   (O(files) × O(1) lookupExactAll — avoids a global name scan).
 * - Tier 3 combines lookupClassByName + lookupImplByName + lookupCallableByName
 *   (three O(1) index lookups with a narrow, type-specific result set).
 */

import type { SymbolDefinition, SymbolTableReader } from './symbol-table.js';
import type { MutableSemanticModel } from './semantic-model.js';
import { createSemanticModel } from './semantic-model.js';

// ---------------------------------------------------------------------------
// Named-import types — describe how a file imports specific names from a
// source file. Consumed by the Tier 2a-named binding-chain walker below.
// ---------------------------------------------------------------------------

/**
 * A single named binding in a source file (e.g. `import { User as U }`).
 * Stores both the resolved source path and the original exported name so
 * that aliased imports can resolve U → User in the source file.
 */
export interface NamedImportBinding {
  sourcePath: string;
  exportedName: string;
}

/**
 * Map<ImportingFilePath, Map<LocalName, NamedImportBinding>>.
 *
 * Tracks which specific names a file imports from which sources (TS / Python
 * / Rust / Java-static / ...). Used to tighten Tier 2a resolution:
 * `import { User } from './models'` means only `User` (not `Repo`) is
 * visible from models.ts via this import.
 */
export type NamedImportMap = Map<string, Map<string, NamedImportBinding>>;

/**
 * Check if a file path is directly inside a package directory identified by
 * its suffix. Used by Tier 2b package-scoped resolution (Go / C#).
 */
export function isFileInPackageDir(filePath: string, dirSuffix: string): boolean {
  // Prepend '/' so paths like "internal/auth/service.go" match suffix "/internal/auth/"
  const normalized = '/' + filePath.replace(/\\/g, '/');
  if (!normalized.includes(dirSuffix)) return false;
  const afterDir = normalized.substring(normalized.indexOf(dirSuffix) + dirSuffix.length);
  return !afterDir.includes('/');
}

/** Maximum re-export hops walkBindingChain will follow before giving up.
 *  A hard cap is needed to defend against pathological cycles that slip
 *  past the `visited` Set (e.g. a binding chain whose key is equal by
 *  string value but visits distinct modules). Five hops covers the
 *  common TypeScript monorepo pattern (component → pkg/index →
 *  packages/index → root/index → types/index). Chains longer than this
 *  fall through to Tier 2a-import / Tier 2b / Tier 3 resolution, which
 *  is a silent false-negative that the caller may or may not recover
 *  from. If a real repo hits this limit, raise it — there is no
 *  correctness reason to keep it at exactly 5. */
const MAX_BINDING_CHAIN_DEPTH = 5;

/**
 * Walk a named-binding re-export chain through NamedImportMap.
 *
 * When file A imports { User } from B, and B re-exports { User } from C,
 * the NamedImportMap for A points to B, but B has no User definition.
 * This function follows the chain: A → B → C until a definition is found.
 *
 * Returns the definitions found at the end of the chain, or null if the
 * chain breaks (missing binding, circular reference, or
 * {@link MAX_BINDING_CHAIN_DEPTH} exceeded). Internal to
 * resolution-context — not exported from the model barrel.
 */
function walkBindingChain(
  name: string,
  currentFilePath: string,
  symbolTable: SymbolTableReader,
  namedImportMap: NamedImportMap,
): readonly SymbolDefinition[] | null {
  // Fast exit: most files have no named imports at all. Skip the Set
  // allocation + loop entry on the common empty-binding path so resolve()
  // stays allocation-free for the typical call site.
  const firstBindings = namedImportMap.get(currentFilePath);
  if (!firstBindings) return null;
  const firstBinding = firstBindings.get(name);
  if (!firstBinding) return null;

  let lookupFile = currentFilePath;
  let lookupName = name;
  const visited = new Set<string>();

  for (let depth = 0; depth < MAX_BINDING_CHAIN_DEPTH; depth++) {
    const bindings = depth === 0 ? firstBindings : namedImportMap.get(lookupFile);
    if (!bindings) return null;

    const binding = depth === 0 ? firstBinding : bindings.get(lookupName);
    if (!binding) return null;

    const key = `${binding.sourcePath}:${binding.exportedName}`;
    if (visited.has(key)) return null; // circular
    visited.add(key);

    const targetName = binding.exportedName;
    const resolvedDefs = symbolTable.lookupExactAll(binding.sourcePath, targetName);

    if (resolvedDefs.length > 0) return resolvedDefs;

    // No definition in source file → follow re-export chain
    lookupFile = binding.sourcePath;
    lookupName = targetName;
  }

  return null;
}

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
  /** Semantic model — the top-level container for types, methods, fields,
   *  and the nested file/callable SymbolTable. Typed as
   *  {@link MutableSemanticModel} because `ResolutionContext` is the
   *  lifecycle owner — the pipeline registers symbols through it during
   *  the fan-out phase. Resolvers that only query should annotate their
   *  own fields as {@link SemanticModel} to drop write access. */
  readonly model: MutableSemanticModel;
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
    cacheHits: number;
    cacheMisses: number;
    tierSameFile: number;
    tierImportScoped: number;
    tierGlobal: number;
    tierMiss: number;
  };
  clear(): void;
}

export const createResolutionContext = (): ResolutionContext => {
  const model = createSemanticModel();
  const symbols = model.symbols;
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
  // Tier hit counters — replaces the lost fuzzyCallCount diagnostic
  let tierSameFile = 0;
  let tierImportScoped = 0;
  let tierGlobal = 0;
  let tierMiss = 0;

  // --- Core resolution (single implementation of tier logic) ---

  const resolveUncached = (name: string, fromFile: string): TieredCandidates | null => {
    // Tier 1: Same file — authoritative match (returns all overloads)
    const localDefs = symbols.lookupExactAll(fromFile, name);
    if (localDefs.length > 0) {
      tierSameFile++;
      return { candidates: localDefs, tier: 'same-file' };
    }

    // Tier 2a-named: Named binding chain (aliased / re-exported imports)
    // Checked before import-scoped so that `import { User as U }` resolves
    // correctly even when lookupExactAll on the alias name returns nothing.
    const chainResult = walkBindingChain(name, fromFile, symbols, namedImportMap);
    if (chainResult && chainResult.length > 0) {
      tierImportScoped++;
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
        tierImportScoped++;
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
        tierImportScoped++;
        return { candidates: packageDefs, tier: 'import-scoped' };
      }
    }

    // Tier 3: Global — targeted O(1) index lookups for each symbol category.
    // Class-like symbols (Class, Struct, Interface, Enum, Record, Trait) are
    // covered by lookupClassByName; Rust impl blocks by lookupImplByName
    // (separate to avoid polluting heritage resolution); free callables
    // (Function, Macro, Delegate) by lookupCallableByName; owner-scoped
    // methods and constructors by `model.methods.lookupMethodByName`.
    //
    // FREE_CALLABLE_TYPES excludes Method/Constructor, so strictly-labeled
    // methods are disjoint between the two indexes.
    //
    // Partial-state caveat: Python/Rust/Kotlin class methods are emitted
    // as Function + ownerId — `rawSymbols.add` routes them through both
    // the Function callable index AND, via the dispatch-key normalization
    // in `wrappedAdd`, the method registry. The same `SymbolDefinition`
    // reference lands in both `callableDefs` and `methodDefs`, so the
    // Set-based dedup below is required.
    //
    // Known exclusion: TypeAlias, Const, and Variable are NOT reachable at
    // Tier 3 — they don't belong to any of the indexes. TypeAlias is not
    // a call target; Const/Variable are resolved via import or same-file
    // tiers. Macro (C/C++) and Delegate (C#) stay in the callable index
    // since call-processor.ts treats them as callable targets.
    const classDefs = model.types.lookupClassByName(name);
    const implDefs = model.types.lookupImplByName(name);
    const callableDefs = symbols.lookupCallableByName(name);
    const methodDefs = model.methods.lookupMethodByName(name);

    if (
      classDefs.length === 0 &&
      implDefs.length === 0 &&
      callableDefs.length === 0 &&
      methodDefs.length === 0
    ) {
      tierMiss++;
      return null;
    }

    // Fast path: if no `Function + ownerId` class method was ever
    // registered into the method registry (the only source of
    // cross-index duplication), the callable and method indexes are
    // guaranteed disjoint and we can concat without dedup.
    if (!model.methods.hasFunctionMethods) {
      const globalDefs: SymbolDefinition[] = [
        ...classDefs,
        ...implDefs,
        ...callableDefs,
        ...methodDefs,
      ];
      tierGlobal++;
      return { candidates: globalDefs, tier: 'global' };
    }

    // Slow path: dedup by nodeId because the same SymbolDefinition
    // reference can land in both `callableDefs` (via the Function
    // callable-index gate) and `methodDefs` (via the dispatch-key
    // normalization routing Function+ownerId into MethodRegistry).
    // Dedup covers all four index reads so any nodeId overlap (even
    // theoretical ones between classDefs/implDefs) is caught.
    const globalDefs: SymbolDefinition[] = [];
    const seen = new Set<string>();
    const pushUnique = (pool: readonly SymbolDefinition[]): void => {
      for (const def of pool) {
        if (seen.has(def.nodeId)) continue;
        seen.add(def.nodeId);
        globalDefs.push(def);
      }
    };
    pushUnique(classDefs);
    pushUnique(implDefs);
    pushUnique(callableDefs);
    pushUnique(methodDefs);

    tierGlobal++;
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
    tierSameFile,
    tierImportScoped,
    tierGlobal,
    tierMiss,
  });

  const clear = (): void => {
    model.clear();
    importMap.clear();
    packageMap.clear();
    namedImportMap.clear();
    moduleAliasMap.clear();
    packageDirIndex = null; // invalidate — will rebuild on next Tier 2b hit
    clearCache();
    cacheHits = 0;
    cacheMisses = 0;
    tierSameFile = 0;
    tierImportScoped = 0;
    tierGlobal = 0;
    tierMiss = 0;
  };

  return {
    resolve,
    model,
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
