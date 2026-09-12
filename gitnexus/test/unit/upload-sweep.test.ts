import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { sweepStaleUploads } from '../../src/server/upload-sweep.js';

let root: string;
let home: string;
let previousHome: string | undefined;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-sweep-test-'));
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-sweep-home-'));
  await fs.writeFile(path.join(home, 'registry.json'), '[]');
  previousHome = process.env.GITNEXUS_HOME;
  process.env.GITNEXUS_HOME = home;
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  if (previousHome === undefined) delete process.env.GITNEXUS_HOME;
  else process.env.GITNEXUS_HOME = previousHome;
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

  it('removes an unregistered stale promoted dir, keeps a registered one without local index', async () => {
    const now = 2_000_000_000_000;
    const old = new Date(now - 10 * 60 * 60 * 1000);

    // Orphan: a failed analysis that never registered its source directory.
    await fs.mkdir(path.join(root, 'orphan'));
    await fs.utimes(path.join(root, 'orphan'), old, old);

    // Registered: stale and its index is external, so it has no local
    // `.gitnexus` directory at all. Registry membership is the persistence
    // signal for promoted uploads.
    const registered = path.join(root, 'registered');
    await fs.mkdir(registered);
    await fs.writeFile(
      path.join(home, 'registry.json'),
      JSON.stringify([
        {
          name: 'registered',
          path: registered,
          storagePath: path.join(home, 'storage', 'registered'),
          indexedAt: '',
          lastCommit: '',
        },
      ]),
    );
    await fs.utimes(registered, old, old);

    const { removed } = await sweepStaleUploads({ root, now, maxAgeMs: 6 * 60 * 60 * 1000 });

    expect(removed.some((r) => r.endsWith('orphan'))).toBe(true);
    await expect(fs.access(path.join(root, 'orphan'))).rejects.toBeTruthy();
    await expect(fs.access(path.join(root, 'registered'))).resolves.toBeUndefined();
  });

  it('still removes stale staging dirs but preserves promoted source dirs when the registry is corrupt', async () => {
    const now = 2_000_000_000_000;
    const old = new Date(now - 10 * 60 * 60 * 1000);
    const staging = path.join(root, '.staging-old');
    const promoted = path.join(root, 'promoted');
    await fs.mkdir(staging);
    await fs.mkdir(promoted);
    await fs.utimes(staging, old, old);
    await fs.utimes(promoted, old, old);
    await fs.writeFile(path.join(home, 'registry.json'), '{"truncated":');

    const { removed } = await sweepStaleUploads({ root, now, maxAgeMs: 6 * 60 * 60 * 1000 });

    expect(removed).toContain(staging);
    await expect(fs.access(staging)).rejects.toBeTruthy();
    await expect(fs.access(promoted)).resolves.toBeUndefined();
  });

  it('tolerates a missing root', async () => {
    const { removed } = await sweepStaleUploads({ root: path.join(root, 'does-not-exist') });
    expect(removed).toEqual([]);
  });
});
