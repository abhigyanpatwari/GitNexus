import { afterEach, describe, expect, it, vi } from 'vitest';
import { extensionManager, resetExtensionState } from '../../src/core/lbug/extension-loader.js';
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
});
