import { describe, expect, it } from 'vitest';
import { ladybugUnavailableError } from '../../src/core/lbug/pool-adapter.js';

describe('ladybugUnavailableError', () => {
  it('keeps the rebuild wording for real lock/busy errors and preserves inner message', () => {
    for (const msg of [
      'IO exception: Could not set lock on file',
      'Only one write transaction at a time is allowed in the system.',
      'database busy',
    ]) {
      const err = ladybugUnavailableError(
        'my-repo',
        new Error(msg),
        'C:\\Users\\alice\\repo\\.gitnexus\\lbug',
        'win32',
      );
      expect(err.message).toContain('Another process may be rebuilding the index');
      expect(err.message).toContain(msg);
    }
  });

  it('reports the real cause without rebuild speculation for generic non-lock errors', () => {
    const inner = 'Permission denied opening database';
    const err = ladybugUnavailableError(
      'my-repo',
      new Error(inner),
      '/home/alice/repo/.gitnexus/lbug',
      'linux',
    );
    expect(err.message).toBe(`LadybugDB unavailable for my-repo: ${inner}`);
    expect(err.message).not.toContain('Another process may be rebuilding');
  });

  it('handles undefined error with unknown error fallback and no rebuild speculation', () => {
    const err = ladybugUnavailableError(
      'my-repo',
      undefined,
      '/home/alice/repo/.gitnexus/lbug',
      'linux',
    );
    expect(err.message).toBe('LadybugDB unavailable for my-repo: unknown error');
    expect(err.message).not.toContain('Another process may be rebuilding');
  });

  it('adds an actionable non-ASCII hint on win32 with non-ASCII path and code-page/open error', () => {
    const nonAsciiPath = 'C:\\Users\\한글사용자\\repo\\.gitnexus\\lbug';
    for (const inner of [
      'No mapping for the Unicode character exists in the target multi-byte code page.',
      'ERROR_NO_UNICODE_TRANSLATION',
      'Binder exception: No file found that matches the pattern: C:/Users/한글사용자/repo/.gitnexus/lbug.',
      'IO exception: Cannot open file',
    ]) {
      const err = ladybugUnavailableError('my-repo', new Error(inner), nonAsciiPath, 'win32');
      expect(err.message).toContain(`LadybugDB unavailable for my-repo: ${inner}`);
      expect(err.message).toContain(
        'may be caused by a non-ASCII path under the Windows ANSI code page',
      );
      expect(err.message).toContain('move the repo to an ASCII path or use an ASCII junction');
      expect(err.message).not.toContain('fsutil');
      expect(err.message).not.toContain('Another process may be rebuilding');
    }
  });

  it('omits the Windows code-page hint on POSIX or when the win32 path is ASCII', () => {
    const inner = 'No mapping for the Unicode character exists in the target multi-byte code page.';
    const posixErr = ladybugUnavailableError(
      'my-repo',
      new Error(inner),
      '/home/한글사용자/repo/.gitnexus/lbug',
      'linux',
    );
    expect(posixErr.message).toBe(`LadybugDB unavailable for my-repo: ${inner}`);
    expect(posixErr.message).not.toContain('Windows ANSI code page');

    const asciiWinErr = ladybugUnavailableError(
      'my-repo',
      new Error(inner),
      'C:\\Users\\alice\\repo\\.gitnexus\\lbug',
      'win32',
    );
    expect(asciiWinErr.message).toBe(`LadybugDB unavailable for my-repo: ${inner}`);
    expect(asciiWinErr.message).not.toContain('Windows ANSI code page');
  });
});
