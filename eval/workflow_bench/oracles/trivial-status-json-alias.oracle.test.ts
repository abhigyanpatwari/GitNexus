import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('hidden oracle: status -j JSON alias', () => {
  it('returns the same machine-readable status shape as --json', () => {
    const executable = path.resolve('node_modules/.bin/tsx');
    const options = {
      cwd: process.cwd(),
      encoding: 'utf8' as const,
      env: { ...process.env, NO_COLOR: '1' },
    };
    const short = spawnSync(executable, ['src/cli/index.ts', 'status', '-j'], options);
    const long = spawnSync(executable, ['src/cli/index.ts', 'status', '--json'], options);

    expect(short.error).toBeUndefined();
    expect(short.status).toBe(0);
    expect(short.stderr.trim()).toBe('');
    expect(long.status).toBe(0);

    const shortPayload = JSON.parse(short.stdout) as Record<string, unknown>;
    const longPayload = JSON.parse(long.stdout) as Record<string, unknown>;
    expect(shortPayload.schemaVersion).toBe(1);
    expect(shortPayload).toHaveProperty('status');
    expect(shortPayload).toHaveProperty('repository');
    expect(shortPayload).toEqual(longPayload);
  });
});
