import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { pruneWindowsIdentityCache } from '../../src/core/windows-identity-cache-retention.js';

it('keeps the just-published file even when it sorts fourth and expires only stale cache temporaries', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'identity-retention-'));
  try {
    const keys = ['a', 'b', 'c', 'd'].map((key) => key.repeat(64) + '.json');
    const keep = keys[3];
    const recent = keep + '.123.abcdef123456.tmp';
    const old = keys[0] + '.123.abcdef123456.tmp';
    for (const name of [...keys, recent, old, 'unrelated.tmp']) {
      await writeFile(path.join(directory, name), '');
    }
    const yesterday = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await utimes(path.join(directory, old), yesterday, yesterday);
    for (const [index, key] of keys.entries()) {
      const time = new Date(yesterday.getTime() - 1000 * index);
      await utimes(path.join(directory, key), time, time);
    }
    pruneWindowsIdentityCache(directory, keep);
    expect((await readdir(directory)).sort()).toEqual(
      [keys[0], keys[1], keep, recent, 'unrelated.tmp'].sort(),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
