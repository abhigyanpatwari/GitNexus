import path from 'node:path';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { after, afterEach, describe, it, mock } from 'node:test';
import { expect } from 'expect';
import { registerCases } from '../support/cases.mjs';
import { createTestEnvironment } from '../support/environment.js';
import { createTempDir, type TestDBHandle } from '../../../../test/helpers/test-db.js';
import {
  seedEmbeddingsForFiles,
  stampEmbeddingCount,
} from '../../../../test/helpers/embedding-seed.js';
import { EMBEDDING_DIMS } from '../../../../dist/core/lbug/schema.js';
import { DEFAULT_EMBEDDING_CONFIG } from '../../../../dist/core/embeddings/types.js';
import * as sidecar from '../../../../dist/core/embeddings/embedding-sidecar-client.js';
import * as runtimeSupport from '../../../../dist/core/embeddings/runtime-support.js';
import * as adapter from '../../../../dist/core/lbug/lbug-adapter.js';
import { getStoragePaths, loadMeta } from '../../../../dist/storage/repo-manager.js';

const init = mock.fn(async (_options?: Parameters<typeof sidecar.ensureEmbeddingSidecar>[0]) => ({
  device: 'cpu' as const,
}));
let marker = 0;
const embed = mock.fn(async (texts: string[]) =>
  texts.map(() => {
    const vector = new Float32Array(EMBEDDING_DIMS);
    vector[marker] = 1;
    return vector;
  }),
);
const sidecarMock = mock.module(
  new URL('../../../../dist/core/embeddings/embedding-sidecar-client.js', import.meta.url).href,
  {
    namedExports: {
      ...sidecar,
      ensureEmbeddingSidecar: init,
      sidecarEmbedBatch: embed,
      reapEmbeddingSidecarAndWait: async () => {},
    },
  },
);
const runtimeMock = mock.module(
  new URL('../../../../dist/core/embeddings/runtime-support.js', import.meta.url).href,
  {
    namedExports: { ...runtimeSupport, getLocalEmbeddingRuntimeBlocker: () => null },
  },
);
after(() => {
  sidecarMock.restore();
  runtimeMock.restore();
});
const { runFullAnalysis } = await import('../../../../dist/core/run-analyze.js');
const { batchInsertEmbeddings, runEmbeddingPipeline } =
  await import('../../../../dist/core/embeddings/embedding-pipeline.js');
const environment = createTestEnvironment();

describe('embedding identity integrity (#3569)', () => {
  let tmp: TestDBHandle | undefined;
  afterEach(async () => {
    await adapter.closeLbug();
    await tmp?.cleanup();
    tmp = undefined;
    environment.restore();
  });

  it(
    'replaces same-width model vectors on forced analyze and reuses only matching hashes',
    { timeout: 180_000 },
    async () => {
      tmp = await createTempDir('gitnexus-test-embedding-identity-');
      const repo = path.join(tmp.dbPath, 'repo');
      await fs.mkdir(repo);
      environment.set('GITNEXUS_HOME', path.join(tmp.dbPath, 'home'));
      environment.set('GITNEXUS_SHARED_STORE', 'off');
      environment.set('GITNEXUS_LBUG_EXTENSION_INSTALL', 'never');
      environment.set('GITNEXUS_EMBEDDING_URL', '');
      environment.set('GITNEXUS_EMBEDDING_MODEL', '');
      environment.set('GITNEXUS_EMBEDDING_DIMS', String(EMBEDDING_DIMS));
      // Only model inference is faked. Analyze, hashes, cache restore, and database writes are real.
      marker = 0;
      await fs.writeFile(path.join(repo, 'main.ts'), 'export function main() { return 1; }\n');
      await fs.writeFile(path.join(repo, 'util.ts'), 'export function util() { return 2; }\n');
      const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
      git('init', '-q');
      git('add', '.');
      git('-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-qm', 'fixture');
      const options = {
        force: true,
        embeddings: true,
        skipFts: true,
        skipAgentsMd: true,
        skipSkills: true,
      };
      const readRows = async () => {
        await adapter.initLbug(getStoragePaths(repo).lbugPath, { skipFts: true });
        try {
          return await adapter.executeQuery(
            'MATCH (e:CodeEmbedding) RETURN e.nodeId AS nodeId, e.contentHash AS hash, e.embedding AS vector ORDER BY nodeId',
          );
        } finally {
          await adapter.closeLbug();
        }
      };
      let previousHashes: string[] = [];
      let defaultHashes: string[] = [];
      let nodeIds: string[] = [];
      for (const modelId of ['', 'fixture/model-a', 'fixture/model-b', '']) {
        environment.set('GITNEXUS_EMBEDDING_MODEL_ID', modelId);
        embed.mock.resetCalls();
        await runFullAnalysis(repo, options, { onProgress: () => {} });
        expect(init.mock.calls.at(-1)?.arguments[0]?.embeddingConfig?.modelId).toBe(
          modelId || DEFAULT_EMBEDDING_CONFIG.modelId,
        );
        const rows = await readRows();
        expect(rows).toHaveLength(2);
        expect(embed.mock.calls.flatMap(({ arguments: [texts] }) => texts)).toHaveLength(2);
        expect(rows.map((row) => row.vector[marker])).toEqual([1, 1]);
        const hashes = rows.map((row) => row.hash);
        if (marker === 0) {
          defaultHashes = hashes;
          nodeIds = rows.map((row) => row.nodeId);
        } else {
          expect(rows.map((row) => row.nodeId)).toEqual(nodeIds);
          hashes.forEach((hash, index) => expect(hash).not.toBe(previousHashes[index]));
          if (modelId === '') expect(hashes).toEqual(defaultHashes);
        }
        previousHashes = hashes;

        embed.mock.resetCalls();
        await runFullAnalysis(repo, options, { onProgress: () => {} });
        expect(embed.mock.callCount()).toBe(0);
        expect(await readRows()).toEqual(rows);
        marker += 1;
      }
    },
  );

  registerCases(
    it,
    [
      { limit: '2048', invalid: 'negative' },
      { limit: '0', invalid: 'negative' },
      { limit: '0', invalid: 'blank' },
      { limit: '2048', invalid: 'duplicate' },
    ],
    'preserves healthy cached vectors before writeback ($invalid, limit=$limit)',
    async ({ limit, invalid }) => {
      tmp = await createTempDir('gitnexus-test-corrupt-cache-');
      const repo = path.join(tmp.dbPath, 'repo');
      await fs.mkdir(repo);
      environment.set('GITNEXUS_HOME', path.join(tmp.dbPath, 'home'));
      environment.set('GITNEXUS_SHARED_STORE', 'off');
      environment.set('GITNEXUS_LBUG_EXTENSION_INSTALL', 'never');
      environment.set('GITNEXUS_EMBEDDING_CACHE_IN_MEMORY_LIMIT', limit);
      execFileSync('git', ['init', '-q'], { cwd: repo });
      const source = path.join(repo, 'source.ts');
      await fs.writeFile(
        source,
        'export function good() { return 1; }\nexport function bad() { return 2; }\n',
      );
      execFileSync('git', ['add', '.'], { cwd: repo });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@t',
          '-c',
          'commit.gpgsign=false',
          'commit',
          '-qm',
          'initial',
        ],
        { cwd: repo },
      );
      await runFullAnalysis(repo, { skipFts: true }, { onProgress: () => {} });
      const { lbugPath, storagePath } = getStoragePaths(repo);
      const seeded = await seedEmbeddingsForFiles(repo, ['source.ts'], 2);
      expect(seeded.get('source.ts')).toHaveLength(2);
      await stampEmbeddingCount(storagePath, 2);
      const oldMeta = await loadMeta(storagePath);
      await adapter.initLbug(lbugPath, { skipFts: true });
      const badId = seeded.get('source.ts')![1]!;
      const goodId = seeded.get('source.ts')![0]!;
      // Controlled stored corruption, not a reproduction of the host's producer.
      await adapter.executeWithReusedStatement(
        invalid === 'negative'
          ? 'MATCH (e:CodeEmbedding {nodeId: $id}) SET e.chunkIndex = -1'
          : 'MATCH (e:CodeEmbedding {nodeId: $id}) SET e.nodeId = $replacement',
        [{ id: badId, replacement: invalid === 'blank' ? '' : goodId }],
      );
      const query =
        'MATCH (e:CodeEmbedding) RETURN e.id AS id, e.nodeId AS nodeId, e.chunkIndex AS chunkIndex, e.embedding AS embedding ORDER BY id';
      const before = await adapter.executeQuery(query);
      await adapter.closeLbug();
      await fs.appendFile(source, '// incremental update\n');
      const failure = await runFullAnalysis(
        repo,
        { skipFts: true },
        { onProgress: () => {} },
      ).catch((error: unknown) => error);
      await adapter.closeLbug();
      await adapter.initLbug(lbugPath, { skipFts: true });
      expect(await adapter.executeQuery(query)).toEqual(before);
      expect(await loadMeta(storagePath)).toEqual(oldMeta);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/embedding.*(identity|node.?id|key|chunk)/i);
    },
    180_000,
  );

  registerCases(
    it,
    ['blank', 'duplicate'],
    'rejects a persisted %s identity before endpoint calls or replacing valid vectors',
    async (invalid) => {
      const inputs: string[] = [];
      const server = createServer(async (request, response) => {
        const pieces: Buffer[] = [];
        for await (const piece of request) pieces.push(Buffer.from(piece));
        const body = JSON.parse(Buffer.concat(pieces).toString()) as { input: string[] };
        inputs.push(...body.input);
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            data: body.input.map((_, index) => ({
              index,
              embedding: Array<number>(EMBEDDING_DIMS).fill(0),
            })),
          }),
        );
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Expected loopback server');
        environment.set('GITNEXUS_EMBEDDING_URL', `http://127.0.0.1:${address.port}`);
        environment.set('GITNEXUS_EMBEDDING_MODEL', 'identity-fixture');
        environment.set('GITNEXUS_LBUG_EXTENSION_INSTALL', 'never');
        tmp = await createTempDir('gitnexus-test-persisted-identity-');
        await adapter.initLbug(path.join(tmp.dbPath, 'lbug'), { skipFts: true });
        // Controlled malformed stored row; this does not claim to reproduce the
        // original Windows Java producer that left thousands of blank scan rows.
        await adapter.executeQuery(
          invalid === 'blank'
            ? "CREATE (:Function {id: '', name: 'broken', filePath: 'bad.ts', content: 'export function broken() {}', startLine: 1, endLine: 1})"
            : "CREATE (:Method {id: 'Function:good.ts:good', name: 'broken', filePath: 'bad.ts', content: 'broken() {}', startLine: 1, endLine: 1})",
        );
        await adapter.executeQuery(
          "CREATE (:Function {id: 'Function:good.ts:good', name: 'good', filePath: 'good.ts', content: 'export function good() { return 1; }', startLine: 1, endLine: 1})",
        );
        const good = {
          nodeId: 'Function:good.ts:good',
          chunkIndex: 0,
          startLine: 1,
          endLine: 1,
          embedding: Array<number>(EMBEDDING_DIMS).fill(0),
          contentHash: 'old-valid',
        };
        await batchInsertEmbeddings(adapter.executeWithReusedStatement, [good]);
        const failure = await runEmbeddingPipeline(
          adapter.executeQuery,
          adapter.executeWithReusedStatement,
          () => {},
          {},
          undefined,
          new Map([[good.nodeId, good.contentHash]]),
        ).catch((error: unknown) => error);
        expect(inputs).toEqual([]);
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toMatch(/invalid.*node.*id|duplicate.*node.*id/i);
        expect(
          await adapter.executeQuery('MATCH (e:CodeEmbedding) RETURN e.contentHash AS contentHash'),
        ).toEqual([{ contentHash: 'old-valid' }]);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
});
