import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupMiniRepo } from '../helpers/mini-repo.js';
import { createTempDir } from '../helpers/test-db.js';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import * as adapter from '../../src/core/lbug/lbug-adapter.js';
import { extensionManager } from '../../src/core/lbug/extension-loader.js';
import { getStoragePaths, loadMeta, saveMeta } from '../../src/storage/repo-manager.js';
import { batchInsertEmbeddings } from '../../src/core/embeddings/embedding-pipeline.js';
import { EMBEDDING_DIMS } from '../../src/core/lbug/schema.js';
import { searchFTSFromLbug } from '../../src/core/search/bm25-index.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { CLI_SPAWN_PREFIX } from '../helpers/cli-entry.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

describe('FTS opt-out analysis lifecycle (#3091)', () => {
  let repo: Awaited<ReturnType<typeof setupMiniRepo>>;
  let home: Awaited<ReturnType<typeof createTempDir>>;
  const options = { skipAgentsMd: true, registryName: 'skip-fts-fixture' };
  const callbacks = { onProgress() {} };

  beforeEach(async () => {
    repo = await setupMiniRepo();
    home = await createTempDir();
    vi.stubEnv('GITNEXUS_HOME', home.dbPath);
    vi.stubEnv('GITNEXUS_SKIP_FTS', undefined);
  });

  afterEach(async () => {
    await adapter.closeLbug();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await repo.cleanup();
    await home.cleanup();
  });

  async function graphSnapshot() {
    const { lbugPath, storagePath } = getStoragePaths(repo.dbPath);
    const meta = await loadMeta(storagePath);
    const cacheKeys = [...(meta?.cacheKeys ?? [])].sort();
    expect(cacheKeys).not.toEqual([]);
    const cache = [];
    for (const key of cacheKeys) {
      const bytes = await fs.readFile(path.join(storagePath, 'parse-cache', `${key}.v8`));
      cache.push([key, createHash('sha256').update(bytes).digest('hex')]);
    }
    await adapter.initLbug(lbugPath, { skipFts: true });
    try {
      return {
        functions: await adapter.executeQuery(
          'MATCH (n:Function) RETURN n.id AS id, n.name AS name ORDER BY n.id',
        ),
        edges: await adapter.executeQuery(
          'MATCH (n)-[r:CodeRelation]->(m) RETURN n.id AS source, m.id AS target, r.type AS type ORDER BY source, target, type',
        ),
        communities: await adapter.executeQuery(
          'MATCH (n:Community) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.keywords AS keywords, n.cohesion AS cohesion, n.symbolCount AS symbolCount ORDER BY id',
        ),
        processes: await adapter.executeQuery(
          'MATCH (n:Process) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.processType AS processType, n.stepCount AS stepCount, n.communities AS communities, n.entryPointId AS entryPointId, n.terminalId AS terminalId ORDER BY id',
        ),
        cache,
        embeddings: await adapter.loadCachedEmbeddings(),
        indexes: await adapter.executeQuery('CALL SHOW_INDEXES() RETURN *'),
      };
    } finally {
      await adapter.closeLbug();
    }
  }

  it('indexes without any FTS load and reports intentional disablement through MCP', async () => {
    const ensure = vi.spyOn(extensionManager, 'ensure');
    const result = await runFullAnalysis(repo.dbPath, { ...options, skipFts: true }, callbacks);
    expect(result.ftsSkipped).toBe(true);
    expect(result.ftsSkipReason).toBe('disabled-by-flag');
    expect(ensure.mock.calls.filter((call) => call[1] === 'fts')).toEqual([]);
    const meta = await loadMeta(getStoragePaths(repo.dbPath).storagePath);
    expect(meta?.capabilities?.fts).toEqual({
      provider: 'ladybugdb-fts',
      status: 'unavailable',
      skipReason: 'disabled-by-flag',
    });
    expect(meta?.capabilities?.graph.status).toBe('available');
    const snapshot = await graphSnapshot();
    expect(snapshot.functions).toContainEqual(expect.objectContaining({ name: 'createHandler' }));
    expect(snapshot.edges).toContainEqual(expect.objectContaining({ type: 'CALLS' }));
    expect(snapshot.indexes.filter((row) => row.index_type === 'FTS')).toEqual([]);
    const repeat = await runFullAnalysis(repo.dbPath, { ...options, skipFts: true }, callbacks);
    expect(repeat.alreadyUpToDate).toBe(true);
    expect(repeat.ftsSkipReason).toBe('disabled-by-flag');
    expect(ensure.mock.calls.filter((call) => call[1] === 'fts')).toEqual([]);
    vi.stubEnv('GITNEXUS_SKIP_FTS', '1');
    const switched = await runFullAnalysis(repo.dbPath, options, callbacks);
    expect(switched.alreadyUpToDate).toBe(true);
    expect(switched.ftsSkipReason).toBe('disabled-by-env');
    expect(ensure.mock.calls.filter((call) => call[1] === 'fts')).toEqual([]);
    expect((await loadMeta(getStoragePaths(repo.dbPath).storagePath))?.capabilities?.fts).toEqual({
      provider: 'ladybugdb-fts',
      status: 'unavailable',
      skipReason: 'disabled-by-env',
    });
    vi.stubEnv('GITNEXUS_SKIP_FTS', undefined);
    const backend = new LocalBackend();
    try {
      expect(await backend.init()).toBe(true);
      const query = await backend.callTool('query', {
        repo: options.registryName,
        search_query: 'createHandler',
      });
      expect(query.error).toBeUndefined();
      expect(query.warning).toContain('FTS disabled for this index');
      expect(query.warning).not.toMatch(/failed to load|indexes missing|reinstall|repair-fts/);
    } finally {
      await backend.dispose();
    }
  }, 180_000);

  it('re-enables at the same commit and safely disables existing native indexes while preserving graph and embeddings', async () => {
    vi.stubEnv('GITNEXUS_SKIP_FTS', '1');
    const disabled = await runFullAnalysis(repo.dbPath, options, callbacks);
    expect(disabled.ftsSkipReason).toBe('disabled-by-env');
    const { storagePath, lbugPath } = getStoragePaths(repo.dbPath);
    const before = await graphSnapshot();
    expect(before.communities).not.toEqual([]);
    expect(before.processes).not.toEqual([]);
    const node = before.functions.find((row) => row.name === 'createHandler');
    expect(node).toBeDefined();
    await adapter.initLbug(lbugPath, { skipFts: true });
    const embedding = {
      nodeId: String(node!.id),
      chunkIndex: 0,
      startLine: 13,
      endLine: 15,
      embedding: Array.from({ length: EMBEDDING_DIMS }, (_, i) => (i === 0 ? 1 : 0)),
      contentHash: 'seed-preserved',
    };
    await batchInsertEmbeddings(adapter.executeWithReusedStatement, [embedding]);
    await adapter.flushWAL();
    await adapter.closeLbug();
    const meta = (await loadMeta(storagePath))!;
    await saveMeta(storagePath, {
      ...meta,
      stats: { ...meta.stats, embeddings: 1 },
      embeddingDims: EMBEDDING_DIMS,
    });
    vi.stubEnv('GITNEXUS_SKIP_FTS', undefined);
    const enabled = await runFullAnalysis(repo.dbPath, options, callbacks);
    expect(enabled.alreadyUpToDate).not.toBe(true);
    expect(enabled.ftsSkipped).toBe(false);
    expect((await loadMeta(storagePath))?.lastCommit).toBe(meta.lastCommit);
    await adapter.initLbug(lbugPath);
    const found = await searchFTSFromLbug('createHandler');
    expect(found.ftsAvailable).toBe(true);
    expect(found.results.some((r) => r.filePath === 'src/handler.ts')).toBe(true);
    await adapter.closeLbug();
    const afterEnable = await graphSnapshot();
    expect(afterEnable.functions).toEqual(before.functions);
    expect(afterEnable.edges).toEqual(before.edges);
    expect(afterEnable.communities).toEqual(before.communities);
    expect(afterEnable.processes).toEqual(before.processes);
    expect(afterEnable.cache).toEqual(before.cache);
    expect(afterEnable.embeddings.embeddings).toEqual([embedding]);
    const ensure = vi.spyOn(extensionManager, 'ensure');
    const enabledMeta = (await loadMeta(storagePath))!;
    let dirtyDuringDisable: Promise<Awaited<ReturnType<typeof loadMeta>>> | undefined;
    const disabledAgain = await runFullAnalysis(
      repo.dbPath,
      { ...options, skipFts: true },
      {
        onProgress() {},
        onLog(msg) {
          // vi.spyOn cannot intercept run-analyze's ESM saveMeta binding.
          // The escalation log is emitted after the dirty stamp and before wipe.
          if (
            !dirtyDuringDisable &&
            msg.includes('FTS is explicitly disabled and existing search indexes')
          ) {
            dirtyDuringDisable = loadMeta(storagePath);
          }
        },
      },
    );
    expect(disabledAgain.ftsSkipReason).toBe('disabled-by-flag');
    expect(dirtyDuringDisable).toBeDefined();
    const dirty = await dirtyDuringDisable!;
    expect(dirty?.incrementalInProgress).toBeDefined();
    expect(dirty?.indexedAt).toBe(enabledMeta.indexedAt);
    expect(dirty?.capabilities?.fts).toEqual({
      provider: 'ladybugdb-fts',
      status: 'unavailable',
      skipReason: 'disabled-by-flag',
    });
    expect(ensure.mock.calls.filter((call) => call[1] === 'fts')).toEqual([]);
    const after = await graphSnapshot();
    expect(after.functions).toEqual(before.functions);
    expect(after.edges).toEqual(before.edges);
    expect(after.communities).toEqual(before.communities);
    expect(after.processes).toEqual(before.processes);
    expect(after.cache).toEqual(before.cache);
    expect(after.embeddings.embeddings).toEqual([embedding]);
    expect(after.indexes.filter((row) => row.index_type === 'FTS')).toEqual([]);
    expect((await loadMeta(storagePath))?.stats?.embeddings).toBe(1);
  }, 240_000);

  it('refreshes an existing MCP session across both FTS mode transitions without losing context', async () => {
    await runFullAnalysis(repo.dbPath, { ...options, skipFts: true }, callbacks);
    const backend = new LocalBackend();
    const uid = 'Function:src/handler.ts:createHandler';
    const queryArgs = { repo: options.registryName, search_query: 'createHandler' };
    const contextArgs = { repo: options.registryName, uid };
    try {
      expect(await backend.init()).toBe(true);
      expect((await backend.callTool('query', queryArgs)).warning).toContain(
        'FTS disabled for this index',
      );
      const initialContext = await backend.callTool('context', contextArgs);
      expect(initialContext).toMatchObject({ status: 'found', symbol: { uid } });
      await runFullAnalysis(repo.dbPath, options, callbacks);
      // Observe the production staleness throttle without resetting the backend.
      await vi.waitFor(
        async () => {
          const result = await backend.callTool('query', queryArgs);
          expect(result.error).toBeUndefined();
          expect(result.warning).toBeUndefined();
          const hits = [...(result.definitions ?? []), ...(result.process_symbols ?? [])];
          expect(hits.map((hit) => hit.id)).toContain(uid);
        },
        { timeout: 15_000, interval: 300 },
      );
      await runFullAnalysis(repo.dbPath, { ...options, skipFts: true }, callbacks);
      await vi.waitFor(
        async () => {
          const result = await backend.callTool('query', queryArgs);
          expect(result.error).toBeUndefined();
          expect(result.warning).toContain('FTS disabled for this index');
        },
        { timeout: 15_000, interval: 300 },
      );
      const finalContext = await backend.callTool('context', contextArgs);
      expect(finalContext.status).toBe('found');
      expect(finalContext.symbol).toEqual(initialContext.symbol);
    } finally {
      await backend.dispose();
    }
  }, 240_000);

  it('fails closed for unknown catalog state without loading FTS', async () => {
    const { lbugPath } = getStoragePaths(repo.dbPath);
    const ensure = vi.spyOn(extensionManager, 'ensure');
    await adapter.initLbug(lbugPath, { skipFts: true });
    expect(await adapter.ensureFtsRowDmlSafe([], { skipFts: true })).toBe(true);
    expect(
      await adapter.ensureFtsRowDmlSafe(adapter.INDEX_CATALOG_UNREADABLE, { skipFts: true }),
    ).toBe(false);
    expect(await adapter.ensureFtsRowDmlSafe([{ index_type: 'FTS' }], { skipFts: true })).toBe(
      false,
    );
    expect(ensure.mock.calls.filter((call) => call[1] === 'fts')).toEqual([]);
  });

  it('exposes the explicit CLI flag, status capability and HTTP disabled response', async () => {
    const cli = (args: string[]) =>
      promisify(execFile)(process.execPath, [...CLI_SPAWN_PREFIX, ...args], {
        cwd: repo.dbPath,
        env: { ...process.env, GITNEXUS_MEMORY: 'off' },
        timeout: 120_000,
        maxBuffer: 2_000_000,
      });
    const analyze = await cli([
      'analyze',
      '--skip-fts',
      '--skip-agents-md',
      '--name',
      options.registryName,
    ]);
    expect(analyze.stdout + analyze.stderr).toContain('FTS disabled for this index');
    const status = await cli(['status', '--json']);
    const statusJson = JSON.parse(
      status.stdout.split(/\r?\n/).find((line) => line.startsWith('{'))!,
    );
    expect(statusJson.index.capabilities.fts).toMatchObject({
      status: 'unavailable',
      skipReason: 'disabled-by-flag',
    });
    expect((await cli(['status'])).stdout).toContain('FTS disabled for this index');

    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        if (!address || typeof address === 'string') {
          probe.close();
          reject(new Error('No port'));
          return;
        }
        probe.close((error) => (error ? reject(error) : resolve(address.port)));
      });
    });
    const server = spawn(
      process.execPath,
      [...CLI_SPAWN_PREFIX, 'serve', '--port', String(port), '--host', '127.0.0.1'],
      {
        cwd: repo.dbPath,
        env: { ...process.env, GITNEXUS_MEMORY: 'off', GITNEXUS_NO_UPDATE_NOTIFIER: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    server.stdout.on('data', (data) => {
      output += String(data);
    });
    server.stderr.on('data', (data) => {
      output += String(data);
    });
    const exited = new Promise<void>((resolve) => server.once('exit', () => resolve()));
    try {
      await vi.waitFor(
        async () => {
          if (server.exitCode !== null) throw new Error(`Server exited: ${output}`);
          const health = await fetch(`http://127.0.0.1:${port}/api/health`, {
            signal: AbortSignal.timeout(2_000),
          });
          expect(health.status).toBe(200);
        },
        { timeout: 60_000, interval: 250 },
      );
      for (const mode of ['bm25', 'hybrid']) {
        const response = await fetch(`http://127.0.0.1:${port}/api/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: 'createHandler', mode, repo: options.registryName }),
          signal: AbortSignal.timeout(30_000),
        });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.warning).toContain('FTS disabled for this index');
        expect(body.warning).not.toMatch(/failed to load|indexes missing|repair-fts/);
      }
    } finally {
      if (server.exitCode === null) server.kill('SIGTERM');
      const force = setTimeout(() => server.kill('SIGKILL'), 3_000);
      await exited;
      clearTimeout(force);
    }
  }, 240_000);
});
