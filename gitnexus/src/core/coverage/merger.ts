// gitnexus/src/core/coverage/merger.ts
import type { CanonicalCoverage, CoverageRunMeta } from './types.js';
import { CoverageStore } from './store.js';
import { ingestCoverage, type IngestOptions } from './ingestor.js';

export function mergeRuns(
  runIds: string[],
  store: CoverageStore,
  opts: IngestOptions,
  mergedMeta: CoverageRunMeta,
): string {
  const mergedLineHits = store.getMergedLineHits(runIds);
  const mergedBranchHits = store.getMergedBranchHits(runIds);

  let totalLines = 0;
  let coveredLines = 0;

  const files: Record<string, { lines: Record<string, number>; branches?: Record<string, number> }> = {};

  for (const [filePath, lineMap] of mergedLineHits) {
    const lineEntries: Record<string, number> = {};
    for (const [lineNum, hitCount] of lineMap) {
      const key = lineNum.toString();
      lineEntries[key] = hitCount;
      totalLines++;
      if (hitCount > 0) coveredLines++;
    }

    const branchEntries: Record<string, number> | undefined =
      mergedBranchHits.has(filePath)
        ? Object.fromEntries(
            [...mergedBranchHits.get(filePath)!.entries()].map(
              ([branchId, count]) => [branchId, count],
            ),
          )
        : undefined;

    files[filePath] = { lines: lineEntries, branches: branchEntries };
  }

  const merged: CanonicalCoverage = {
    format: 'gitnexus-coverage-v1',
    run: { ...mergedMeta, totalLines, coveredLines },
    files,
  };

  return ingestCoverage(merged, opts);
}
