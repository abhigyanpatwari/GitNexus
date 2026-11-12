/**
 * R: `setRefClass("A", methods = list(...))` defines the same methods whether or not its value is
 * assigned. The method patterns used to require `A <- setRefClass(...)`, so an unassigned call
 * produced the Class and its fields but no Method.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo } from './helpers.js';
import type { PipelineResult } from './helpers.js';

// Cold worker-pool startups otherwise flake against the 5s default ready budget
// on a loaded runner, failing for reasons unrelated to R parsing or resolution.
beforeAll(() => vi.stubEnv('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000'));
afterAll(() => vi.unstubAllEnvs());

describe('R RefClass methods without an assignment', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'r-refclass-unassigned'), () => {});
  }, 60000);

  it('creates a Method for every entry of an unassigned and an assigned methods list', () => {
    const methods = [...result.graph.iterNodes()]
      .filter((n) => n.label === 'Method')
      .map((n) => n.id.replace(/#\d+$/, ''))
      .sort();
    expect(methods).toEqual([
      'Method:R/refclass.R:Account.deposit',
      'Method:R/refclass.R:Account.report',
      'Method:R/refclass.R:Person.greet',
    ]);
  });

  it('attaches each method to its own class, once', () => {
    const owned = getRelationships(result, 'HAS_METHOD')
      .map((e) => `${e.source}->${e.target}`)
      .sort();
    expect(owned).toEqual(['Account->deposit', 'Account->report', 'Person->greet']);
  });
});
