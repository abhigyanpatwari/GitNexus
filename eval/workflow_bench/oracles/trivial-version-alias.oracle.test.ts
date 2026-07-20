import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import pkg from '../gitnexus/package.json';

describe('hidden oracle: -V version alias', () => {
  it('prints exactly the installed GitNexus version and exits successfully', () => {
    const result = spawnSync(path.resolve('node_modules/.bin/tsx'), ['src/cli/index.ts', '-V'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
    expect(result.stderr.trim()).toBe('');
  });
});
