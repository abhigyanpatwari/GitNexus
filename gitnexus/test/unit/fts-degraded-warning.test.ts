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
});
