import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  _clearAnalyzerIdentityProcessCacheForTests,
  _clearWindowsCacheDirectoryStateForTests,
  _isPrivateWindowsDaclForTests,
  _setWindowsToolRunnerForTests,
  resolveAnalyzerRunnerIdentity,
} from '../../src/core/analyzer-identity.js';
import { createTempDir } from '../helpers/test-db.js';

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function hashedAnalyzerBytes(modulePath: string): number {
  let bytes = 0;
  resolveAnalyzerRunnerIdentity(pathToFileURL(modulePath).href, {
    onHashedInput: (input) => {
      bytes += input.bytes;
    },
  });
  return bytes;
}

async function createWindowsProfileFixture(
  root: string,
): Promise<{ modulePath: string; profile: string }> {
  const modulePath = path.join(root, 'src', 'core', 'analyzer.ts');
  const profile = path.join(root, 'profile');
  await mkdir(path.dirname(modulePath), { recursive: true });
  await mkdir(profile);
  await writeFile(
    path.join(root, 'package.json'),
    '{"name":"fixture-analyzer","version":"9.8.7"}\n',
  );
  await writeFile(modulePath, Buffer.alloc(64 * 1024, 0x33));
  return { modulePath, profile: await realpath(profile) };
}

/** Start as a fresh process would: no in-process identity cache, no verified directories. */
function simulateNewProcess(): void {
  _clearAnalyzerIdentityProcessCacheForTests();
  _clearWindowsCacheDirectoryStateForTests();
}

/** Run with the given directory as the Windows user profile (HOME/USERPROFILE). */
async function withWindowsProfile(profile: string, run: () => Promise<void> | void): Promise<void> {
  const environment = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    GITNEXUS_ANALYZER_IDENTITY_CACHE_DIR: process.env.GITNEXUS_ANALYZER_IDENTITY_CACHE_DIR,
  };
  process.env.HOME = profile;
  process.env.USERPROFILE = profile;
  delete process.env.GITNEXUS_ANALYZER_IDENTITY_CACHE_DIR;
  simulateNewProcess();
  try {
    await run();
  } finally {
    for (const [name, value] of Object.entries(environment)) restoreEnv(name, value);
    simulateNewProcess();
  }
}

function icacls(args: string[]): string {
  return execFileSync(
    path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'),
    args,
    {
      encoding: 'utf8',
    },
  );
}

describe('Windows analyzer identity cache', () => {
  it('accepts only protected Windows DACLs limited to the user, SYSTEM and Administrators', () => {
    const user = 'S-1-5-21-1-2-3-1001';
    const accepts = (sddl: string) => _isPrivateWindowsDaclForTests(sddl, user);
    expect(accepts(`D:PAI(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)(A;OICI;FA;;;${user})`)).toBe(true);
    expect(
      accepts(`D:PAI(A;OICI;FA;;;S-1-5-32-544)(A;OICI;FA;;;S-1-5-18)(A;OICI;FA;;;${user})`),
    ).toBe(true);
    // A deny entry cannot widen access.
    expect(accepts(`D:P(D;OICI;FA;;;WD)(A;OICI;FA;;;${user})`)).toBe(true);
    // Not protected: entries inherited from the parent still apply.
    expect(accepts(`D:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;${user})`)).toBe(false);
    // Users, Everyone or another account allowed in.
    expect(accepts(`D:PAI(A;OICI;FR;;;BU)(A;OICI;FA;;;${user})`)).toBe(false);
    expect(accepts(`D:PAI(A;OICI;FA;;;WD)(A;OICI;FA;;;${user})`)).toBe(false);
    expect(accepts(`D:PAI(A;OICI;FA;;;S-1-5-21-1-2-3-1002)(A;OICI;FA;;;${user})`)).toBe(false);
    // The current user must be allowed; unknown entry types and malformed text are rejected.
    expect(accepts('D:PAI(A;OICI;FA;;;SY)')).toBe(false);
    expect(accepts(`D:PAI(XA;OICI;FA;;;${user};(x))`)).toBe(false);
    expect(accepts('not an sddl string')).toBe(false);
  });

  it.runIf(process.platform === 'win32')(
    'persists the default cache in a restricted directory under the Windows user profile',
    async () => {
      const fixture = await createTempDir();
      try {
        const { modulePath, profile } = await createWindowsProfileFixture(fixture.dbPath);
        const cacheDirectory = path.join(profile, '.gitnexus', 'analyzer-identity');
        await withWindowsProfile(profile, () => {
          expect(hashedAnalyzerBytes(modulePath)).toBeGreaterThanOrEqual(64 * 1024);
          simulateNewProcess();
          expect(hashedAnalyzerBytes(modulePath)).toBe(0);
        });
        expect(await readdir(cacheDirectory)).toHaveLength(1);
        // Inheritance removed; only the user, SYSTEM and Administrators remain.
        const saved = path.join(fixture.dbPath, 'acl.txt');
        icacls([cacheDirectory, '/save', saved]);
        const sddl = (await readFile(saved, 'utf16le')).split(/\r?\n/)[1];
        expect(sddl).toMatch(/^D:P/);
        expect(sddl).not.toMatch(/;(BU|AU|WD|S-1-1-0|S-1-5-32-545|S-1-5-11)\)/);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'discards a Windows default cache whose directory was opened to other users',
    async () => {
      const fixture = await createTempDir();
      try {
        const { modulePath, profile } = await createWindowsProfileFixture(fixture.dbPath);
        const cacheDirectory = path.join(profile, '.gitnexus', 'analyzer-identity');
        await withWindowsProfile(profile, async () => {
          expect(hashedAnalyzerBytes(modulePath)).toBeGreaterThanOrEqual(64 * 1024);
          // BUILTIN\Users (S-1-5-32-545) may now write into the cache directory.
          icacls([cacheDirectory, '/grant', '*S-1-5-32-545:(OI)(CI)M']);
          await writeFile(path.join(cacheDirectory, 'planted.json'), '{}\n');
          simulateNewProcess();
          expect(hashedAnalyzerBytes(modulePath)).toBeGreaterThanOrEqual(64 * 1024);
        });
        expect(await readdir(cacheDirectory)).not.toContain('planted.json');
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.runIf(process.platform === 'win32').each(['whoami.exe', 'icacls.exe'])(
    'keeps the Windows default cache disabled when %s fails',
    async (failingTool) => {
      const fixture = await createTempDir();
      try {
        const { modulePath, profile } = await createWindowsProfileFixture(fixture.dbPath);
        const realRunner = (name: string, args: string[]): string | null => {
          const systemRoot = process.env.SystemRoot;
          if (!systemRoot) return null;
          try {
            return execFileSync(path.join(systemRoot, 'System32', name), args, {
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'ignore'],
            });
          } catch {
            return null;
          }
        };
        _setWindowsToolRunnerForTests((name, args) =>
          name === failingTool ? null : realRunner(name, args),
        );
        await withWindowsProfile(profile, () => {
          expect(hashedAnalyzerBytes(modulePath)).toBeGreaterThanOrEqual(64 * 1024);
          simulateNewProcess();
          expect(hashedAnalyzerBytes(modulePath)).toBeGreaterThanOrEqual(64 * 1024);
        });
        const cacheDirectory = path.join(profile, '.gitnexus', 'analyzer-identity');
        expect(await readdir(cacheDirectory).catch(() => [])).toEqual([]);
      } finally {
        _setWindowsToolRunnerForTests();
        await fixture.cleanup();
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'does not persist the Windows default cache through a redirected .gitnexus directory',
    async () => {
      const fixture = await createTempDir();
      try {
        const { modulePath, profile } = await createWindowsProfileFixture(fixture.dbPath);
        const elsewhere = path.join(fixture.dbPath, 'elsewhere');
        await mkdir(elsewhere);
        await symlink(elsewhere, path.join(profile, '.gitnexus'), 'junction');
        await withWindowsProfile(profile, () => {
          expect(hashedAnalyzerBytes(modulePath)).toBeGreaterThanOrEqual(64 * 1024);
          simulateNewProcess();
          expect(hashedAnalyzerBytes(modulePath)).toBeGreaterThanOrEqual(64 * 1024);
        });
      } finally {
        await fixture.cleanup();
      }
    },
  );
});
