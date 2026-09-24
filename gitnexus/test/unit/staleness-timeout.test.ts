/**
 * #3256 + #3232: a `rev-list` that TIMED OUT must answer `unknown` from the
 * timeout alone. The #3232 bound exists per request, so asking the same
 * unresponsive working tree for HEAD afterwards would double it — and could
 * report `diverged`/`current` off a HEAD a hung tree may still answer for.
 *
 * Its own file because the mock replaces `node:child_process` for the whole
 * module graph, while `staleness.test.ts` drives these helpers against real git
 * repositories and must keep the real one.
 */
import { describe, expect, it, vi } from 'vitest';

const { spawnedArgs } = vi.hoisted(() => ({ spawnedArgs: [] as string[][] }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const execFile = (
    _file: string,
    args: readonly string[],
    _options: unknown,
    callback: (error: Error | null, result: { stdout: string; stderr: string }) => void,
  ): void => {
    spawnedArgs.push([...args]);
    // What `promisify(execFile)` rejects with when `timeout` kills the child:
    // Node 22 reports `killed: true` alongside `signal: 'SIGTERM'`.
    const timedOut = Object.assign(new Error('Command failed: git rev-list'), {
      killed: true,
      signal: 'SIGTERM',
    });
    callback(timedOut, { stdout: '', stderr: '' });
  };
  return { ...actual, execFile: execFile as unknown as typeof actual.execFile };
});

const INDEXED_COMMIT = 'a'.repeat(40);

describe('checkStalenessAsync — timed-out rev-list (#3256)', () => {
  it('reports unknown without probing HEAD again', async () => {
    const { checkStalenessAsync } = await import('../../src/core/git-staleness.js');

    const result = await checkStalenessAsync('/repo', INDEXED_COMMIT);

    expect(result).toEqual({ status: 'unknown', isStale: false, commitsBehind: 0 });
    // Exactly one spawn. A `rev-parse HEAD` follow-up here is the regression:
    // it doubles the hung-mount bound and can flip this answer.
    expect(spawnedArgs).toEqual([['rev-list', '--count', `${INDEXED_COMMIT}..HEAD`]]);
  });
});
