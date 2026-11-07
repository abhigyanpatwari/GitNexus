import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { saveMeta, loadMeta } from '../../src/storage/repo-manager.js';
import { VectorStore } from '../../src/core/lbug/vector-store.js';

const execute = promisify(execFile);
const helper = fileURLToPath(new URL('../helpers/embedding-restart-runner.mjs', import.meta.url));
const boundaries = [
  'intent-before',
  'intent-after',
  'appendBatch-before',
  'appendBatch-after',
  'checkpointUnit-before',
  'checkpointUnit-after',
  'cursor-before',
  'cursor-after',
  'seal-after',
  'pointer-after',
] as const;

it.each(boundaries)(
  'resumes a real process exit at %s without replaying acknowledged inputs',
  async (boundary) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-vector-restart-'));
    const env = {
      ...process.env,
      GITNEXUS_HOME: path.join(root, 'home'),
      GITNEXUS_SHARED_STORE: 'off',
      GITNEXUS_LBUG_EXTENSION_INSTALL: 'never',
      GITNEXUS_WAL_CHECKPOINT_THRESHOLD: String(64 * 1024 ** 2),
    };
    let store: VectorStore | undefined;
    try {
      await saveMeta(root, {
        repoPath: root,
        lastCommit: 'fixture',
        indexedAt: 'fixture',
        graphPath: `lbug.generation.${'a'.repeat(32)}`,
        graphGeneration: { version: 1, id: 'a'.repeat(32), coveredContent: 'b'.repeat(64) },
        schemaFingerprint: 'fixture',
        parseCacheIdentity: { base: 'fixture' },
        scopeExtractionReceipt: 1,
        runnerIdentity: {
          schemaVersion: 4,
          cliVersion: 'fixture',
          runtime: {
            executablePath: process.execPath,
            version: process.version,
            platform: process.platform,
            architecture: process.arch,
            modulesAbi: process.versions.modules,
            libc: 'fixture',
          },
          invokedArtifact: { path: helper, digest: 'fixture' },
          build: {
            kind: 'distribution',
            rootPath: root,
            canonicalization: 'gitnexus-analyzer-build-v2',
            digest: 'fixture',
          },
          dependencyRuntime: {
            manifestPath: 'package.json',
            lockfilePath: null,
            canonicalization: 'gitnexus-analyzer-dependency-runtime-v4',
            packageCount: 1,
            artifactCount: 1,
            digest: 'fixture',
          },
        },
      });
      const stopped = await execute(process.execPath, [helper, root, boundary], { env }).then(
        () => ({ code: 0, stderr: '' }),
        (error: NodeJS.ErrnoException & { stderr?: string }) => error,
      );
      expect(stopped.code, stopped.stderr).toBe(73);
      if (boundary === 'checkpointUnit-after' || boundary === 'cursor-after') {
        // Prove recovery uses committed WAL, not a clean close or a forced
        // database checkpoint that could hide missing transaction durability.
        const pending = (await loadMeta(root))?.embeddingJob;
        if (!pending) throw new Error('Missing interrupted embedding job');
        const wal = path.join(
          root,
          'embeddings',
          pending.artifactIdentity ?? pending.identity,
          'vectors.wal',
        );
        expect((await fs.stat(wal)).size).toBeGreaterThan(0);
      }
      await execute(process.execPath, [helper, root, 'resume'], { env });
      const readInputs = async (
        phase: string,
      ): Promise<Array<{ node: string | null; hash: string }>> => {
        const text = await fs
          .readFile(path.join(root, `${phase}.inputs.jsonl`), 'utf8')
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return '';
            throw error;
          });
        return text
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      };
      const first = await readInputs(boundary);
      const resumed = await readInputs('resume');
      expect(resumed.every(({ node }) => node === null || Number(node.slice(1)) >= 64)).toBe(true);
      if (boundary === 'seal-after' || boundary === 'pointer-after') expect(resumed).toEqual([]);
      const paid = new Map<string, { node: string | null; count: number }>();
      for (const input of [...first, ...resumed]) {
        const entry = paid.get(input.hash) ?? { node: input.node, count: 0 };
        entry.count++;
        paid.set(input.hash, entry);
      }
      expect(
        new Set([...paid.values()].map(({ node }) => node).filter((node) => node !== null)),
      ).toEqual(
        new Set(Array.from({ length: 130 }, (_, index) => `n${String(index).padStart(5, '0')}`)),
      );
      for (const { node, count } of paid.values()) {
        // Only n00064 has interior slices without a name, all in the active unit.
        const mayReplay =
          node === null || (Number(node.slice(1)) >= 64 && Number(node.slice(1)) < 128);
        expect(count).toBeLessThanOrEqual(mayReplay ? 2 : 1);
      }
      const metadata = await loadMeta(root);
      const generation = metadata?.vectorGeneration;
      if (!generation) throw new Error('Restart did not publish vectors');
      expect(metadata.embeddingJob).toBeUndefined();
      expect(generation.nodes).toBe(130);
      store = await VectorStore.open({
        directory: path.join(
          root,
          'embeddings',
          generation.artifactIdentity ?? generation.identity,
        ),
        identity: generation.artifactIdentity ?? generation.identity,
        dimensions: 4,
        mode: 'read',
        bufferPoolBytes: 64 * 1024 ** 2,
        threads: 1,
        batchBytes: 64 * 1024,
      });
      let totalChunks = 0;
      for (let offset = 0; offset < 130; offset += 64) {
        const ids = Array.from(
          { length: Math.min(64, 130 - offset) },
          (_, index) => `Function:a.ts:n${String(offset + index).padStart(5, '0')}`,
        );
        const complete = await store.completedNodes(ids);
        expect(complete.size).toBe(ids.length);
        for (const [id, receipt] of complete) {
          const chunks = await store.readChunks(receipt, 0, receipt.chunks);
          expect(chunks.map(({ chunkIndex }) => chunkIndex)).toEqual(
            Array.from({ length: receipt.chunks }, (_, index) => index),
          );
          if (id.endsWith('n00064')) expect(chunks.length).toBeGreaterThan(1);
          totalChunks += chunks.length;
        }
      }
      expect(totalChunks).toBe(generation.chunks);
    } finally {
      await store?.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);
