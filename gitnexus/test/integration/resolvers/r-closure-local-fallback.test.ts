/**
 * R: a function bound inside another function lives in that call's frame, so no other function
 * (in its file or another) can call it by its bare name. The unique-name fallback used to bind
 * such calls to it at 0.5 whenever the name was unique in the repository.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo } from './helpers.js';
import type { PipelineResult } from './helpers.js';

// Safe under `pool: 'forks'`: the env stub is process-global, but each file gets its own process.
beforeAll(() => vi.stubEnv('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000'));
afterAll(() => vi.unstubAllEnvs());

describe('R unique-name fallback and closure-local functions', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'r-closure-local-fallback'), () => {});
  }, 60000);

  /** `caller -> callee (reason)` for every CALLS edge, sorted. */
  const calls = (): string[] =>
    getRelationships(result, 'CALLS')
      .map((e) => `${e.source}->${e.target}`)
      .sort();

  it('does not bind a bare call to a closure-local function of another function', () => {
    expect(calls()).not.toContain('use_local->count_fn');
    expect(calls()).not.toContain('use_other->count_fn');
    expect(calls()).not.toContain('reach_inner->inner_only');
  });

  it('keeps the unique-name guess to a top-level function in another file (positive control)', () => {
    expect(calls()).toContain('use_top->top_helper');
    expect(calls()).toContain('reach_top->top_helper');
  });

  it('keeps the lexical edges inside a function that defines the closure itself', () => {
    expect(calls()).toContain('wrap->shared_name');
    expect(calls()).toContain('inner_only->top_helper');
    expect(calls()).toContain('other->inner_only');
  });
});
