import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { sweepStaleUploads } from '../../src/server/upload-sweep.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-sweep-test-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

describe('sweepStaleUploads', () => {
  it('removes stale staging dirs but keeps recent ones and non-staging dirs', async () => {
    await fs.mkdir(path.join(root, '.staging-old'));
    await fs.mkdir(path.join(root, '.staging-new'));
    await fs.mkdir(path.join(root, 'myrepo')); // a promoted (persistent) upload dir

    const now = 1_000_000_000_000;
    // Age the "old" staging dir well past the threshold.
    const old = new Date(now - 10 * 60 * 60 * 1000);
    await fs.utimes(path.join(root, '.staging-old'), old, old);
    const recent = new Date(now - 60 * 1000);
    await fs.utimes(path.join(root, '.staging-new'), recent, recent);

    const { removed } = await sweepStaleUploads({ root, now, maxAgeMs: 6 * 60 * 60 * 1000 });

    expect(removed).toHaveLength(1);
    expect(removed[0]).toContain('.staging-old');
    await expect(fs.access(path.join(root, '.staging-old'))).rejects.toBeTruthy();
    // Recent staging and the promoted repo dir survive.
    await expect(fs.access(path.join(root, '.staging-new'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(root, 'myrepo'))).resolves.toBeUndefined();
  });

  it('tolerates a missing root', async () => {
    const { removed } = await sweepStaleUploads({ root: path.join(root, 'does-not-exist') });
    expect(removed).toEqual([]);
  });
});
