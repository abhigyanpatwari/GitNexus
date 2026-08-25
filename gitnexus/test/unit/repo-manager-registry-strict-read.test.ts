import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readRegistry, readRegistryStrict } from '../../src/storage/repo-manager.js';
import { createTempDir } from '../helpers/test-db.js';

/**
 * `readRegistry` used to answer every failure with `[]`.
 *
 * For a listing that is harmless — an unreadable registry and an empty one look
 * the same in `gitnexus list`, and both print nothing. For a caller that *acts*
 * on emptiness it is not: `syncGroup` derives `missingRepos` from this list, and
 * an all-missing sync is allowed to write, so an EACCES after a
 * `sudo gitnexus analyze`, a truncated registry.json, or an $HOME-on-NFS blip
 * turned "I could not read the registry" into the factual claim "no repo is
 * registered" — and replaced a good contracts.json with an empty one at exit 0.
 *
 * That is an unreadable condition reported as missing: the same conflation
 * #3011 removes one stack frame further down, which is why `readRegistryStrict`
 * exists and why syncGroup is the only caller that uses it. It is a separate
 * export rather than an option on `readRegistry` so that the nine lenient call
 * sites keep a provably untouched signature.
 *
 * ENOENT stays lenient in both modes. No file genuinely means nothing has been
 * registered yet, and every first-run path depends on that.
 */

describe('readRegistryStrict', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let savedGitnexusHome: string | undefined;
  let registryPath: string;

  beforeEach(async () => {
    tmpHome = await createTempDir('gitnexus-registry-strict-');
    savedGitnexusHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
    registryPath = path.join(tmpHome.dbPath, 'registry.json');
  });

  afterEach(async () => {
    if (savedGitnexusHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedGitnexusHome;
    await tmpHome.cleanup();
  });

  it('returns [] for a registry that does not exist, strict or not', async () => {
    await expect(readRegistry()).resolves.toEqual([]);
    await expect(readRegistryStrict()).resolves.toEqual([]);
  });

  it('reads a valid registry identically in both modes', async () => {
    const entries = [
      {
        name: 'backend-repo',
        path: '/repos/backend',
        storagePath: '/repos/backend/.gitnexus',
        indexedAt: '2026-01-01T00:00:00.000Z',
        lastCommit: 'abc123',
      },
    ];
    await fs.writeFile(registryPath, JSON.stringify(entries));

    await expect(readRegistry()).resolves.toEqual(entries);
    await expect(readRegistryStrict()).resolves.toEqual(entries);
  });

  it('throws on a corrupt registry instead of reporting an empty one', async () => {
    await fs.writeFile(registryPath, '{"truncated": ');

    // Lenient stays lenient — existing callers keep the contract they have.
    await expect(readRegistry()).resolves.toEqual([]);
    await expect(readRegistryStrict()).rejects.toThrow();
  });

  it('throws when a row is missing the fields the resolver needs', async () => {
    // `[{}]` is a JSON array, so an array-shape check alone waved it through.
    // Every configured repo then failed to resolve and landed in missingRepos;
    // because none produced a load ERROR the total-failure guard stayed off,
    // and a good contracts.json was replaced with an empty one at exit 0. Same
    // fail-open as an unreadable file, one level down.
    await fs.writeFile(registryPath, JSON.stringify([{}]));

    await expect(readRegistry()).resolves.toEqual([{}]);
    await expect(readRegistryStrict()).rejects.toThrow('registry is corrupt');
  });

  it('throws on a row whose required fields are the wrong type', async () => {
    await fs.writeFile(
      registryPath,
      JSON.stringify([{ name: 'backend-repo', path: 42, storagePath: '/s' }]),
    );

    await expect(readRegistryStrict()).rejects.toThrow('registry is corrupt');
  });

  it('rejects the whole registry rather than dropping the bad row', async () => {
    // Filtering would report the repos the surviving rows do not name as
    // unregistered — the unreadable-as-missing answer this mode exists to
    // refuse, reintroduced as a silent partial read.
    await fs.writeFile(
      registryPath,
      JSON.stringify([
        {
          name: 'good-repo',
          path: '/repos/good',
          storagePath: '/repos/good/.gitnexus',
          indexedAt: '2026-01-01T00:00:00.000Z',
          lastCommit: 'abc123',
        },
        {},
      ]),
    );

    await expect(readRegistryStrict()).rejects.toThrow('entry 1');
  });

  it('accepts a legacy row that omits indexedAt and lastCommit', async () => {
    // Those two are defaulted by every caller (`e?.indexedAt || ''`), so
    // demanding them would turn a fail-open into a fail-shut on real data.
    const legacy = [
      { name: 'backend-repo', path: '/repos/backend', storagePath: '/repos/backend/.gitnexus' },
    ];
    await fs.writeFile(registryPath, JSON.stringify(legacy));

    await expect(readRegistryStrict()).resolves.toEqual(legacy);
  });

  it('throws when the registry parses but is not an array', async () => {
    // A JSON object here is corruption too, and it is the shape most likely to
    // survive a partial write: `[]` is what the lenient path would return, which
    // is indistinguishable from a registry that really has no entries.
    await fs.writeFile(registryPath, '{"repos": []}');

    await expect(readRegistry()).resolves.toEqual([]);
    await expect(readRegistryStrict()).rejects.toThrow('not a JSON array');
  });
});
