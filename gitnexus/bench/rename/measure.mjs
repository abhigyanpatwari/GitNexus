/** Prepared-plan benchmark: real files, UTF-16 offsets, and full snapshot validation.
 * Run: node --import tsx bench/rename/measure.mjs [--check]
 * Measures output/report construction and applying a multi-file plan independently
 * of native parsing. The provider integration suites cover semantic planning.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { executeRenamePlan } from '../../src/mcp/local/rename/rename-plan.ts';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-rename-bench-'));
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
async function fixture(count, sourceCount = 1, editedCount = 1) {
  const text = '// 🐈\r\n' + `writer.close(); // ${'x'.repeat(160)}\r\n`.repeat(count);
  const snapshots = new Map();
  const edits = [];
  for (let file = 0; file < sourceCount; file++) {
    const name = `${file}.ts`;
    snapshots.set(path.join(root, name), text);
    await fs.writeFile(path.join(root, name), text);
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
  const measurement = {
    small_ms,
    large_ms,
    scaling_ratio,
    apply_100_sources_8_edits_ms: median(times),
  };
  console.log(JSON.stringify(measurement));
  if (process.argv.includes('--check')) {
    assert.ok(scaling_ratio < 2, `Rename construction became superlinear: ${scaling_ratio}`);
    assert.ok(large_ms < 1000, `4000-edit preview exceeded the 1s budget: ${large_ms}ms`);
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
