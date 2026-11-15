/** Real indexing, native reads and one MCP session across index publication. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import lbug from '@ladybugdb/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as adapter from '../../src/core/lbug/lbug-adapter.js';
import {
  closeLbug as closeReader,
  initLbug as initReader,
} from '../../src/core/lbug/pool-adapter.js';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { createMCPServer, getNextStepHint } from '../../src/mcp/server.js';
import { getStoragePaths, loadMeta, saveMeta } from '../../src/storage/repo-manager.js';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';
import { createTempDir } from '../helpers/test-db.js';

const options = {
  skipAgentsMd: true,
  skipSkills: true,
  skipFts: true,
  atomicIncremental: process.platform !== 'win32',
};

describe('MCP index generation freshness', () => {
  let temp: Awaited<ReturnType<typeof createTempDir>>;
  let repo: string;
  let ftsLoaded = false;
  const backend = new LocalBackend();
  const server = createMCPServer(backend);
  const client = new Client({ name: 'index-generation-regression', version: '1.0.0' });

  beforeAll(async () => {
    temp = await createTempDir();
    const root = await fs.realpath(temp.dbPath);
    vi.stubEnv('GITNEXUS_HOME', path.join(root, 'home'));
    vi.stubEnv('GITNEXUS_STORAGE_PATH', undefined);
    vi.stubEnv('GITNEXUS_STORAGE_ROOT', undefined);
    vi.stubEnv('GITNEXUS_SHARED_STORE', 'off');
    vi.stubEnv('GITNEXUS_WAL_MANUAL_CHECKPOINT', '1');
    vi.stubEnv('GITNEXUS_LBUG_EXTENSION_INSTALL', 'load-only');
    await adapter.initLbug(path.join(root, 'fts-probe'));
    ftsLoaded = await adapter.loadFTSExtension(undefined, { policy: 'load-only' });
    await adapter.closeLbug();
    if (!ftsLoaded && process.env.GITNEXUS_REQUIRE_FTS === '1')
      throw new Error('FTS is required for this test');
    options.skipFts = !ftsLoaded;
    repo = path.join(root, 'repo');
    await fs.mkdir(repo);
    await fs.writeFile(path.join(repo, '.gitignore'), '.gitnexus/\n');
    for (let i = 0; i < 60; i++) {
      await fs.writeFile(
        path.join(repo, `unit_${i}.py`),
        `def retained_${i}():\n    return ${i}\n`,
      );
    }
    initGitRepo(repo);
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });
    commitAll(repo, 'baseline');
    await analyze();
    await backend.init();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  }, 120_000);

  afterAll(async () => {
    await client.close();
    await server.close();
    await backend.dispose();
    vi.unstubAllEnvs();
    await temp?.cleanup();
  });

  async function analyze(target = repo, overrides: Parameters<typeof runFullAnalysis>[1] = {}) {
    // Release Windows file locks for in-place writes while retaining the
    // backend's observed generation and metadata caches between requests.
    if (process.platform === 'win32') await backend.dispose();
    return runFullAnalysis(target, { ...options, ...overrides }, { onProgress: () => {} });
  }

  async function read(branch?: string, target = repo): Promise<any> {
    const args = {
      repo: target,
      ...(branch ? { branch } : {}),
      statement: "MATCH (n:Function) WHERE n.filePath = 'unit_0.py' RETURN n.name AS name",
    };
    return call('cypher', args);
  }

  async function call(name: string, args: Record<string, unknown>): Promise<any> {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>).find(
      (item) => item.type === 'text',
    )!.text;
    const hint = name === 'query' ? '' : getNextStepHint(name, args);
    return JSON.parse(hint ? text.slice(0, -hint.length) : text);
  }

  it('releases ingestion manifests while retaining the opened generation metadata', async () => {
    const { storagePath, lbugPath } = getStoragePaths(repo);
    const metadata = (await loadMeta(storagePath))!;
    expect(Object.keys(metadata.fileHashes ?? {}).length).toBeGreaterThan(0);
    await read();
    await closeReader(lbugPath);
    const state = (backend as any).lastObservedPoolState.get(lbugPath);
    expect(state.metadata.fileHashes).toBeUndefined();
    expect(state.metadata.cacheKeys).toBeUndefined();
    expect(state.metadata.embeddingCheckpoint).toBeUndefined();
    expect((await read()).staleness).toMatchObject({
      status: 'current',
      lastCommit: metadata.lastCommit,
      indexedAt: metadata.indexedAt,
    });
  });

  it('refreshes code and metadata immediately after selective publication and same-commit rebuild', async () => {
    const storagePath = getStoragePaths(repo).storagePath;
    const beforeMeta = (await loadMeta(storagePath))!;
    expect((await read()).staleness).toMatchObject({
      status: 'current',
      lastCommit: beforeMeta.lastCommit,
      indexedAt: beforeMeta.indexedAt,
    });
    await fs.writeFile(path.join(repo, 'unit_0.py'), 'def refreshed_zero():\n    return 9001\n');
    commitAll(repo, 'updated function');
    const update = await analyze();
    expect(update.incrementalStats).toMatchObject({
      writeMode: 'incremental',
      changedFiles: 1,
      deletedFiles: 0,
    });
    const published = (await loadMeta(storagePath))!;
    const immediate = await read();
    expect(JSON.stringify(immediate)).toContain('refreshed_zero');
    expect(immediate.staleness).toMatchObject({
      status: 'current',
      lastCommit: published.lastCommit,
      indexedAt: published.indexedAt,
    });
    expect(published.lastCommit).not.toBe(beforeMeta.lastCommit);
    const context = await call('context', { repo, name: 'refreshed_zero', include_content: true });
    expect(context.symbol).toMatchObject({
      name: 'refreshed_zero',
      filePath: 'unit_0.py',
      startLine: 1,
      endLine: 2,
    });
    expect(context.staleness).toMatchObject({
      status: 'current',
      lastCommit: published.lastCommit,
      indexedAt: published.indexedAt,
    });
    const query = await call('query', {
      repo,
      search_query: 'refreshed_zero',
      include_content: true,
    });
    expect(query.staleness).toMatchObject({
      status: 'current',
      lastCommit: published.lastCommit,
      indexedAt: published.indexedAt,
    });
    if (ftsLoaded)
      expect([...query.process_symbols, ...query.definitions]).toContainEqual(
        expect.objectContaining({
          name: 'refreshed_zero',
          filePath: 'unit_0.py',
          startLine: 1,
          endLine: 2,
        }),
      );

    await analyze(repo, { force: true });
    const rebuilt = (await loadMeta(storagePath))!;
    expect(rebuilt.lastCommit).toBe(published.lastCommit);
    expect(rebuilt.indexedAt).not.toBe(published.indexedAt);
    expect((await read()).staleness).toMatchObject({
      status: 'current',
      lastCommit: rebuilt.lastCommit,
      indexedAt: rebuilt.indexedAt,
    });
  }, 120_000);

  it.skipIf(process.platform === 'win32')(
    'keeps a busy native reader on its old ref, then refreshes on the next call',
    async () => {
      const storagePath = getStoragePaths(repo).storagePath;
      const previous = (await loadMeta(storagePath))!;
      await read();
      const source = await fs.readFile(path.join(repo, 'unit_0.py'), 'utf8');
      const baselineName = /^def (\w+)\(/m.exec(source)![1];
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const original = lbug.QueryResult.prototype.getAll;
      let held = false;
      // Pause after the real native rows are drained but before the adapter closes
      // that result and returns its connection. No native implementation is mocked.
      const spy = vi.spyOn(lbug.QueryResult.prototype, 'getAll').mockImplementation(async function (
        this: lbug.QueryResult,
      ) {
        const rows = await original.call(this);
        if (!held && rows.length === 1 && rows[0]?.name === baselineName) {
          held = true;
          entered();
          await gate;
        }
        return rows;
      });
      const oldRead = read();
      let releasedResult: any;
      const other = new LocalBackend();
      try {
        await ready;
        await fs.writeFile(path.join(repo, 'unit_0.py'), 'def newest_zero():\n    return 9002\n');
        commitAll(repo, 'newer function');
        const update = await analyze();
        expect(update.incrementalStats?.writeMode).toBe('incremental');
        const busyRead = await read();
        expect(JSON.stringify(busyRead)).toContain(baselineName);
        expect(busyRead.staleness).toMatchObject({
          status: 'behind',
          lastCommit: previous.lastCommit,
          indexedAt: previous.indexedAt,
        });
        await other.init();
        // This backend has no metadata for the native generation already held by
        // its sibling, so it must not label those old rows with the new disk ref.
        const unknown = await other.callTool('cypher', {
          repo,
          statement: "MATCH (n:Function) WHERE n.filePath = 'unit_0.py' RETURN n.name AS name",
        });
        expect(JSON.stringify(unknown)).toContain(baselineName);
        expect(unknown.staleness).toMatchObject({
          status: 'unknown',
          lastCommit: '',
          indexedAt: '',
        });
      } finally {
        release();
        releasedResult = await oldRead;
        spy.mockRestore();
      }
      const published = (await loadMeta(storagePath))!;
      expect(releasedResult.staleness).toMatchObject({
        lastCommit: previous.lastCommit,
        indexedAt: previous.indexedAt,
      });
      const recovered = await other.callTool('cypher', {
        repo,
        statement: "MATCH (n:Function) WHERE n.filePath = 'unit_0.py' RETURN n.name AS name",
      });
      expect(recovered.staleness).toMatchObject({
        status: 'current',
        lastCommit: published.lastCommit,
        indexedAt: published.indexedAt,
      });
      const fresh = await read();
      expect(JSON.stringify(fresh)).toContain('newest_zero');
      expect(fresh.staleness).toMatchObject({
        status: 'current',
        lastCommit: published.lastCommit,
        indexedAt: published.indexedAt,
      });
    },
    120_000,
  );

  it.skipIf(process.platform === 'win32')(
    'does not certify a swapped graph until its final metadata stamp arrives',
    async () => {
      const storagePath = getStoragePaths(repo).storagePath;
      const previous = (await loadMeta(storagePath))!;
      await read();
      await fs.writeFile(path.join(repo, 'unit_0.py'), 'def after_gap():\n    return 9003\n');
      commitAll(repo, 'publication gap');
      await analyze();
      const published = (await loadMeta(storagePath))!;
      // Reproduce the actual publication ordering: new native graph, old stamp.
      await saveMeta(storagePath, previous);
      try {
        const gap = await read();
        expect(JSON.stringify(gap)).toContain('after_gap');
        expect(gap.staleness).toMatchObject({ status: 'unknown', lastCommit: '', indexedAt: '' });
      } finally {
        await saveMeta(storagePath, published);
      }
      expect((await read()).staleness).toMatchObject({
        status: 'current',
        lastCommit: published.lastCommit,
        indexedAt: published.indexedAt,
      });
    },
    120_000,
  );

  it.skipIf(process.platform === 'win32').each([false, true])(
    'keeps a replacement opened after stat unknown until publication (intermediate stamp: %s)',
    async (intermediateStamp) => {
      const { storagePath, lbugPath } = getStoragePaths(repo);
      const previous = (await loadMeta(storagePath))!;
      await read();
      // Idle eviction closes the pool but leaves the backend's observed generation.
      await closeReader(lbugPath);
      if (intermediateStamp) {
        // Generation B is published without this backend ever opening it.
        await adapter.initLbug(lbugPath);
        try {
          await adapter.executeQuery(
            "MATCH (n:Function) WHERE n.filePath = 'unit_0.py' SET n.name = 'intermediate_generation'",
          );
        } finally {
          await adapter.closeLbug();
        }
        await saveMeta(storagePath, { ...previous, indexedAt: new Date().toISOString() });
      }
      const replacement = path.join(temp.dbPath, 'replacement.lbug');
      await fs.copyFile(lbugPath, replacement);
      await adapter.initLbug(replacement);
      try {
        await adapter.executeQuery(
          "MATCH (n:Function) WHERE n.filePath = 'unit_0.py' SET n.name = 'reopened_after_stat'",
        );
      } finally {
        await adapter.closeLbug();
      }
      const published = { ...previous, indexedAt: new Date().toISOString() };
      const originalStat = fs.stat;
      let swapped = false;
      const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (...args) => {
        const snapshot = await originalStat(...args);
        if (!swapped && args[0] === lbugPath) {
          swapped = true;
          // The stat describes the published graph; open sees its replacement.
          await fs.rename(replacement, lbugPath);
        }
        return snapshot;
      });
      try {
        const first = await read();
        expect(swapped).toBe(true);
        expect(JSON.stringify(first)).toContain('reopened_after_stat');
        expect(first.staleness).toMatchObject({ status: 'unknown', lastCommit: '', indexedAt: '' });
        statSpy.mockRestore();
        // Repeated requests do not establish publication by themselves.
        for (let attempt = 0; attempt < 2; attempt++) {
          const pending = await read();
          expect(JSON.stringify(pending)).toContain('reopened_after_stat');
          expect(pending.staleness).toMatchObject({
            status: 'unknown',
            lastCommit: '',
            indexedAt: '',
          });
        }
      } finally {
        statSpy.mockRestore();
        await saveMeta(storagePath, published);
      }
      expect((await read()).staleness).toMatchObject({
        status: 'current',
        lastCommit: published.lastCommit,
        indexedAt: published.indexedAt,
      });
    },
    120_000,
  );

  it.skipIf(process.platform === 'win32')(
    'recovers an unknown old shared reader using already-published metadata',
    async () => {
      const { storagePath, lbugPath } = getStoragePaths(repo);
      const previous = (await loadMeta(storagePath))!;
      await read();
      await closeReader(lbugPath);
      await adapter.initLbug(lbugPath);
      try {
        await adapter.executeQuery(
          "MATCH (n:Function) WHERE n.filePath = 'unit_0.py' SET n.name = 'held_generation'",
        );
      } finally {
        await adapter.closeLbug();
      }
      const holder = 'old-shared-generation';
      const replacement = path.join(temp.dbPath, 'shared-replacement.lbug');
      await initReader(holder, lbugPath);
      try {
        await fs.copyFile(lbugPath, replacement);
        await adapter.initLbug(replacement);
        try {
          await adapter.executeQuery(
            "MATCH (n:Function) WHERE n.filePath = 'unit_0.py' SET n.name = 'published_generation'",
          );
        } finally {
          await adapter.closeLbug();
        }
        await fs.rename(replacement, lbugPath);
        const published = { ...previous, indexedAt: new Date().toISOString() };
        await saveMeta(storagePath, published);
        const held = await read();
        expect(JSON.stringify(held)).toContain('held_generation');
        expect(held.staleness).toMatchObject({ status: 'unknown', lastCommit: '', indexedAt: '' });
        await closeReader(holder);
        const recovered = await read();
        expect(JSON.stringify(recovered)).toContain('published_generation');
        expect(recovered.staleness).toMatchObject({
          status: 'current',
          lastCommit: published.lastCommit,
          indexedAt: published.indexedAt,
        });
      } finally {
        await closeReader(holder);
      }
    },
    120_000,
  );

  it('keeps a pinned branch isolated when the flat workspace is reindexed', async () => {
    const oldBranch = execFileSync('git', ['branch', '--show-current'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['checkout', '-qb', 'generation-feature'], { cwd: repo });
    await fs.writeFile(path.join(repo, 'unit_0.py'), 'def branch_zero():\n    return 9004\n');
    commitAll(repo, 'feature function');
    await analyze(repo, { branch: 'generation-feature' });
    await client.callTool({ name: 'list_repos', arguments: {} });
    const pinned = await read('generation-feature');
    execFileSync('git', ['checkout', '-q', oldBranch], { cwd: repo });
    await fs.writeFile(path.join(repo, 'unit_0.py'), 'def flat_latest():\n    return 9005\n');
    commitAll(repo, 'flat update');
    await analyze();
    const flat = await read();
    expect(JSON.stringify(flat)).toContain('flat_latest');
    expect(flat.staleness.branch).toBe(oldBranch);
    const stillPinned = await read('generation-feature');
    expect(JSON.stringify(stillPinned)).toContain('branch_zero');
    expect(stillPinned.staleness).toMatchObject({
      lastCommit: pinned.staleness.lastCommit,
      branch: 'generation-feature',
    });
    expect((await read()).staleness.lastCommit).toBe(flat.staleness.lastCommit);
  }, 120_000);

  it('follows a shared-store graph pointer with matching commit and checkout branch', async () => {
    vi.stubEnv('GITNEXUS_SHARED_STORE', undefined);
    const sharedRepo = path.join(temp.dbPath, 'shared-repo');
    const sibling = path.join(temp.dbPath, 'shared-sibling');
    await fs.mkdir(sharedRepo);
    await fs.writeFile(path.join(sharedRepo, '.gitignore'), '.gitnexus/\n');
    await fs.writeFile(path.join(sharedRepo, 'unit_0.py'), 'def shared_before():\n    return 1\n');
    initGitRepo(sharedRepo);
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: sharedRepo });
    commitAll(sharedRepo, 'shared baseline');
    execFileSync('git', ['worktree', 'add', '-qb', 'shared-sibling', sibling], { cwd: sharedRepo });
    await analyze(sharedRepo);
    const storagePath = getStoragePaths(sharedRepo).storagePath;
    const previous = (await loadMeta(storagePath))!;
    expect(previous.graphPath).toBeTruthy();
    await analyze(sibling);
    const siblingMeta = (await loadMeta(getStoragePaths(sibling).storagePath))!;
    expect(siblingMeta.graphPath).toBe(previous.graphPath);
    const [mainResult, siblingResult] = await Promise.all([
      read(undefined, sharedRepo),
      read(undefined, sibling),
    ]);
    expect(mainResult.staleness).toMatchObject({
      lastCommit: previous.lastCommit,
      branch: previous.branch,
    });
    expect(siblingResult.staleness).toMatchObject({
      lastCommit: previous.lastCommit,
      branch: 'shared-sibling',
    });
    execFileSync('git', ['checkout', '-qb', 'shared-feature'], { cwd: sharedRepo });
    await fs.writeFile(path.join(sharedRepo, 'unit_0.py'), 'def shared_after():\n    return 2\n');
    commitAll(sharedRepo, 'shared update');
    await analyze(sharedRepo);
    const published = (await loadMeta(storagePath))!;
    expect(published.graphPath).not.toBe(previous.graphPath);
    const moved = await read(undefined, sharedRepo);
    expect(JSON.stringify(moved)).toContain('shared_after');
    expect(moved.staleness).toMatchObject({
      status: 'current',
      lastCommit: published.lastCommit,
      indexedAt: published.indexedAt,
      branch: 'shared-feature',
    });
  }, 120_000);
});
