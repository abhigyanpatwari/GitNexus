import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FTS_DISABLED_MESSAGE,
  getFtsDisabledReason,
  resolveFtsDisableReason,
} from '../../src/core/search/fts-policy.js';
import { ftsDegradedWarning } from '../../src/core/search/fts-indexes.js';
import { searchFTSFromLbug } from '../../src/core/search/bm25-index.js';
import { hybridSearch } from '../../src/core/search/hybrid-search.js';
import { extensionManager, resetExtensionState } from '../../src/core/lbug/extension-loader.js';

afterEach(() => {
  vi.unstubAllEnvs();
  resetExtensionState();
});

describe('explicit FTS opt-out', () => {
  it('is off by default and accepts only the exact environment value 1', () => {
    vi.stubEnv('GITNEXUS_SKIP_FTS', undefined);
    expect(resolveFtsDisableReason()).toBeUndefined();
    for (const value of ['', '0', 'true', 'yes', ' 1', '1 ']) {
      expect(resolveFtsDisableReason(false, value)).toBeUndefined();
    }
    expect(resolveFtsDisableReason(false, '1')).toBe('disabled-by-env');
    expect(resolveFtsDisableReason(true, '1')).toBe('disabled-by-flag');
    expect(resolveFtsDisableReason(true, '0')).toBe('disabled-by-flag');
  });

  it('does not infer intent from a failed or legacy index', () => {
    expect(getFtsDisabledReason(undefined)).toBeUndefined();
    for (const skipReason of [undefined, 'build-failed', 'extension-unavailable'] as const) {
      expect(
        getFtsDisabledReason({ provider: 'ladybugdb-fts', status: 'unavailable', skipReason }),
      ).toBeUndefined();
    }
    expect(
      getFtsDisabledReason({
        provider: 'ladybugdb-fts',
        status: 'available',
        skipReason: 'disabled-by-flag',
      }),
    ).toBeUndefined();
    expect(
      getFtsDisabledReason({
        provider: 'ladybugdb-fts',
        status: 'unavailable',
        skipReason: 'disabled-by-env',
      }),
    ).toBe('disabled-by-env');
  });

  it('reports intent even when another database has an extension failure', async () => {
    await extensionManager.ensure(
      vi.fn().mockRejectedValue(new Error('invalid ELF header')),
      'fts',
      'FTS',
      { policy: 'load-only' },
    );
    expect(ftsDegradedWarning(undefined, 'disabled-by-flag')).toBe(FTS_DISABLED_MESSAGE);
    expect(ftsDegradedWarning()).toContain('FTS extension failed to load');
  });

  it('returns no keyword results without a database or extension load', async () => {
    await expect(
      searchFTSFromLbug('createHandler', 10, undefined, 'disabled-by-env'),
    ).resolves.toEqual({ results: [], ftsAvailable: false });
  });

  it.each([{ skipFts: true }, {}])(
    'rejects FTS repair while explicitly disabled (%j)',
    async (options) => {
      vi.stubEnv('GITNEXUS_SKIP_FTS', '1');
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      await expect(
        runFullAnalysis('nonexistent-repo', { ...options, repairFts: true }, { onProgress() {} }),
      ).rejects.toThrow('--repair-fts cannot be used with --skip-fts or GITNEXUS_SKIP_FTS=1');
    },
  );

  it('keeps semantic results when keyword search is explicitly disabled', async () => {
    const executeQuery = vi.fn();
    const semantic = vi.fn().mockResolvedValue([
      {
        nodeId: 'Function:handler',
        filePath: 'src/handler.ts',
        name: 'handler',
        label: 'Function',
        startLine: 1,
        endLine: 3,
        distance: 0.1,
      },
    ]);
    const result = await hybridSearch('handler', 10, executeQuery, semantic, 'disabled-by-flag');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'handler',
      sources: ['semantic'],
      filePath: 'src/handler.ts',
    });
    expect(semantic).toHaveBeenCalledWith(executeQuery, 'handler', 10);
    expect(executeQuery).not.toHaveBeenCalled();
  });
});
