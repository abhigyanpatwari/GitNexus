import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('hidden oracle: status -j JSON alias', () => {
  it('returns the same machine-readable status shape as --json', () => {
    const options = {
      cwd: process.cwd(),
      encoding: 'utf8' as const,
      env: { ...process.env, NO_COLOR: '1' },
      timeout: 60_000,
    };
    // Node's loader runs the candidate source without the tsx CLI's IPC socket.
    const command = ['--import', 'tsx', 'src/cli/index.ts', 'status'];
    const short = spawnSync(process.execPath, [...command, '-j'], options);
    const long = spawnSync(process.execPath, [...command, '--json'], options);

    expect(short.error).toBeUndefined();
    expect(short.status).toBe(0);
    // The command banner is written to stderr, including in JSON mode.
    expect(short.stderr).toBe(long.stderr);
    expect(long.error).toBeUndefined();
    expect(long.status).toBe(0);

    const shortPayload = JSON.parse(short.stdout) as Record<string, unknown>;
    const longPayload = JSON.parse(long.stdout) as Record<string, unknown>;
    expect(shortPayload.schemaVersion).toBe(1);
    expect(shortPayload).toHaveProperty('repository');
    expect(shortPayload).toEqual(longPayload);
  });
});
