/**
 * R: a name defined in two files of one package binds nothing through `library(pkg)` or
 * `importFrom(pkg, name)`. Which file R would use depends on collation order and load order, and
 * the provider used to bind the first file at 0.85. A name with one definition still binds
 * (positive controls).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo } from './helpers.js';
import type { PipelineResult } from './helpers.js';

beforeAll(() => vi.stubEnv('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000'));
afterAll(() => vi.unstubAllEnvs());

describe('R name defined in two files of one package', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'r-two-file-package'), () => {});
  }, 60000);

  /** `file:reason:confidence` of every CALLS edge from `source`. */
  const targets = (source: string): string[] =>
    getRelationships(result, 'CALLS')
      .filter((e) => e.source === source)
      .map((e) => `${e.targetFilePath}:${e.rel.reason}:${e.rel.confidence}`)
      .sort();

  it('binds no edge from library(pkg)', () => {
    expect(targets('via_library')).toEqual([]);
  });

  it('binds no edge from importFrom(pkg, name)', () => {
    expect(targets('via_import')).toEqual([]);
  });

  it('still binds a name with a single definition (positive controls)', () => {
    expect(targets('via_library_once')).toEqual(['pkgt/R/a.R:import-resolved:0.85']);
    expect(targets('via_import_once')).toEqual(['pkgt/R/a.R:import-resolved:0.85']);
  });
});
