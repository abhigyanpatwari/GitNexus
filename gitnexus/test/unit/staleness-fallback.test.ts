/**
 * #3256: what a staleness check reports once `rev-list` has failed for a reason
 * OTHER than a timeout. `staleness.test.ts` reaches `diverged` and `unknown`
 * against real repositories, but not the third arm of `fromHead`: HEAD still
 * resolves to the indexed commit, so the index is at HEAD however `rev-list`
 * failed. Real git cannot fail `<sha>..HEAD` while HEAD prints that same SHA
 * without a corrupted object store, so this drives it through a mock.
 *
 * Its own file for the same reason as `staleness-timeout.test.ts`: the mock
 * replaces `node:child_process` for the whole module graph.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { plan, spawnedArgs } = vi.hoisted(() => ({
  plan: { head: null as string | null },
  spawnedArgs: [] as string[][],
}));

// `rev-list` exits 128 the way git does for a missing object; `rev-parse HEAD`
// answers `plan.head`, or fails when it is null.
const answer = (args: readonly string[]): { error: Error | null; stdout: string } => {
  spawnedArgs.push([...args]);
  if (args[0] === 'rev-parse' && plan.head) return { error: null, stdout: `${plan.head}\n` };
  const failure = Object.assign(new Error(`Command failed: git ${args.join(' ')}`), {
    code: 128,
    killed: false,
  });
  return { error: failure, stdout: '' };
};

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const execFile = (
    _file: string,
    args: readonly string[],
    _options: unknown,
    callback: (error: Error | null, result: { stdout: string; stderr: string }) => void,
  ): void => {
    const { error, stdout } = answer(args);
    callback(error, { stdout, stderr: '' });
  };
  const execFileSync = (_file: string, args: readonly string[]): string => {
    const { error, stdout } = answer(args);
    if (error) throw error;
    return stdout;
  };
  return {
    ...actual,
    execFile: execFile as unknown as typeof actual.execFile,
    execFileSync: execFileSync as unknown as typeof actual.execFileSync,
  };
});

import { checkStaleness, checkStalenessAsync } from '../../src/core/git-staleness.js';

const INDEXED_COMMIT = 'a'.repeat(40);
const REV_LIST = ['rev-list', '--count', `${INDEXED_COMMIT}..HEAD`];
const REV_PARSE = ['rev-parse', 'HEAD'];

const bothHelpers = {
  checkStaleness: async (repo: string, lastCommit: string) => checkStaleness(repo, lastCommit),
  checkStalenessAsync,
};

describe('staleness after a failed (not timed-out) rev-list (#3256)', () => {
  beforeEach(() => {
    plan.head = null;
    spawnedArgs.length = 0;
  });

  for (const [name, check] of Object.entries(bothHelpers)) {
    describe(name, () => {
      it('reports current when HEAD alone still resolves to the indexed commit', async () => {
        plan.head = INDEXED_COMMIT;

        const result = await check('/repo', INDEXED_COMMIT);

        expect(result).toEqual({ isStale: false, commitsBehind: 0, status: 'current' });
        // The answer came from the HEAD probe, not from rev-list.
        expect(spawnedArgs).toEqual([REV_LIST, REV_PARSE]);
      });

      it('reports diverged when HEAD resolves elsewhere', async () => {
        plan.head = 'b'.repeat(40);

        const result = await check('/repo', INDEXED_COMMIT);

        expect(result).toMatchObject({ isStale: false, commitsBehind: 0, status: 'diverged' });
        expect(spawnedArgs).toEqual([REV_LIST, REV_PARSE]);
      });

      it('reports unknown when HEAD cannot be read either', async () => {
        const result = await check('/repo', INDEXED_COMMIT);

        expect(result).toEqual({ isStale: false, commitsBehind: 0, status: 'unknown' });
        expect(spawnedArgs).toEqual([REV_LIST, REV_PARSE]);
      });
    });
  }
});
