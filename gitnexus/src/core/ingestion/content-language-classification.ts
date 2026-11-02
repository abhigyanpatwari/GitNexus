import fs from 'fs/promises';
import path from 'path';
import type { SupportedLanguages } from 'gitnexus-shared';
import { mapConcurrent } from '../../lib/utils.js';
import { READ_CONCURRENCY } from './filesystem-walker.js';
import { getLanguageForFileContent } from './languages/index.js';

/**
 * Classify files whose language cannot be determined from their extension.
 *
 * Source text is retained only for the duration of each individual read and
 * classification. The returned map deliberately contains language results,
 * not source text, so downstream phases can reuse the decision without
 * holding every candidate header in memory or rereading it to classify again.
 */
export async function classifyContentLanguages(
  repoPath: string,
  relativePaths: readonly string[],
): Promise<ReadonlyMap<string, SupportedLanguages | null>> {
  const classifications = new Map<string, SupportedLanguages | null>();
  const results = await mapConcurrent(
    relativePaths,
    async (relativePath) => {
      const sourceText = await fs.readFile(path.join(repoPath, relativePath), 'utf-8');
      return {
        path: relativePath,
        language: getLanguageForFileContent(relativePath, sourceText),
      };
    },
    { concurrency: READ_CONCURRENCY },
  );

  // An unreadable file yields `undefined` from mapConcurrent. Leave it absent
  // so the caller retains the existing filename-based fallback behavior.
  for (const result of results) {
    if (result !== undefined) classifications.set(result.path, result.language);
  }

  return classifications;
}
