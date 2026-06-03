// gitnexus/src/core/coverage/streaming.ts
import { createInterface } from 'readline';
import type { Readable } from 'stream';
import type { CanonicalCoverage, CoverageRunMeta } from './types.js';
import { ingestCoverage, type IngestOptions } from './ingestor.js';

export async function streamIngest(
  input: Readable,
  opts: IngestOptions,
  meta: CoverageRunMeta,
  batchSize = 1000,
  flushIntervalMs = 100,
): Promise<string> {
  const rl = createInterface({ input, crlfDelay: Infinity });

  const accumulator: { files: Record<string, { lines: Record<string, number>; branches?: Record<string, number> }>; totalLines: number; coveredLines: number } = {
    files: {},
    totalLines: 0,
    coveredLines: 0,
  };

  let lineCount = 0;
  let lastFlush = Date.now();
  const runId = meta.id;

  const flush = () => {
    if (Object.keys(accumulator.files).length === 0) return;

    const snapshot: CanonicalCoverage = {
      format: 'gitnexus-coverage-v1',
      run: {
        ...meta,
        totalLines: accumulator.totalLines,
        coveredLines: accumulator.coveredLines,
      },
      files: { ...accumulator.files },
    };

    ingestCoverage(snapshot, opts);

    accumulator.files = {};
    accumulator.totalLines = 0;
    accumulator.coveredLines = 0;
    lineCount = 0;
    lastFlush = Date.now();
  };

  for await (const line of rl) {
    if (!line.trim()) continue;
    lineCount++;

    try {
      const parsed = JSON.parse(line);
      if (!parsed.file || !parsed.line) continue;

      const file = parsed.file as string;
      const lineNum = parsed.line as number;
      const count = (parsed.count as number) ?? 1;

      if (!accumulator.files[file]) {
        accumulator.files[file] = { lines: {} };
      }
      accumulator.files[file].lines[lineNum.toString()] =
        (accumulator.files[file].lines[lineNum.toString()] ?? 0) + count;

      accumulator.totalLines++;
      if (count > 0) accumulator.coveredLines++;
    } catch {
      continue;
    }

    if (lineCount >= batchSize || (Date.now() - lastFlush) >= flushIntervalMs) {
      flush();
    }
  }

  flush();

  return runId;
}
