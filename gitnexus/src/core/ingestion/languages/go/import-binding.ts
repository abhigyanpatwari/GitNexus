import type { ParsedImport } from 'gitnexus-shared';
import { inferGoPackageName } from './package-clause.js';

/** An omitted alias binds the imported package clause, never its path spelling. */
export function resolveGoImportBinding(
  parsedImport: ParsedImport,
  resolveTargetFiles: () => readonly string[],
  sourceTextFor: (filePath: string) => string | undefined,
): ParsedImport {
  if (parsedImport.kind !== 'namespace' || !parsedImport.implicitLocalName) return parsedImport;
  const targetFiles = resolveTargetFiles();
  if (targetFiles.length === 0) return parsedImport;

  const names = new Set(targetFiles.map((file) => inferGoPackageName(sourceTextFor(file) ?? '')));
  const name = names.size === 1 ? names.values().next().value : undefined;
  if (!name) {
    // Keep the dependency without inventing a scope-visible package qualifier.
    return { kind: 'side-effect', targetRaw: parsedImport.targetRaw };
  }
  return { ...parsedImport, localName: name, importedName: name };
}
