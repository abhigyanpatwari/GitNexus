/**
 * Parse-phase context.
 *
 * Holds the {@link MutableSemanticModel} (the symbol table the parse phase
 * populates and the scope-resolution phase reads) plus the legacy per-file
 * import maps that the import-processor and wildcard-synthesis phases still
 * write.
 *
 * The tiered name-resolution lookup that this module used to own
 * (`resolve` / `TieredCandidates` / `walkBindingChain` / package-dir index)
 * was deleted in RING4-2 (#943) — all languages resolve through the
 * scope-resolution registry (`Registry.lookup` / `resolveTypeRef`). The
 * remaining import maps are themselves dead and are removed in the follow-up
 * prune; only `model` is read by live code.
 */

import type { MutableSemanticModel } from './semantic-model.js';
import { createSemanticModel } from './semantic-model.js';

// ---------------------------------------------------------------------------
// Named-import types — describe how a file imports specific names from a
// source file. Written by import-processor / wildcard-synthesis (no live
// reader remains after the tiered lookup was removed).
// ---------------------------------------------------------------------------

/**
 * A single named binding in a source file (e.g. `import { User as U }`).
 * Stores both the resolved source path and the original exported name.
 */
export interface NamedImportBinding {
  sourcePath: string;
  exportedName: string;
}

/**
 * Map<ImportingFilePath, Map<LocalName, NamedImportBinding>>.
 */
export type NamedImportMap = Map<string, Map<string, NamedImportBinding>>;

/**
 * Check if a file path is directly inside a package directory identified by
 * its suffix.
 */
export function isFileInPackageDir(filePath: string, dirSuffix: string): boolean {
  // Prepend '/' so paths like "internal/auth/service.go" match suffix "/internal/auth/"
  const normalized = '/' + filePath.replace(/\\/g, '/');
  if (!normalized.includes(dirSuffix)) return false;
  const afterDir = normalized.substring(normalized.indexOf(dirSuffix) + dirSuffix.length);
  return !afterDir.includes('/');
}

// --- Map types ---
export type ImportMap = Map<string, Set<string>>;
export type PackageMap = Map<string, Set<string>>;
/** Maps callerFile → (moduleAlias → sourceFilePath) for Python namespace imports.
 *  e.g. `import models` in app.py → moduleAliasMap.get('app.py')?.get('models') === 'models.py' */
export type ModuleAliasMap = Map<string, Map<string, string>>;

export interface ResolutionContext {
  /**
   * Semantic model — the top-level container for types, methods, fields, and
   * the nested file/callable SymbolTable. Typed as {@link MutableSemanticModel}
   * because this context is the lifecycle owner — the pipeline registers
   * symbols through it during the fan-out phase.
   */
  readonly model: MutableSemanticModel;
  /** Raw maps — populated by import-processor / wildcard-synthesis. */
  readonly importMap: ImportMap;
  readonly packageMap: PackageMap;
  readonly namedImportMap: NamedImportMap;
  /** Module-alias map for Python namespace imports: callerFile → (alias → sourceFile). */
  readonly moduleAliasMap: ModuleAliasMap;

  clear(): void;
}

export const createResolutionContext = (): ResolutionContext => {
  const model = createSemanticModel();
  const importMap: ImportMap = new Map();
  const packageMap: PackageMap = new Map();
  const namedImportMap: NamedImportMap = new Map();
  const moduleAliasMap: ModuleAliasMap = new Map();

  const clear = (): void => {
    model.clear();
    importMap.clear();
    packageMap.clear();
    namedImportMap.clear();
    moduleAliasMap.clear();
  };

  return {
    model,
    importMap,
    packageMap,
    namedImportMap,
    moduleAliasMap,
    clear,
  };
};
