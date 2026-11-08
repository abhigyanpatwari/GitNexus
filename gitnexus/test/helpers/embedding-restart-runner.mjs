// Exit at JS-visible boundaries after native promises settle. Never kill a
// worker or interrupt a native call; omit cleanup to exercise process recovery.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runPublishedEmbeddingJob } from '../../dist/core/embeddings/embedding-job.js';
import { VectorStore } from '../../dist/core/lbug/vector-store.js';
import { EmbeddingJobJournal } from '../../dist/storage/embedding-job-journal.js';
import { loadMeta, saveMeta } from '../../dist/storage/repo-manager.js';

const [root, boundary] = process.argv.slice(2);
const crash = () => process.exit(73);
const secondUnit = (rows) => rows.some((row) => row.nodeId === 'Function:a.ts:n00064');
const begin = EmbeddingJobJournal.prototype.begin;
EmbeddingJobJournal.prototype.begin = async function (intent) {
  if (intent.start.unit === 1 && boundary === 'intent-before') crash();
  await begin.call(this, intent);
  if (intent.start.unit === 1 && boundary === 'intent-after') crash();
};
for (const method of ['appendBatch', 'checkpointUnit']) {
  const original = VectorStore.prototype[method];
  VectorStore.prototype[method] = async function (rows) {
    const selected = secondUnit(rows);
    if (selected && boundary === `${method}-before`) crash();
    const result = await original.call(this, rows);
    if (selected && boundary === `${method}-after`) crash();
    return result;
  };
}
const acknowledge = EmbeddingJobJournal.prototype.acknowledge;
EmbeddingJobJournal.prototype.acknowledge = async function (result) {
  const selected = this.snapshot().active?.start.unit === 1;
  if (selected && boundary === 'cursor-before') crash();
  await acknowledge.call(this, result);
  if (selected && boundary === 'cursor-after') crash();
};
const seal = VectorStore.prototype.seal;
VectorStore.prototype.seal = async function (...args) {
  const result = await seal.apply(this, args);
  if (boundary === 'seal-after') crash();
  return result;
};

const nodes = Array.from({ length: 130 }, (_, index) => {
  const name = `n${String(index).padStart(5, '0')}`;
  const body =
    index === 64
      ? Array.from({ length: 40 }, (_, line) => `  const value${line} = "漢😀";`).join('\n')
      : '  return 1;';
  const content = `export function ${name}() {\n${body}\n}`;
  return {
    id: `Function:a.ts:${name}`,
    name,
    label: 'Function',
    filePath: 'a.ts',
    content,
    startLine: 1,
    endLine: content.split('\n').length,
  };
});
const byId = new Map(nodes.map((node) => [node.id, node]));
const result = await runPublishedEmbeddingJob(
  {
    metadataDirectory: root,
    graphPath: path.join(root, `lbug.generation.${'a'.repeat(32)}`),
    resources: {
      graphPoolBytes: 16 * 1024 ** 2,
      vectorPoolBytes: 64 * 1024 ** 2,
      modelBytes: 0,
      modelHeapMb: 0,
      queueBytes: 16 * 1024 ** 2,
      nativeThreads: 1,
      reservedBytes: 96 * 1024 ** 2,
    },
    config: { threads: 1, subBatchSize: 8, maxInputChars: 256 },
    metadata: {
      loadMetadata: () => loadMeta(root),
      saveMetadata: async (metadata) => {
        await saveMeta(root, metadata);
        if (metadata.vectorGeneration && boundary === 'pointer-after') crash();
      },
    },
  },
  {
    identity: () => ({ provider: 'local', model: 'restart-fixture', dimensions: 4 }),
    initializeProvider: async () => {},
    openSource: async () => ({
      async *scan(label) {
        if (label !== 'Function') return;
        for (const node of nodes)
          yield { id: node.id, contentBytes: Buffer.byteLength(node.content), metadataBytes: 1024 };
      },
      fetch: async (_label, ids) => ids.map((id) => byId.get(id)),
      close: async () => {},
    }),
    provider: async (texts) => {
      const inputs = texts.map((text) => {
        // Interior slices of the oversized node need not repeat its name.
        const node = text.match(/n\d{5}/)?.[0] ?? null;
        return { node, hash: createHash('sha256').update(text).digest('hex') };
      });
      await fs.appendFile(
        path.join(root, `${boundary}.inputs.jsonl`),
        inputs.map((input) => JSON.stringify(input) + '\n').join(''),
      );
      return texts.map(() => new Float32Array([1, 0, 0, 0]));
    },
  },
);
await fs.writeFile(path.join(root, `${boundary}.result.json`), JSON.stringify(result));
