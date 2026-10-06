/**
 * Count both sides in one Git process to distinguish freshness from rollback
 * without mixing HEAD snapshots (#3127).
 * Keep the child-process mock isolated from tests that use real repositories.
 */
import type { ExecFileOptions } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { plan, invocations } = vi.hoisted(() => ({
  plan: { counts: '0\t0\n' as string | null, head: 'failure', advanceHead: false },
  invocations: [] as { args: string[]; options: ExecFileOptions }[],
}));

const answer = (args: readonly string[], options: ExecFileOptions): string => {
  invocations.push({ args: [...args], options });
  if (args[0] === 'rev-list') {
    if (plan.counts === null) {
      throw Object.assign(new Error('Command failed: git rev-list'), { code: 128, killed: false });
    }
    // Simulate a checkout/commit after Git measured the relationship. A second
    // process would see this different HEAD and could misclassify the result.
    if (plan.advanceHead) plan.head = 'b'.repeat(40);
    return plan.counts;
  }
  if (plan.head === 'empty') return ' \n';
  if (plan.head === 'timeout') {
    throw Object.assign(new Error('Command failed: git rev-parse HEAD'), {
      killed: true,
      signal: 'SIGTERM',
    });
  }
  if (plan.head === 'failure') {
    throw Object.assign(new Error('Command failed: git rev-parse HEAD'), {
      code: 128,
      killed: false,
    });
  }
  return `${plan.head}\n`;
};

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execFile = (
    _file: string,
    args: readonly string[],
    options: ExecFileOptions,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ): void => {
    try {
      callback(null, answer(args, options), '');
    } catch (error) {
      callback(error as Error, '', '');
    }
  };
  // Real execFile has a custom promisifier returning both output streams.
  Object.defineProperty(execFile, promisify.custom, {
    value: async (_file: string, args: readonly string[], options: ExecFileOptions) => ({
      stdout: answer(args, options),
      stderr: '',
    }),
  });
  const execFileSync = (_file: string, args: readonly string[], options: ExecFileOptions): string =>
    answer(args, options);
  return {
    ...actual,
    execFile: execFile as unknown as typeof actual.execFile,
    execFileSync: execFileSync as unknown as typeof actual.execFileSync,
  };
});

import { checkStaleness, checkStalenessAsync } from '../../src/core/git-staleness.js';

const INDEXED_COMMIT = 'a'.repeat(40);
const REV_LIST = ['rev-list', '--left-right', '--count', `${INDEXED_COMMIT}...HEAD`];
const REV_PARSE = ['rev-parse', 'HEAD'];

const bothHelpers = {
  checkStaleness: async (repo: string, lastCommit: string) => checkStaleness(repo, lastCommit),
  checkStalenessAsync,
};

describe('staleness from one relationship query (#3127)', () => {
  beforeEach(() => {
    plan.counts = '0\t0\n';
    plan.head = 'failure';
    plan.advanceHead = false;
    invocations.length = 0;
  });

  for (const [name, check] of Object.entries(bothHelpers)) {
    describe(name, () => {
      it.each([
        { counts: '0\t0\n', status: 'current', isStale: false, commitsBehind: 0 },
        { counts: '2\t0\n', status: 'diverged', isStale: true, commitsBehind: 0 },
        { counts: '0\t3\n', status: 'behind', isStale: true, commitsBehind: 3 },
        { counts: '2\t3\n', status: 'behind', isStale: true, commitsBehind: 3 },
      ])('reports $status from $counts in one process', async ({ counts, ...expected }) => {
        plan.counts = counts;

        const result = await check('/repo', INDEXED_COMMIT);

        expect(result).toMatchObject(expected);
        expect(invocations.map(({ args }) => args)).toEqual([REV_LIST]);
      });

      it('keeps the count snapshot when HEAD advances after the query', async () => {
        plan.head = INDEXED_COMMIT;
        plan.advanceHead = true;

        const result = await check('/repo', INDEXED_COMMIT);

        expect(plan.head).not.toBe(INDEXED_COMMIT);
        expect(result).toEqual({ status: 'current', isStale: false, commitsBehind: 0 });
        expect(invocations.map(({ args }) => args)).toEqual([REV_LIST]);
      });

      it.each(['', '0\n', '0\tbogus\n'])(
        'reports unknown for malformed counts %j',
        async (counts) => {
          plan.counts = counts;

          const result = await check('/repo', INDEXED_COMMIT);

          expect(result).toEqual({ status: 'unknown', isStale: false, commitsBehind: 0 });
          expect(invocations.map(({ args }) => args)).toEqual([REV_LIST]);
        },
      );

      it('reports unknown when the follow-up HEAD command fails', async () => {
        plan.counts = null;
        const result = await check('/repo', INDEXED_COMMIT);

        expect(result).toEqual({ status: 'unknown', isStale: false, commitsBehind: 0 });
        expect(invocations.map(({ args }) => args)).toEqual([REV_LIST, REV_PARSE]);
      });

      it('reports unknown when the follow-up HEAD command returns no commit', async () => {
        plan.counts = null;
        plan.head = 'empty';

        const result = await check('/repo', INDEXED_COMMIT);

        expect(result).toEqual({ status: 'unknown', isStale: false, commitsBehind: 0 });
        expect(invocations.map(({ args }) => args)).toEqual([REV_LIST, REV_PARSE]);
      });

      it('bounds the HEAD command and reports unknown without retrying after its timeout', async () => {
        plan.counts = null;
        plan.head = 'timeout';

        const result = await check('/repo', INDEXED_COMMIT);

        expect(result).toEqual({ status: 'unknown', isStale: false, commitsBehind: 0 });
        expect(invocations.map(({ args }) => args)).toEqual([REV_LIST, REV_PARSE]);
        const timeout = invocations[1].options.timeout;
        expect(Number.isFinite(timeout)).toBe(true);
        expect(timeout).toBeGreaterThan(0);
      });
    });
  }
});
