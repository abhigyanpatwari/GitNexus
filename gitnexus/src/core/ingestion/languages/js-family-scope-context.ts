/**
 * Shared import-closure expansion for the TypeScript/JavaScript family.
 *
 * TypeScript and JavaScript are one language family in practice: mixed
 * codebases (`allowJs` projects, gradual JS → TS migrations, TS apps
 * consuming untyped JS utilities) import across the `.ts` / `.js`
 * boundary constantly. But the scope-resolution phase partitions scanned
 * files by language, so a TypeScript pass only sees `.ts`/`.tsx` files
 * and a JavaScript pass only sees `.js`/`.jsx` files — a cross-language
 * import can never resolve, and no IMPORTS or CALLS edge is emitted
 * (#4252).
 *
 * Both providers fix this with the same `collectScopeContextPaths` hook
 * (the pattern Vue already uses for its `.vue` → TS/JS closure): trace
 * the import closure from the primary files and pull in files of the
 * sibling language. The pass then resolves cross-language imports
 * against the full family, and the graph's id-based `addRelationship`
 * dedup keeps the sibling pass from double-emitting the same edges.
 *
 * Shared code must not name languages (AGENTS.md), so the sibling
 * language is a parameter — each provider passes its own sibling.
 */

import type { ParsedFile } from 'gitnexus-shared';
import { getLanguageFromFilename, SupportedLanguages } from 'gitnexus-shared';
import { extractParsedFile } from '../scope-extractor-bridge.js';
import type { LanguageProvider } from '../language-provider.js';
import type { ScopeResolver } from '../scope-resolution/contract/scope-resolver.js';

export interface JsFamilyScopeContextOptions {
  /** The provider's own `resolveImportTarget` (memoized per pass). */
  readonly resolveImportTarget: ScopeResolver['resolveImportTarget'];
  /** The provider's language provider, for fallback extraction. */
  readonly provider: LanguageProvider;
  /** The sibling language to pull in (TypeScript pulls JavaScript and vice versa). */
  readonly siblingLanguage: SupportedLanguages.TypeScript | SupportedLanguages.JavaScript;
  readonly primaryFilePaths: readonly string[];
  readonly preExtractedByPath: ReadonlyMap<string, ParsedFile>;
  readonly entryFileContents: ReadonlyMap<string, string>;
  readonly allScannedPaths: ReadonlySet<string>;
  readonly resolutionConfig: unknown;
}

/**
 * Transitive import closure from `primaryFilePaths`, adding every
 * reachable file whose language is `siblingLanguage`. Files of any
 * other language are never added (their own pass owns them), and files
 * already visited — including all primaries — are skipped.
 */
export function collectJsFamilyScopeContextPaths(
  options: JsFamilyScopeContextOptions,
): Set<string> {
  const {
    resolveImportTarget,
    provider,
    siblingLanguage,
    primaryFilePaths,
    preExtractedByPath,
    entryFileContents,
    allScannedPaths,
    resolutionConfig,
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
        parsed = extractParsedFile(provider, source, current);
        if (parsed !== undefined) fallbackParsed.set(current, parsed);
      }
    }
    if (parsed === undefined) continue;

    for (const parsedImport of parsed.parsedImports) {
      if (parsedImport.targetRaw.trim().length === 0) continue;
      for (const targetPath of resolveTargets(parsedImport.targetRaw, current)) {
        if (!allScannedPaths.has(targetPath)) continue;
        if (getLanguageFromFilename(targetPath) !== siblingLanguage) continue;
        if (visited.has(targetPath)) continue;
        visited.add(targetPath);
        queue.push(targetPath);
      }
    }
  }

  return visited;
}
