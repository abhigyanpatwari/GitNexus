import type { SymbolTable, SymbolDefinition } from './symbol-table.js';
import type { NamedImportMap } from './import-processor.js';

/**
 * Walk a named-binding re-export chain through NamedImportMap.
 *
 * When file A imports { User } from B, and B re-exports { User } from C,
 * the NamedImportMap for A points to B, but B has no User definition.
 * This function follows the chain: A→B→C until a definition is found.
 *
 * Returns the definitions found at the end of the chain, or null if the
 * chain breaks (missing binding, circular reference, or depth exceeded).
 * Max depth 5 to prevent infinite loops.
 *
 * @param allDefs Pre-computed `symbolTable.lookupFuzzy(name)` result — must be the
 *               complete unfiltered result. Passing a file-filtered subset will cause
 *               silent misses at depth=0 for non-aliased bindings.
 */
export function walkBindingChain(
  name: string,
  currentFilePath: string,
  symbolTable: SymbolTable,
  namedImportMap: NamedImportMap,
  allDefs: SymbolDefinition[],
): SymbolDefinition[] | null {
  let lookupFile = currentFilePath;
  let lookupName = name;
  const visited = new Set<string>();

  for (let depth = 0; depth < 5; depth++) {
    const bindings = namedImportMap.get(lookupFile);
    if (!bindings) return null;

    const binding = bindings.get(lookupName);
    if (!binding) return null;

    const key = `${binding.sourcePath}:${binding.exportedName}`;
    if (visited.has(key)) return null; // circular
    visited.add(key);

    const targetName = binding.exportedName;
    const resolvedDefs = targetName !== lookupName || depth > 0
      ? symbolTable.lookupFuzzy(targetName).filter(def => def.filePath === binding.sourcePath)
      : allDefs.filter(def => def.filePath === binding.sourcePath);

    if (resolvedDefs.length > 0) return resolvedDefs;

    // No definition in source file → follow re-export chain
    lookupFile = binding.sourcePath;
    lookupName = targetName;
  }

  return null;
}
