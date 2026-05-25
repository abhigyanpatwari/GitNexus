/**
 * Rust ingestion pipeline benchmark.
 *
 * Generates synthetic Rust codebases at increasing scales and measures
 * wall-clock time and peak heap through the full pipeline — parsing,
 * scope extraction, impl/trait resolution, use decomposition, and
 * call resolution.
 *
 * Run: GITNEXUS_BENCH=1 npx vitest run test/integration/rust-pipeline-benchmark.test.ts
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

const BENCH_ENABLED = process.env.GITNEXUS_BENCH === '1';

interface BenchResult {
  fileCount: number;
  structCount: number;
  moduleCount: number;
  elapsedMs: number;
  peakHeapMB: number;
  nodeCount: number;
  edgeCount: number;
}

function generateRustFixture(
  fileCount: number,
  modulesPerLevel: number,
): { dir: string; structCount: number; moduleCount: number } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rust-bench-${fileCount}-`));
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });

  const modules: string[] = [];
  for (let i = 0; i < modulesPerLevel; i++) {
    for (let j = 0; j < modulesPerLevel; j++) {
      modules.push(`mod${i}_sub${j}`);
    }
  }

  const moduleCount = modules.length;
  const structCount = fileCount;

  const modDeclarations: string[] = [];
  const createdModules = new Set<string>();

  for (let f = 0; f < fileCount; f++) {
    const modName = modules[f % modules.length];
    const structName = `Item${f}`;
    const traitName = `Process${f}`;

    if (!createdModules.has(modName)) {
      const modDir = path.join(srcDir, modName);
      fs.mkdirSync(modDir, { recursive: true });
      createdModules.add(modName);
      modDeclarations.push(`pub mod ${modName};`);
    }

    const siblingIdx = (f + 1) % fileCount;
    const siblingStruct = `Item${siblingIdx}`;
    const siblingMod = modules[siblingIdx % modules.length];

    const crossIdx = (f + Math.floor(fileCount / 3)) % fileCount;
    const crossStruct = `Item${crossIdx}`;
    const crossMod = modules[crossIdx % modules.length];

    const needsCrossImport = crossMod !== modName;

    const content = [
      needsCrossImport ? `use crate::${crossMod}::${crossStruct};` : '',
      modName !== siblingMod ? `use crate::${siblingMod}::${siblingStruct};` : '',
      '',
      `pub trait ${traitName} {`,
      `    fn process(&self) -> String;`,
      `    fn default_method(&self) -> bool { true }`,
      `}`,
      '',
      `pub struct ${structName} {`,
      `    pub id: u64,`,
      `    pub name: String,`,
      `    pub value: f64,`,
      `}`,
      '',
      `impl ${structName} {`,
      `    pub fn new(id: u64, name: String) -> Self {`,
      `        Self { id, name, value: 0.0 }`,
      `    }`,
      '',
      `    pub fn get_id(&self) -> u64 {`,
      `        self.id`,
      `    }`,
      '',
      `    pub fn set_value(&mut self, v: f64) {`,
      `        self.value = v;`,
      `    }`,
      '',
      `    pub fn compute(&self) -> f64 {`,
      `        self.value * self.id as f64`,
      `    }`,
      `}`,
      '',
      `impl ${traitName} for ${structName} {`,
      `    fn process(&self) -> String {`,
      `        format!("{}: {}", self.name, self.compute())`,
      `    }`,
      `}`,
      '',
      `pub fn create_${structName.toLowerCase()}(id: u64) -> ${structName} {`,
      `    let mut item = ${structName}::new(id, String::from("test"));`,
      `    item.set_value(42.0);`,
      `    let _result = item.compute();`,
      `    let _processed = item.process();`,
      `    item`,
      `}`,
      '',
    ].join('\n');

    const modDir = path.join(srcDir, modName);
    const existingMod = path.join(modDir, 'mod.rs');
    const fileBaseName = structName.toLowerCase();

    fs.writeFileSync(path.join(modDir, `${fileBaseName}.rs`), content);

    const modEntry = `pub mod ${fileBaseName};\npub use ${fileBaseName}::*;\n`;
    fs.appendFileSync(existingMod, modEntry);
  }

  const libContent = modDeclarations.join('\n') + '\n';
  fs.writeFileSync(path.join(srcDir, 'lib.rs'), libContent);

  const cargoToml = [
    '[package]',
    'name = "bench-rust-pipeline"',
    'version = "0.1.0"',
    'edition = "2021"',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'Cargo.toml'), cargoToml);

  return { dir, structCount, moduleCount };
}

async function runBenchmark(
  fileCount: number,
  modLevels: number,
  budgetMs: number,
): Promise<BenchResult> {
  const { dir, structCount, moduleCount } = generateRustFixture(fileCount, modLevels);

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
      structCount,
      moduleCount,
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
  console.log('│ Files    │ Structs │ Modules  │ Time (ms) │ Heap MB  │ Nodes │ Edges │');
  console.log('├──────────┼─────────┼──────────┼───────────┼──────────┼───────┼───────┤');
  for (const r of results) {
    console.log(
      `│ ${String(r.fileCount).padStart(8)} │ ${String(r.structCount).padStart(7)} │ ${String(r.moduleCount).padStart(8)} │ ${String(r.elapsedMs).padStart(9)} │ ${String(r.peakHeapMB).padStart(8)} │ ${String(r.nodeCount).padStart(5)} │ ${String(r.edgeCount).padStart(5)} │`,
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

describe.skipIf(!BENCH_ENABLED)('Rust pipeline benchmark', () => {
  it('scales with file count (workers enabled)', async () => {
    const scales = [100, 250, 500];
    const results: BenchResult[] = [];

    for (const fileCount of scales) {
      const modLevels = Math.max(2, Math.ceil(Math.sqrt(fileCount / 4)));
      const result = await runBenchmark(fileCount, modLevels, 180_000);
      results.push(result);
      console.log(
        `  ${fileCount} files: ${result.elapsedMs}ms, ${result.peakHeapMB}MB heap, ${result.nodeCount} nodes, ${result.edgeCount} edges`,
      );
    }

    printResults('Rust Pipeline — Workers Enabled', results);

    for (let i = 1; i < results.length; i++) {
      const fileRatio = results[i].fileCount / results[i - 1].fileCount;
      const timeRatio = results[i].elapsedMs / results[i - 1].elapsedMs;
      expect(timeRatio / fileRatio).toBeLessThan(3);
    }
  }, 300_000);
});
