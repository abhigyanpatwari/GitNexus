/**
 * R: a definition written in backticks (`%+%`, `my fn`) is exported by the
 * NAMESPACE entry that names the symbol. The graph node keeps the spelling of the
 * definition, so the export check compares the symbol, not the written name.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import { FIXTURES, runPipelineFromRepo } from './helpers.js';
import type { PipelineResult } from './helpers.js';

// Cold worker-pool startups otherwise flake against the 5s default ready budget
// on a loaded runner, failing for reasons unrelated to R parsing or resolution.
beforeAll(() => vi.stubEnv('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000'));
afterAll(() => vi.unstubAllEnvs());

describe('R backtick-quoted definitions and the NAMESPACE', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'r-backtick-names'), () => {});
  }, 60000);

  const exported = (name: string): unknown =>
    [...result.graph.iterNodes()].find((n) => n.label === 'Function' && n.properties.name === name)
      ?.properties.isExported;

  it('keeps the definition spelling on the node', () => {
    expect(exported('`%+%`')).toBeDefined();
    expect(exported('`odd name`')).toBeDefined();
  });

  it('exports a backticked definition that export() names', () => {
    expect(exported('`%+%`')).toBe(true);
    expect(exported('`odd name`')).toBe(true);
  });

  it('exports a backticked definition that an exportPattern() matches', () => {
    expect(exported('`pat_hit`')).toBe(true);
  });

  it('still hides a definition the NAMESPACE does not export', () => {
    expect(exported('hidden_op')).toBe(false);
    expect(exported('plain_op')).toBe(true);
  });
});
