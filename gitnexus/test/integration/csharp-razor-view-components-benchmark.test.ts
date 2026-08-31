/**
 * C# Razor ViewComponent extractor + loader scaling guards (#2991).
 *
 * The coverage job always runs the tripwire (direct extractors, no worker).
 * GITNEXUS_BENCH=1 additionally checks sub-quadratic scaling and that the
 * production loader retains invocation names instead of view source.
 *
 * Run: GITNEXUS_BENCH=1 npx vitest run test/integration/csharp-razor-view-components-benchmark.test.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extractCsharpViewComponentInvocations,
  extractRazorViewComponentInvocations,
  loadRazorViewComponentConfig,
} from '../../src/core/ingestion/languages/csharp/razor-view-components.js';

const BENCH_ENABLED = process.env.GITNEXUS_BENCH === '1';
const PAD = 'x'.repeat(4_000);

function csharpMixed(i: number): string {
  if (i % 10 === 0) {
    return (
      'using Microsoft.AspNetCore.Mvc;\n' +
      `class C${i} {\n` +
      '  async Task T() {\n' +
      '    await Component.InvokeAsync("Cart");\n' +
      '  }\n' +
      '}\n' +
      `// ${PAD}\n`
    );
  }
  if (i % 10 === 1) {
    return `// ViewComponent decoy\nclass C${i} { string s = "InvokeAsync"; }\n// ${PAD}\n`;
  }
  return `class C${i} { int X => ${i}; }\n// ${PAD}\n`;
}

function razorMixed(i: number): string {
  if (i % 10 === 0) {
    return `@await Component.InvokeAsync("Cart")\n<!-- ${PAD} -->\n`;
  }
  if (i % 10 === 1) {
    return (
      '@* @await Component.InvokeAsync("Dead") *@\n' +
      '@@await Component.InvokeAsync("Escaped")\n' +
      '@* <vc:login /> *@\n' +
      `<!-- ${PAD} -->\n`
    );
  }
  return `<p>hello ${i}</p>\n<!-- ${PAD} -->\n`;
}

function expectedHits(fileCount: number): number {
  return fileCount > 0 ? Math.floor((fileCount - 1) / 10) + 1 : 0;
}

function scanCsharp(fileCount: number): { hits: number; elapsedMs: number } {
  const sources = Array.from({ length: fileCount }, (_, i) => csharpMixed(i));
  const started = performance.now();
  let hits = 0;
  for (const source of sources) {
    hits += extractCsharpViewComponentInvocations(source).length;
  }
  return { hits, elapsedMs: performance.now() - started };
}

function scanRazor(fileCount: number): { hits: number; elapsedMs: number } {
  const sources = Array.from({ length: fileCount }, (_, i) => razorMixed(i));
  const started = performance.now();
  let hits = 0;
  for (const source of sources) {
    hits += extractRazorViewComponentInvocations(source).length;
  }
  return { hits, elapsedMs: performance.now() - started };
}

/**
 * Direct extractor tripwire for the coverage job. Coarse budget: far above the
 * measured linear path, far below a full-corpus character-by-character scan of
 * every padded view without the token prefilter.
 */
describe('C# Razor ViewComponent extractor tripwire', () => {
  it('scans a 400-file mixed corpus well under the O(n^2) budget', () => {
    const FILE_COUNT = 400;
    const BUDGET_MS = 2_000;
    scanCsharp(40);
    scanRazor(40);

    const csharp = scanCsharp(FILE_COUNT);
    const razor = scanRazor(FILE_COUNT);
    expect(csharp.hits).toBe(expectedHits(FILE_COUNT));
    expect(razor.hits).toBe(expectedHits(FILE_COUNT));
    expect(csharp.elapsedMs + razor.elapsedMs).toBeLessThan(BUDGET_MS);
  }, 15_000);
});

describe.skipIf(!BENCH_ENABLED)('C# Razor ViewComponent extractor benchmark', () => {
  it('scales sub-quadratically as mixed C# and Razor corpora grow', () => {
    scanCsharp(50);
    scanRazor(50);

    const csharpSmall = scanCsharp(500);
    const csharpLarge = scanCsharp(2_000);
    const razorSmall = scanRazor(500);
    const razorLarge = scanRazor(2_000);
    const ratio = 2_000 / 500;

    console.log('\nC# Razor ViewComponent extractor benchmark');
    console.log(
      `  csharp files=500 wall=${csharpSmall.elapsedMs.toFixed(2)}ms hits=${csharpSmall.hits}`,
    );
    console.log(
      `  csharp files=2000 wall=${csharpLarge.elapsedMs.toFixed(2)}ms hits=${csharpLarge.hits}`,
    );
    console.log(
      `  razor files=500 wall=${razorSmall.elapsedMs.toFixed(2)}ms hits=${razorSmall.hits}`,
    );
    console.log(
      `  razor files=2000 wall=${razorLarge.elapsedMs.toFixed(2)}ms hits=${razorLarge.hits}`,
    );

    expect(csharpSmall.hits).toBe(expectedHits(500));
    expect(csharpLarge.hits).toBe(expectedHits(2_000));
    expect(razorSmall.hits).toBe(expectedHits(500));
    expect(razorLarge.hits).toBe(expectedHits(2_000));

    if (csharpSmall.elapsedMs >= 5) {
      expect(csharpLarge.elapsedMs / csharpSmall.elapsedMs).toBeLessThan(Math.pow(ratio, 1.5));
    }
    if (razorSmall.elapsedMs >= 5) {
      expect(razorLarge.elapsedMs / razorSmall.elapsedMs).toBeLessThan(Math.pow(ratio, 1.5));
    }
    expect(csharpLarge.elapsedMs).toBeLessThan(5_000);
    expect(razorLarge.elapsedMs).toBeLessThan(5_000);
  }, 60_000);

  it('loader retains invocation names instead of view source', async () => {
    const FILE_COUNT = 2_000;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-razor-vc-bench-'));
    try {
      fs.mkdirSync(path.join(dir, 'Views'), { recursive: true });
      for (let i = 0; i < FILE_COUNT; i++) {
        fs.writeFileSync(path.join(dir, 'Views', `v${i}.cshtml`), razorMixed(i));
      }

      await loadRazorViewComponentConfig(dir);

      const started = performance.now();
      const config = await loadRazorViewComponentConfig(dir);
      const elapsedMs = performance.now() - started;

      let sourceBytes = 0;
      let retainedChars = 0;
      let hits = 0;
      for (const names of config.views.values()) {
        hits += names.length;
        for (const name of names) retainedChars += name.length;
      }
      for (let i = 0; i < FILE_COUNT; i++) {
        sourceBytes += Buffer.byteLength(razorMixed(i));
      }

      console.log(
        `  loader files=${FILE_COUNT} wall=${elapsedMs.toFixed(2)}ms ` +
          `source=${(sourceBytes / 1024 / 1024).toFixed(2)}MB retainedChars=${retainedChars}`,
      );

      expect(config.views.size).toBe(FILE_COUNT);
      expect(hits).toBe(expectedHits(FILE_COUNT));
      expect(retainedChars).toBeLessThan(sourceBytes / 20);
      expect(elapsedMs).toBeLessThan(15_000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
