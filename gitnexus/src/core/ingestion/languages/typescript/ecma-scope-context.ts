/**
 * Cross-language scope context for the TypeScript and JavaScript passes (#4252).
 *
 * Scope resolution runs once per language, and each run's file universe is its
 * own language's files. A `.ts` file importing `../lib/a` (a `.js` file) — or a
 * `.js` file importing a `.ts` module — therefore had no target file to resolve
 * to and no definition to bind against: neither IMPORTS nor CALLS was emitted.
 *
 * The TypeScript and JavaScript resolvers implement
 * `ScopeResolver.collectScopeContextPaths` with this helper, the pattern Vue
 * already uses for its TS/JS imports: walk the primary files' imports and pull
 * the imported files of the OTHER ECMAScript language into this run, following
 * their imports transitively so re-export chains bind.
 *
 * Context files reuse the ParsedFile the parse phase produced for them, so
 * they are not re-parsed by this provider. Their edges are emitted again by
 * this run; the graph de-duplicates relationships by id, as it already does
 * for files the Vue pass pulls in.
 */

import type { ParsedFile } from 'gitnexus-shared';
import { SupportedLanguages, getLanguageFromFilename } from 'gitnexus-shared';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';

const ECMA_LANGUAGES = new Set<SupportedLanguages>([
  SupportedLanguages.TypeScript,
  SupportedLanguages.JavaScript,
]);

type ContextOptions = Parameters<NonNullable<ScopeResolver['collectScopeContextPaths']>>[0];

/**
 * The primary paths plus every TypeScript / JavaScript file reachable from them
 * through imports that cross into the other ECMAScript language. Same-language
 * targets are already primaries of this run and are not walked again.
 */
export function collectEcmaCrossLanguageContext(
  resolveImportTarget: ScopeResolver['resolveImportTarget'],
  primaryLanguage: SupportedLanguages,
  options: ContextOptions,
): Set<string> {
  const { primaryFilePaths, preExtractedByPath, allScannedPaths, resolutionConfig } = options;
  const visited = new Set<string>(primaryFilePaths);
  // Walk only files whose imports the parse phase already decomposed; a file
  // with no ParsedFile contributes no imports to follow.
  const queue: string[] = [...primaryFilePaths];

  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) break;
    const parsed: ParsedFile | undefined = preExtractedByPath.get(current);
    if (parsed === undefined) continue;
    const fromPrimary = getLanguageFromFilename(current) === primaryLanguage;
    for (const parsedImport of parsed.parsedImports) {
      const targetRaw = parsedImport.targetRaw;
      if (targetRaw.trim().length === 0) continue;
      const resolved = resolveImportTarget(targetRaw, current, allScannedPaths, resolutionConfig);
      if (resolved === null) continue;
      for (const target of typeof resolved === 'string' ? [resolved] : resolved) {
        if (visited.has(target) || !allScannedPaths.has(target)) continue;
        const lang = getLanguageFromFilename(target);
        if (lang === null || !ECMA_LANGUAGES.has(lang)) continue;
        // From a primary file, only a cross-language target is new context.
        // From a context file, follow its imports in either language so a
        // re-export chain (`a.js` re-exporting `c.js`) reaches the definition.
        if (fromPrimary && lang === primaryLanguage) continue;
        visited.add(target);
        queue.push(target);
      }
    }
  }
  return visited;
}
