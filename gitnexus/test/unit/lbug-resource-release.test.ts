import { beforeEach, describe, expect, it, vi } from 'vitest';
import type lbug from '@ladybugdb/core';
import type { LbugConnectionHandle } from '../../src/core/lbug/lbug-config.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

type LbugModule = typeof lbug;

describe('reserved native resource release', () => {
  let native: typeof import('../../src/core/lbug/lbug-config.js');
  beforeEach(async () => {
    vi.resetModules();
    native = await import('../../src/core/lbug/lbug-config.js');
  });

  function handles() {
    const conn = { close: vi.fn(async () => {}) };
    const db = { close: vi.fn(async () => {}) };
    return { conn, db, handle: { conn, db } as unknown as LbugConnectionHandle };
  }

  it.each(['conn', 'db'] as const)(
    'propagates a failed %s close and retries its release',
    async (part) => {
      const h = handles();
      h[part].close.mockRejectedValueOnce(new Error('release failed'));
      await expect(native.closeLbugConnection(h.handle, { strict: true })).rejects.toThrow(
        'release failed',
      );
      expect(h.db.close).toHaveBeenCalledTimes(part === 'conn' ? 0 : 1);
      await native.closeLbugConnection(h.handle, { strict: true });
      expect(h[part].close).toHaveBeenCalledTimes(2);
      expect(h[part === 'conn' ? 'db' : 'conn'].close).toHaveBeenCalledTimes(1);
    },
  );

  it('coalesces concurrent closes and waits for the physical release', async () => {
    const h = handles();
    let release!: () => void;
    h.conn.close.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    let completed = false;
    const first = native.closeLbugConnection(h.handle, { strict: true });
    const second = native.closeLbugConnection(h.handle, { strict: true }).then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(h.conn.close).toHaveBeenCalledTimes(1);
    expect(h.db.close).not.toHaveBeenCalled();
    release();
    await Promise.all([first, second]);
    expect(h.db.close).toHaveBeenCalledTimes(1);
  });

  it('blocks another reserved pool until a failed release succeeds', async () => {
    const h = handles();
    h.db.close.mockRejectedValue(new Error('pool still allocated'));
    await native.closeLbugConnection(h.handle, { strict: true }).catch(() => {});
    const Database = vi.fn(function () {
      return handles().db;
    });
    const Connection = vi.fn(function () {
      return handles().conn;
    });
    const module = { Database, Connection } as unknown as LbugModule;
    await expect(
      native.openLbugConnection(module, '/unused', { bufferPoolBytes: 8 * 1024 * 1024 }),
    ).rejects.toThrow('pool still allocated');
    expect(Database).not.toHaveBeenCalled();
    h.db.close.mockResolvedValue();
    const next = await native.openLbugConnection(module, '/unused', {
      bufferPoolBytes: 8 * 1024 * 1024,
    });
    expect(Database).toHaveBeenCalledTimes(1);
    await native.closeLbugConnection(next);
  });

  it('retains a database whose connection constructor and cleanup both failed', async () => {
    const h = handles();
    h.db.close.mockRejectedValue(new Error('orphan pool still allocated'));
    const Database = vi.fn(function () {
      return h.db;
    });
    const Connection = vi.fn(function (): typeof h.conn {
      throw new Error('connection construction failed');
    });
    const module = { Database, Connection } as unknown as LbugModule;
    const allocation = { bufferPoolBytes: 8 * 1024 * 1024 };
    await expect(native.openLbugConnection(module, '/unused', allocation)).rejects.toThrow(
      /connection construction|release/,
    );
    await expect(native.openLbugConnection(module, '/unused', allocation)).rejects.toThrow(
      'orphan pool still allocated',
    );
    expect(Database).toHaveBeenCalledTimes(1);
    h.db.close.mockResolvedValue();
    Connection.mockImplementation(function () {
      return h.conn;
    });
    const next = await native.openLbugConnection(module, '/unused', allocation);
    expect(Database).toHaveBeenCalledTimes(2);
    await native.closeLbugConnection(next);
  });

  it('preserves best-effort close for callers without a reservation', async () => {
    const h = handles();
    h.conn.close.mockRejectedValue(new Error('legacy close failure'));
    await native.closeLbugConnection(h.handle);
    expect(h.db.close).toHaveBeenCalledTimes(1);
  });

  it('keeps strict release mandatory for a handle opened with a reservation', async () => {
    const h = handles();
    const Database = vi.fn(function () {
      return h.db;
    });
    const Connection = vi.fn(function () {
      return h.conn;
    });
    const handle = await native.openLbugConnection(
      { Database, Connection } as unknown as LbugModule,
      '/unused',
      { threads: 1, bufferPoolBytes: 8 * 1024 * 1024 },
    );
    h.db.close.mockRejectedValueOnce(new Error('reserved close failed'));
    await expect(native.closeLbugConnection(handle)).rejects.toThrow('reserved close failed');
    await native.closeLbugConnection(handle);
    expect(h.conn.close).toHaveBeenCalledTimes(1);
    expect(h.db.close).toHaveBeenCalledTimes(2);
  });

  it('blocks parser and model admission while a prior native release is still failing', async () => {
    const { resolveAnalysisResourceBudget } =
      await import('../../src/core/analysis-resource-budget.js');
    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
    const { runPublishedEmbeddingJob } = await import('../../src/core/embeddings/embedding-job.js');
    const resources = resolveAnalysisResourceBudget({
      effectiveMemoryBytes: 8 * 1024 ** 3,
      availableCpus: 4,
      modelMemoryMb: 0,
    });
    const h = handles();
    h.db.close.mockRejectedValue(new Error('previous allocation is live'));
    await native.closeLbugConnection(h.handle, { strict: true }).catch(() => {});
    const onProgress = vi.fn();
    const loadMetadata = vi.fn();
    const provider = vi.fn();
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-release-admission-'));
    execFileSync('git', ['init', '--quiet', repo]);
    vi.stubEnv('GITNEXUS_HOME', path.join(repo, 'home'));
    vi.stubEnv('GITNEXUS_SHARED_STORE', 'off');
    try {
      await expect(runFullAnalysis(repo, { resources }, { onProgress })).rejects.toThrow(
        'previous allocation is live',
      );
      await expect(
        runPublishedEmbeddingJob(
          {
            metadataDirectory: path.join(repo, '.gitnexus'),
            graphPath: path.join(repo, '.gitnexus', 'lbug'),
            resources: resources.embedding,
            metadata: { loadMetadata, saveMetadata: vi.fn() },
          },
          { provider },
        ),
      ).rejects.toThrow('previous allocation is live');
      expect(onProgress).not.toHaveBeenCalled();
      expect(loadMetadata).not.toHaveBeenCalled();
      expect(provider).not.toHaveBeenCalled();
    } finally {
      h.db.close.mockResolvedValue();
      await native.drainLbugResourceReleases();
      vi.unstubAllEnvs();
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});
