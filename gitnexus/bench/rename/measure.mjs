/** Rename benchmark: real files, UTF-16 offsets, and full snapshot validation.
 * Run: node --import tsx bench/rename/measure.mjs [--check]
 * Measures output/report construction and applying a multi-file plan independently
 * of native parsing, then full semantic planning (`planGraphRename`: parse,
 * resolve, provider proofs, rewrite validation and binding verification) over a
 * generated single-file TypeScript source. The provider integration suites cover
 * semantic correctness.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { executeRenamePlan } from '../../src/mcp/local/rename/rename-plan.ts';
import { planGraphRename } from '../../src/mcp/local/rename/graph-rename.ts';
import {
  RenamePreviewPlans,
  renameSourceInventory,
} from '../../src/mcp/local/rename/preview-plans.ts';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-rename-bench-'));
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
async function fixture(count, sourceCount = 1, editedCount = 1, directory = root) {
  const text = '// 🐈\r\n' + `writer.close(); // ${'x'.repeat(160)}\r\n`.repeat(count);
  const snapshots = new Map();
  const edits = [];
  for (let file = 0; file < sourceCount; file++) {
    const name = `${file}.ts`;
    snapshots.set(path.join(directory, name), text);
    await fs.writeFile(path.join(directory, name), text);
    if (file >= editedCount) continue;
    let start = text.indexOf('close');
    while (start >= 0) {
      edits.push({ file_path: name, start, length: 5, old_text: 'close', new_text: 'complete' });
      start = text.indexOf('close', start + 5);
    }
  }
  return {
    symbol: { name: 'close', filePath: '0.ts', startLine: 2 },
    new_name: 'complete',
    coverage: {
      name: 'benchmark',
      scope: 'indexed-repository',
      source_file_count: sourceCount,
      languages: ['typescript'],
      limitations: [],
    },
    snapshots,
    edits,
  };
}
async function retainedPreview(sourceCount, indexedCount = sourceCount) {
  const repository = await fs.mkdtemp(path.join(root, 'retained-'));
  const plan = await fixture(1, sourceCount, 1, repository);
  for (let file = indexedCount; file < sourceCount; file++)
    plan.snapshots.delete(path.join(repository, `${file}.ts`));
  const store = new RenamePreviewPlans();
  const sources = await renameSourceInventory(repository);
  const saveTimes = [];
  const validationTimes = [];
  for (let repeat = 0; repeat < 5; repeat++) {
    const started = performance.now();
    const token = await store.remember(repository, plan, [], [], sources);
    const saved = performance.now();
    const retained = await store.take(token, repository, plan.symbol, plan.new_name, [], []);
    validationTimes.push(performance.now() - saved);
    saveTimes.push(saved - started);
    assert.deepEqual(retained.edits, plan.edits);
    assert.equal(retained.snapshots.size, 1);
    assert.equal(retained.evidence.size, sourceCount - 1);
  }
  return {
    save_ms: median(saveTimes.slice(1)),
    validation_ms: median(validationTimes.slice(1)),
    original_source_text_bytes: [...plan.snapshots.values()].reduce(
      (sum, source) => sum + source.length * 2,
      0,
    ),
    retained_source_text_bytes: plan.snapshots.get(path.join(repository, '0.ts')).length * 2,
  };
}
async function preview(count) {
  const plan = await fixture(count);
  const times = [];
  for (let repeat = 0; repeat < 7; repeat++) {
    const started = performance.now();
    const result = await executeRenamePlan(root, plan);
    times.push(performance.now() - started);
    assert.equal(result.status, 'success');
    assert.equal(result.total_edits, count);
    assert.equal(result.changes[0].edits.at(-1).line, count + 1);
    assert.equal(result.changes[0].edits[0].before, `writer.close(); // ${'x'.repeat(160)}\r`);
    assert.equal(result.changes[0].edits[0].after, `writer.complete(); // ${'x'.repeat(160)}\r`);
  }
  assert.equal(
    await fs.readFile(path.join(root, '0.ts'), 'utf8'),
    plan.snapshots.get(path.join(root, '0.ts')),
  );
  return median(times.slice(1));
}

/** One module of `calls` member calls spread over 20-call functions that each
 * construct their own receiver, so every call needs a constructor proof and
 * the receiver spelling is shared by many declarations. */
function writerSource(calls) {
  const lines = ['export class Writer {', '  close(): number { return 1; }', '}'];
  for (let first = 0; first < calls; first += 20) {
    lines.push(`export function run${first / 20}(): number {`, '  const writer = new Writer();');
    for (let call = first; call < Math.min(calls, first + 20); call++)
      lines.push('  writer.close();');
    lines.push('  return 0;', '}');
  }
  return lines.join('\n') + '\n';
}
async function semanticPlanning(calls) {
  const file = 'model.ts';
  const repository = await fs.mkdtemp(path.join(root, 'semantic-'));
  const text = writerSource(calls);
  await fs.writeFile(path.join(repository, file), text);
  const uid = `Method:${file}:Writer.close#0`;
  const nodes = [
    { id: `File:${file}`, label: 'File', properties: { name: file, filePath: file } },
    {
      id: `Class:${file}:Writer`,
      label: 'Class',
      properties: { name: 'Writer', filePath: file, startLine: 0, endLine: 2 },
    },
    {
      id: uid,
      label: 'Method',
      properties: { name: 'close', filePath: file, startLine: 1, endLine: 1 },
    },
  ];
  const started = performance.now();
  const plan = await planGraphRename(
    repository,
    { uid, name: 'close', kind: 'Method', filePath: file, startLine: 2 },
    { new_name: 'finish' },
    nodes,
  );
  const elapsed = performance.now() - started;
  // The declaration and every call are renamed, nothing else is touched.
  assert.equal(plan.edits.length, calls + 1);
  let cursor = 0;
  let rebuilt = '';
  for (const edit of plan.edits) {
    assert.equal(edit.old_text, 'close');
    assert.equal(text.slice(edit.start, edit.start + edit.length), 'close');
    rebuilt += text.slice(cursor, edit.start) + edit.new_text;
    cursor = edit.start + edit.length;
  }
  assert.equal(rebuilt + text.slice(cursor), text.replaceAll('close', 'finish'));
  return elapsed;
}
const planning_bound = 2;
async function planningScaling() {
  const small_calls = 2000;
  const large_calls = 4 * small_calls;
  await semanticPlanning(200); // load grammars and warm the planner before timing
  const smalls = [];
  for (let repeat = 0; repeat < 3; repeat++) smalls.push(await semanticPlanning(small_calls));
  const small_ms = median(smalls);
  // Stop at the first large run inside the bound: a regression is quadratic
  // and slow, so only a suspect run is repeated.
  let large_ms = Infinity;
  for (let repeat = 0; repeat < 2 && large_ms / small_ms / 4 >= planning_bound; repeat++)
    large_ms = Math.min(large_ms, await semanticPlanning(large_calls));
  return { small_calls, large_calls, small_ms, large_ms, scaling_ratio: large_ms / small_ms / 4 };
}
try {
  const small_ms = await preview(1000);
  const large_ms = await preview(4000);
  const scaling_ratio = large_ms / small_ms / 4;
  const times = [];
  for (let repeat = 0; repeat < 3; repeat++) {
    const plan = await fixture(300, 100, 8);
    const started = performance.now();
    const result = await executeRenamePlan(root, plan, false);
    times.push(performance.now() - started);
    assert.equal(result.application_status, 'applied');
    assert.equal(result.total_edits, 2400);
    for (const [absolute, original] of plan.snapshots) {
      const expected =
        Number(path.basename(absolute, '.ts')) < 8
          ? original.replaceAll('close', 'complete')
          : original;
      assert.equal(await fs.readFile(absolute, 'utf8'), expected);
    }
  }
  const planning = await planningScaling();
  const reviewedTimes = [];
  let reviewedOriginalTextBytes = 0;
  let reviewedRetainedTextBytes = 0;
  for (let repeat = 0; repeat < 3; repeat++) {
    const repository = await fs.mkdtemp(path.join(root, 'reviewed-apply-'));
    const plan = await fixture(300, 100, 8, repository);
    const store = new RenamePreviewPlans();
    const token = await store.remember(
      repository,
      plan,
      [],
      [],
      await renameSourceInventory(repository),
    );
    const retained = await store.take(token, repository, plan.symbol, plan.new_name, [], []);
    reviewedOriginalTextBytes = [...plan.snapshots.values()].reduce(
      (sum, source) => sum + source.length * 2,
      0,
    );
    reviewedRetainedTextBytes = [...retained.snapshots.values()].reduce(
      (sum, source) => sum + source.length * 2,
      0,
    );
    const started = performance.now();
    const result = await executeRenamePlan(repository, retained, false, retained.evidence);
    reviewedTimes.push(performance.now() - started);
    assert.equal(result.application_status, 'applied');
    assert.equal(result.total_edits, 2400);
    for (const [file, original] of plan.snapshots)
      assert.equal(
        await fs.readFile(file, 'utf8'),
        Number(path.basename(file, '.ts')) < 8
          ? original.replaceAll('close', 'complete')
          : original,
      );
  }
  const retainedSmall = await retainedPreview(100);
  const retainedLarge = await retainedPreview(400);
  const unindexedSmall = await retainedPreview(100, 50);
  const unindexedLarge = await retainedPreview(400, 200);
  const measurement = {
    small_ms,
    large_ms,
    scaling_ratio,
    apply_100_sources_8_edits_ms: median(times),
    planning_small_calls: planning.small_calls,
    planning_large_calls: planning.large_calls,
    planning_small_ms: planning.small_ms,
    planning_large_ms: planning.large_ms,
    planning_scaling_ratio: planning.scaling_ratio,
    retain_100_sources_ms: retainedSmall.save_ms,
    validate_100_sources_ms: retainedSmall.validation_ms,
    retain_400_sources_ms: retainedLarge.save_ms,
    validate_400_sources_ms: retainedLarge.validation_ms,
    retained_validation_scaling_ratio:
      retainedLarge.validation_ms / retainedSmall.validation_ms / 4,
    original_400_source_text_bytes: retainedLarge.original_source_text_bytes,
    retained_400_source_text_bytes: retainedLarge.retained_source_text_bytes,
    retain_100_sources_half_unindexed_ms: unindexedSmall.save_ms,
    validate_100_sources_half_unindexed_ms: unindexedSmall.validation_ms,
    retain_400_sources_half_unindexed_ms: unindexedLarge.save_ms,
    validate_400_sources_half_unindexed_ms: unindexedLarge.validation_ms,
    unindexed_validation_scaling_ratio:
      unindexedLarge.validation_ms / unindexedSmall.validation_ms / 4,
    reviewed_apply_100_sources_8_edits_ms: median(reviewedTimes),
    reviewed_original_source_text_bytes: reviewedOriginalTextBytes,
    reviewed_retained_source_text_bytes: reviewedRetainedTextBytes,
  };
  console.log(JSON.stringify(measurement));
  if (process.argv.includes('--check')) {
    assert.ok(scaling_ratio < 2, `Rename construction became superlinear: ${scaling_ratio}`);
    assert.ok(large_ms < 1000, `4000-edit preview exceeded the 1s budget: ${large_ms}ms`);
    assert.ok(
      median(reviewedTimes) < 1000,
      `Reviewed 100-source application exceeded 1s: ${median(reviewedTimes)}ms`,
    );
    assert.ok(
      retainedLarge.validation_ms < 1000,
      `400-source reviewed-plan validation exceeded 1s: ${retainedLarge.validation_ms}ms`,
    );
    assert.ok(
      measurement.retained_validation_scaling_ratio < 2.5,
      `Reviewed-plan validation became superlinear: ${measurement.retained_validation_scaling_ratio}`,
    );
    assert.ok(
      unindexedLarge.validation_ms < 1000 && measurement.unindexed_validation_scaling_ratio < 2.5,
      `Unindexed-source validation exceeded its linear/1s budgets: ${JSON.stringify(unindexedLarge)}`,
    );
    assert.ok(
      planning.scaling_ratio < planning_bound,
      `Semantic rename planning became superlinear: ${planning.scaling_ratio}`,
    );
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
