/**
 * Synthetic benchmark for scope-resolution. Builds a large in-memory
 * Python workspace and times runScopeResolution against it directly,
 * isolating the resolution cost from parse / heritage / pipeline
 * overhead.
 *
 * Usage: REGISTRY_PRIMARY_PYTHON=1 npx tsx scripts/bench-scope-resolution.ts
 */
process.env.REGISTRY_PRIMARY_PYTHON = '1';

import { generateId } from '../src/lib/utils.js';
import { createKnowledgeGraph } from '../src/core/graph/graph.js';
import { runScopeResolution } from '../src/core/ingestion/scope-resolution/index.js';
import { pythonScopeResolver } from '../src/core/ingestion/languages/python/scope-resolver.js';

const N_CLASSES = Number(process.env.BENCH_CLASSES ?? '60');
const N_USERS = Number(process.env.BENCH_USERS ?? '40');
const ITERS = Number(process.env.BENCH_ITERS ?? '5');

function buildWorkspace(): { path: string; content: string }[] {
  const files: { path: string; content: string }[] = [];

  // Build N_CLASSES "model" files, each defining a class with a few methods.
  for (let i = 0; i < N_CLASSES; i++) {
    const lines: string[] = [];
    for (let j = 0; j < 5; j++) {
      lines.push(`class Model${i}_${j}:`);
      lines.push(`    name: str`);
      lines.push(`    def save(self) -> bool:`);
      lines.push(`        return True`);
      lines.push(`    def update(self, name: str) -> "Model${i}_${j}":`);
      lines.push(`        self.name = name`);
      lines.push(`        return self`);
      lines.push(`    def get_other(self) -> "Model${i}_${(j + 1) % 5}":`);
      lines.push(`        return Model${i}_${(j + 1) % 5}()`);
      lines.push('');
    }
    files.push({ path: `models/m${i}.py`, content: lines.join('\n') });
  }

  // Build N_USERS "user" files that import from a few model files
  // and exercise the receiver-bound dispatcher heavily.
  for (let u = 0; u < N_USERS; u++) {
    const targets = [u % N_CLASSES, (u + 1) % N_CLASSES, (u + 2) % N_CLASSES];
    const imports = targets
      .map((t) => `from models.m${t} import Model${t}_0, Model${t}_1, Model${t}_2`)
      .join('\n');
    const calls: string[] = [];
    for (let k = 0; k < 30; k++) {
      const t = targets[k % 3]!;
      const j = k % 3;
      calls.push(`    m${k} = Model${t}_${j}()`);
      calls.push(`    m${k}.save()`);
      calls.push(`    m${k}.update("x").save()`);
      calls.push(`    m${k}.get_other().save()`);
    }
    const content = `${imports}\n\ndef use_${u}() -> None:\n${calls.join('\n')}\n`;
    files.push({ path: `app/u${u}.py`, content });
  }

  return files;
}

function buildGraph(files: { path: string; content: string }[]) {
  const graph = createKnowledgeGraph();
  // Pre-populate File / Class / Function nodes the resolver expects.
  for (const f of files) {
    const fileId = generateId('File', f.path);
    graph.addNode({
      id: fileId,
      label: 'File',
      properties: { name: f.path, filePath: f.path },
    });

    // Lightweight regex-extract class & def names so the lookup index
    // has something to find. Real pipeline builds these via parse phase;
    // for the bench this stand-in is enough to exercise the resolver.
    const classRe = /^class (\w+)/gm;
    const defRe = /^\s*def (\w+)/gm;
    let m: RegExpExecArray | null;
    while ((m = classRe.exec(f.content)) !== null) {
      const name = m[1]!;
      const id = generateId('Class', `${f.path}:${name}`);
      graph.addNode({
        id,
        label: 'Class',
        properties: { name, filePath: f.path, qualifiedName: name },
      });
    }
    while ((m = defRe.exec(f.content)) !== null) {
      const name = m[1]!;
      const id = generateId('Function', `${f.path}:${name}`);
      graph.addNode({
        id,
        label: 'Function',
        properties: { name, filePath: f.path, qualifiedName: name },
      });
    }
  }
  return graph;
}

async function main() {
  const files = buildWorkspace();
  console.log(`bench: ${files.length} files (${N_CLASSES} models × 5 classes + ${N_USERS} users)`);
  console.log(`       × ${ITERS} iterations\n`);

  // Warmup
  for (let i = 0; i < 2; i++) {
    const graph = buildGraph(files);
    runScopeResolution({ graph, files, onWarn: () => {} }, pythonScopeResolver);
  }

  const samples: number[] = [];
  for (let i = 0; i < ITERS; i++) {
    const graph = buildGraph(files);
    const start = process.hrtime.bigint();
    runScopeResolution({ graph, files, onWarn: () => {} }, pythonScopeResolver);
    const end = process.hrtime.bigint();
    const ms = Number(end - start) / 1_000_000;
    samples.push(ms);
    console.log(`  iter ${i + 1}: ${ms.toFixed(0)} ms`);
  }

  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)]!;
  const min = samples[0]!;
  console.log(`\nmin: ${min.toFixed(0)} ms · median: ${median.toFixed(0)} ms`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
