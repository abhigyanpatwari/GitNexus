/**
 * PHP ingestion pipeline benchmark.
 *
 * Generates synthetic PHP codebases at increasing scales and measures
 * wall-clock time and peak heap through the full pipeline — parsing,
 * scope extraction, namespace-siblings (Steps 1-4), and call resolution.
 *
 * Run: GITNEXUS_BENCH=1 npx vitest run test/integration/php-pipeline-benchmark.test.ts
 *
 * The benchmark uses workers (production path) by default. Set
 * skipWorkers to test the sequential fallback path.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

const BENCH_ENABLED = process.env.GITNEXUS_BENCH === '1';

interface BenchResult {
  fileCount: number;
  classCount: number;
  namespaceCount: number;
  elapsedMs: number;
  peakHeapMB: number;
  nodeCount: number;
  edgeCount: number;
}

function generatePhpFixture(
  fileCount: number,
  namespacesPerLevel: number,
): { dir: string; classCount: number; namespaceCount: number } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `php-bench-${fileCount}-`));
  const namespaces: string[] = [];

  for (let i = 0; i < namespacesPerLevel; i++) {
    for (let j = 0; j < namespacesPerLevel; j++) {
      namespaces.push(`App\\Module${i}\\Sub${j}`);
    }
  }

  const classCount = fileCount;
  const namespaceCount = namespaces.length;

  for (let f = 0; f < fileCount; f++) {
    const ns = namespaces[f % namespaces.length];
    const nsDir = ns.replace(/\\/g, '/');
    const className = `Class${f}`;
    const targetDir = path.join(dir, nsDir);
    fs.mkdirSync(targetDir, { recursive: true });

    const siblingIdx = (f + 1) % fileCount;
    const siblingClass = `Class${siblingIdx}`;

    const crossNsIdx = (f + Math.floor(fileCount / 3)) % fileCount;
    const crossNs = namespaces[crossNsIdx % namespaces.length];
    const crossClass = `Class${crossNsIdx}`;

    const content = [
      '<?php',
      `namespace ${ns};`,
      '',
      ns !== crossNs ? `use ${crossNs}\\${crossClass};` : '',
      '',
      `class ${className}`,
      '{',
      `    private int $id;`,
      `    private string $name;`,
      '',
      `    public function getId(): int`,
      '    {',
      '        return $this->id;',
      '    }',
      '',
      `    public function process(): ${siblingClass}`,
      '    {',
      `        $sibling = new ${siblingClass}();`,
      '        return $sibling;',
      '    }',
      '',
      ns !== crossNs
        ? [
            `    public function crossCall(): ${crossClass}`,
            '    {',
            `        $cross = new ${crossClass}();`,
            `        $cross->getId();`,
            '        return $cross;',
            '    }',
          ].join('\n')
        : '',
      '}',
      '',
    ]
      .filter(Boolean)
      .join('\n');

    fs.writeFileSync(path.join(targetDir, `${className}.php`), content);
  }

  const composerJson = {
    name: 'bench/php-pipeline',
    autoload: { 'psr-4': { 'App\\': 'App/' } },
  };
  fs.writeFileSync(path.join(dir, 'composer.json'), JSON.stringify(composerJson, null, 2));

  return { dir, classCount, namespaceCount };
}

async function runBenchmark(
  fileCount: number,
  nsLevels: number,
  budgetMs: number,
): Promise<BenchResult> {
  const { dir, classCount, namespaceCount } = generatePhpFixture(fileCount, nsLevels);

  let peakHeapMB = 0;
  const heapSampler = setInterval(() => {
    const heap = process.memoryUsage().heapUsed / 1024 / 1024;
    if (heap > peakHeapMB) peakHeapMB = heap;
  }, 50);

  try {
    const start = Date.now();
    const result = await Promise.race([
      runPipelineFromRepo(dir, () => {}, { skipGraphPhases: true }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Pipeline exceeded ${budgetMs}ms at ${fileCount} files`)),
          budgetMs,
        ),
      ),
    ]);
    const elapsedMs = Date.now() - start;

    return {
      fileCount,
      classCount,
      namespaceCount,
      elapsedMs,
      peakHeapMB: Math.round(peakHeapMB),
      nodeCount: result.graph.nodeCount,
      edgeCount: result.graph.relationshipCount,
    };
  } finally {
    clearInterval(heapSampler);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function printResults(label: string, results: BenchResult[]) {
  console.log(`\n${label}`);
  console.log('┌──────────┬─────────┬──────────┬───────────┬──────────┬───────┬───────┐');
  console.log('│ Files    │ Classes │ NS Count │ Time (ms) │ Heap MB  │ Nodes │ Edges │');
  console.log('├──────────┼─────────┼──────────┼───────────┼──────────┼───────┼───────┤');
  for (const r of results) {
    console.log(
      `│ ${String(r.fileCount).padStart(8)} │ ${String(r.classCount).padStart(7)} │ ${String(r.namespaceCount).padStart(8)} │ ${String(r.elapsedMs).padStart(9)} │ ${String(r.peakHeapMB).padStart(8)} │ ${String(r.nodeCount).padStart(5)} │ ${String(r.edgeCount).padStart(5)} │`,
    );
  }
  console.log('└──────────┴─────────┴──────────┴───────────┴──────────┴───────┴───────┘');

  if (results.length >= 2) {
    console.log('\nScaling ratios (time_ratio / file_ratio):');
    for (let i = 1; i < results.length; i++) {
      const fileRatio = results[i].fileCount / results[i - 1].fileCount;
      const timeRatio = results[i].elapsedMs / results[i - 1].elapsedMs;
      const scaling = timeRatio / fileRatio;
      console.log(
        `  ${results[i - 1].fileCount} → ${results[i].fileCount}: ${scaling.toFixed(2)}x (${scaling < 1.5 ? 'linear' : scaling < 3 ? 'superlinear' : 'WARNING: quadratic'})`,
      );
    }
  }
}

describe.skipIf(!BENCH_ENABLED)('PHP pipeline benchmark', () => {
  it('scales with file count (workers enabled)', async () => {
    const scales = [100, 250, 500];
    const results: BenchResult[] = [];

    for (const fileCount of scales) {
      const nsLevels = Math.max(2, Math.ceil(Math.sqrt(fileCount / 4)));
      const result = await runBenchmark(fileCount, nsLevels, 180_000);
      results.push(result);
      console.log(
        `  ${fileCount} files: ${result.elapsedMs}ms, ${result.peakHeapMB}MB heap, ${result.nodeCount} nodes, ${result.edgeCount} edges`,
      );
    }

    printResults('PHP Pipeline — Workers Enabled', results);

    for (let i = 1; i < results.length; i++) {
      const fileRatio = results[i].fileCount / results[i - 1].fileCount;
      const timeRatio = results[i].elapsedMs / results[i - 1].elapsedMs;
      expect(timeRatio / fileRatio).toBeLessThan(3);
    }
  }, 300_000);
});
