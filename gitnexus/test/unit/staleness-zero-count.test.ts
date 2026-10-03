/**
 * A successful zero count still needs HEAD to establish freshness (#3127).
 * Keep the child-process mock isolated from tests that use real repositories.
 */
import type { ExecFileOptions } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { plan, invocations } = vi.hoisted(() => ({
  plan: { head: 'failure' as 'failure' | 'empty' | 'timeout' },
  invocations: [] as { args: string[]; options: ExecFileOptions }[],
}));

const answer = (args: readonly string[], options: ExecFileOptions): string => {
  invocations.push({ args: [...args], options });
  if (args[0] === 'rev-list') return '0\n';
  if (plan.head === 'empty') return ' \n';
  if (plan.head === 'timeout') {
    throw Object.assign(new Error('Command failed: git rev-parse HEAD'), {
      killed: true,
      signal: 'SIGTERM',
    });
  }
  throw Object.assign(new Error('Command failed: git rev-parse HEAD'), {
    code: 128,
    killed: false,
  });
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
const REV_LIST = ['rev-list', '--count', `${INDEXED_COMMIT}..HEAD`];
const REV_PARSE = ['rev-parse', 'HEAD'];

const bothHelpers = {
  checkStaleness: async (repo: string, lastCommit: string) => checkStaleness(repo, lastCommit),
  checkStalenessAsync,
};

describe('staleness after a successful zero-count rev-list (#3127)', () => {
  beforeEach(() => {
    plan.head = 'failure';
    invocations.length = 0;
  });

  for (const [name, check] of Object.entries(bothHelpers)) {
    describe(name, () => {
      it('reports unknown when the follow-up HEAD command fails', async () => {
        const result = await check('/repo', INDEXED_COMMIT);

        expect(result).toEqual({ status: 'unknown', isStale: false, commitsBehind: 0 });
        expect(invocations.map(({ args }) => args)).toEqual([REV_LIST, REV_PARSE]);
      });

      it('reports unknown when the follow-up HEAD command returns no commit', async () => {
        plan.head = 'empty';

        const result = await check('/repo', INDEXED_COMMIT);

        expect(result).toEqual({ status: 'unknown', isStale: false, commitsBehind: 0 });
        expect(invocations.map(({ args }) => args)).toEqual([REV_LIST, REV_PARSE]);
      });

      it('bounds the HEAD command and reports unknown without retrying after its timeout', async () => {
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
