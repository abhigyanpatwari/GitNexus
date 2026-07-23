/**
 * Instance-ownership free-call gate benchmark.
 *
 * Generates C# and Kotlin projects where every file contains a caller and an
 * unrelated class method with the same receiver-less call name. Repeated calls
 * stress the ownership gate that prevents the same-file fallback from linking
 * those unrelated methods.
 *
 * Run:
 *   cd gitnexus && GITNEXUS_BENCH=1 npx vitest run test/integration/instance-ownership-pipeline-benchmark.test.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

const BENCH_ENABLED = process.env.GITNEXUS_BENCH === '1';
const CALLS_PER_FILE = 24;
// time growth divided by file growth: quadratic work reaches 2 on a doubling.
const NORMALIZED_SCALING_LIMIT = 2;

interface BenchResult {
  fileCount: number;
  callCount: number;
  elapsedMs: number;
  peakHeapMB: number;
}

interface LanguageCase {
  readonly label: string;
  readonly extension: string;
  source(fileIndex: number): string;
}

const LANGUAGES: readonly LanguageCase[] = [
  {
    label: 'C#',
    extension: 'cs',
    source: (fileIndex) => `namespace Bench${fileIndex};

public class Caller${fileIndex}
{
${Array.from(
  { length: CALLS_PER_FILE },
  (_, callIndex) => `    public void Run${callIndex}() { Foreign(); }`,
).join('\n')}
}

public class Unrelated${fileIndex}
{
    public void Foreign() {}
}
`,
  },
  {
    label: 'Kotlin',
    extension: 'kt',
    source: (fileIndex) => `package bench${fileIndex}

class Caller${fileIndex} {
${Array.from(
  { length: CALLS_PER_FILE },
  (_, callIndex) => `    fun run${callIndex}() { foreign() }`,
).join('\n')}
}

class Unrelated${fileIndex} {
    fun foreign() {}
}
`,
  },
];

function generateFixture(language: LanguageCase, fileCount: number): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), `instance-ownership-${language.extension}-${fileCount}-`),
  );
  for (let i = 0; i < fileCount; i++) {
    fs.writeFileSync(path.join(dir, `Case${i}.${language.extension}`), language.source(i));
  }
  return dir;
}

async function runBenchmark(language: LanguageCase, fileCount: number): Promise<BenchResult> {
  const dir = generateFixture(language, fileCount);
  let peakHeapMB = 0;
  const heapSampler = setInterval(() => {
    peakHeapMB = Math.max(peakHeapMB, process.memoryUsage().heapUsed / 1024 / 1024);
  }, 25);

  try {
    const start = performance.now();
    await runPipelineFromRepo(dir, () => {}, { skipGraphPhases: true });
    return {
      fileCount,
      callCount: fileCount * CALLS_PER_FILE,
      elapsedMs: Math.round(performance.now() - start),
      peakHeapMB: Math.round(peakHeapMB),
    };
  } finally {
    clearInterval(heapSampler);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!BENCH_ENABLED)('instance-ownership free-call gate benchmark', () => {
  for (const language of LANGUAGES) {
    it(`${language.label} scales sub-quadratically with ownership-gated calls`, async () => {
      // Wide enough steps to expose quadratic growth without making this
      // opt-in benchmark impractical on contributor machines.
      let previous: BenchResult | undefined;
      for (const fileCount of [100, 250, 500]) {
        const result = await runBenchmark(language, fileCount);
        console.log(
          `${language.label}: ${result.fileCount} files / ${result.callCount} calls: ` +
            `${result.elapsedMs}ms, ${result.peakHeapMB}MB heap`,
        );

        if (previous !== undefined) {
          const fileRatio = result.fileCount / previous.fileCount;
          const timeRatio = result.elapsedMs / previous.elapsedMs;
          expect(timeRatio / fileRatio).toBeLessThan(NORMALIZED_SCALING_LIMIT);
        }
        previous = result;
      }
    }, 600_000);
  }
});
