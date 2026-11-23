/**
 * R: `slots = c(...)` and `fields = c(...)` are the forms `methods::setClass` and
 * `setRefClass` document. They used to create no Property nodes, although the
 * `slots = list(...)` and `representation(...)` forms did.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo } from './helpers.js';
import type { PipelineResult } from './helpers.js';

// Cold worker-pool startups otherwise flake against the 5s default ready budget
// on a loaded runner, failing for reasons unrelated to R parsing or resolution.
// Safe under `pool: 'forks'`: the env stub is process-global, but each file gets its own process.
beforeAll(() => vi.stubEnv('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000'));
afterAll(() => vi.unstubAllEnvs());

describe('R slots / fields given as a c(...) vector', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'r-vector-members'), () => {});
  }, 60000);

  it('creates a Property for every named and unnamed entry, owned by its class', () => {
    const owned = getRelationships(result, 'HAS_PROPERTY')
      .map((e) => `${e.source}->${e.target}`)
      .sort();
    expect(owned).toEqual([
      'Account->balance',
      'Ledger->entries',
      'Person->age',
      'Person->name',
      'Tagged->tag',
      'Tagged->weight',
    ]);
  });

  it('records the declared type of a named entry and none for an unnamed one', () => {
    const declared = (name: string) =>
      result.graph.getNode(`Property:R/vectors.R:${name}`)?.properties.declaredType;
    expect(declared('Person.name')).toBe('character');
    expect(declared('Person.age')).toBe('numeric');
    expect(declared('Tagged.tag')).toBeUndefined();
  });
});
