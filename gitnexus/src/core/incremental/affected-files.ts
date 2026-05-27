/**
 * Shared affected-file expansion for incremental analysis.
 *
 * The first seed comes from the content-hash diff: changed/added files
 * need fresh rows, deleted files need stale rows removed. Cross-file
 * resolution adds one more requirement: files that imported a changed or
 * deleted file in the previous index may need their own edges rewritten
 * even when their source bytes did not change.
 */

import type { FileHashDiff } from '../../storage/file-hash.js';
import { shadowCandidatesFor } from './shadow-candidates.js';

export const DEFAULT_MAX_IMPORTER_BFS_DEPTH = 4;

export type QueryImporters = (targetFilePath: string) => Promise<readonly string[]>;

export interface ComputeIncrementalWritableFilesInput {
  readonly hashDiff: FileHashDiff;
  readonly priorFileSet: ReadonlySet<string>;
  readonly queryImporters: QueryImporters;
  readonly maxImporterDepth?: number;
}

export interface IncrementalWritableFilesResult {
  /** Files whose rows should be rewritten before graph-boundary expansion. */
  readonly writableFiles: ReadonlySet<string>;
  /** Shadow candidates seeded into importer traversal for newly added files. */
  readonly shadowSeeds: readonly string[];
  /** Number of importer files added to the writable set. */
  readonly importerExpansionCount: number;
  /** Query failures swallowed to preserve the existing best-effort behavior. */
  readonly importerQueryFailures: readonly string[];
}

/**
 * Expand changed/added files with previous-run importers.
 *
 * Deleted files and shadow candidates are part of the BFS frontier but are
 * not added to `writableFiles` by this helper. That mirrors the historical
 * `runFullAnalysis` behavior: deleted files are handled by the delete list,
 * and shadow candidates exist only to find their previous importers.
 */
export const computeIncrementalWritableFiles = async ({
  hashDiff,
  priorFileSet,
  queryImporters,
  maxImporterDepth = DEFAULT_MAX_IMPORTER_BFS_DEPTH,
}: ComputeIncrementalWritableFilesInput): Promise<IncrementalWritableFilesResult> => {
  const writableFiles = new Set<string>(hashDiff.toWrite);
  const directlyChangedCount = writableFiles.size;

  const shadowSeeds: string[] = [];
  for (const added of hashDiff.added) {
    for (const candidate of shadowCandidatesFor(added)) {
      if (priorFileSet.has(candidate) && !writableFiles.has(candidate)) {
        shadowSeeds.push(candidate);
      }
    }
  }

  const importerQueryFailures: string[] = [];
  let frontier: string[] = [...hashDiff.toWrite, ...hashDiff.deleted, ...shadowSeeds];
  for (let depth = 0; depth < maxImporterDepth && frontier.length > 0; depth++) {
    const nextFrontier: string[] = [];
    for (const filePath of frontier) {
      let importers: readonly string[];
      try {
        importers = await queryImporters(filePath);
      } catch {
        importerQueryFailures.push(filePath);
        continue;
      }
      for (const importer of importers) {
        if (!writableFiles.has(importer)) {
          writableFiles.add(importer);
          nextFrontier.push(importer);
        }
      }
    }
    frontier = nextFrontier;
  }

  return {
    writableFiles,
    shadowSeeds,
    importerExpansionCount: writableFiles.size - directlyChangedCount,
    importerQueryFailures,
  };
};
