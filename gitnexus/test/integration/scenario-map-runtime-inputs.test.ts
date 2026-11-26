import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
// Positive/negative controls for the scenario-map runtime fixture recorder.
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

const inputs = [
  ['typescript', 'ts', 'export function twice(x: number) { return x + x; }'],
  ['python', 'py', 'def twice(x):\n    return x + x\n'],
  ['loop', 'ts', 'export function twice(x: number) { while(x > 0) { x--; } return x; }'],
] as const;

describe.each(inputs)('%s generated repository', (_name, extension, source) => {
  let count = 0;
  beforeAll(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'scenario-runtime-'));
    try {
      writeFileSync(path.join(root, `main.${extension}`), source);
      count = (await runPipelineFromRepo(root, () => {}, { skipGraphPhases: true })).graph
        .nodeCount;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
  // dupe-ok: intentional detector control; preserve fixture and capture ground truth
  it('finds declarations', () => {
    expect(count).toBeGreaterThan(0);
  });
  // dupe-ok: intentional detector control; preserve fixture and capture ground truth
  it('retains the result after fixture cleanup', () => {
    expect(count).toBeGreaterThan(0);
  });
});

// dupe-ok: intentional detector control; preserve fixture and capture ground truth
it.each(['sync', 'promise'])('dynamic %s read survives cleanup', async (api) => {
  const root = mkdtempSync(path.join(tmpdir(), 'scenario-runtime-read-'));
  let text: string;
  try {
    const file = path.join(root, 'main.ts');
    writeFileSync(file, inputs[0][2]);
    text = api === 'sync' ? readFileSync(file, 'utf8') : await readFile(file, 'utf8');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  expect(text).toContain('function twice');
});
