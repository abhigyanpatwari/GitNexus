/**
 * Symbol Resolver
 *
 * Import-filtered candidate narrowing for bare identifier resolution.
 * NOT FQN resolution — does not parse qualifiers (ns::Bar, com.foo.Bar).
 *
 * Shared between heritage-processor.ts and call-processor.ts.
 */

import type { SymbolTable, SymbolDefinition } from './symbol-table.js';
import type { ImportMap, PackageMap, NamedImportMap } from './import-processor.js';
import { isFileInPackageDir } from './import-processor.js';
import { walkBindingChain } from './named-binding-extraction.js';

/** Resolution tier for internal tracking, logging, and test assertions. */
export type ResolutionTier = 'same-file' | 'import-scoped' | 'unique-global';

/** Internal resolution result preserving tier metadata. */
export interface InternalResolution {
  definition: SymbolDefinition;
  tier: ResolutionTier;
  candidateCount: number;
}

/**
 * Resolve a bare identifier to its best-matching definition using import context.
 *
 * Resolution tiers (highest confidence first):
 * 1. Same file (lookupExactFull — authoritative)
 * 2. Import-scoped (lookupFuzzy filtered by importMap — acceptable)
 * 3. Unique global (lookupFuzzy with exactly 1 match — acceptable fallback)
 *
 * If multiple global candidates remain after filtering, returns null.
 * A wrong edge is worse than no edge.
 */
export const resolveSymbol = (
  name: string,
  currentFilePath: string,
  symbolTable: SymbolTable,
  importMap: ImportMap,
  packageMap?: PackageMap,
  namedImportMap?: NamedImportMap,
): SymbolDefinition | null => {
  return resolveSymbolInternal(name, currentFilePath, symbolTable, importMap, packageMap, namedImportMap)?.definition ?? null;
};

/** Internal resolver preserving tier metadata for logging and test assertions. */
export const resolveSymbolInternal = (
  name: string,
  currentFilePath: string,
  symbolTable: SymbolTable,
  importMap: ImportMap,
  packageMap?: PackageMap,
  namedImportMap?: NamedImportMap,
): InternalResolution | null => {
  // Tier 1: Same file — authoritative match
  const localDef = symbolTable.lookupExactFull(currentFilePath, name);
  if (localDef) return { definition: localDef, tier: 'same-file', candidateCount: 1 };

  // Get all global definitions for subsequent tiers
  const allDefs = symbolTable.lookupFuzzy(name);

  // Tier 2a-named: Check named bindings BEFORE the empty-allDefs early return,
  // because aliased imports (import { User as U }) mean lookupFuzzy('U') returns
  // empty but we can resolve via the exported name.
  if (namedImportMap) {
    const result = resolveNamedBindingChain(name, currentFilePath, symbolTable, namedImportMap, allDefs);
    if (result) return result;
  }

  if (allDefs.length === 0) return null;

  // Tier 2a: Import-scoped — check if any definition is in a file imported by currentFile
  const importedFiles = importMap.get(currentFilePath);
  if (importedFiles) {
    for (const def of allDefs) {
      if (importedFiles.has(def.filePath)) {
        return { definition: def, tier: 'import-scoped', candidateCount: allDefs.length };
      }
    }
  }

  // Tier 2b: Package-scoped — check if any definition is in a package/namespace dir imported by currentFile
  // Used for Go packages and C# namespace imports to avoid ImportMap expansion bloat
  const importedPackages = packageMap?.get(currentFilePath);
  if (importedPackages) {
    for (const def of allDefs) {
      for (const dirSuffix of importedPackages) {
        if (isFileInPackageDir(def.filePath, dirSuffix)) {
          return { definition: def, tier: 'import-scoped', candidateCount: allDefs.length };
        }
      }
    }
  }

  // Tier 3: Unique global — ONLY if exactly one candidate exists
  // Ambiguous global matches are refused. A wrong edge is worse than no edge.
  if (allDefs.length === 1) {
    return { definition: allDefs[0], tier: 'unique-global', candidateCount: 1 };
  }

  // Ambiguous: multiple global candidates, no import or same-file match → refuse
  return null;
};

/**
 * Follow re-export chains through NamedImportMap.
 * Delegates chain-walking to the shared walkBindingChain utility, then
 * applies symbol-resolver semantics: exactly one match required.
 */
const resolveNamedBindingChain = (
  name: string,
  currentFilePath: string,
  symbolTable: SymbolTable,
  namedImportMap: NamedImportMap,
  allDefs: SymbolDefinition[],
): InternalResolution | null => {
  const defs = walkBindingChain(name, currentFilePath, symbolTable, namedImportMap, allDefs);
  if (defs?.length === 1) {
    return { definition: defs[0], tier: 'import-scoped', candidateCount: defs.length };
  }
  return null;
};
