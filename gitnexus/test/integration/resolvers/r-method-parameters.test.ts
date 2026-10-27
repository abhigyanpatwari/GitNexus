/**
 * R: the formals of R6 and RefClass methods used to be dropped, so every method had
 * parameterCount 0 and a `#0` id. The count (and the id's `#n` arity tag) now follows
 * the method's formals; a variadic method has no count and no tag.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import { FIXTURES, runPipelineFromRepo } from './helpers.js';
import type { PipelineResult } from './helpers.js';

// Cold worker-pool startups otherwise flake against the 5s default ready budget
// on a loaded runner, failing for reasons unrelated to R parsing or resolution.
// Safe under `pool: 'forks'`: the env stub is process-global, but each file gets its own process.
beforeAll(() => vi.stubEnv('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000'));
afterAll(() => vi.unstubAllEnvs());

// requiredParameterCount is only recorded for a method that has an optional parameter.
describe('R method parameter counts', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'r-method-parameters'), () => {});
  }, 60000);

  const method = (id: string) => result.graph.getNode(`Method:R/methods.R:${id}`);

  it.each([
    ['Acct.reset#0', 0, undefined],
    ['Acct.show#1', 1, undefined],
    ['Acct.transfer#3', 3, undefined],
    ['Acct.deposit#2', 2, 1],
    ['Wallet.empty#0', 0, undefined],
    ['Wallet.spend#2', 2, 1],
  ])('%s has parameterCount %i and requiredParameterCount %s', (id, count, required) => {
    const node = method(id);
    expect(node).toBeDefined();
    expect(node?.properties.parameterCount).toBe(count);
    expect(node?.properties.requiredParameterCount).toBe(required);
  });

  it('gives a variadic method no count and no arity tag', () => {
    const node = method('Acct.log');
    expect(node).toBeDefined();
    expect(node?.properties.parameterCount).toBeUndefined();
    expect(result.graph.getNode('Method:R/methods.R:Acct.log#2')).toBeUndefined();
  });
});
