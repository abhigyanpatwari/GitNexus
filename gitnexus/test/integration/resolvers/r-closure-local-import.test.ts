/**
 * R: `library(pkg)` and `importFrom(pkg, name)` must not bind an export to a closure-local
 * function of the same name. The shared finalize indexes every definition of the target file by
 * simple name, so the nested `validate` inside `process()` used to win over the exported
 * top-level one. A name with one definition still binds (positive controls).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo } from './helpers.js';
import type { PipelineResult } from './helpers.js';

beforeAll(() => vi.stubEnv('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000'));
afterAll(() => vi.unstubAllEnvs());

describe('R import of a name that also has a closure-local definition', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'r-closure-local-import'), () => {});
  }, 60000);

  /** `file:reason:confidence` of every CALLS edge from `source`. */
  const targets = (source: string): string[] =>
    getRelationships(result, 'CALLS')
      .filter((e) => e.source === source)
      .map((e) => `${e.targetFilePath}:${e.rel.reason}:${e.rel.confidence}`)
      .sort();

  it('does not bind library(pkg) to the closure-local definition', () => {
    expect(targets('via_library').filter((t) => t.includes(':import-resolved'))).toEqual([]);
  });

  it('does not bind importFrom() to the closure-local definition', () => {
    expect(targets('via_import').filter((t) => t.includes(':import-resolved'))).toEqual([]);
  });

  it('still binds a name with a single definition (positive controls)', () => {
    expect(targets('via_library_solo')).toEqual(['provc/R/v.R:import-resolved:0.85']);
    expect(targets('via_import_solo')).toEqual(['provc/R/v.R:import-resolved:0.85']);
  });
});
