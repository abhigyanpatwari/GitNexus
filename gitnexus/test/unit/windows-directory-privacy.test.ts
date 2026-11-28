import { describe, expect, it } from 'vitest';
import {
  isWindowsDirectoryPrivate,
  WINDOWS_LOCAL_SYSTEM_SID,
  WINDOWS_ADMINISTRATORS_SID,
  type WindowsDirectoryAccess,
} from '../../src/utils/windows-directory-privacy.js';

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
