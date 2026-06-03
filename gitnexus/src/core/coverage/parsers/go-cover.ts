// gitnexus/src/core/coverage/parsers/go-cover.ts
import type { CanonicalCoverage, CoverageRunMeta, FileCoverage } from '../types.js';

export function parseGoCover(input: string, meta: CoverageRunMeta): CanonicalCoverage {
  const files: Record<string, FileCoverage> = {};
  let totalLines = 0;
  let coveredLines = 0;

  const lines = input.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('mode:')) continue;

    const match = trimmed.match(/^(.+?):(\d+)\.\d+,(\d+)\.\d+\s+(\d+)\s+(\d+)$/);
    if (!match) continue;

    const [, filePath, startLine, endLine, numStmts, count] = match;
    const start = parseInt(startLine, 10);
    const end = parseInt(endLine, 10);
    const hitCount = parseInt(count, 10);
    const stmts = parseInt(numStmts, 10);

    if (!files[filePath]) {
      files[filePath] = { lines: {}, branches: {} };
    }

    for (let l = start; l <= end; l++) {
      files[filePath].lines[l.toString()] = (files[filePath].lines[l.toString()] ?? 0) + hitCount;
    }
    totalLines += stmts;
    if (hitCount > 0) coveredLines += stmts;
  }

  return {
    format: 'gitnexus-coverage-v1',
    run: { ...meta, totalLines, coveredLines },
    files,
  };
}
