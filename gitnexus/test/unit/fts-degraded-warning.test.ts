import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extensionManager,
  getExtensionCapabilities,
  resetExtensionState,
} from '../../src/core/lbug/extension-loader.js';
import { ftsDegradedWarning } from '../../src/core/search/fts-indexes.js';

afterEach(() => {
  resetExtensionState();
});

describe('ftsDegradedWarning (#2374)', () => {
  it('reports missing indexes when the FTS extension loaded fine', async () => {
    await extensionManager.ensure(vi.fn().mockResolvedValue({}), 'fts', 'FTS', {
      policy: 'load-only',
    });

    expect(ftsDegradedWarning()).toContain('FTS indexes missing');
  });

  it('reports the live load failure with its reason when the extension cannot load', async () => {
    await extensionManager.ensure(
      vi.fn().mockRejectedValue(new Error('invalid ELF header.')),
      'fts',
      'FTS',
      { policy: 'load-only' },
    );

    const warning = ftsDegradedWarning();
    expect(warning).toContain('FTS extension failed to load');
    expect(warning).toContain('invalid ELF header');
    expect(warning).toContain('gitnexus doctor');
  });

  it('falls back to the indexes-missing message when no load was attempted in this process', () => {
    expect(ftsDegradedWarning()).toContain('FTS indexes missing');
  });

  it('redacts the absolute extension path from the warning but keeps the error class', async () => {
    await extensionManager.ensure(
      vi
        .fn()
        .mockRejectedValue(
          new Error(
            "Failed to load library '/home/alice/.lbdb/extension/0.18.0/linux_amd64/fts/libfts.lbug_extension': invalid ELF header",
          ),
        ),
      'fts',
      'FTS',
      { policy: 'load-only' },
    );

    const warning = ftsDegradedWarning();
    // The username / home dir / absolute path must not leak to HTTP or MCP clients.
    expect(warning).not.toMatch(/\/home\/|\/Users\/|C:\\Users\\/);
    // …but the actionable error class survives redaction.
    expect(warning).toContain('FTS extension failed to load');
    expect(warning).toContain('Failed to load library');
    expect(warning).toContain('invalid ELF header');
  });

  it('redacts Windows-style extension paths too', async () => {
    await extensionManager.ensure(
      vi
        .fn()
        .mockRejectedValue(
          new Error(
            "Failed to load library 'C:\\Users\\bob\\.lbdb\\extension\\0.18.0\\win_amd64\\fts\\libfts.lbug_extension': not a valid Win32 application",
          ),
        ),
      'fts',
      'FTS',
      { policy: 'load-only' },
    );

    const warning = ftsDegradedWarning();
    expect(warning).not.toMatch(/C:\\Users\\/);
    expect(warning).toContain('not a valid Win32 application');
  });

  it('fully redacts a Windows path containing a space in the username (tri-review Residual-3, was only partially redacted)', async () => {
    await extensionManager.ensure(
      vi
        .fn()
        .mockRejectedValue(
          new Error(
            "Failed to load library 'C:\\Users\\alice smith\\.lbdb\\extension\\0.18.0\\win_amd64\\fts\\libfts.lbug_extension': not a valid Win32 application",
          ),
        ),
      'fts',
      'FTS',
      { policy: 'load-only' },
    );

    const warning = ftsDegradedWarning();
    // Neither the drive-letter prefix NOR the tail after the space may leak.
    expect(warning).not.toMatch(/C:\\Users\\/);
    expect(warning).not.toContain('smith');
    expect(warning).not.toContain('alice');
    expect(warning).toContain('not a valid Win32 application');
  });

  it('surfaces the runtime-install remedy, not reinstall, for a Windows missing-dependency error', async () => {
    await extensionManager.ensure(
      vi
        .fn()
        .mockRejectedValue(
          new Error(
            "Failed to load library 'C:\\Users\\bob\\.lbdb\\extension\\0.18.0\\win_amd64\\fts\\libfts.lbug_extension' which is needed by extension: fts. Error: The specified module could not be found.",
          ),
        ),
      'fts',
      'FTS',
      { policy: 'load-only' },
    );

    const warning = ftsDegradedWarning();
    expect(warning).toContain('FTS extension failed to load');
    expect(warning).toMatch(/Visual C\+\+/);
    expect(warning).toMatch(/vc_redist\.x64\.exe/);
    // The old "reinstall with network access" tail must not appear for this class.
    expect(warning).not.toMatch(/with network access to reinstall/);
    // Absolute path still redacted from the client-facing warning.
    expect(warning).not.toMatch(/C:\\Users\\/);
  });

  it('keeps the reinstall guidance for a never-installed extension', async () => {
    await extensionManager.ensure(
      vi
        .fn()
        .mockRejectedValue(
          new Error('Extension "fts" is an official extension and has not been installed.'),
        ),
      'fts',
      'FTS',
      { policy: 'load-only' },
    );

    expect(ftsDegradedWarning()).toContain('--repair-fts');
  });

  it('caches the load diagnosis on the capability so the warning does no per-request I/O (#2383 F3)', async () => {
    await extensionManager.ensure(
      vi
        .fn()
        .mockRejectedValue(
          new Error(
            "Failed to load library '/home/alice/.lbdb/extension/0.18.0/linux_amd64/fts/libfts.lbug_extension': The specified module could not be found.",
          ),
        ),
      'fts',
      'FTS',
      { policy: 'load-only' },
    );
    // The diagnosis is computed ONCE at mark-unavailable time and cached on the
    // capability, so ftsDegradedWarning (per-request on /api/search + MCP query)
    // reads it instead of re-inspecting the extension file on every call.
    const fts = getExtensionCapabilities().find((c) => c.name === 'fts');
    expect(fts).toMatchObject({ loaded: false, diagnosis: { kind: 'missing_dependency' } });
    expect(ftsDegradedWarning()).toMatch(/Visual C\+\+/);
  });
});

describe('ftsDegradedWarning resolved-repo context (#2767)', () => {
  it('omits the context suffix entirely when no context is passed (unchanged message)', async () => {
    await extensionManager.ensure(vi.fn().mockResolvedValue({}), 'fts', 'FTS', {
      policy: 'load-only',
    });

    expect(ftsDegradedWarning()).toBe(
      'FTS indexes missing — keyword search degraded. Run: gitnexus analyze --repair-fts (or gitnexus analyze --force) to rebuild indexes.',
    );
  });

  it('appends the resolved repo name and indexed-at on the indexes-missing branch', async () => {
    await extensionManager.ensure(vi.fn().mockResolvedValue({}), 'fts', 'FTS', {
      policy: 'load-only',
    });

    const warning = ftsDegradedWarning({
      repoName: 'myrepo',
      indexedAt: '2026-07-30T12:00:00.000Z',
    });
    expect(warning).toContain('FTS indexes missing');
    expect(warning).toContain('resolved: myrepo');
    expect(warning).toContain('indexed 2026-07-30T12:00:00.000Z');
  });

  it('includes the branch label when the resolved handle is branch-scoped', async () => {
    await extensionManager.ensure(vi.fn().mockResolvedValue({}), 'fts', 'FTS', {
      policy: 'load-only',
    });

    const warning = ftsDegradedWarning({ repoName: 'myrepo', branch: 'feature/x' });
    expect(warning).toContain('branch:feature/x');
  });

  it('never leaks an absolute path via the context suffix', async () => {
    await extensionManager.ensure(vi.fn().mockResolvedValue({}), 'fts', 'FTS', {
      policy: 'load-only',
    });

    const warning = ftsDegradedWarning({
      repoName: 'myrepo',
      lastErrorRedacted: 'connection reset',
    });
    expect(warning).not.toMatch(/\/home\/|\/Users\/|C:\\Users\\/);
    expect(warning).toContain('last error: connection reset');
  });

  it('also renders the context suffix on the extension-failed-to-load branch', async () => {
    await extensionManager.ensure(
      vi.fn().mockRejectedValue(new Error('invalid ELF header.')),
      'fts',
      'FTS',
      { policy: 'load-only' },
    );

    const warning = ftsDegradedWarning({
      repoName: 'myrepo',
      indexedAt: '2026-07-30T12:00:00.000Z',
    });
    expect(warning).toContain('FTS extension failed to load');
    expect(warning).toContain('resolved: myrepo');
    expect(warning).toContain('indexed 2026-07-30T12:00:00.000Z');
  });
});
