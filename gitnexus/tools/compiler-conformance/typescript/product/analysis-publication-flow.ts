import { registerCases } from '../support/cases.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fork, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, afterEach, beforeEach, it, mock } from 'node:test';
import { expect } from 'expect';
import { verifyPublishedAnalysisGraph } from '../../../../dist/core/analysis-graph-verification.js';
import { resolveAnalysisResourceBudget } from '../../../../dist/core/analysis-resource-budget.js';
import { loadMeta, saveMeta } from '../../../../dist/storage/repo-manager.js';
import {
  readPreparedAnalysis,
  publishPreparedAnalysis,
} from '../../../../dist/core/analysis-publication.js';
import type { PreparedAnalysisHandoff } from '../../../../dist/core/analysis-phase-supervisor.js';
import { waitForAnalysisProcessExit } from '../../../../test/helpers/analysis-process-exit.js';
import { EmbeddingGraphSource } from '../../../../dist/core/lbug/embedding-source.js';
import type { RepoMeta } from '../../../../dist/storage/repo-meta.js';
import lbug from '@ladybugdb/core';
import {
  openLbugConnection,
  closeLbugConnection,
  estimateBufferPool,
} from '../../../../dist/core/lbug/lbug-config.js';
import { readLegacyEmbeddingSource } from '../../../../dist/storage/legacy-embedding-source.js';
import {
  loadFileResultStore,
  readFileResults,
} from '../../../../dist/storage/file-result-store.js';
import { decodeFileResultSection } from '../../../../dist/storage/file-result-codec.js';

import * as config from '../../../../dist/core/lbug/lbug-config.js';
import { createTestEnvironment } from '../support/environment.js';

const estimate = mock.fn(config.estimateWriteBufferPool);
const configMock = mock.module(
  new URL('../../../../dist/core/lbug/lbug-config.js', import.meta.url).href,
  {
    namedExports: { ...config, estimateWriteBufferPool: estimate },
  },
);
after(() => configMock.restore());
const { continuePreparedAnalysis, runFullAnalysis } =
  await import('../../../../dist/core/run-analyze.js');
const environment = createTestEnvironment();
let root: string, repo: string, slot: string;
const resources = resolveAnalysisResourceBudget({
  effectiveMemoryBytes: 4 * 1024 ** 3,
  availableCpus: 2,
  totalMb: 2048,
  workers: 1,
  graphPoolBytes: 256 * 1024 ** 2,
  modelMemoryMb: 0,
});
const options = {
  graphPublication: 'inline' as const,
  resources,
  skipFts: true,
  skipAgentsMd: true,
  skipSkills: true,
};
const callbacks = { onProgress() {} };
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gn-publication-flow-')));
  repo = path.join(root, 'repo');
  slot = path.join(repo, '.gitnexus');
  await fs.mkdir(repo);
  environment.set('GITNEXUS_HOME', path.join(root, 'home'));
  environment.set('GITNEXUS_SHARED_STORE', 'off');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  await fs.writeFile(path.join(repo, 'a.ts'), 'export function alpha() { return 1; }\n');
  git('add', 'a.ts');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture');
});
afterEach(async () => {
  environment.restore();
  await fs.rm(root, { recursive: true, force: true });
});
async function meta(): Promise<RepoMeta> {
  const result = await loadMeta(slot);
  if (!result) throw new Error('Missing fixture metadata');
  return result;
}
async function contents(metadata: RepoMeta) {
  const source = await EmbeddingGraphSource.open(
    path.join(slot, metadata.graphPath!),
    256 * 1024 ** 2,
    1,
  );
  try {
    const ids = [];
    for await (const key of source.scan('Function')) ids.push(key.id);
    return (await source.fetch('Function', ids))[0].content;
  } finally {
    await source.close();
  }
}

it(
  'keeps automatic plain graph analysis on its existing publication path',
  { timeout: 120_000 },
  async () => {
    const beforeWork = mock.fn(() => {
      throw new Error('Unexpected process handoff');
    });
    await runFullAnalysis(
      repo,
      { ...options, graphPublication: 'auto' },
      {
        ...callbacks,
        onGraphWork: beforeWork,
      },
    );
    expect(beforeWork.mock.callCount()).toBe(0);
    expect((await meta()).graphGeneration).toBeUndefined();
    await expect(fs.stat(path.join(slot, 'lbug'))).resolves.toBeDefined();
  },
);

for (const poolMb of [128, 1024]) {
  it(
    `keeps a small graph cache within a ${poolMb} MiB ceiling`,
    { timeout: 120_000 },
    async (t) => {
      environment.set('GITNEXUS_LBUG_BUFFER_POOL_SIZE', undefined);
      const database = t.mock.method(lbug, 'Database');
      const roomy = resolveAnalysisResourceBudget({
        effectiveMemoryBytes: 8 * 1024 ** 3,
        availableCpus: 2,
        totalMb: 4096,
        workers: 1,
        graphPoolBytes: poolMb * 1024 ** 2,
        modelMemoryMb: 0,
      });
      await runFullAnalysis(
        repo,
        { ...options, graphPublication: 'auto', resources: roomy },
        callbacks,
      );
      const writers = database.mock.calls
        .map((call) => call.arguments as ConstructorParameters<typeof lbug.Database>)
        .filter(([file]) => file.startsWith(path.join(slot, 'lbug')));
      expect(writers.length).toBeGreaterThan(0);
      const expected = Math.min(estimateBufferPool(100), poolMb * 1024 ** 2);
      expect(writers.every(([, pool]) => pool === expected)).toBe(true);
    },
  );
}

it(
  'includes file text, symbol text and descriptions in the bulk writer estimate',
  { timeout: 120_000 },
  async () => {
    const description = 'Recorded input and expected result. '.repeat(80).trim();
    const source = `def transform(value):\n    """${description}"""\n    return value\n`;
    await fs.writeFile(path.join(repo, 'transform.py'), source);
    estimate.mock.resetCalls();
    await runFullAnalysis(repo, options, callbacks);
    const [, textBytes, buildFts] = estimate.mock.calls[0].arguments;
    expect(textBytes).toBeGreaterThanOrEqual(
      2 * Buffer.byteLength(source) + Buffer.byteLength(description),
    );
    expect(buildFts).toBe(false);
  },
);

it(
  'requests an exit supervisor before parsing or opening a graph writer',
  { timeout: 120_000 },
  async () => {
    const phases: string[] = [];
    await expect(
      runFullAnalysis(
        repo,
        {
          ...options,
          graphPublication: 'auto',
          embeddings: true,
          skipNativeCloseOnExit: true,
        },
        {
          onProgress: (phase) => phases.push(phase),
          onGraphWork: () => {
            throw new Error('Supervisor requested');
          },
        },
      ),
    ).rejects.toThrow('Supervisor requested');
    expect(phases).not.toContain('extracting');
    expect(await loadMeta(slot)).toMatchObject({ repoPath: repo, lastCommit: '' });
    expect((await loadMeta(slot))?.graphGeneration).toBeUndefined();
    await expect(fs.stat(path.join(slot, 'lbug'))).rejects.toMatchObject({ code: 'ENOENT' });
  },
);

registerCases(
  it,
  [true, false],
  'publishes a verified native graph before reporting graph-ready (skipFts=%s)',
  async (skipFts) => {
    const events: string[] = [];
    await runFullAnalysis(
      repo,
      { ...options, skipFts },
      {
        onProgress(phase, _percent, _message, details) {
          if (phase === 'graph-ready') {
            expect(details?.graphPhase).toBe('ready');
            events.push(phase);
          }
          if (phase === 'done' && _percent === 100) events.push('terminal');
        },
      },
    );
    const published = await meta();
    if (!skipFts) expect(published.capabilities?.fts.status).toBe('available');
    expect(events).toEqual(['graph-ready']);
    expect(published.graphGeneration?.coveredContent).toMatch(/^[a-f0-9]{64}$/);
    expect(published.graphPath).toMatch(/^lbug\.generation\.[a-f0-9]{32}$/);
    expect(await contents(published)).toContain('return 1');
    await expect(fs.stat(path.join(slot, 'lbug'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readPreparedAnalysis(slot)).toBeUndefined();
    await expect(
      verifyPublishedAnalysisGraph(
        path.join(slot, published.graphPath!),
        {
          ...published,
          stats: { ...published.stats, nodes: (published.stats?.nodes ?? 0) + 1 },
        },
        { bufferPoolBytes: 256 * 1024 ** 2, threads: 1 },
      ),
    ).rejects.toThrow('counts differ');
  },
  120_000,
);

it(
  'advances the logical generation on a tiny edit without copying its private graph',
  { timeout: 120_000 },
  async (t) => {
    await runFullAnalysis(repo, options, callbacks);
    const first = await meta();
    const graph = path.join(slot, first.graphPath!);
    const inode = (await fs.stat(graph)).ino;
    await fs.writeFile(path.join(repo, 'a.ts'), 'export function alpha() { return 2; }\n');
    const copy = t.mock.method(fs, 'copyFile');
    await runFullAnalysis(repo, options, callbacks);
    const second = await meta();
    expect(second.graphPath).toBe(first.graphPath);
    expect((await fs.stat(graph)).ino).toBe(inode);
    expect(second.graphGeneration?.id).not.toBe(first.graphGeneration?.id);
    expect(second.graphGeneration?.coveredContent).not.toBe(first.graphGeneration?.coveredContent);
    expect(second.incrementalInProgress).toBeUndefined();
    expect(await contents(second)).toContain('return 2');
    expect(
      copy.mock.calls.filter(({ arguments: args }) =>
        args.some((file) => path.basename(String(file)).startsWith('lbug')),
      ),
    ).toHaveLength(0);
    const unchanged = await runFullAnalysis(repo, options, callbacks);
    expect(unchanged.alreadyUpToDate).toBe(true);
    expect((await meta()).graphGeneration?.id).toBe(second.graphGeneration?.id);
    await fs.writeFile(path.join(repo, 'a.ts'), 'export function alpha() { return 5; }\n');
    expect((await runFullAnalysis(repo, options, callbacks)).alreadyUpToDate).not.toBe(true);
    expect(await contents(await meta())).toContain('return 5');
    await fs.writeFile(path.join(repo, 'b.ts'), 'export function beta() { return 6; }\n');
    expect((await runFullAnalysis(repo, options, callbacks)).alreadyUpToDate).not.toBe(true);
    expect((await meta()).fileHashes?.['b.ts']).toBeDefined();
  },
);

it('verifies published FTS with an empty extension home', { timeout: 120_000 }, async () => {
  const home = path.join(root, 'empty-home');
  await fs.mkdir(home);
  environment.set('HOME', home);
  environment.set('USERPROFILE', home);
  environment.set('GITNEXUS_LBUG_EXTENSION_INSTALL', 'load-only');
  await runFullAnalysis(repo, { ...options, skipFts: false }, callbacks);
  const published = await meta();
  expect(published.capabilities?.fts.status).toBe('available');
  expect(published.graphGeneration).toBeDefined();
  expect(await readPreparedAnalysis(slot)).toBeUndefined();
  await expect(fs.stat(path.join(home, '.lbdb', 'extension'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it(
  'preserves completed vector coverage across a new graph generation',
  { timeout: 120_000 },
  async () => {
    await runFullAnalysis(repo, options, callbacks);
    const first = await meta();
    const vector = {
      version: 1 as const,
      graphGeneration: first.graphGeneration!.id,
      identity: 'a'.repeat(64),
      vectorIdentity: 'b'.repeat(64),
      inputIdentity: 'c'.repeat(64),
      dimensions: 4,
      nodes: 1,
      chunks: 1,
      indexKind: 'exact' as const,
    };
    await saveMeta(slot, { ...first, vectorGeneration: vector });
    await fs.writeFile(path.join(repo, 'a.ts'), 'export function alpha() { return 3; }\n');
    await runFullAnalysis(repo, options, callbacks);
    const second = await meta();
    expect(second.vectorGeneration).toEqual({
      ...vector,
      preservedForGraph: second.graphGeneration?.id,
    });
    expect(second.stats?.embeddings).toBe(1);
  },
);

it(
  'preserves an old-width legacy table before writable schema initialization changes it',
  { timeout: 120_000 },
  async () => {
    await runFullAnalysis(repo, { ...options, graphPublication: 'auto' }, callbacks);
    const graph = path.join(slot, 'lbug');
    const handle = await openLbugConnection(lbug, graph, {
      bufferPoolBytes: 256 * 1024 ** 2,
      threads: 1,
    });
    const query = async (sql: string) => {
      const result = await handle.conn.query(sql);
      for (const cursor of Array.isArray(result) ? result : [result]) cursor.close();
    };
    try {
      await query('DROP TABLE CodeEmbedding');
      await query(
        'CREATE NODE TABLE CodeEmbedding (id STRING, nodeId STRING, chunkIndex INT32, startLine INT64, endLine INT64, embedding FLOAT[4], contentHash STRING, PRIMARY KEY(id))',
      );
      await query(
        "CREATE (:CodeEmbedding {id:'old:0',nodeId:'old',chunkIndex:0,startLine:1,endLine:1,embedding:[1,0,0,0],contentHash:'historical'})",
      );
      await query('CHECKPOINT');
    } finally {
      await closeLbugConnection(handle, { strict: true, databasePath: graph });
    }
    await saveMeta(slot, {
      ...(await meta()),
      embeddingDims: 4,
      stats: { ...(await meta()).stats, embeddings: 1 },
    });
    await fs.writeFile(path.join(repo, 'a.ts'), 'export function alpha() { return 7; }\n');
    await runFullAnalysis(repo, options, callbacks);
    const published = await meta();
    expect(published.legacyVectorSource).toMatch(/^[a-f0-9]{64}$/);
    const retained = await readLegacyEmbeddingSource(slot, published.legacyVectorSource!);
    expect(retained.recordedIdentity).toBeUndefined();
    const old = await openLbugConnection(lbug, retained.path, {
      readOnly: true,
      bufferPoolBytes: 32 * 1024 ** 2,
      threads: 1,
    });
    try {
      const result = await old.conn.query('MATCH (e:CodeEmbedding) RETURN e.embedding AS vector');
      const cursors = Array.isArray(result) ? result : [result];
      try {
        expect(await cursors[0].getAll()).toEqual([{ vector: [1, 0, 0, 0] }]);
      } finally {
        for (const cursor of cursors) cursor.close();
      }
    } finally {
      await closeLbugConnection(old, { strict: true, databasePath: retained.path });
    }
    expect(await contents(published)).toContain('return 7');
  },
);

it(
  'retains an unpublished replacement and its parse cache when publication fails',
  { timeout: 120_000 },
  async (t) => {
    await runFullAnalysis(repo, options, callbacks);
    const first = await meta();
    await fs.writeFile(path.join(repo, 'a.ts'), 'export function alpha() { return 4; }\n');
    const rename = fs.rename;
    const failPublication = t.mock.method(
      fs,
      'rename',
      async (
        source: Parameters<typeof fs.rename>[0],
        destination: Parameters<typeof fs.rename>[1],
      ) => {
        if (
          String(source).includes('.staging.') &&
          path.basename(String(destination)).startsWith('lbug.generation.')
        )
          throw new Error('publication interrupted');
        return rename(source, destination);
      },
    );
    await expect(runFullAnalysis(repo, { ...options, force: true }, callbacks)).rejects.toThrow(
      'publication interrupted',
    );
    failPublication.mock.restore();
    expect((await meta()).graphGeneration?.id).toBe(first.graphGeneration?.id);
    expect(await contents(await meta())).toContain('return 1');
    const pending = await readPreparedAnalysis(slot);
    expect(pending).toBeDefined();
    await expect(fs.stat(path.join(slot, pending!.stagingFile))).resolves.toBeDefined();
    await expect(
      fs.stat(path.join(slot, `analysis-cache-${pending!.id}.json`)),
    ).resolves.toBeDefined();
    expect((await fs.readdir(path.join(slot, 'parse-rebuild'))).length).toBeGreaterThan(0);
    const recoveryLogs: string[] = [];
    const result = await runFullAnalysis(repo, options, {
      onLog: (message) => {
        recoveryLogs.push(message);
      },
      onProgress(phase) {
        if (phase === 'extracting')
          throw new Error(`Recovery unexpectedly reparsed: ${recoveryLogs.join('\n')}`);
      },
    });
    expect(result.alreadyUpToDate).toBe(true);
    expect((await meta()).graphGeneration?.id).toBe(pending!.id);
    expect(await contents(await meta())).toContain('return 4');
  },
);

registerCases(
  it,
  ['prepared', 'graph-published'] as const,
  'recovers the %s graph and parse stage after actual writer exit without parsing',
  async (state) => {
    const child = fork(
      fileURLToPath(
        new URL('../../../../test/helpers/prepared-analysis-runner.mjs', import.meta.url),
      ),
      [repo],
      {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        execArgv: [],
        env: process.env,
      },
    );
    const exit = waitForAnalysisProcessExit(child);
    void exit.catch(() => {});
    let output = '';
    child.stderr?.on('data', (chunk) => {
      output = (output + String(chunk)).slice(-8192);
    });
    const prepared = new Promise<{ handoff: { publicationId: string } }>((resolve, reject) => {
      child.once('message', (message) =>
        resolve(message as { handoff: { publicationId: string } }),
      );
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code !== 0) reject(new Error(`Graph child exited ${code}: ${output}`));
      });
    });
    try {
      const message = await prepared;
      expect((await readPreparedAnalysis(slot))?.id).toBe(message.handoff.publicationId);
      expect((await meta()).graphGeneration).toBeUndefined();
      expect((await fs.readdir(path.join(slot, 'parse-rebuild'))).length).toBeGreaterThan(0);
      await expect(runFullAnalysis(repo, options, callbacks)).rejects.toThrow('has not exited');
      child.send('exit');
      await exit;
      if (state === 'graph-published') {
        // Simulate exit between durable graph publication and cache publication.
        await publishPreparedAnalysis(slot, {
          saveMetadata: (metadata) => saveMeta(slot, metadata),
          verify: (file, metadata) =>
            verifyPublishedAnalysisGraph(file, metadata, {
              bufferPoolBytes: resources.parse.graphPoolBytes,
              threads: resources.parse.nativeThreads,
            }),
        });
        expect(await readPreparedAnalysis(slot)).toBeUndefined();
        await expect(
          fs.stat(path.join(slot, `analysis-cache-${message.handoff.publicationId}.json`)),
        ).resolves.toBeDefined();
      }
      // Use the same distribution runtime for both phases: mixing the Vitest and
      // plain Node parser loaders would test an analyzer change as well as recovery.
      const continuation = fork(
        fileURLToPath(
          new URL('../../../../test/helpers/prepared-analysis-runner.mjs', import.meta.url),
        ),
        [repo, 'recover'],
        {
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          execArgv: [],
          env: process.env,
        },
      );
      const continuationExit = waitForAnalysisProcessExit(continuation);
      const result = await new Promise<{
        alreadyUpToDate: boolean;
        reasons: string[];
        phases: string[];
      }>((resolve, reject) => {
        continuation.once('message', (message) =>
          resolve(message as { alreadyUpToDate: boolean; reasons: string[]; phases: string[] }),
        );
        continuation.once('error', reject);
        void continuationExit.catch(reject);
      });
      await continuationExit;
      expect({ alreadyUpToDate: result.alreadyUpToDate, reasons: result.reasons }).toEqual({
        alreadyUpToDate: true,
        reasons: [],
      });
      expect(result.phases).not.toContain('extracting');
      expect((await meta()).graphGeneration?.id).toBe(message.handoff.publicationId);
      expect(await contents(await meta())).toContain('return 1');
      expect(await readPreparedAnalysis(slot)).toBeUndefined();
      const keys = (await meta()).cacheKeys!;
      expect(keys.length).toBeGreaterThan(0);
      const cache = await loadFileResultStore(
        path.join(slot, 'parse-cache', 'files'),
        (await meta()).parseCacheIdentity!.base,
      );
      expect([...cache.records.keys()].sort()).toEqual([...keys].sort());
      const records = await readFileResults(cache, keys);
      expect(records.size).toBe(keys.length);
      for (const record of records.values()) {
        expect(
          decodeFileResultSection(record.facts, record.key, record.path, 'facts'),
        ).toBeDefined();
        expect(
          decodeFileResultSection(record.scopes, record.key, record.path, 'scopes'),
        ).toBeDefined();
      }
      await expect(
        fs.stat(path.join(slot, `analysis-cache-${message.handoff.publicationId}.json`)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (child.connected) child.send('exit');
      await exit;
    }
  },
  120_000,
);

it(
  'continues only the exited writer and unchanged target, without repeating forced parsing',
  { timeout: 120_000 },
  async () => {
    const child = fork(
      fileURLToPath(
        new URL('../../../../test/helpers/prepared-analysis-runner.mjs', import.meta.url),
      ),
      [repo],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [], env: process.env },
    );
    const exit = waitForAnalysisProcessExit(child);
    void exit.catch(() => {});
    child.stderr?.resume();
    child.stdout?.resume();
    try {
      const { handoff } = await new Promise<{ handoff: PreparedAnalysisHandoff }>(
        (resolve, reject) => {
          child.once('message', (message) =>
            resolve(message as { handoff: PreparedAnalysisHandoff }),
          );
          child.once('error', reject);
          void exit.then(() => reject(new Error('Writer exited without preparing')), reject);
        },
      );
      if (!child.pid) throw new Error('Missing writer PID');
      await expect(
        continuePreparedAnalysis(handoff, child.pid, options, callbacks),
      ).rejects.toThrow('has not exited');
      child.send('exit');
      await exit;
      await expect(
        continuePreparedAnalysis(
          handoff,
          child.pid,
          { ...options, registryName: 'changed' },
          callbacks,
        ),
      ).rejects.toThrow('registered name changed');
      expect((await readPreparedAnalysis(slot))?.id).toBe(handoff.publicationId);
      const phases: string[] = [];
      const published = await continuePreparedAnalysis(
        handoff,
        child.pid,
        { ...options, force: true },
        { onProgress: (phase) => phases.push(phase) },
      );
      expect(phases).toEqual(['graph-ready', 'done']);
      expect(published.graphGeneration?.id).toBe(handoff.publicationId);
      expect(await contents(published)).toContain('return 1');
      expect(await readPreparedAnalysis(slot)).toBeUndefined();
      await expect(fs.stat(path.join(slot, 'parse-rebuild'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      if (child.connected) child.send('exit');
      await exit;
    }
  },
);
