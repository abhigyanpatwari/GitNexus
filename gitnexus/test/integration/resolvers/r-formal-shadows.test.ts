/**
 * R: a name bound by a function's formals, or by a `for` loop variable, shadows a top-level
 * function of the same name inside that scope. `function(data, transform) transform(data)` calls
 * its argument, not the repository's `transform()`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo } from './helpers.js';
import type { PipelineResult } from './helpers.js';

// Safe under `pool: 'forks'`: the env stub is process-global, but each file gets its own process.
beforeAll(() => vi.stubEnv('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000'));
afterAll(() => vi.unstubAllEnvs());

describe('R calls through a formal or a loop variable', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'r-formal-shadows'), () => {});
  }, 60000);

  const targets = (source: string): string[] =>
    getRelationships(result, 'CALLS')
      .filter((e) => e.source === source)
      .map((e) => e.target)
      .sort();

  it('does not bind a call through a formal to the top-level function of that name', () => {
    expect(targets('apply_it')).toEqual([]);
    expect(targets('run_with')).toEqual([]);
  });

  it('does not bind a call through a for variable or an anonymous function formal', () => {
    expect(targets('each_cb')).toEqual([]);
    expect(targets('via_lapply')).toEqual(
      ['lapply'].filter((n) => targets('via_lapply').includes(n)),
    );
    expect(targets('via_lapply')).not.toContain('handler');
  });

  it('does not bind a call through a formal with a constant default: a default proves nothing about the argument', () => {
    expect(targets('constant_default')).toEqual([]);
  });

  it('does not bind a call through a formal that defaults to NULL: it can hold a callback', () => {
    expect(targets('null_default')).toEqual([]);
  });

  it('does not bind a call through a formal that defaults to a function', () => {
    expect(targets('function_default')).toEqual([]);
  });

  it('still binds the same call where no formal shadows the name (positive control)', () => {
    expect(targets('plain')).toEqual(['transform']);
  });
});
