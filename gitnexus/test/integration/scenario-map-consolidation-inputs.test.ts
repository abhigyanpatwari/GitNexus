import { expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

// Ground truth controls: fixture content changes independently of the checks below.
const BASE = 'export function calculate(value: number) { return value + 1; }\n';
const RENAMED = 'export function compute(amount: number) { return amount + 1; }\n';
const EXTRA =
  BASE + 'export function extra(value: number) { while (value > 0) { value--; } return value; }\n';
const UNRELATED = 'export interface Settings { enabled: boolean; label: string; }\n';
let count = 0;

async function ingest(source: string, extension = 'ts'): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'consolidation-control-'));
  try {
    writeFileSync(path.join(root, `main.${extension}`), source);
    count = (await runPipelineFromRepo(root, () => {}, { skipGraphPhases: true })).graph.nodeCount;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// dupe-ok: intentional detector control; preserve fixture and capture ground truth
it('exact A', async () => {
  await ingest(BASE);
  expect(count).toBeGreaterThan(0);
});
// dupe-ok: intentional detector control; preserve fixture and capture ground truth
it('exact B', async () => {
  await ingest(BASE);
  expect(count).toBeGreaterThan(0);
});
// dupe-ok: intentional detector control; preserve fixture and capture ground truth
it('renamed fixture', async () => {
  await ingest(RENAMED);
  expect(count).toBeGreaterThan(0);
});
// dupe-ok: intentional detector control; preserve fixture and capture ground truth
it('partial fixture and unique check', async () => {
  await ingest(EXTRA);
  expect(count).toBeGreaterThan(0);
  expect(count).toBeGreaterThan(2);
});
// dupe-ok: intentional detector control; preserve fixture and capture ground truth
it('different expectation', async () => {
  await ingest(BASE);
  expect(count).toBeGreaterThan(1);
});
// dupe-ok: intentional detector control; preserve fixture and capture ground truth
it('unrelated assertion', async () => {
  await ingest(BASE);
  expect(count).toBeTypeOf('number');
});
// dupe-ok: intentional detector control; preserve fixture and capture ground truth
it('unrelated fixture', async () => {
  await ingest(UNRELATED);
  expect(count).toBeGreaterThan(0);
});
// dupe-ok: intentional detector control; preserve fixture and capture ground truth
it('equivalent Python scenario', async () => {
  await ingest('def calculate(value):\n    return value + 1\n', 'py');
  expect(count).toBeGreaterThan(0);
});
