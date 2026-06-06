/**
 * Ruby ingestion pipeline benchmark.
 *
 * Generates synthetic Ruby codebases at increasing scales and measures
 * wall-clock time and peak heap through the full pipeline — parsing,
 * scope extraction, heritage (include/extend/prepend), MRO construction,
 * and call resolution via the registry-primary scope-resolution path.
 *
 * Run: GITNEXUS_BENCH=1 npx vitest run test/integration/ruby-pipeline-benchmark.test.ts
 *
 * The benchmark uses workers (production path) by default. Set
 * a single-worker pool (the sequential parser was removed).
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
  moduleCount: number;
  mixinModuleCount: number;
  elapsedMs: number;
  peakHeapMB: number;
  nodeCount: number;
  edgeCount: number;
  implementsCount: number;
  hasPropertyCount: number;
  extendsCount: number;
}

function generateRubyFixture(
  fileCount: number,
  modulesPerLevel: number,
): { dir: string; classCount: number; moduleCount: number; mixinModuleCount: number } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ruby-bench-${fileCount}-`));

  // Three families of mixins: one for include, one for extend, one for prepend.
  // Each family has modulesPerLevel² modules so the MRO partitioning logic is
  // exercised with all three heritage kinds and varied orderings.
  const includeMixins: string[] = [];
  const extendMixins: string[] = [];
  const prependMixins: string[] = [];

  for (let i = 0; i < modulesPerLevel; i++) {
    for (let j = 0; j < modulesPerLevel; j++) {
      includeMixins.push(`Includable${i}x${j}`);
      extendMixins.push(`Extendable${i}x${j}`);
      prependMixins.push(`Prependable${i}x${j}`);
    }
  }

  const allMixins = [...includeMixins, ...extendMixins, ...prependMixins];
  const moduleCount = allMixins.length;
  const classCount = fileCount;

  // Generate mixin module files — each module includes a shared base module
  // to create diamond mixin patterns (class includes A and B, both include Base).
  const concernsDir = path.join(dir, 'lib', 'concerns');
  fs.mkdirSync(concernsDir, { recursive: true });

  // Shared base modules that other mixins include (diamond pattern)
  const baseModuleCount = Math.max(2, Math.floor(modulesPerLevel / 2));
  for (let b = 0; b < baseModuleCount; b++) {
    const baseName = `BaseMixin${b}`;
    const content = [
      `module ${baseName}`,
      `  def base${b}_check`,
      '    true',
      '  end',
      'end',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(concernsDir, `${baseName.toLowerCase()}.rb`), content);
  }

  for (let m = 0; m < allMixins.length; m++) {
    const moduleName = allMixins[m];
    const baseIdx = m % baseModuleCount;
    const baseName = `BaseMixin${baseIdx}`;
    const content = [
      `require_relative '${baseName.toLowerCase()}'`,
      '',
      `module ${moduleName}`,
      `  include ${baseName}`,
      '',
      `  def ${moduleName.toLowerCase()}_action`,
      `    base${baseIdx}_check`,
      '  end',
      'end',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(concernsDir, `${moduleName.toLowerCase()}.rb`), content);
  }

  // Generate class files — each class uses include + extend + prepend with
  // different modules, creating a rich MRO that exercises all three
  // heritage-kind partitions in buildRubyMro.
  const modelsDir = path.join(dir, 'lib', 'models');
  fs.mkdirSync(modelsDir, { recursive: true });

  for (let f = 0; f < fileCount; f++) {
    const className = `Model${f}`;

    // Pick one mixin of each kind (rotating through the pools)
    const incMixin = includeMixins[f % includeMixins.length];
    const extMixin = extendMixins[f % extendMixins.length];
    const preMixin = prependMixins[f % prependMixins.length];
    // Second include mixin for diamond-overlap testing
    const incMixin2 = includeMixins[(f + 1) % includeMixins.length];

    const siblingIdx = (f + 1) % fileCount;
    const siblingClass = `Model${siblingIdx}`;

    const crossIdx = (f + Math.floor(fileCount / 3)) % fileCount;
    const crossClass = `Model${crossIdx}`;

    const requireLines = [
      `require_relative '../concerns/${incMixin.toLowerCase()}'`,
      `require_relative '../concerns/${incMixin2.toLowerCase()}'`,
      `require_relative '../concerns/${extMixin.toLowerCase()}'`,
      `require_relative '../concerns/${preMixin.toLowerCase()}'`,
      f !== siblingIdx ? `require_relative '${siblingClass.toLowerCase()}'` : '',
      f !== crossIdx ? `require_relative '${crossClass.toLowerCase()}'` : '',
    ].filter(Boolean);

    const content = [
      ...requireLines,
      '',
      `class ${className}`,
      `  include ${incMixin}`,
      `  include ${incMixin2}`,
      `  extend ${extMixin}`,
      `  prepend ${preMixin}`,
      '',
      `  attr_accessor :id, :name, :status`,
      '',
      `  # @param other [${siblingClass}]`,
      `  # @return [${siblingClass}]`,
      `  def process(other)`,
      `    other.save`,
      `    ${incMixin.toLowerCase()}_action`,
      `    other`,
      '  end',
      '',
      '  def save',
      '    true',
      '  end',
      '',
      `  # @return [${crossClass}]`,
      `  def build_cross`,
      `    ${crossClass}.new`,
      '  end',
      '',
      `  def self.class_action`,
      `    ${extMixin.toLowerCase()}_action`,
      '  end',
      'end',
      '',
    ].join('\n');

    fs.writeFileSync(path.join(modelsDir, `${className.toLowerCase()}.rb`), content);
  }

  return {
    dir,
    classCount,
    moduleCount: moduleCount + baseModuleCount,
    mixinModuleCount: moduleCount,
  };
}

async function runBenchmark(
  fileCount: number,
  moduleLevels: number,
  budgetMs: number,
): Promise<BenchResult> {
  const { dir, classCount, moduleCount, mixinModuleCount } = generateRubyFixture(
    fileCount,
    moduleLevels,
  );

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

    let implementsCount = 0;
    let hasPropertyCount = 0;
    let extendsCount = 0;
    for (const rel of result.graph.iterRelationshipsByType('IMPLEMENTS')) {
      implementsCount++;
      void rel;
    }
    for (const rel of result.graph.iterRelationshipsByType('HAS_PROPERTY')) {
      hasPropertyCount++;
      void rel;
    }
    for (const rel of result.graph.iterRelationshipsByType('EXTENDS')) {
      extendsCount++;
      void rel;
    }

    return {
      fileCount,
      classCount,
      moduleCount,
      mixinModuleCount,
      elapsedMs,
      peakHeapMB: Math.round(peakHeapMB),
      nodeCount: result.graph.nodeCount,
      edgeCount: result.graph.relationshipCount,
      implementsCount,
      hasPropertyCount,
      extendsCount,
    };
  } finally {
    clearInterval(heapSampler);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function printResults(label: string, results: BenchResult[]) {
  console.log(`\n${label}`);
  console.log(
    '┌──────────┬─────────┬──────────┬───────────┬──────────┬───────┬───────┬──────┬───────┬─────┐',
  );
  console.log(
    '│ Files    │ Classes │ Modules  │ Time (ms) │ Heap MB  │ Nodes │ Edges │ IMPL │ PROPS │ EXT │',
  );
  console.log(
    '├──────────┼─────────┼──────────┼───────────┼──────────┼───────┼───────┼──────┼───────┼─────┤',
  );
  for (const r of results) {
    console.log(
      `│ ${String(r.fileCount).padStart(8)} │ ${String(r.classCount).padStart(7)} │ ${String(r.moduleCount).padStart(8)} │ ${String(r.elapsedMs).padStart(9)} │ ${String(r.peakHeapMB).padStart(8)} │ ${String(r.nodeCount).padStart(5)} │ ${String(r.edgeCount).padStart(5)} │ ${String(r.implementsCount).padStart(4)} │ ${String(r.hasPropertyCount).padStart(5)} │ ${String(r.extendsCount).padStart(3)} │`,
    );
  }
  console.log(
    '└──────────┴─────────┴──────────┴───────────┴──────────┴───────┴───────┴──────┴───────┴─────┘',
  );

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

describe.skipIf(!BENCH_ENABLED)('Ruby pipeline benchmark', () => {
  it('scales with file count (workers enabled)', async () => {
    const scales = [100, 250, 500];
    const results: BenchResult[] = [];

    for (const fileCount of scales) {
      const moduleLevels = Math.max(2, Math.ceil(Math.sqrt(fileCount / 4)));
      const result = await runBenchmark(fileCount, moduleLevels, 180_000);
      results.push(result);
      console.log(
        `  ${fileCount} files: ${result.elapsedMs}ms, ${result.peakHeapMB}MB heap, ${result.nodeCount} nodes, ${result.edgeCount} edges`,
      );
    }

    printResults('Ruby Pipeline — Workers Enabled', results);

    for (let i = 1; i < results.length; i++) {
      const fileRatio = results[i].fileCount / results[i - 1].fileCount;
      const timeRatio = results[i].elapsedMs / results[i - 1].elapsedMs;
      expect(timeRatio / fileRatio).toBeLessThan(3);
    }

    // Verify heritage emission produces exact expected counts.
    // Each class: 2x include + 1x extend + 1x prepend = 4 IMPLEMENTS.
    // Each mixin module (non-base) includes one BaseMixin = 1 IMPLEMENTS.
    // Each class: attr_accessor :id, :name, :status = 3 HAS_PROPERTY.
    for (const r of results) {
      expect(r.implementsCount).toBe(r.classCount * 4 + r.mixinModuleCount);
      expect(r.hasPropertyCount).toBe(r.classCount * 3);
    }
  }, 300_000);
});
