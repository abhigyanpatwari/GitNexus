import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import lbug from '@ladybugdb/core';
import { expect, it, vi } from 'vitest';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { EMBEDDING_DIMS } from '../../src/core/lbug/schema.js';
import { getStoragePaths, listRegisteredRepos, loadMeta } from '../../src/storage/repo-manager.js';
import { createTempDir } from '../helpers/test-db.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

interface Row {
  id: string;
  nodeId: string;
  chunkIndex: number;
  hash: string;
}

// Each receipt uses a fresh native read-only handle after analyze has closed.
async function readRows(dbPath: string): Promise<Row[]> {
  const db = new lbug.Database(dbPath, 256 * 1024 * 1024, true, true);
  const conn = new lbug.Connection(db);
  try {
    const result = await conn.query(
      'MATCH (e:CodeEmbedding) RETURN e.id AS id, e.nodeId AS nodeId, e.chunkIndex AS chunkIndex, e.contentHash AS hash ORDER BY id',
    );
    if (Array.isArray(result)) throw new Error('Expected one result');
    try {
      return (await result.getAll()) as unknown as Row[];
    } finally {
      await result.close();
    }
  } finally {
    await conn.close();
    await db.close();
  }
}

it('reuses sibling vectors across dirty clone copies, shrinking chunks, retries and rebuilds (#3474)', async () => {
  const tmp = await createTempDir('gn-shared-embeddings-');
  const root = await fs.realpath(tmp.dbPath);
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  const submitted: string[] = [];
  const server = createServer(async (request, response) => {
    const pieces: Buffer[] = [];
    for await (const piece of request) pieces.push(Buffer.from(piece));
    const { input } = JSON.parse(Buffer.concat(pieces).toString()) as { input: string[] };
    submitted.push(...input);
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        data: input.map((_, index) => ({
          index,
          embedding: Array<number>(EMBEDDING_DIMS).fill(0.125),
        })),
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected loopback endpoint');
    vi.stubEnv('GITNEXUS_HOME', path.join(root, 'home'));
    vi.stubEnv('GITNEXUS_SHARED_STORE', '');
    vi.stubEnv('GITNEXUS_EMBEDDING_URL', `http://127.0.0.1:${address.port}`);
    vi.stubEnv('GITNEXUS_EMBEDDING_MODEL', 'shared-store-fixture');
    vi.stubEnv('GITNEXUS_LBUG_EXTENSION_INSTALL', 'auto');
    await fs.mkdir(first);
    git(first, 'init', '-q', '-b', 'main');
    git(first, 'remote', 'add', 'origin', 'https://example.invalid/shared/embeddings.git');
    for (let i = 0; i < 12; i++) {
      const body =
        i === 0
          ? Array.from({ length: 100 }, (_, n) => `  console.log('original line ${n}');`).join('\n')
          : `  return 'healthy ${i}';`;
      await fs.writeFile(
        path.join(first, `source${i}.ts`),
        `export function item${i}() {\n${body}\n}\n`,
      );
    }
    git(first, 'add', '-A');
    git(first, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture');
    git(root, 'clone', '-q', first, second);
    git(second, 'remote', 'set-url', 'origin', 'https://example.invalid/shared/embeddings.git');
    const logs: string[] = [];
    const analyze = (repo: string, force = false) =>
      runFullAnalysis(
        repo,
        {
          embeddings: true,
          embeddingsNodeLimit: 0,
          force,
          skipAgentsMd: true,
          skipSkills: true,
        },
        { onProgress: () => {}, onLog: (message) => logs.push(message) },
      );
    const graph = async (repo: string) => {
      const registration = (await listRegisteredRepos()).find((entry) => entry.path === repo);
      expect(registration).toBeDefined();
      return getStoragePaths(repo, undefined, registration!.storagePath);
    };
    await analyze(first);
    const before = await readRows((await graph(first)).lbugPath);
    expect(new Set(before.map((row) => row.nodeId)).size).toBe(12);
    expect(
      before.filter((row) => row.nodeId === 'Function:source0.ts:item0').length,
    ).toBeGreaterThan(1);
    submitted.length = 0;
    await analyze(second); // Establish the shared store from two standalone clones.
    submitted.length = 0;
    await analyze(first); // Both members now point at the same immutable commit graph.
    expect((await graph(first)).lbugPath).toBe((await graph(second)).lbugPath);
    expect(submitted, logs.join('\n')).toEqual([]);

    await fs.writeFile(
      path.join(second, 'source0.ts'),
      "export function item0() { return 'changed'; }\n",
    );
    logs.length = 0;
    await analyze(second);
    expect(
      logs.some((message) => message.startsWith('Shared store: copied the shared graph')),
    ).toBe(true);
    expect(logs.some((message) => message.startsWith('Incremental:'))).toBe(true);
    expect(submitted.length).toBeGreaterThan(0);
    expect(submitted.every((text) => text.includes('source0.ts'))).toBe(true);
    const changedGraph = await graph(second);
    const after = await readRows(changedGraph.lbugPath);
    expect(after.filter((row) => row.nodeId === 'Function:source0.ts:item0')).toHaveLength(1);
    expect(after.filter((row) => row.nodeId !== 'Function:source0.ts:item0')).toEqual(
      before.filter((row) => row.nodeId !== 'Function:source0.ts:item0'),
    );
    expect(new Set(after.map((row) => row.id)).size).toBe(after.length);
    expect(await readRows((await graph(first)).lbugPath)).toEqual(before);
    expect((await loadMeta(changedGraph.storagePath))?.embeddingCheckpoint).toBeUndefined();

    submitted.length = 0;
    await analyze(second);
    await analyze(second, true);
    expect(submitted).toEqual([]);
    expect(await readRows((await graph(second)).lbugPath)).toEqual(after);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    vi.unstubAllEnvs();
    await tmp.cleanup();
  }
}, 240_000);
