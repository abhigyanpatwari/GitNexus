/**
 * Expand a TypeScript or JavaScript scope-resolution pass to include
 * import-reachable sibling ECMA files (TS ↔ JS), mirroring Vue's
 * `collectScopeContextPaths` (#4252).
 *
 * Without this, each language pass only sees its own file bucket, so a
 * relative import from `.ts` to `.js` (or the reverse) never resolves and
 * never emits IMPORTS/CALLS — even though the same import between two
 * `.js` files works.
 */

import type { ParsedFile } from 'gitnexus-shared';
import { SupportedLanguages, getLanguageFromFilename } from 'gitnexus-shared';
import type { LanguageProvider } from '../../language-provider.js';
import { extractParsedFile } from '../../scope-extractor-bridge.js';
import { javascriptProvider, typescriptProvider } from '../typescript.js';

const ECMA_SCOPE_CONTEXT_LANGUAGES = new Set<SupportedLanguages>([
  SupportedLanguages.TypeScript,
  SupportedLanguages.JavaScript,
]);

function isEcmaScopeContextLanguage(lang: SupportedLanguages | null): boolean {
  return lang !== null && ECMA_SCOPE_CONTEXT_LANGUAGES.has(lang);
}

function providerForEcmaPath(filePath: string): LanguageProvider {
  const lang = getLanguageFromFilename(filePath);
  return lang === SupportedLanguages.JavaScript ? javascriptProvider : typescriptProvider;
}

export type EcmaResolveImportTarget = (
  targetRaw: string,
  fromFile: string,
  allFilePaths: ReadonlySet<string>,
  resolutionConfig: unknown,
) => string | readonly string[] | null;

export function collectEcmaScopeContextPaths(options: {
  readonly primaryFilePaths: readonly string[];
  readonly preExtractedByPath: ReadonlyMap<string, ParsedFile>;
  readonly entryFileContents: ReadonlyMap<string, string>;
  readonly allScannedPaths: ReadonlySet<string>;
  readonly resolutionConfig: unknown;
  readonly resolveImportTarget: EcmaResolveImportTarget;
}): Set<string> {
  const {
    primaryFilePaths,
    preExtractedByPath,
    entryFileContents,
    allScannedPaths,
    resolutionConfig,
    resolveImportTarget,
  } = options;

  const resolveTargets = (targetRaw: string, fromFile: string): readonly string[] => {
    const resolved = resolveImportTarget(targetRaw, fromFile, allScannedPaths, resolutionConfig);
    if (resolved === null) return [];
    if (typeof resolved === 'string') return [resolved];
    return resolved;
  };

  const visited = new Set<string>(primaryFilePaths);
  const queue = [...primaryFilePaths];
  const fallbackParsed = new Map<string, ParsedFile>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    let parsed = preExtractedByPath.get(current) ?? fallbackParsed.get(current) ?? undefined;
    if (parsed === undefined) {
      const source = entryFileContents.get(current);
      if (source !== undefined) {
        parsed = extractParsedFile(providerForEcmaPath(current), source, current);
        if (parsed !== undefined) fallbackParsed.set(current, parsed);
      }
    }
    if (parsed === undefined) continue;

    for (const parsedImport of parsed.parsedImports) {
      if (parsedImport.targetRaw.trim().length === 0) continue;
      for (const targetPath of resolveTargets(parsedImport.targetRaw, current)) {
        if (!allScannedPaths.has(targetPath)) continue;
        if (!isEcmaScopeContextLanguage(getLanguageFromFilename(targetPath))) continue;
        if (visited.has(targetPath)) continue;
        visited.add(targetPath);
        queue.push(targetPath);
      }
    }
  }

  return visited;
}
