/**
 * Rust: a module-qualified call (`tools::dispatch(..)`) beside a local binding of the same name.
 *
 * The shared free-call pass can resolve a qualified site's hook before it applies a lexical name
 * claim, but only for a provider that sets `qualifiedFreeCallOutranksNameClaim` (R does; Rust
 * does not). For Rust the original order stands, so every shape below produces the graph it did
 * before that option existed (checked against upstream main):
 *
 *  - the unshadowed control binds `tools::dispatch` (import-resolved, 0.85);
 *    (the `let`, `for`, `match`, `if let` and `const` callers live in `shadowed.rs`, whose file-level
 *    `const dispatch` would otherwise shadow the control);
 *  - a caller with a `let`, `for`, `match`, `if let` or `const` binding of `dispatch`, or a
 *    `dispatch` parameter, gets no edge to tools.rs. That is a gap that comes from another pass,
 *    pinned here so a later fix flips these tests deliberately.
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

const edgesFrom = (source: string, file = 'src/main.rs') =>
  getRelationships(result, 'CALLS').filter((e) => e.source === source && e.sourceFilePath === file);

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

  it.each(['with_let_value', 'with_for', 'with_match', 'with_if_let', 'with_const'])(
    '%s is unchanged: no edge to tools.rs (gap of another pass)',
    (caller) => {
      expect(edgesFrom(caller, 'src/shadowed.rs').map((e) => e.targetFilePath)).not.toContain(
        'src/tools.rs',
      );
    },
  );
});
