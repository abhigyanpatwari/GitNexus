/**
 * R: two `library()` calls that attach packages defining the same name. R masks with the package
 * attached last, so the call reaches that one whichever way the file names sort; the binding used
 * to be the first package file in id order.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo } from './helpers.js';
import type { PipelineResult } from './helpers.js';

// Safe under `pool: 'forks'`: the env stub is process-global, but each file gets its own process.
beforeAll(() => vi.stubEnv('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000'));
afterAll(() => vi.unstubAllEnvs());

describe('R library() masking', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'r-library-masking'), () => {});
  }, 60000);

  /** `target file` of every CALLS edge from `source`. */
  const targets = (source: string): string[] =>
    getRelationships(result, 'CALLS')
      .filter((e) => e.source === source)
      .map((e) => e.targetFilePath)
      .sort();

  it('binds the name to the package attached last', () => {
    expect(targets('run_a')).toEqual(['lp2/R/f.R']);
    expect(targets('run_b')).toEqual(['lp/R/f.R']);
  });

  it('counts a package named by several calls at its last one', () => {
    // library(lp); library(lp2); library(lp) -> lp. library(lp2); library(lp); library(lp2) -> lp2.
    expect(targets('run_c')).toEqual(['lp/R/f.R']);
    expect(targets('run_d')).toEqual(['lp2/R/f.R']);
  });

  it('still binds a name that only one attached package defines', () => {
    expect(targets('keep_a')).toEqual(['lp/R/f.R']);
    expect(targets('keep_b')).toEqual(['lp2/R/f.R']);
  });
});
