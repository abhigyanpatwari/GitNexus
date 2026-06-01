/**
 * Go ingestion pipeline benchmark.
 *
 * Generates synthetic Go codebases at increasing scales and measures
 * wall-clock time and peak heap through the full pipeline — parsing,
 * Go scope capture (emitGoScopeCaptures), package/import resolution, and
 * call resolution.
 *
 * Run: GITNEXUS_BENCH=1 npx vitest run test/integration/go-pipeline-benchmark.test.ts
 *
 * The first suite ("scales with file count") generates many small files —
 * each a struct plus getter/setter/compute methods, the DAO-style shape that
 * stresses the Go scope-capture path. Run under vitest it falls back to the
 * sequential path (no compiled worker), so it measures parse + scope-capture
 * scaling without the worker pool.
 *
 * The second suite ("worker pool — issue #1848") reproduces the actual bug:
 * it points the pool at the COMPILED `dist/.../parse-worker.js` (real
 * worker_threads), generates one ~400 KiB generated-DAO file plus padding so
 * the 15-file worker threshold trips, and runs with a short sub-batch idle
 * timeout. Under the buggy code the worker looks idle while inside
 * emitGoScopeCaptures and the file is quarantined; the fix emits progress so
 * the file survives. Requires a build first:
 *
 *   (cd gitnexus && npm run build)
 *   GITNEXUS_BENCH=1 npx vitest run test/integration/go-pipeline-benchmark.test.ts
 *
 * The worker suite auto-skips if the compiled worker is absent.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import {
  emitGoScopeCaptures,
  detectGoInterfaceImplementations,
} from '../../src/core/ingestion/languages/go/index.js';

const BENCH_ENABLED = process.env.GITNEXUS_BENCH === '1';

const MODULE_PATH = 'example.com/go-bench';

/**
 * The compiled worker the pool spawns. Under vitest, `import.meta.url`
 * resolves to `src/`, where no `.js` exists — so we point straight at the
 * `dist/` build, the same fallback parse-impl uses. `null` when unbuilt.
 */
const DIST_WORKER_URL = new URL(
  '../../dist/core/ingestion/workers/parse-worker.js',
  import.meta.url,
);
const DIST_WORKER_AVAILABLE = fs.existsSync(fileURLToPath(DIST_WORKER_URL));

interface BenchResult {
  fileCount: number;
  structCount: number;
  packageCount: number;
  elapsedMs: number;
  peakHeapMB: number;
  nodeCount: number;
  edgeCount: number;
}

function generateGoFixture(
  fileCount: number,
  packageCount: number,
): { dir: string; structCount: number; packageCount: number } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `go-bench-${fileCount}-`));
  fs.writeFileSync(path.join(dir, 'go.mod'), `module ${MODULE_PATH}\n\ngo 1.22\n`);

  const packages: string[] = [];
  for (let i = 0; i < packageCount; i++) {
    packages.push(`pkg${i}`);
  }

  const structCount = fileCount;
  const createdPackages = new Set<string>();

  for (let f = 0; f < fileCount; f++) {
    const pkg = packages[f % packages.length];
    const pkgDir = path.join(dir, pkg);
    if (!createdPackages.has(pkg)) {
      fs.mkdirSync(pkgDir, { recursive: true });
      createdPackages.add(pkg);
    }

    const structName = `Item${f}`;

    const siblingIdx = (f + 1) % fileCount;
    const siblingStruct = `Item${siblingIdx}`;
    const siblingPkg = packages[siblingIdx % packages.length];

    const crossIdx = (f + Math.floor(fileCount / 3)) % fileCount;
    const crossStruct = `Item${crossIdx}`;
    const crossPkg = packages[crossIdx % packages.length];

    // Only import packages we actually reference, and never our own.
    const imports = new Set<string>();
    if (siblingPkg !== pkg) imports.add(siblingPkg);
    if (crossPkg !== pkg) imports.add(crossPkg);

    const importBlock =
      imports.size > 0
        ? ['import (', ...[...imports].map((p) => `\t"${MODULE_PATH}/${p}"`), ')', '']
        : [];

    const qualify = (otherPkg: string, name: string) =>
      otherPkg === pkg ? name : `${otherPkg}.${name}`;

    const siblingRef = qualify(siblingPkg, siblingStruct);
    const siblingCtor = qualify(siblingPkg, `New${siblingStruct}`);
    const crossRef = qualify(crossPkg, crossStruct);
    const crossCtor = qualify(crossPkg, `New${crossStruct}`);

    const content = [
      `package ${pkg}`,
      '',
      ...importBlock,
      `type ${structName} struct {`,
      `\tID    int64`,
      `\tName  string`,
      `\tEmail string`,
      `\tValue float64`,
      `}`,
      '',
      `func New${structName}(id int64, name string) *${structName} {`,
      `\treturn &${structName}{ID: id, Name: name}`,
      `}`,
      '',
      `func (i *${structName}) GetID() int64 {`,
      `\treturn i.ID`,
      `}`,
      '',
      `func (i *${structName}) SetID(id int64) {`,
      `\ti.ID = id`,
      `}`,
      '',
      `func (i *${structName}) GetName() string {`,
      `\treturn i.Name`,
      `}`,
      '',
      `func (i *${structName}) SetValue(v float64) {`,
      `\ti.Value = v`,
      `}`,
      '',
      `func (i *${structName}) Compute() float64 {`,
      `\treturn i.Value * float64(i.ID)`,
      `}`,
      '',
      `func (i *${structName}) Process() *${siblingRef} {`,
      `\tsibling := ${siblingCtor}(i.ID, i.Name)`,
      `\tsibling.SetValue(i.Compute())`,
      `\treturn sibling`,
      `}`,
      '',
      `func (i *${structName}) CrossCall() *${crossRef} {`,
      `\tcross := ${crossCtor}(i.ID, i.Name)`,
      `\t_ = cross.GetID()`,
      `\treturn cross`,
      `}`,
      '',
    ].join('\n');

    fs.writeFileSync(path.join(pkgDir, `item${f}.go`), content);
  }

  return { dir, structCount, packageCount: createdPackages.size };
}

async function runBenchmark(
  fileCount: number,
  packageCount: number,
  budgetMs: number,
): Promise<BenchResult> {
  const {
    dir,
    structCount,
    packageCount: actualPackages,
  } = generateGoFixture(fileCount, packageCount);

  let peakHeapMB = 0;
  const heapSampler = setInterval(() => {
    const heap = process.memoryUsage().heapUsed / 1024 / 1024;
    if (heap > peakHeapMB) peakHeapMB = heap;
  }, 50);

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const start = Date.now();
    const result = await Promise.race([
      runPipelineFromRepo(dir, () => {}, { skipGraphPhases: true }),
      new Promise<never>((_, reject) => {
        // Hold the handle so the winning (pipeline) path can cancel it in the
        // finally — otherwise the timer lingers for up to budgetMs and its
        // late rejection surfaces as an unhandled promise rejection.
        timeoutHandle = setTimeout(
          () => reject(new Error(`Pipeline exceeded ${budgetMs}ms at ${fileCount} files`)),
          budgetMs,
        );
      }),
    ]);
    const elapsedMs = Date.now() - start;

    return {
      fileCount,
      structCount,
      packageCount: actualPackages,
      elapsedMs,
      peakHeapMB: Math.round(peakHeapMB),
      nodeCount: result.graph.nodeCount,
      edgeCount: result.graph.relationshipCount,
    };
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    clearInterval(heapSampler);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function printResults(label: string, results: BenchResult[]) {
  console.log(`\n${label}`);
  console.log('┌──────────┬─────────┬──────────┬───────────┬──────────┬───────┬───────┐');
  console.log('│ Files    │ Structs │ Packages │ Time (ms) │ Heap MB  │ Nodes │ Edges │');
  console.log('├──────────┼─────────┼──────────┼───────────┼──────────┼───────┼───────┤');
  for (const r of results) {
    console.log(
      `│ ${String(r.fileCount).padStart(8)} │ ${String(r.structCount).padStart(7)} │ ${String(r.packageCount).padStart(8)} │ ${String(r.elapsedMs).padStart(9)} │ ${String(r.peakHeapMB).padStart(8)} │ ${String(r.nodeCount).padStart(5)} │ ${String(r.edgeCount).padStart(5)} │`,
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

/**
 * Mirrors the issue #1848 reproduction fixture: one large generated-DAO Go
 * file (`package generated`, struct + 7 methods per entity) plus `padCount`
 * trivial files so parse-impl crosses the 15-file worker threshold and the
 * real worker pool engages.
 */
function generateGoQuarantineFixture(
  entityCount: number,
  padCount: number,
): { dir: string; bigFileBytes: number; fileCount: number } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `go-bench-1848-${entityCount}-`));

  const lines = [
    'package generated',
    '',
    '// Code generated for GitNexus issue #1848 repro. DO NOT EDIT.',
    '',
  ];
  for (let i = 0; i < entityCount; i++) {
    const n = String(i).padStart(4, '0');
    lines.push(`type DefUserDao${n} struct {`);
    lines.push('\tid int64');
    lines.push('\tname string');
    lines.push('\temail string');
    lines.push('\tcreatedAt int64');
    lines.push('}', '');
    lines.push(`func (d *DefUserDao${n}) GetID() int64 { return d.id }`);
    lines.push(`func (d *DefUserDao${n}) SetID(id int64) { d.id = id }`);
    lines.push(`func (d *DefUserDao${n}) GetName() string { return d.name }`);
    lines.push(`func (d *DefUserDao${n}) SetName(name string) { d.name = name }`);
    lines.push(`func (d *DefUserDao${n}) GetEmail() string { return d.email }`);
    lines.push(`func (d *DefUserDao${n}) SetEmail(email string) { d.email = email }`);
    lines.push(`func (d *DefUserDao${n}) Validate() error { return nil }`);
    lines.push('');
  }
  const bigContent = lines.join('\n');
  fs.writeFileSync(path.join(dir, 'zz_generated.def_userdao.go'), bigContent);

  for (let i = 0; i < padCount; i++) {
    const idx = String(i).padStart(2, '0');
    fs.writeFileSync(
      path.join(dir, `pad_${idx}.go`),
      `package pad${i}\n\nfunc Ping${i}() int { return ${i} }\n`,
    );
  }

  return {
    dir,
    bigFileBytes: Buffer.byteLength(bigContent),
    fileCount: 1 + padCount,
  };
}

describe.skipIf(!BENCH_ENABLED)('Go pipeline benchmark', () => {
  it('scales with file count (workers enabled)', async () => {
    const scales = [100, 250, 500];
    const results: BenchResult[] = [];

    for (const fileCount of scales) {
      const packageCount = Math.max(4, Math.ceil(Math.sqrt(fileCount)));
      const result = await runBenchmark(fileCount, packageCount, 180_000);
      results.push(result);
      console.log(
        `  ${fileCount} files: ${result.elapsedMs}ms, ${result.peakHeapMB}MB heap, ${result.nodeCount} nodes, ${result.edgeCount} edges`,
      );
    }

    printResults('Go Pipeline — Workers Enabled', results);

    for (let i = 1; i < results.length; i++) {
      const fileRatio = results[i].fileCount / results[i - 1].fileCount;
      const timeRatio = results[i].elapsedMs / results[i - 1].elapsedMs;
      // The scale steps are 2.5x (100->250) and 2x (250->500). A quadratic
      // regression makes timeRatio ~= fileRatio^2, i.e. timeRatio/fileRatio ~=
      // fileRatio (2.5 and 2.0) — which a `< 3` bound would wave through. The
      // O(n) path keeps this ratio ~1 (measured 0.44 and 0.75 post-fix), so a
      // `< 1.5` bound (the printResults "linear" boundary) actually fails on a
      // re-regression to O(n^2) while leaving comfortable headroom for linear.
      expect(timeRatio / fileRatio).toBeLessThan(1.5);
    }
  }, 300_000);
});

describe.skipIf(!BENCH_ENABLED || !DIST_WORKER_AVAILABLE)(
  'Go pipeline benchmark — worker pool (issue #1848)',
  () => {
    if (BENCH_ENABLED && !DIST_WORKER_AVAILABLE) {
      // Surfaced once when the bench is requested but the worker is unbuilt.
      console.warn(
        `\n[go-bench] Skipping worker-pool suite: compiled worker not found at\n  ${fileURLToPath(DIST_WORKER_URL)}\n  Build first: (cd gitnexus && npm run build)\n`,
      );
    }

    // Tunables mirror run-analyze-repro.sh. 800 entities ≈ 406 KiB — under the
    // 512 KiB GITNEXUS_MAX_FILE_SIZE ceiling so the file is parsed, not skipped.
    const entityCount = Number(process.env.REPRO_GO_ENTITIES ?? 800);
    // 30 s reproduces on the report author's machine; raising it (e.g. 120000)
    // is the documented workaround. Kept overridable so the same test can both
    // reproduce the bug and confirm the fix.
    const subBatchTimeoutMs = Number(process.env.GITNEXUS_WORKER_SUB_BATCH_TIMEOUT_MS ?? 30_000);

    it('does not quarantine the large generated Go file on sub-batch idle timeout', async () => {
      const { dir, bigFileBytes, fileCount } = generateGoQuarantineFixture(entityCount, 14);

      // Sub-batch knobs that force fine chunking onto the worker (env-only —
      // there is no PipelineOptions field for these two). Capture the prior
      // values before the try; set them as the first statements INSIDE it so
      // the finally's restore covers every path that mutated the process env.
      const prevMaxBytes = process.env.GITNEXUS_WORKER_SUB_BATCH_MAX_BYTES;
      const prevTimeout = process.env.GITNEXUS_WORKER_SUB_BATCH_TIMEOUT_MS;

      let peakHeapMB = 0;
      const heapSampler = setInterval(() => {
        const heap = process.memoryUsage().heapUsed / 1024 / 1024;
        if (heap > peakHeapMB) peakHeapMB = heap;
      }, 50);

      try {
        process.env.GITNEXUS_WORKER_SUB_BATCH_MAX_BYTES = '262144';
        process.env.GITNEXUS_WORKER_SUB_BATCH_TIMEOUT_MS = String(subBatchTimeoutMs);
        const start = Date.now();
        const result = await runPipelineFromRepo(dir, () => {}, {
          skipGraphPhases: true,
          // Real worker_threads against the compiled worker — the surface the
          // bug actually lives on.
          workerUrlForTest: DIST_WORKER_URL,
          // Match the repro's chunking so the byte budget mirrors the issue.
          chunkByteBudget: 262144,
          parseChunkConcurrency: 1,
        });
        const elapsedMs = Date.now() - start;

        // The big file alone emits ≥ entityCount*5 nodes (1 struct + 7 methods
        // each). If the worker is quarantined on the idle timeout, those
        // vanish — so this threshold is the regression guard.
        const survivalFloor = entityCount * 5;
        const survived = result.graph.nodeCount >= survivalFloor;

        console.log(
          `\nGo Pipeline — Worker Pool (issue #1848)` +
            `\n  files: ${fileCount} (1 big @ ${Math.round(bigFileBytes / 1024)} KiB + 14 pad)` +
            `\n  entities: ${entityCount}, sub-batch idle timeout: ${subBatchTimeoutMs}ms` +
            `\n  elapsed: ${elapsedMs}ms, peak heap: ${Math.round(peakHeapMB)}MB` +
            `\n  usedWorkerPool: ${result.usedWorkerPool}` +
            `\n  nodes: ${result.graph.nodeCount} (survival floor ${survivalFloor}) → ${survived ? 'SURVIVED' : 'QUARANTINED (bug reproduced)'}`,
        );

        // Sanity: the worker path must have actually engaged, else the test
        // proves nothing about the worker bug.
        expect(result.usedWorkerPool).toBe(true);
        // The fix: the generated file is fully parsed despite the idle timeout.
        expect(result.graph.nodeCount).toBeGreaterThanOrEqual(survivalFloor);
      } finally {
        clearInterval(heapSampler);
        if (prevMaxBytes === undefined) delete process.env.GITNEXUS_WORKER_SUB_BATCH_MAX_BYTES;
        else process.env.GITNEXUS_WORKER_SUB_BATCH_MAX_BYTES = prevMaxBytes;
        if (prevTimeout === undefined) delete process.env.GITNEXUS_WORKER_SUB_BATCH_TIMEOUT_MS;
        else process.env.GITNEXUS_WORKER_SUB_BATCH_TIMEOUT_MS = prevTimeout;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }, 360_000);
  },
);

/**
 * Unlike the two suites above, this one is NOT gated behind GITNEXUS_BENCH and
 * needs no compiled worker — so it runs in normal CI and is the actual guard
 * against an O(n^2) re-regression of emitGoScopeCaptures (issue #1848). It calls
 * the hotpath directly on a ~400-struct generated source. The O(n) path does
 * this in a few hundred ms; the old findNodeAtRange-from-root behaviour took
 * ~25s+ at this size. The budget is a coarse tripwire (huge margin over the
 * fixed path, far below a quadratic regression), not a microbenchmark — keep it
 * generous so it never flakes on a loaded CI runner.
 */
describe('Go scope-capture O(n^2) regression tripwire', () => {
  function generateGoStructSource(structCount: number): string {
    const lines = ['package generated', ''];
    for (let i = 0; i < structCount; i++) {
      const n = String(i).padStart(4, '0');
      lines.push(
        `type Item${n} struct {`,
        '\tid int64',
        '\tname string',
        '}',
        '',
        `func (d *Item${n}) GetID() int64 { return d.id }`,
        `func (d *Item${n}) SetID(id int64) { d.id = id }`,
        `func (d *Item${n}) GetName() string { return d.name }`,
        `func (d *Item${n}) Validate() error { return nil }`,
        '',
      );
    }
    return lines.join('\n');
  }

  it('parses a 400-struct file in well under the O(n^2) tripwire budget', () => {
    const STRUCT_COUNT = 400;
    const BUDGET_MS = 5_000; // coarse: ~20x the fixed path (~250ms), trips a ~20x regression; a quadratic regression at 400 structs is ~25s
    const src = generateGoStructSource(STRUCT_COUNT);

    emitGoScopeCaptures(src, 'tripwire-warmup.go'); // warm up the parser/query JIT

    const start = Date.now();
    const matches = emitGoScopeCaptures(src, 'tripwire.go');
    const elapsedMs = Date.now() - start;

    // Sanity: the captures are actually produced (each struct + 4 methods emits
    // far more than 10 capture groups), so a fast-but-empty result can't pass.
    expect(matches.length).toBeGreaterThan(STRUCT_COUNT * 10);
    // The actual regression guard: a re-regression to O(n^2) blows this budget.
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Go structural interface detection benchmarks
// ---------------------------------------------------------------------------

/**
 * Build synthetic ParsedFile data for detectGoInterfaceImplementations.
 *
 * Creates `interfaceCount` interfaces (each with Find + Save methods) and
 * `structCount` structs that implement all of them (matching signatures).
 * Also generates a few BadStruct entries with mismatched signatures to
 * verify they are correctly excluded (non-vacuous guard).
 */
function generateSyntheticInterfaceData(interfaceCount: number, structCount: number): ParsedFile[] {
  const defs: SymbolDefinition[] = [];
  const ifaceIds: string[] = [];
  const structIds: string[] = [];

  // Interfaces
  for (let i = 0; i < interfaceCount; i++) {
    const ifaceId = `iface:Repo${i}`;
    ifaceIds.push(ifaceId);
    defs.push({
      nodeId: ifaceId,
      filePath: 'repo.go',
      type: 'Interface',
      qualifiedName: `Repo${i}`,
    });
    // Find(id string) User
    defs.push({
      nodeId: `iface:Repo${i}.Find`,
      filePath: 'repo.go',
      type: 'Method',
      qualifiedName: `Repo${i}.Find`,
      ownerId: ifaceId,
      parameterCount: 1,
      requiredParameterCount: 1,
      parameterTypes: ['string'],
      returnType: 'User',
    });
    // Save(user User) error
    defs.push({
      nodeId: `iface:Repo${i}.Save`,
      filePath: 'repo.go',
      type: 'Method',
      qualifiedName: `Repo${i}.Save`,
      ownerId: ifaceId,
      parameterCount: 1,
      requiredParameterCount: 1,
      parameterTypes: ['User'],
      returnType: 'error',
    });
  }

  // Structs — each implements all interfaces
  for (let s = 0; s < structCount; s++) {
    const structId = `struct:Impl${s}`;
    structIds.push(structId);
    defs.push({
      nodeId: structId,
      filePath: 'repo.go',
      type: 'Struct',
      qualifiedName: `Impl${s}`,
    });
    for (let i = 0; i < interfaceCount; i++) {
      defs.push({
        nodeId: `struct:Impl${s}.Repo${i}.Find`,
        filePath: 'repo.go',
        type: 'Method',
        qualifiedName: `Impl${s}.Find`,
        ownerId: structId,
        parameterCount: 1,
        requiredParameterCount: 1,
        parameterTypes: ['string'],
        returnType: 'User',
      });
      defs.push({
        nodeId: `struct:Impl${s}.Repo${i}.Save`,
        filePath: 'repo.go',
        type: 'Method',
        qualifiedName: `Impl${s}.Save`,
        ownerId: structId,
        parameterCount: 1,
        requiredParameterCount: 1,
        parameterTypes: ['User'],
        returnType: 'error',
      });
    }
  }

  // BadStructs — wrong Save signature (string instead of User), should NOT match
  for (let b = 0; b < Math.min(5, structCount); b++) {
    const badId = `struct:Bad${b}`;
    defs.push({
      nodeId: badId,
      filePath: 'repo.go',
      type: 'Struct',
      qualifiedName: `Bad${b}`,
    });
    for (let i = 0; i < interfaceCount; i++) {
      defs.push({
        nodeId: `struct:Bad${b}.Repo${i}.Find`,
        filePath: 'repo.go',
        type: 'Method',
        qualifiedName: `Bad${b}.Find`,
        ownerId: badId,
        parameterCount: 1,
        requiredParameterCount: 1,
        parameterTypes: ['string'],
        returnType: 'User',
      });
      // Mismatched Save: string param instead of User
      defs.push({
        nodeId: `struct:Bad${b}.Repo${i}.Save`,
        filePath: 'repo.go',
        type: 'Method',
        qualifiedName: `Bad${b}.Save`,
        ownerId: badId,
        parameterCount: 1,
        requiredParameterCount: 1,
        parameterTypes: ['string'],
        returnType: 'error',
      });
    }
  }

  return [
    {
      filePath: 'repo.go',
      language: 'go',
      scopes: [],
      imports: [],
      localDefs: defs,
      referenceSites: [],
    },
  ] as ParsedFile[];
}

/**
 * Ungated tripwire: runs in normal CI. Calls detectGoInterfaceImplementations
 * directly on synthetic data to catch O(n²) regressions. The current indexed
 * path (structIdsByMethodName intersection) keeps this well under budget.
 */
describe('Go structural interface detection O(n²) regression tripwire', () => {
  it('detects implementations for 50 interfaces × 50 structs within budget', () => {
    const IFACE_COUNT = 50;
    const STRUCT_COUNT = 50;
    const BUDGET_MS = 5_000;

    const parsed = generateSyntheticInterfaceData(IFACE_COUNT, STRUCT_COUNT);
    const emptyIndexes = {} as any;
    const emptyModel = {} as any;

    // Warm up
    detectGoInterfaceImplementations(
      generateSyntheticInterfaceData(5, 5),
      emptyIndexes,
      emptyModel,
    );

    const start = Date.now();
    const result = detectGoInterfaceImplementations(parsed, emptyIndexes, emptyModel);
    const elapsedMs = Date.now() - start;

    // Sanity: each interface should be implemented by all STRUCT_COUNT structs
    expect(result.size).toBe(IFACE_COUNT);
    for (const [, impls] of result) {
      expect(impls).toHaveLength(STRUCT_COUNT);
    }
    // Regression guard
    expect(elapsedMs).toBeLessThan(BUDGET_MS);

    console.log(
      `  interface-detection tripwire: ${IFACE_COUNT}×${STRUCT_COUNT} = ${IFACE_COUNT * STRUCT_COUNT} pairs, ${elapsedMs}ms`,
    );
  }, 30_000);
});

/**
 * Gated scaling benchmark: measures how detectGoInterfaceImplementations
 * scales as interface and struct counts grow proportionally.
 *
 * Run: GITNEXUS_BENCH=1 npx vitest run test/integration/go-pipeline-benchmark.test.ts
 */
describe.skipIf(!BENCH_ENABLED)('Go structural interface detection benchmark', () => {
  const scales = [50, 200, 800];
  const REPS = 3;

  it('scales linearly with interface × struct count', () => {
    interface ScaleResult {
      ifaceCount: number;
      structCount: number;
      totalPairs: number;
      elapsedMs: number;
      implEdges: number;
    }

    const results: ScaleResult[] = [];
    const emptyIndexes = {} as any;
    const emptyModel = {} as any;

    for (const n of scales) {
      // Warm up with small data once
      detectGoInterfaceImplementations(
        generateSyntheticInterfaceData(5, 5),
        emptyIndexes,
        emptyModel,
      );

      let bestMs = Infinity;
      let implEdges = 0;
      const parsed = generateSyntheticInterfaceData(n, n);

      for (let r = 0; r < REPS; r++) {
        const start = Date.now();
        const result = detectGoInterfaceImplementations(parsed, emptyIndexes, emptyModel);
        const elapsed = Date.now() - start;
        if (elapsed < bestMs) {
          bestMs = elapsed;
          implEdges = 0;
          for (const [, impls] of result) implEdges += impls.length;
        }
      }

      results.push({
        ifaceCount: n,
        structCount: n,
        totalPairs: n * n,
        elapsedMs: bestMs,
        implEdges,
      });
      console.log(`  ${n}×${n} = ${n * n} pairs: ${bestMs}ms (${implEdges} IMPLEMENTS edges)`);
    }

    // Print scaling table
    console.log('\nGo Interface Detection — Scaling');
    console.log('┌──────────┬──────────┬───────────┬───────────┐');
    console.log('│ Iface×St │ Pairs    │ Time (ms) │ IMPL edges│');
    console.log('├──────────┼──────────┼───────────┼───────────┤');
    for (const r of results) {
      console.log(
        `│ ${String(`${r.ifaceCount}×${r.structCount}`).padStart(8)} │ ${String(r.totalPairs).padStart(8)} │ ${String(r.elapsedMs).padStart(9)} │ ${String(r.implEdges).padStart(9)} │`,
      );
    }
    console.log('└──────────┴──────────┴───────────┴───────────┘');

    // Assert linear scaling
    if (results.length >= 2) {
      console.log('\nScaling ratios (time_ratio / size_ratio):');
      for (let i = 1; i < results.length; i++) {
        const sizeRatio = results[i].totalPairs / results[i - 1].totalPairs;
        const timeRatio = results[i].elapsedMs / results[i - 1].elapsedMs;
        const scaling = timeRatio / sizeRatio;
        console.log(
          `  ${results[i - 1].totalPairs} → ${results[i].totalPairs}: ${scaling.toFixed(2)}x (${scaling < 1.5 ? 'linear' : scaling < 3 ? 'superlinear' : 'WARNING: quadratic'})`,
        );
        expect(scaling).toBeLessThan(1.5);
      }
    }
  }, 300_000);
});
