// gitnexus/src/core/coverage/parsers/lcov.ts
import type { CanonicalCoverage, CoverageRunMeta, FileCoverage } from '../types.js';

/**
 * Parse LCOV .info format into CanonicalCoverage.
 *
 * LCOV format:
 *   TN:<test name>
 *   SF:<source file path>
 *   DA:<lineNumber>,<hitCount>
 *   BRDA:<lineNumber>,<block>,<branch>,<taken>
 *   LF:<lines found>
 *   LH:<lines hit>
 *   end_of_record
 */
export function parseLcov(input: string, meta: CoverageRunMeta): CanonicalCoverage {
  const files: Record<string, FileCoverage> = {};
  let currentFile: string | null = null;
  let currentCoverage: FileCoverage | null = null;
  let totalLines = 0;
  let coveredLines = 0;

  const lines = input.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === 'end_of_record') {
      currentFile = null;
      currentCoverage = null;
      continue;
    }

    if (trimmed.startsWith('SF:')) {
      currentFile = trimmed.slice(3);
      currentCoverage = { lines: {}, branches: {} };
      files[currentFile] = currentCoverage;
      continue;
    }

    if (trimmed.startsWith('DA:') && currentCoverage) {
      const [lineNum, hits] = trimmed.slice(3).split(',');
      const hitsNum = parseInt(hits, 10);
      currentCoverage.lines[lineNum] = hitsNum;
      totalLines++;
      if (hitsNum > 0) coveredLines++;
      continue;
    }

    if (trimmed.startsWith('BRDA:') && currentCoverage) {
      const parts = trimmed.slice(5).split(',');
      if (parts.length >= 4) {
        const [lineNum, , branch, taken] = parts;
        const branchId = `${lineNum}:${branch}`;
        currentCoverage.branches![branchId] = taken === '-' ? 0 : parseInt(taken, 10);
      }
      continue;
    }
  }

  return {
    format: 'gitnexus-coverage-v1',
    run: {
      ...meta,
      totalLines,
      coveredLines,
    },
    files,
  };
}
