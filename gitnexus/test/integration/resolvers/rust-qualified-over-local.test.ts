/**
 * Rust: a module-qualified call (`tools::dispatch(..)`) beside a local binding of the same name.
 *
 * The shared free-call pass now resolves a qualified site's hook before it applies a lexical name
 * claim, so a defined hit outranks the claim (unit-tested with a fake hook in
 * `free-call-qualified-over-name-claim.test.ts`). Rust publishes no such claim for a `let` or a
 * parameter, so this fixture pins that its edges did not move with the reorder:
 *
 *  - the unshadowed control binds `tools::dispatch` (import-resolved, 0.85);
 *  - a caller with a `let dispatch = ..` or a `dispatch` parameter keeps the behaviour it had
 *    before the reorder. It gets no edge to tools.rs, which is a gap that comes from another pass
 *    and is pinned here so a later fix flips this test deliberately.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo } from './helpers.js';
import type { PipelineResult } from './helpers.js';

beforeAll(() => vi.stubEnv('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000'));
afterAll(() => vi.unstubAllEnvs());

let result: PipelineResult;
beforeAll(async () => {
  result = await runPipelineFromRepo(path.join(FIXTURES, 'qualified-over-local-rust'), () => {});
}, 60000);

const edgesFrom = (source: string) =>
  getRelationships(result, 'CALLS').filter(
    (e) => e.source === source && e.sourceFilePath === 'src/main.rs',
  );

describe('Rust qualified call beside a same-named local binding', () => {
  it('control: tools::dispatch with no local binding binds tools.rs', () => {
    const edges = edgesFrom('plain');
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ target: 'dispatch', targetFilePath: 'src/tools.rs' });
    expect(edges[0].rel.reason).toBe('import-resolved');
  });

  it('a `let dispatch` caller is unchanged: no edge to tools.rs (gap of another pass)', () => {
    expect(edgesFrom('with_let').map((e) => e.targetFilePath)).not.toContain('src/tools.rs');
  });

  it('a `dispatch` parameter caller is unchanged: no edge to tools.rs (gap of another pass)', () => {
    expect(edgesFrom('with_parameter')).toEqual([]);
  });
});
