/**
 * R: a roxygen `@param` description is prose, not a type. The type
 * environment is the only place a roxygen type is held, and no graph edge
 * consumes it, so this pins the end-to-end outcome: a function documented
 * `@param df Data frame ...` is not linked to the unrelated R6 class `Data`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo, type PipelineResult } from './helpers.js';

// Cold worker-pool startups otherwise flake against the 5s default ready budget
// on a loaded runner, failing for reasons unrelated to R parsing or resolution.
// Safe under `pool: 'forks'`: the env stub is process-global, but each file gets its own process.
beforeAll(() => vi.stubEnv('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000'));
afterAll(() => vi.unstubAllEnvs());

describe('R roxygen @param prose does not type a receiver', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'r-roxygen-param-prose'), () => {});
  }, 60000);

  it('links a receiver typed by a constructor call to the class method (positive control)', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.some((e) => e.source === 'fit_from_constructor' && e.target === 'fit')).toBe(true);
  });

  it('does not link a receiver documented only by a prose description to the class method', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.filter((e) => e.source === 'fit_from_prose')).toEqual([]);
  });
});
