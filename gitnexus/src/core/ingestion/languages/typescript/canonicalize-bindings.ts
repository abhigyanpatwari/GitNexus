import type { ParsedFile } from 'gitnexus-shared';
import { canonicalizeBindings } from '../../scope-resolution/scope/canonicalize-bindings.js';
import { canonicalTypeScriptName } from './identifiers.js';

/** Normalize lexical bindings while preserving the module keys decoded by the importer. */
export function canonicalizeEcmaBindings(parsed: ParsedFile): ParsedFile {
  const lexical = canonicalizeBindings({ ...parsed, parsedImports: [] }, canonicalTypeScriptName);
  return {
    ...lexical,
    parsedImports: parsed.parsedImports.map((entry) => {
      if (entry.kind === 'reexport' || entry.exportsOnly || !('localName' in entry)) return entry;
      return {
        ...entry,
        localName: canonicalTypeScriptName(entry.localName),
        ...('alias' in entry && entry.alias ? { alias: canonicalTypeScriptName(entry.alias) } : {}),
      };
    }),
  };
}

export function canonicalizeEcmaWorkspaceBindings(parsedFiles: ParsedFile[]): void {
  for (let index = 0; index < parsedFiles.length; index++) {
    parsedFiles[index] = canonicalizeEcmaBindings(parsedFiles[index]);
  }
}
