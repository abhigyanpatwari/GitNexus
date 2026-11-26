/**
 * Analyzer identity cache persistence on Windows.
 *
 * Windows has no `getuid`, so the analyzer identity cache was never persisted
 * there: the identity was recomputed on every `status`/`analyze` run, which
 * costs seconds per invocation. The blocker is not the cache but the proof
 * that the cache directory is private to the user — POSIX proves it with the
 * owner UID and the mode bits, Windows with the access-control list.
 *
 * These cases drive the Windows branch from a POSIX runner by pinning
 * `process.platform` and replacing the access-control probe, so the policy is
 * asserted on every CI platform rather than only on a Windows machine.
 */
import { mkdir, readdir, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  _clearAnalyzerIdentityProcessCacheForTests,
  resolveAnalyzerRunnerIdentity,
} from '../../src/core/analyzer-identity.js';
import {
  _setWindowsDirectoryPrivacyHooksForTests,
  type WindowsDirectoryAccess,
} from '../../src/utils/windows-directory-privacy.js';
import { createTempDir } from '../helpers/test-db.js';

const USER_SID = 'S-1-5-21-111111111-222222222-333333333-1001';
const STRANGER_SID = 'S-1-5-21-111111111-222222222-333333333-1002';

function privateAccess(): WindowsDirectoryAccess {
  return {
    currentUser: USER_SID,
    owner: USER_SID,
    allowedSids: [USER_SID, 'S-1-5-18', 'S-1-5-32-544'],
  };
}

function permissiveAccess(): WindowsDirectoryAccess {
  return {
    currentUser: USER_SID,
    owner: USER_SID,
    allowedSids: [USER_SID, 'S-1-5-18', 'S-1-5-32-544', STRANGER_SID],
  };
}

interface Fixture {
  readonly homePath: string;
  readonly cachePath: string;
  readonly url: string;
  readonly cleanup: () => Promise<void>;
}

async function createFixture(): Promise<Fixture> {
  const fixture = await createTempDir();
  const home = await createTempDir();
  const sourceRoot = path.join(fixture.dbPath, 'src');
  const modulePath = path.join(sourceRoot, 'core', 'analyzer.ts');
  await mkdir(path.dirname(modulePath), { recursive: true });
  await writeFile(
    path.join(fixture.dbPath, 'package.json'),
    '{"name":"fixture-analyzer","version":"9.8.7"}\n',
  );
  await writeFile(modulePath, Buffer.alloc(64 * 1024, 0x37));
  return {
    homePath: home.dbPath,
    cachePath: path.join(home.dbPath, '.gitnexus', 'analyzer-identity'),
    url: pathToFileURL(modulePath).href,
    cleanup: async () => {
      await home.cleanup();
      await fixture.cleanup();
    },
  };
}

async function withWindowsCache(
  fixture: Fixture,
  run: (hashedBytes: () => number) => Promise<void>,
): Promise<void> {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const homedir = vi.spyOn(os, 'homedir').mockReturnValue(fixture.homePath);
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    await run(() => {
      let bytes = 0;
      resolveAnalyzerRunnerIdentity(fixture.url, {
        onHashedInput: (input) => {
          bytes += input.bytes;
        },
      });
      return bytes;
    });
  } finally {
    if (platform) Object.defineProperty(process, 'platform', platform);
    homedir.mockRestore();
    _setWindowsDirectoryPrivacyHooksForTests(null);
    _clearAnalyzerIdentityProcessCacheForTests();
  }
}

describe('analyzer identity cache on Windows', () => {
  it('persists the identity in the per-user directory once it is proven private', async () => {
    const fixture = await createFixture();
    try {
      await withWindowsCache(fixture, async (hashedBytes) => {
        _setWindowsDirectoryPrivacyHooksForTests({
          read: () => privateAccess(),
          lock: () => privateAccess(),
        });

        expect(hashedBytes()).toBeGreaterThanOrEqual(64 * 1024);
        _clearAnalyzerIdentityProcessCacheForTests();
        // The persisted entry is reused: nothing is hashed a second time.
        expect(hashedBytes()).toBe(0);

        const entries = await readdir(fixture.cachePath);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatch(/^[0-9a-f]{64}\.json$/);
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('persists nothing when the directory cannot be proven private', async () => {
    const fixture = await createFixture();
    try {
      await withWindowsCache(fixture, async (hashedBytes) => {
        _setWindowsDirectoryPrivacyHooksForTests({
          read: () => null,
          lock: () => privateAccess(),
        });

        expect(hashedBytes()).toBeGreaterThanOrEqual(64 * 1024);
        _clearAnalyzerIdentityProcessCacheForTests();
        // Without a provable directory the identity is recomputed every run,
        // exactly as it was before the Windows cache existed.
        expect(hashedBytes()).toBeGreaterThanOrEqual(64 * 1024);
        expect(await readdir(fixture.cachePath)).toEqual([]);
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps the per-user directory bounded across analyzer updates', async () => {
    const fixture = await createFixture();
    try {
      await withWindowsCache(fixture, async (hashedBytes) => {
        await mkdir(fixture.cachePath, { recursive: true });
        const planted = ['a', 'b', 'c', 'd'].map((marker) => `${marker.repeat(64)}.json`);
        for (const [index, file] of planted.entries()) {
          const target = path.join(fixture.cachePath, file);
          await writeFile(target, '{"stale":true}\n');
          const stamp = new Date(Date.now() - (planted.length - index) * 86_400_000);
          await utimes(target, stamp, stamp);
        }

        _setWindowsDirectoryPrivacyHooksForTests({
          read: () => privateAccess(),
          lock: () => privateAccess(),
        });

        expect(hashedBytes()).toBeGreaterThanOrEqual(64 * 1024);

        const entries = (await readdir(fixture.cachePath)).filter((entry) =>
          /^[0-9a-f]{64}\.json$/.test(entry),
        );
        // The entry written by this run and the two most recent stale ones
        // survive; older ones are removed so the directory cannot grow with
        // every analyzer update.
        expect(entries).toHaveLength(3);
        expect(entries).toContain(planted[3]);
        expect(entries).not.toContain(planted[0]);
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('discards the files a writable directory may contain before locking it', async () => {
    const fixture = await createFixture();
    try {
      await withWindowsCache(fixture, async (hashedBytes) => {
        await mkdir(fixture.cachePath, { recursive: true });
        const planted = `${'a'.repeat(64)}.json`;
        await writeFile(path.join(fixture.cachePath, planted), '{"planted":true}\n');
        await writeFile(path.join(fixture.cachePath, 'notes.txt'), 'keep me\n');

        const reads: WindowsDirectoryAccess[] = [permissiveAccess()];
        _setWindowsDirectoryPrivacyHooksForTests({
          read: () => reads.shift() ?? null,
          lock: () => privateAccess(),
        });

        expect(hashedBytes()).toBeGreaterThanOrEqual(64 * 1024);

        const entries = await readdir(fixture.cachePath);
        // The planted entry is gone: while the directory was writable by
        // others, its contents cannot be trusted.
        expect(entries).not.toContain(planted);
        expect(entries).toContain('notes.txt');
        expect(entries.filter((entry) => /^[0-9a-f]{64}\.json$/.test(entry))).toHaveLength(1);
      });
    } finally {
      await fixture.cleanup();
    }
  });
});
