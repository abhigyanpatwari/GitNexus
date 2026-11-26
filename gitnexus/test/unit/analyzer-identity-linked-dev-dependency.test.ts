import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { _hasNodeModulesSegmentForTests } from '../../src/core/analyzer-identity.js';

describe('analyzer identity resolved-location dev dependencies (#2798)', () => {
  it('treats node_modules as a whole path segment, per platform separator', () => {
    expect({
      checkout: _hasNodeModulesSegmentForTests('/home/u/checkouts/tool', path.posix),
      installed: _hasNodeModulesSegmentForTests('/home/u/app/node_modules/tool', path.posix),
      substring: _hasNodeModulesSegmentForTests('/home/u/node_modules_old/tool', path.posix),
      nested: _hasNodeModulesSegmentForTests(
        '/a/node_modules/.pnpm/x@1/node_modules/x',
        path.posix,
      ),
      // `\` is a legal POSIX filename character, so it is NOT a boundary there
      // — but it is the separator win32 realpaths come back with.
      posixBackslash: _hasNodeModulesSegmentForTests('/a/node_modules\\x/tool', path.posix),
      win32Backslash: _hasNodeModulesSegmentForTests('C:\\app\\node_modules\\tool', path.win32),
      win32Substring: _hasNodeModulesSegmentForTests('C:\\app\\node_modulesx\\tool', path.win32),
    }).toEqual({
      checkout: false,
      installed: true,
      substring: false,
      nested: true,
      posixBackslash: false,
      win32Backslash: true,
      win32Substring: false,
    });
  });
});
