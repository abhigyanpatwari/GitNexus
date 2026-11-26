/**
 * Windows directory privacy proof for the analyzer identity cache.
 *
 * POSIX proves cache privacy with `stat.uid` and `stat.mode`. Windows keeps
 * the equivalent information in the access-control list, which Node cannot
 * read, so the OS is asked instead and the decision is made here — in
 * TypeScript, on security identifiers, so it does not depend on the machine's
 * UI language.
 *
 * Every failure mode means "not private": an unreadable directory, an
 * unresolvable principal, an owner outside the acceptable set. The persistent
 * cache is then skipped, exactly as it is on a platform without ownership
 * APIs.
 */
import { describe, expect, it } from 'vitest';
import {
  _setWindowsDirectoryPrivacyHooksForTests,
  ensurePrivateWindowsDirectory,
  isWindowsDirectoryPrivate,
  lockWindowsDirectory,
  readWindowsDirectoryAccess,
  WINDOWS_ADMINISTRATORS_SID,
  WINDOWS_LOCAL_SYSTEM_SID,
  type WindowsDirectoryAccess,
} from '../../src/utils/windows-directory-privacy.js';
import { createTempDir } from '../helpers/test-db.js';

const USER_SID = 'S-1-5-21-111111111-222222222-333333333-1001';
const STRANGER_SID = 'S-1-5-21-111111111-222222222-333333333-1002';

function privateAccess(overrides: Partial<WindowsDirectoryAccess> = {}): WindowsDirectoryAccess {
  return {
    currentUser: USER_SID,
    owner: USER_SID,
    allowedSids: [USER_SID, WINDOWS_LOCAL_SYSTEM_SID, WINDOWS_ADMINISTRATORS_SID],
    ...overrides,
  };
}

describe('isWindowsDirectoryPrivate', () => {
  it('accepts a directory only the user, SYSTEM and Administrators may access', () => {
    expect(isWindowsDirectoryPrivate(privateAccess())).toBe(true);
  });

  it('rejects a directory another principal may access', () => {
    expect(
      isWindowsDirectoryPrivate(privateAccess({ allowedSids: [USER_SID, STRANGER_SID] })),
    ).toBe(false);
  });

  it('rejects a directory owned by a principal outside the acceptable set', () => {
    // An owner may always rewrite the access-control list of the object it
    // owns, so a foreign owner could grant itself access after the check.
    expect(isWindowsDirectoryPrivate(privateAccess({ owner: STRANGER_SID }))).toBe(false);
  });

  it('accepts an owner that is SYSTEM or Administrators', () => {
    // Both can rewrite any file the user owns, so treating them as untrusted
    // would make the check unsatisfiable on a normal Windows install.
    expect(isWindowsDirectoryPrivate(privateAccess({ owner: WINDOWS_LOCAL_SYSTEM_SID }))).toBe(
      true,
    );
    expect(isWindowsDirectoryPrivate(privateAccess({ owner: WINDOWS_ADMINISTRATORS_SID }))).toBe(
      true,
    );
  });

  it('rejects incomplete facts', () => {
    expect(isWindowsDirectoryPrivate(privateAccess({ currentUser: '' }))).toBe(false);
    expect(isWindowsDirectoryPrivate(privateAccess({ owner: '' }))).toBe(false);
  });
});

describe('ensurePrivateWindowsDirectory', () => {
  it('trusts a directory that is already private without locking it', () => {
    const reads: string[] = [];
    let locks = 0;
    let discards = 0;
    _setWindowsDirectoryPrivacyHooksForTests({
      read: (directory) => {
        reads.push(directory);
        return privateAccess();
      },
      lock: () => {
        locks += 1;
        return true;
      },
    });
    try {
      expect(ensurePrivateWindowsDirectory('C:\\cache', () => (discards += 1))).toBe(true);
      expect(reads).toEqual(['C:\\cache']);
      expect(locks).toBe(0);
      expect(discards).toBe(0);
    } finally {
      _setWindowsDirectoryPrivacyHooksForTests(null);
    }
  });

  it('locks a permissive directory and discards what it may contain', () => {
    const reads: WindowsDirectoryAccess[] = [
      privateAccess({ allowedSids: [USER_SID, STRANGER_SID] }),
      privateAccess(),
    ];
    let locks = 0;
    const discarded: string[] = [];
    _setWindowsDirectoryPrivacyHooksForTests({
      read: () => reads.shift() ?? null,
      lock: () => {
        locks += 1;
        return true;
      },
    });
    try {
      expect(
        ensurePrivateWindowsDirectory('C:\\cache', (directory) => discarded.push(directory)),
      ).toBe(true);
      expect(locks).toBe(1);
      expect(discarded).toEqual(['C:\\cache']);
    } finally {
      _setWindowsDirectoryPrivacyHooksForTests(null);
    }
  });

  it('fails closed when the directory cannot be locked', () => {
    let locks = 0;
    let discards = 0;
    _setWindowsDirectoryPrivacyHooksForTests({
      read: () => privateAccess({ allowedSids: [USER_SID, STRANGER_SID] }),
      lock: () => {
        locks += 1;
        return false;
      },
    });
    try {
      expect(ensurePrivateWindowsDirectory('C:\\cache', () => (discards += 1))).toBe(false);
      expect(locks).toBe(1);
      // Nothing is discarded while the directory is still writable by others:
      // the contents are worthless, but deleting them would throw the cache
      // away on every run.
      expect(discards).toBe(0);
    } finally {
      _setWindowsDirectoryPrivacyHooksForTests(null);
    }
  });

  it('fails closed when the access-control list cannot be read', () => {
    let locks = 0;
    _setWindowsDirectoryPrivacyHooksForTests({
      read: () => null,
      lock: () => {
        locks += 1;
        return true;
      },
    });
    try {
      expect(ensurePrivateWindowsDirectory('C:\\cache')).toBe(false);
      expect(locks).toBe(0);
    } finally {
      _setWindowsDirectoryPrivacyHooksForTests(null);
    }
  });

  it('probes a directory only once per process', () => {
    let reads = 0;
    _setWindowsDirectoryPrivacyHooksForTests({
      read: () => {
        reads += 1;
        return privateAccess();
      },
      lock: () => true,
    });
    try {
      expect(ensurePrivateWindowsDirectory('C:\\cache')).toBe(true);
      expect(ensurePrivateWindowsDirectory('C:\\cache')).toBe(true);
      expect(reads).toBe(1);
    } finally {
      _setWindowsDirectoryPrivacyHooksForTests(null);
    }
  });
});

/**
 * The proof above is only worth anything if the OS answers it. These cases
 * ask the real Windows access-control list, so they run on the Windows runner
 * of the cross-platform matrix.
 */
describe.skipIf(process.platform !== 'win32')('the real Windows access-control probe', () => {
  it('reports the owner and the allowed principals as security identifiers', async () => {
    const directory = await createTempDir();
    try {
      const access = readWindowsDirectoryAccess(directory.dbPath);
      expect(access).not.toBeNull();
      expect(access?.currentUser).toMatch(/^S-\d+(?:-\d+)+$/);
      expect(access?.owner).toMatch(/^S-\d+(?:-\d+)+$/);
      expect(access?.allowedSids).toContain(access?.currentUser);
    } finally {
      await directory.cleanup();
    }
  }, 60_000);

  it('locks a directory so that only the user, SYSTEM and Administrators may access it', async () => {
    const directory = await createTempDir();
    try {
      expect(lockWindowsDirectory(directory.dbPath)).toBe(true);
      const access = readWindowsDirectoryAccess(directory.dbPath);
      expect(access).not.toBeNull();
      if (!access) return;
      expect(isWindowsDirectoryPrivate(access)).toBe(true);
      expect([...access.allowedSids].sort()).toEqual(
        [access.currentUser, WINDOWS_LOCAL_SYSTEM_SID, WINDOWS_ADMINISTRATORS_SID].sort(),
      );
    } finally {
      await directory.cleanup();
    }
  }, 60_000);
});
