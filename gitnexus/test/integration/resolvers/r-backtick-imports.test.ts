/**
 * R: a function defined in backticks (`%||%`, `odd fn`) is bound by a NAMESPACE `importFrom()` that
 * names its symbol. The graph keeps the definition's spelling (backticks included) and the call site
 * spells the name as written, while NAMESPACE entries carry the bare symbol; the import has to bridge
 * the two, or the call degrades to the name-based guess, which cannot tell two packages' `%||%` apart.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo } from './helpers.js';
import type { PipelineResult } from './helpers.js';

// Cold worker-pool startups otherwise flake against the 5s default ready budget
// on a loaded runner, failing for reasons unrelated to R parsing or resolution.
beforeAll(() => vi.stubEnv('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000'));
afterAll(() => vi.unstubAllEnvs());

describe('R importFrom() of backtick-quoted definitions', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'r-backtick-imports'), () => {});
  }, 60000);

  /** `target:targetFile:reason:confidence` of every CALLS edge from `source` in the file ending `suffix`. */
  const edges = (source: string, suffix: string): string[] =>
    getRelationships(result, 'CALLS')
      .filter((e) => e.source === source && e.sourceFilePath.endsWith(suffix))
      .map((e) => `${e.target}:${e.targetFilePath}:${e.rel.reason}:${e.rel.confidence}`)
      .sort();

  it('binds a call to a backticked operator through importFrom(pkg, `%||%`), not by name guess', () => {
    expect(edges('run_all', 'consumer/R/use.R').filter((e) => e.startsWith('`%||%`:'))).toEqual([
      '`%||%`:provlib/R/ops.R:import-resolved:0.85',
    ]);
  });

  it('binds a call to a backticked name through a quoted importFrom(pkg, "odd fn")', () => {
    expect(edges('run_all', 'consumer/R/use.R').filter((e) => e.startsWith('`odd fn`:'))).toEqual([
      '`odd fn`:provlib/R/ops.R:import-resolved:0.85',
    ]);
  });

  it('still binds an unquoted name the same way', () => {
    expect(edges('run_all', 'consumer/R/use.R').filter((e) => e.startsWith('plain_fn:'))).toEqual([
      'plain_fn:provlib/R/ops.R:import-resolved:0.85',
    ]);
  });

  it('lets the caller package own definition mask the import of the same symbol', () => {
    expect(
      edges('use_own', 'consumer/R/own.R').map((e) => e.split(':').slice(0, 2).join(':')),
    ).toEqual(['`shadowed_op`:consumer/R/own.R']);
  });

  it('attributes a pkg::name() call to the definition written in backticks', () => {
    const qualified = edges('run_all', 'consumer/R/use.R').filter((e) =>
      e.startsWith('`qualified_op`:'),
    );
    expect(qualified.map((e) => e.split(':').slice(0, 2).join(':'))).toEqual([
      '`qualified_op`:provlib/R/ops.R',
    ]);
  });

  it('keeps resolving a backticked name that library(pkg) brings into scope', () => {
    expect(
      edges('from_library', 'consumer/scripts/lib.R').map((e) =>
        e.split(':').slice(0, 2).join(':'),
      ),
    ).toEqual(['`%||%`:provlib/R/ops.R']);
  });
});
