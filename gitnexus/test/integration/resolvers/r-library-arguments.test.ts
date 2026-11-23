/**
 * R: `library(pkg, exclude = ...)`, `library(pkg, include.only = ...)` and
 * `library(pkg, character.only = TRUE)` attach nothing. The provider does not model the three
 * arguments (what is hidden, what is attached, which package the variable names), and an
 * edge the call cannot reach is worse than no edge. A plain `library(pkg)` still binds
 * (positive control). The call may still meet the unique-name guess of a lower tier (0.5,
 * `global-name-fallback`), which does not claim the package was attached.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo } from './helpers.js';
import type { PipelineResult } from './helpers.js';

beforeAll(() => vi.stubEnv('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000'));
afterAll(() => vi.unstubAllEnvs());

describe('R library() arguments that change what is attached', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'r-library-arguments'), () => {});
  }, 60000);

  /** `file:reason:confidence` of every CALLS edge from `source`. */
  const targets = (source: string): string[] =>
    getRelationships(result, 'CALLS')
      .filter((e) => e.source === source)
      .map((e) => `${e.targetFilePath}:${e.rel.reason}:${e.rel.confidence}`)
      .sort();

  /** The 0.85 edges a `library()` attachment yields. */
  const attached = (source: string): string[] =>
    targets(source).filter((t) => t.includes(':import-resolved:'));

  it('attaches nothing for exclude =', () => {
    expect(attached('call_f')).toEqual([]);
  });

  it('attaches nothing for include.only =', () => {
    expect(attached('call_g')).toEqual([]);
    expect(attached('call_h')).toEqual([]);
  });

  it('attaches nothing for character.only = TRUE', () => {
    expect(attached('run_charonly')).toEqual([]);
  });

  it('still binds a plain library(pkg) (positive control)', () => {
    expect(targets('call_kept')).toEqual(['pkgk/R/k.R:import-resolved:0.85']);
  });
});
