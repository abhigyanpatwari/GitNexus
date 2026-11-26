import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, it, mock } from 'node:test';
import { expect } from 'expect';
import { runEmbeddingJob } from '../../../../src/core/embeddings/embedding-job-runner.js';
import { createEmbeddingWorkManifest } from '../../../../src/core/embeddings/embedding-work-manifest.js';
import { VectorStore, type VectorStoreOptions } from '../../../../src/core/lbug/vector-store.js';
import { EmbeddingJobJournal } from '../../../../src/storage/embedding-job-journal.js';
import { HttpEmbeddingError } from '../../../../src/core/embeddings/http-client.js';
import type { EmbeddableNode } from '../../../../src/core/embeddings/types.js';
import { createTempDir, type TestDBHandle } from '../../../../test/helpers/test-db.js';
import { createTestEnvironment } from '../support/environment.js';
import { registerCases } from '../support/cases.mjs';

const environment = createTestEnvironment();
let temporary: TestDBHandle | undefined;
let store: VectorStore;
async function setup() {
  temporary = await createTempDir();
  environment.set('GITNEXUS_LBUG_EXTENSION_INSTALL', 'never');
  const options: VectorStoreOptions = {
    directory: temporary.dbPath,
    identity: 'a'.repeat(64),
    dimensions: 4,
    bufferPoolBytes: 64 * 1024 * 1024,
    threads: 1,
    batchBytes: 64 * 1024,
    mode: 'create',
  };
  store = await VectorStore.open(options);
  return options;
}
afterEach(async () => {
  mock.restoreAll();
  await store?.close();
  store = undefined;
  await temporary?.cleanup();
  temporary = undefined;
  environment.restore();
});

describe('embedding source admission and recovery', () => {
  it('drops the optional source cache when an admitted unit needs its remaining bytes', async () => {
    const options = await setup();
    const text = 'class Sample { value = 1; }';
    await fs.writeFile(path.join(options.directory, 'source.ts'), text);
    const content = text.padEnd(20_000, ' ');
    const nodes: EmbeddableNode[] = Array.from({ length: 16 }, (_, i) => ({
      id: `Class:source.ts:n${String(i).padStart(2, '0')}`,
      label: 'Class',
      name: 'Sample',
      filePath: 'source.ts',
      content,
      startLine: 0,
      endLine: 0,
    }));
    const source = {
      async *scan(label: string) {
        if (label !== 'Class') return;
        for (const node of nodes)
          yield { id: node.id, contentBytes: Buffer.byteLength(content), metadataBytes: 1024 };
      },
      async fetch(_label: string, ids: readonly string[]) {
        return nodes.filter((node) => ids.includes(node.id));
      },
    };
    const manifest = await createEmbeddingWorkManifest(options.directory, 'source', source);
    expect(manifest.totalUnits).toBe(1);
    const journal = await EmbeddingJobJournal.create(options.directory, options.identity, manifest);
    const provider = mock.fn(async (texts: string[]) =>
      texts.map(() => new Float32Array([1, 0, 0, 0])),
    );
    const queueBytes = 1121 * 1024;
    const result = await runEmbeddingJob({
      directory: options.directory,
      manifest,
      source,
      journal,
      store,
      provider,
      queueBytes,
      config: { subBatchSize: 8, maxInputChars: 256 },
      sourceContext: {
        repoPath: options.directory,
        fileHashes: { 'source.ts': createHash('sha256').update(text).digest('hex') },
        contentRetention: 'full',
      },
    });
    expect(result.state).toMatchObject({ completedNodes: 16, failedNodes: 0, phase: 'indexing' });
    expect(result.peakQueueBytes).toBeLessThanOrEqual(queueBytes);
    expect((await store.completedNodes(nodes.map((node) => node.id))).size).toBe(16);
    expect(provider.mock.callCount()).toBeGreaterThan(0);
  });

  registerCases(
    it,
    ['input rejection', 'storage failure'],
    'preserves source-admission abort recovery and errors (%s)',
    async (failure) => {
      const options = await setup();
      const content = 'function tail() { return 7; }\n//' + ' '.repeat(100_000);
      await fs.writeFile(path.join(options.directory, 'source.ts'), content);
      const nodes: EmbeddableNode[] = Array.from({ length: 7 }, (_, i) => ({
        id: `Function:source.ts:n${i}`,
        label: 'Function',
        name: `n${i}`,
        filePath: 'source.ts',
        content: i === 6 ? 'function tail() ... [truncated]' : `function n${i}() { return ${i}; }`,
        startLine: 0,
        endLine: 0,
      }));
      const source = {
        async *scan(label: string) {
          if (label !== 'Function') return;
          for (const node of nodes)
            yield {
              id: node.id,
              contentBytes: Buffer.byteLength(node.content),
              metadataBytes: 1024,
            };
        },
        async fetch(_label: string, ids: readonly string[]) {
          return nodes.filter((node) => ids.includes(node.id));
        },
      };
      const manifest = await createEmbeddingWorkManifest(options.directory, 'source', source);
      const paid: string[] = [];
      const provider = mock.fn(async (texts: string[]) => {
        if (texts.some((text) => /function n[1-5]\(/.test(text)))
          throw new HttpEmbeddingError('bad input', { status: 422 });
        paid.push(...texts);
        return texts.map(() => new Float32Array([1, 0, 0, 0]));
      });
      let journal = await EmbeddingJobJournal.create(options.directory, options.identity, manifest);
      const run = () =>
        runEmbeddingJob({
          directory: options.directory,
          manifest,
          source,
          journal,
          store,
          provider,
          queueBytes: 2 * 1024 ** 2,
          config: { subBatchSize: 8, maxInputChars: 1024 },
          sourceContext: {
            repoPath: options.directory,
            fileHashes: { 'source.ts': createHash('sha256').update(content).digest('hex') },
            contentRetention: 'full',
          },
        });
      if (failure === 'storage failure') {
        mock.method(
          store,
          'appendBatch',
          async () => {
            throw new Error('injected vector write failure');
          },
          { times: 1 },
        );
        await expect(run()).rejects.toThrow('injected vector write failure');
        expect(journal.snapshot().active).not.toBeNull();
        expect((await store.completedNodes([nodes[0].id])).size).toBe(0);
        return;
      }
      for (let attempt = 1; attempt <= 3; attempt++) {
        await expect(run()).rejects.toThrow('five nodes without a success');
        expect((await store.completedNodes([nodes[0].id])).size).toBe(1);
        await store.close();
        store = await VectorStore.open({ ...options, mode: 'resume' });
        journal = await EmbeddingJobJournal.open(options.directory, options.identity, manifest);
        const failed = [];
        for await (const unit of journal.failed()) failed.push(unit);
        expect(failed).toHaveLength(1);
        expect(Object.values(failed[0].inputFailures ?? {})).toEqual(Array(5).fill(attempt));
      }
      expect(paid).toHaveLength(1);
      const result = await run();
      expect(result.state).toMatchObject({ excludedNodes: 5, reusedNodes: 1, completedNodes: 1 });
      expect(paid).toHaveLength(2);
      expect(paid[1]).toContain('function tail');
    },
  );
});
