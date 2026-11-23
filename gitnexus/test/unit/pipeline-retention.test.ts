import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);

describe('completed pipeline context lifetime', () => {
  it.each(['eager', 'deferred'])(
    'releases progress state while retaining a usable graph (%s)',
    async (mode) => {
      const { stdout } = await run(
        process.execPath,
        [
          '--expose-gc',
          '--import',
          'tsx',
          fileURLToPath(new URL('../helpers/pipeline-retention-child.mjs', import.meta.url)),
          mode,
        ],
        { cwd: fileURLToPath(new URL('../../', import.meta.url)), env: process.env },
      );
      const receipt = JSON.parse(stdout.trim().split('\n').at(-1)!);
      expect(receipt).toEqual({ released: true, deferred: mode === 'deferred' });
    },
    30_000,
  );
});
