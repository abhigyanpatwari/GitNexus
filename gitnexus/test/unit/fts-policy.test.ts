import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  FTS_DISABLED_MESSAGE,
  FTS_SKIP_REASONS,
  formatAnalyzeFtsSkipSummary,
  getFtsDisabledReason,
  isExplicitFtsDisablement,
  resolveFtsDisableReason,
  withExplicitFtsDisablement,
  type FtsSkipReason,
} from '../../src/core/search/fts-policy.js';
import type { PersistedFtsSkipReason, RepoMeta } from '../../src/storage/repo-meta.js';
import { classifyFtsBuildError, ftsDegradedWarning } from '../../src/core/search/fts-indexes.js';
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
    expect(isExplicitFtsDisablement('disabled-by-flag')).toBe(true);
    expect(isExplicitFtsDisablement('disabled-by-env')).toBe(true);
    expect(isExplicitFtsDisablement('build-failed')).toBe(false);
    expect(isExplicitFtsDisablement('native-abort')).toBe(false);
    expect(isExplicitFtsDisablement('tuple-missing')).toBe(false);
  });

  it('does not infer intent from a failed or legacy index', () => {
    expect(getFtsDisabledReason(undefined)).toBeUndefined();
    for (const skipReason of [
      undefined,
      'build-failed',
      'extension-unavailable',
      'native-abort',
      'tuple-missing',
    ] as const) {
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

  it('stamps explicit disablement without rewriting freshness or sibling capabilities', () => {
    const indexedAt = '2026-01-01T00:00:00.000Z';
    const meta = {
      indexedAt,
      lastCommit: 'abc',
      capabilities: {
        graph: { provider: 'ladybugdb', status: 'available' },
        fts: { provider: 'ladybugdb-fts', status: 'available' },
        vectorSearch: {
          provider: 'ladybugdb-vector',
          status: 'vector-index',
          exactScanLimit: 10,
        },
      },
    } as RepoMeta;
    const stamped = withExplicitFtsDisablement(meta, 'disabled-by-flag');
    expect(stamped.indexedAt).toBe(indexedAt);
    expect(stamped.lastCommit).toBe('abc');
    expect(stamped.capabilities?.graph).toEqual(meta.capabilities?.graph);
    expect(stamped.capabilities?.vectorSearch).toEqual(meta.capabilities?.vectorSearch);
    expect(stamped.capabilities?.fts).toEqual({
      provider: 'ladybugdb-fts',
      status: 'unavailable',
      skipReason: 'disabled-by-flag',
    });
    expect(withExplicitFtsDisablement(meta, undefined)).toBe(meta);
    expect(withExplicitFtsDisablement(stamped, 'disabled-by-flag')).toBe(stamped);
    expect(
      withExplicitFtsDisablement(stamped, 'disabled-by-env').capabilities?.fts?.skipReason,
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

  it.each([
    { skipFts: true, env: undefined },
    { skipFts: false, env: '1' },
    { skipFts: true, env: '1' },
  ])('rejects FTS repair while explicitly disabled (%j)', async ({ skipFts, env }) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-fts-policy-'));
    vi.stubEnv('GITNEXUS_HOME', home);
    vi.stubEnv('GITNEXUS_SKIP_FTS', env);
    try {
      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      await expect(
        runFullAnalysis(path.join(home, 'repo'), { skipFts, repairFts: true }, { onProgress() {} }),
      ).rejects.toThrow('--repair-fts cannot be used with --skip-fts or GITNEXUS_SKIP_FTS=1');
      expect(await fs.readdir(home)).toEqual([]);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

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

describe('FTS skip-reason members (U6)', () => {
  type SameSkipReason = FtsSkipReason extends PersistedFtsSkipReason
    ? PersistedFtsSkipReason extends FtsSkipReason
      ? true
      : never
    : never;
  const _storageMirrorsCore: SameSkipReason = true;
  void _storageMirrorsCore;

  it('round-trips native-abort and tuple-missing through the capability stamp', () => {
    const base = {
      indexedAt: '2026-01-01T00:00:00.000Z',
      lastCommit: 'abc',
      capabilities: {
        graph: { provider: 'ladybugdb', status: 'available' as const },
        fts: { provider: 'ladybugdb-fts', status: 'available' as const },
        vectorSearch: {
          provider: 'ladybugdb-vector',
          status: 'vector-index' as const,
          exactScanLimit: 10,
        },
      },
    } as RepoMeta;

    for (const reason of ['native-abort', 'tuple-missing'] as const) {
      const stamped: RepoMeta = {
        ...base,
        capabilities: {
          ...base.capabilities!,
          fts: { provider: 'ladybugdb-fts', status: 'unavailable', skipReason: reason },
        },
      };
      expect(stamped.capabilities?.fts?.skipReason).toBe(reason);
      expect(isExplicitFtsDisablement(stamped.capabilities?.fts?.skipReason)).toBe(false);
    }
  });

  it('lets the storage union accept every core-side member', () => {
    for (const reason of FTS_SKIP_REASONS) {
      const persisted: PersistedFtsSkipReason = reason;
      const core: FtsSkipReason = persisted;
      expect(core).toBe(reason);
    }
  });

  it('keeps explicit disablement ahead of the new failure members', () => {
    expect(resolveFtsDisableReason(true, '1')).toBe('disabled-by-flag');
    expect(isExplicitFtsDisablement(resolveFtsDisableReason(true))).toBe(true);
    expect(formatAnalyzeFtsSkipSummary('disabled-by-flag')).toBe(FTS_DISABLED_MESSAGE);
    expect(formatAnalyzeFtsSkipSummary('native-abort')).not.toContain(
      'GITNEXUS_LBUG_EXTENSION_INSTALL=auto',
    );
    expect(formatAnalyzeFtsSkipSummary('tuple-missing')).not.toContain(
      'GITNEXUS_LBUG_EXTENSION_INSTALL=auto',
    );
  });

  it('still classifies a message-bearing tokenizer failure as capability', () => {
    expect(classifyFtsBuildError('Runtime exception: Failed calling LOWER: Invalid UTF-8.')).toBe(
      'capability',
    );
  });

  it('names each skip reason instead of falling through to the network-install remedy', () => {
    expect(formatAnalyzeFtsSkipSummary('native-abort')).toMatch(/aborted while building/);
    expect(formatAnalyzeFtsSkipSummary('tuple-missing')).toMatch(/no packaged FTS artifact/);
    expect(formatAnalyzeFtsSkipSummary('build-failed')).toMatch(/search index build failed/);
    expect(formatAnalyzeFtsSkipSummary('extension-unavailable')).toContain(
      'GITNEXUS_LBUG_EXTENSION_INSTALL=auto',
    );
    expect(formatAnalyzeFtsSkipSummary(undefined)).toContain(
      'GITNEXUS_LBUG_EXTENSION_INSTALL=auto',
    );
  });
});
