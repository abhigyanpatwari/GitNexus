/**
 * C# ingestion pipeline benchmark.
 *
 * Generates synthetic C# codebases at increasing scales and measures
 * wall-clock time and peak heap through the full pipeline — parsing,
 * scope extraction, C# namespace-siblings (same-namespace cross-file
 * visibility, using-static, cross-namespace imports), and call
 * resolution.
 *
 * Mirrors test/integration/php-pipeline-benchmark.test.ts. Two shapes:
 *   1. "spread" — files distributed across many namespaces (the common
 *      case; each namespace bucket stays small).
 *   2. "concentrated" — every file in the SAME (or global/no) namespace,
 *      so a single namespace bucket holds all type defs. This is the
 *      shape that drove the Unity-solution OOM: `populateCsharpNamespaceSiblings`
 *      materialises O(scopes × defs) BindingRefs into that one bucket.
 *      The concentrated test is the regression guard for that path.
 *
 * Run: GITNEXUS_BENCH=1 npx vitest run test/integration/csharp-pipeline-benchmark.test.ts
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

type FixtureShape = 'spread' | 'concentrated' | 'concentrated-named';

function generateCsharpFixture(
  fileCount: number,
  namespacesPerLevel: number,
  shape: FixtureShape,
): { dir: string; classCount: number; namespaceCount: number } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `csharp-bench-${shape}-${fileCount}-`));

  // "spread": square grid of namespaces. "concentrated": a single global
  // (no-namespace) bucket so every type lands in the `''` bucket — the #1954
  // OOM-prone path. "concentrated-named": every file in ONE named namespace
  // (`namespace App;`) — the #1871 named-namespace twin, which the global-only
  // fix did not cover. Both concentrated shapes put all N type defs in a single
  // bucket; "concentrated-named" exercises the per-namespace channel rather than
  // the flat workspace channel.
  const namespaces: string[] = [];
  if (shape === 'spread') {
    for (let i = 0; i < namespacesPerLevel; i++) {
      for (let j = 0; j < namespacesPerLevel; j++) {
        namespaces.push(`App.Module${i}.Sub${j}`);
      }
    }
  } else if (shape === 'concentrated-named') {
    namespaces.push('App'); // single named namespace — all files share it
  } else {
    namespaces.push(''); // global / no namespace declaration
  }

  const classCount = fileCount;
  const namespaceCount = namespaces.length;

  for (let f = 0; f < fileCount; f++) {
    const ns = namespaces[f % namespaces.length]!;
    const className = `Class${f}`;
    // Concentrated files share a flat directory; spread files mirror the
    // namespace as a directory tree (matches typical C# project layout).
    const targetDir = ns === '' ? dir : path.join(dir, ns.replace(/\./g, '/'));
    fs.mkdirSync(targetDir, { recursive: true });

    const siblingIdx = (f + 1) % fileCount;
    const siblingClass = `Class${siblingIdx}`;

    const crossNsIdx = (f + Math.floor(fileCount / 3)) % fileCount;
    const crossNs = namespaces[crossNsIdx % namespaces.length]!;
    const crossClass = `Class${crossNsIdx}`;
    const usesCross = ns !== '' && ns !== crossNs;

    const body = [
      ns !== '' ? `namespace ${ns};` : '',
      usesCross ? `using ${crossNs};` : '',
      '',
      `public class ${className}`,
      '{',
      '    private int id;',
      '    private string name;',
      '',
      '    public int GetId()',
      '    {',
      '        return this.id;',
      '    }',
      '',
      // Unique method name per file. Each method's return-type binding is
      // hoisted to the file's MODULE scope keyed by the method name, so unique
      // names give the global ('') namespace a DISTINCT module-typeBinding key
      // per file. A shared name (e.g. plain `Process`) collapses every file's
      // key to one, which made the per-file typeBindings propagation skip all
      // copies and HID the O(files²) #1871 blow-up. Unique names exercise the
      // real concentrated-global path that OOM'd large no-namespace solutions.
      `    public ${siblingClass} Process${f}()`,
      '    {',
      `        var sibling = new ${siblingClass}();`,
      '        return sibling;',
      '    }',
      usesCross
        ? [
            '',
            `    public ${crossClass} CrossCall()`,
            '    {',
            `        var cross = new ${crossClass}();`,
            '        cross.GetId();',
            '        return cross;',
            '    }',
          ].join('\n')
        : '',
      '}',
      '',
    ]
      .filter(Boolean)
      .join('\n');

    fs.writeFileSync(path.join(targetDir, `${className}.cs`), body);
  }

  // Minimal SDK-style csproj so the C# project-loading phase engages
  // (matches the real-world Unity/.NET solution path).
  const csproj = [
    '<Project Sdk="Microsoft.NET.Sdk">',
    '  <PropertyGroup>',
    '    <TargetFramework>net8.0</TargetFramework>',
    '    <Nullable>enable</Nullable>',
    '  </PropertyGroup>',
    '</Project>',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'Bench.csproj'), csproj);

  return { dir, classCount, namespaceCount };
}

async function runBenchmark(
  fileCount: number,
  nsLevels: number,
  shape: FixtureShape,
  budgetMs: number,
): Promise<BenchResult> {
  const { dir, classCount, namespaceCount } = generateCsharpFixture(fileCount, nsLevels, shape);

  let peakHeapMB = 0;
  const heapSampler = setInterval(() => {
    const heap = process.memoryUsage().heapUsed / 1024 / 1024;
    if (heap > peakHeapMB) peakHeapMB = heap;
  }, 50);

  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const start = Date.now();
    const result = await Promise.race([
      runPipelineFromRepo(dir, () => {}, { skipGraphPhases: true }),
      new Promise<never>((_, reject) => {
        budgetTimer = setTimeout(
          () =>
            reject(new Error(`Pipeline exceeded ${budgetMs}ms at ${fileCount} files (${shape})`)),
          budgetMs,
        );
      }),
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
    clearTimeout(budgetTimer);
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

describe.skipIf(!BENCH_ENABLED)('C# pipeline benchmark', () => {
  it('scales with file count — namespaces spread across the solution', async () => {
    const scales = [100, 250, 500];
    const results: BenchResult[] = [];

    for (const fileCount of scales) {
      const nsLevels = Math.max(2, Math.ceil(Math.sqrt(fileCount / 4)));
      const result = await runBenchmark(fileCount, nsLevels, 'spread', 180_000);
      results.push(result);
      console.log(
        `  ${fileCount} files: ${result.elapsedMs}ms, ${result.peakHeapMB}MB heap, ${result.nodeCount} nodes, ${result.edgeCount} edges`,
      );
    }

    printResults('C# Pipeline — Namespaces Spread', results);

    for (let i = 1; i < results.length; i++) {
      const fileRatio = results[i].fileCount / results[i - 1].fileCount;
      const timeRatio = results[i].elapsedMs / results[i - 1].elapsedMs;
      expect(timeRatio / fileRatio).toBeLessThan(3);
    }
  }, 600_000);

  it('scales with file count — all types in one (global) namespace bucket', async () => {
    // Regression guard for the Unity-solution OOM: a single namespace
    // bucket holds every type def, so naive per-scope binding
    // materialisation is O(files²). Time must stay sub-quadratic and the
    // run must not OOM.
    //
    // Scales reach 2000 deliberately: with the #1871 regression present
    // (per-file global typeBindings copy), the 1000→2000 step measured ~3.06×
    // for a 2× file increase — failing the <3 sub-quadratic assertion below.
    // The workspaceTypeBindings fast-path keeps it ~linear (~1.2×).
    const scales = [500, 1000, 2000];
    const results: BenchResult[] = [];

    for (const fileCount of scales) {
      const result = await runBenchmark(fileCount, 1, 'concentrated', 180_000);
      results.push(result);
      console.log(
        `  ${fileCount} files: ${result.elapsedMs}ms, ${result.peakHeapMB}MB heap, ${result.nodeCount} nodes, ${result.edgeCount} edges`,
      );
    }

    printResults('C# Pipeline — Concentrated Global Namespace', results);

    for (let i = 1; i < results.length; i++) {
      const fileRatio = results[i].fileCount / results[i - 1].fileCount;
      const timeRatio = results[i].elapsedMs / results[i - 1].elapsedMs;
      expect(timeRatio / fileRatio).toBeLessThan(3);
    }
  }, 600_000);

  it('scales with file count — all types in one (named) namespace bucket', async () => {
    // Regression guard for the #1871 named-namespace twin: every file under one
    // `namespace App;`, so the `App` bucket holds every type def. The global-only
    // fix (#1954, workspaceTypeBindings) did NOT cover this — the per-file
    // namespace-siblings copy (both the BindingRef augmentation and the
    // typeBindings mirror) was still O(files²) for a concentrated named
    // namespace. The per-namespace channels (namespaceFqnBindings /
    // namespaceTypeBindings) keep it sub-quadratic; with the fix reverted the
    // 1000→2000 step goes quadratic and trips the <3 assertion below.
    const scales = [500, 1000, 2000];
    const results: BenchResult[] = [];

    for (const fileCount of scales) {
      const result = await runBenchmark(fileCount, 1, 'concentrated-named', 180_000);
      results.push(result);
      console.log(
        `  ${fileCount} files: ${result.elapsedMs}ms, ${result.peakHeapMB}MB heap, ${result.nodeCount} nodes, ${result.edgeCount} edges`,
      );
    }

    printResults('C# Pipeline — Concentrated Named Namespace', results);

    // The fixture must actually exercise cross-file resolution (not just
    // parsing), or the scaling assertion would pass vacuously.
    expect(results[results.length - 1].edgeCount).toBeGreaterThan(0);

    for (let i = 1; i < results.length; i++) {
      const fileRatio = results[i].fileCount / results[i - 1].fileCount;
      const timeRatio = results[i].elapsedMs / results[i - 1].elapsedMs;
      expect(timeRatio / fileRatio).toBeLessThan(3);
    }
  }, 600_000);
});
