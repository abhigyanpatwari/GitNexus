/**
 * Vue SFC ingestion pipeline benchmark.
 *
 * Generates synthetic Vue codebases at increasing scales and measures
 * wall-clock time and peak heap through the full pipeline — scanning,
 * SFC script extraction, scope-based resolution, template-edge emission,
 * and graph build.
 *
 * Run: GITNEXUS_BENCH=1 npx vitest run test/integration/vue-pipeline-benchmark.test.ts
 *
 * Each synthetic repo contains:
 *   - A shared `utils.ts` exporting one utility function per component
 *   - N `.vue` SFC files, each with a `<script setup>` importing from
 *     `utils.ts` and one event-handler binding in the template
 *   - An `App.vue` that imports and renders all components via props/events
 *
 * Per-component work is intentionally constant as `fileCount` grows.
 * The node-ratio assertion below guards against accidental O(n²) patterns
 * (e.g. every component importing from every other component).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

const BENCH_ENABLED = process.env.GITNEXUS_BENCH === '1';

interface BenchResult {
  fileCount: number;
  componentCount: number;
  elapsedMs: number;
  peakHeapMB: number;
  nodeCount: number;
  edgeCount: number;
}

function generateVueFixture(componentCount: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vue-bench-${componentCount}-`));
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });

  // Shared utils.ts — one exported function per component
  const utilExports = Array.from(
    { length: componentCount },
    (_, i) => `export function util${i + 1}(x: string): string { return x + '${i + 1}'; }`,
  ).join('\n');
  fs.writeFileSync(path.join(srcDir, 'utils.ts'), utilExports + '\n');

  // Generate N .vue components
  for (let i = 1; i <= componentCount; i++) {
    const name = `Comp${i}`;
    const content = [
      `<template>`,
      `  <div class="${name.toLowerCase()}">`,
      `    <p>{{ label }}</p>`,
      `    <button @click="handleClick">Action ${i}</button>`,
      `  </div>`,
      `</template>`,
      ``,
      `<script setup lang="ts">`,
      `import { ref } from 'vue';`,
      `import { util${i} } from './utils';`,
      ``,
      `const props = defineProps<{ value: string }>();`,
      `const label = ref(util${i}(props.value));`,
      ``,
      `function handleClick() {`,
      `  label.value = util${i}(label.value);`,
      `}`,
      `</script>`,
    ].join('\n');
    fs.writeFileSync(path.join(srcDir, `${name}.vue`), content);
  }

  // App.vue — imports and renders all components
  const imports = Array.from(
    { length: componentCount },
    (_, i) => `import Comp${i + 1} from './Comp${i + 1}.vue';`,
  ).join('\n');
  const template = Array.from(
    { length: componentCount },
    (_, i) => `    <Comp${i + 1} :value="items[${i}]" @update="onUpdate" />`,
  ).join('\n');
  const appContent = [
    `<template>`,
    `  <div id="app">`,
    template,
    `  </div>`,
    `</template>`,
    ``,
    `<script setup lang="ts">`,
    `import { ref } from 'vue';`,
    imports,
    ``,
    `const items = ref(Array.from({ length: ${componentCount} }, (_, i) => String(i)));`,
    ``,
    `function onUpdate(val: string) {`,
    `  console.log(val);`,
    `}`,
    `</script>`,
  ].join('\n');
  fs.writeFileSync(path.join(srcDir, 'App.vue'), appContent);

  return dir;
}

async function runBenchmark(componentCount: number, budgetMs: number): Promise<BenchResult> {
  const dir = generateVueFixture(componentCount);

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
          () =>
            reject(new Error(`Pipeline exceeded ${budgetMs}ms at ${componentCount} components`)),
          budgetMs,
        ),
      ),
    ]);
    const elapsedMs = Date.now() - start;

    return {
      fileCount: componentCount + 2, // N components + utils.ts + App.vue
      componentCount,
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

function printResults(results: BenchResult[]) {
  console.log('\nVue SFC Pipeline Benchmark');
  console.log('┌────────────┬──────────┬───────────┬──────────┬───────┬───────┐');
  console.log('│ Components │ Files    │ Time (ms) │ Heap MB  │ Nodes │ Edges │');
  console.log('├────────────┼──────────┼───────────┼──────────┼───────┼───────┤');
  for (const r of results) {
    console.log(
      `│ ${String(r.componentCount).padStart(10)} │ ${String(r.fileCount).padStart(8)} │ ${String(r.elapsedMs).padStart(9)} │ ${String(r.peakHeapMB).padStart(8)} │ ${String(r.nodeCount).padStart(5)} │ ${String(r.edgeCount).padStart(5)} │`,
    );
  }
  console.log('└────────────┴──────────┴───────────┴──────────┴───────┴───────┘');

  if (results.length >= 2) {
    console.log('\nScaling ratios (time_ratio / component_ratio):');
    for (let i = 1; i < results.length; i++) {
      const compRatio = results[i].componentCount / results[i - 1].componentCount;
      const timeRatio = results[i].elapsedMs / results[i - 1].elapsedMs;
      const scaling = timeRatio / compRatio;
      console.log(
        `  ${results[i - 1].componentCount} → ${results[i].componentCount}: ${scaling.toFixed(2)}x (${scaling < 1.5 ? 'linear' : scaling < 3 ? 'superlinear' : 'WARNING: quadratic'})`,
      );
    }
  }
}

describe.skipIf(!BENCH_ENABLED)('Vue pipeline benchmark', () => {
  it('scales with component count', async () => {
    const scales = [10, 25, 50, 100];
    const results: BenchResult[] = [];

    for (const componentCount of scales) {
      const result = await runBenchmark(componentCount, 120_000);
      results.push(result);
      console.log(
        `  ${componentCount} components: ${result.elapsedMs}ms, ${result.peakHeapMB}MB heap, ${result.nodeCount} nodes, ${result.edgeCount} edges`,
      );
    }

    printResults(results);

    for (let i = 1; i < results.length; i++) {
      const compRatio = results[i].componentCount / results[i - 1].componentCount;
      const timeRatio = results[i].elapsedMs / results[i - 1].elapsedMs;
      // Wall-clock is noisy; allow a generous upper bound.
      expect(timeRatio / compRatio).toBeLessThan(4);

      // Node count grows linearly with component count (each component
      // contributes a constant number of nodes: File + Function nodes +
      // scope nodes). A large ratio here indicates accidental O(n²) growth
      // (e.g. every component importing from every other component).
      const nodeRatio = results[i].nodeCount / results[i - 1].nodeCount;
      expect(nodeRatio / compRatio).toBeLessThan(1.5);
    }
  }, 600_000);
});
