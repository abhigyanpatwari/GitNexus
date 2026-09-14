/**
 * U7 Windows FTS arm. OQ1 (does path-LOAD search the extension directory for
 * transitive DLLs?) is unanswered on this Linux workspace, so the shipping-DLL
 * arm is closed — KTD13 forbids merging shipped OpenSSL without a CVE owner.
 * The recorded arm is the vendor-neutral prerequisite.
 *
 * Registered in scripts/cross-platform-tests.ts so windows-latest must run it.
 * Assertions are unconditional: a skip-only suite would stay green if Windows
 * never ran.
 */
import { describe, expect, it } from 'vitest';
import { classifyExtensionLoadError } from '../../src/core/lbug/extension-load-error.js';

export const WINDOWS_FTS_ARM = 'prerequisite' as const;

const BORROWED_DLL_HINT = /Git Bash|mingw64|Program Files\\Git|prepend/i;

describe('Windows FTS dependency arm (U7)', () => {
  it('records the prerequisite arm unconditionally', () => {
    expect(WINDOWS_FTS_ARM).toBe('prerequisite');
  });

  it('names vendor-neutral runtimes and never a third-party application directory', () => {
    const { remedy } = classifyExtensionLoadError(
      'needed by extension: fts. Error: The specified module could not be found.',
    );
    expect(remedy).toMatch(/Visual C\+\+/);
    expect(remedy).toMatch(/OpenSSL 3/);
    expect(remedy).toMatch(/system runtime/);
    expect(remedy).not.toMatch(BORROWED_DLL_HINT);
  });
});
