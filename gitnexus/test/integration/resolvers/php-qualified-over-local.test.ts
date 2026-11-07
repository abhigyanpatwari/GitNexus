/**
 * PHP: a namespaced function call (`\Lib\make()`) beside an unresolved `use function Ext\make` and
 * a same-named function of the caller's own namespace.
 *
 * The shared free-call pass now resolves a qualified site's hook before it applies a lexical name
 * claim (unit-tested with a fake hook in `free-call-qualified-over-name-claim.test.ts`). PHP
 * publishes no such claim for these declarations, so this fixture pins that its edges did not move
 * with the reorder: the qualified call binds `Lib\make`, the unqualified control binds the
 * namespace's own `make`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo } from './helpers.js';
import type { PipelineResult } from './helpers.js';

beforeAll(() => vi.stubEnv('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000'));
afterAll(() => vi.unstubAllEnvs());

let result: PipelineResult;
beforeAll(async () => {
  result = await runPipelineFromRepo(path.join(FIXTURES, 'qualified-over-local-php'), () => {});
}, 60000);

const edgesFrom = (source: string) =>
  getRelationships(result, 'CALLS').filter(
    (e) => e.source === source && e.sourceFilePath === 'src/Caller.php',
  );

describe('PHP qualified function call beside same-named declarations', () => {
  it('binds \\Lib\\make() to the library function, not the namespace-local make', () => {
    const edges = edgesFrom('qualified');
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ target: 'make', targetFilePath: 'lib/functions.php' });
    expect(edges[0].rel.reason).toBe('import-resolved');
  });

  it('control: the unqualified call binds the namespace-local make', () => {
    const edges = edgesFrom('control');
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ target: 'make', targetFilePath: 'src/Caller.php' });
  });
});
