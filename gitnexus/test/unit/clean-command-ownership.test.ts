/**
 * Regression for PR #3060: ordinary `clean --force` must not trust a
 * registry entry that redirects repository A to repository B's external index.
 *
 * This deliberately drives the real clean command, resolver, registry reader,
 * and filesystem. Guard-only tests cannot catch a future bypass in clean.ts.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanCommand } from '../../src/cli/clean.js';
import { createTempDir, type TestDBHandle } from '../helpers/test-db.js';
import { initGitRepo } from '../helpers/temp-git-repo.js';

describe('cleanCommand external storage ownership', () => {
  let fixture: TestDBHandle;
  let previousGitNexusHome: string | undefined;
  let repoA: string;
  let repoB: string;
  let storageB: string;
  let registryPath: string;

  beforeEach(async () => {
    fixture = await createTempDir();
    previousGitNexusHome = process.env.GITNEXUS_HOME;

    const home = path.join(fixture.dbPath, 'home');
    repoA = path.join(fixture.dbPath, 'repo-a');
    repoB = path.join(fixture.dbPath, 'repo-b');
    storageB = path.join(fixture.dbPath, 'external-index-b');
    registryPath = path.join(home, 'registry.json');

    await Promise.all([fs.mkdir(home, { recursive: true }), fs.mkdir(repoA), fs.mkdir(repoB)]);
    initGitRepo(repoA);
    initGitRepo(repoB);

    await fs.mkdir(storageB);
    const metadata = {
      repoPath: repoB,
      storagePath: storageB,
      lastCommit: 'b-indexed-commit',
      indexedAt: '2026-09-05T00:00:00.000Z',
    };
    await Promise.all([
      fs.writeFile(path.join(storageB, 'gitnexus.json'), JSON.stringify(metadata)),
      fs.writeFile(path.join(storageB, 'meta.json'), JSON.stringify(metadata)),
      fs.writeFile(path.join(storageB, 'ownership-sentinel'), 'must survive\n'),
    ]);

    // Deliberately corrupted registry: repository A names B's valid index.
    await fs.writeFile(
      registryPath,
      JSON.stringify([
        {
          name: 'repo-a',
          path: repoA,
          storagePath: storageB,
          lastCommit: 'a-indexed-commit',
          indexedAt: '2026-09-05T00:00:00.000Z',
        },
      ]),
    );

    process.env.GITNEXUS_HOME = home;
    vi.spyOn(process, 'cwd').mockReturnValue(repoA);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (previousGitNexusHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = previousGitNexusHome;
    await fixture.cleanup();
  });

  it('preserves a foreign external index and registry entry on ordinary clean --force', async () => {
    await cleanCommand({ force: true });

    await expect(fs.access(storageB)).resolves.toBeUndefined();
    await expect(fs.access(path.join(storageB, 'gitnexus.json'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(storageB, 'meta.json'))).resolves.toBeUndefined();
    await expect(fs.readFile(path.join(storageB, 'ownership-sentinel'), 'utf-8')).resolves.toBe(
      'must survive\n',
    );

    const [remainingEntry] = JSON.parse(await fs.readFile(registryPath, 'utf-8'));
    expect(remainingEntry).toMatchObject({ path: repoA, storagePath: storageB });
  });
});
