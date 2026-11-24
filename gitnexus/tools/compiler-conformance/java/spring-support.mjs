import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKnowledgeGraph } from '../../../dist/core/graph/graph.js';
import * as database from '../../../dist/core/lbug/lbug-adapter.js';
import {
  initLbugWithDb,
  closeLbug as closePool,
  executeQuery,
  executeParameterized,
} from '../../../dist/core/lbug/pool-adapter.js';
import { resolveParseCacheIdentity } from '../../../dist/core/parse-cache-identity.js';
import { LocalBackend } from '../../../dist/mcp/local/local-backend.js';
import { registerRepo, saveMeta } from '../../../dist/storage/repo-manager.js';
import { createTempDir } from '../../../test/helpers/test-db.ts';

const fixtures = fileURLToPath(new URL('../../../test/fixtures/', import.meta.url));
export const FIXTURES = path.join(fixtures, 'lang-resolution');
export const springProject = (name) =>
  fileURLToPath(new URL(`./spring-projects/fixtures/${name}/`, import.meta.url));
export const springFixture = (name) => path.join(fixtures, 'java', name);

export async function runtimeParseIdentity() {
  const artifact = new URL('../../../dist/core/run-analyze.js', import.meta.url);
  const result = await resolveParseCacheIdentity(artifact.href);
  assert.ok(result.ok, result.reason);
  return result.identity;
}

export function writeFixtureRepo(directory, files) {
  for (const [relative, contents] of Object.entries(files)) {
    const name = path.join(directory, relative);
    fs.mkdirSync(path.dirname(name), { recursive: true });
    fs.writeFileSync(name, contents);
  }
}

export function getRelationships(result, type) {
  return [...result.graph.iterRelationshipsByType(type)].map((rel) => ({
    source: result.graph.getNode(rel.sourceId)?.properties.name ?? rel.sourceId,
    target: result.graph.getNode(rel.targetId)?.properties.name ?? rel.targetId,
    rel,
  }));
}

export function buildTestGraph(rows) {
  const graph = createKnowledgeGraph();
  for (const { id, label, extra, ...properties } of rows) {
    graph.addNode({ id, label, properties: { ...properties, ...extra } });
  }
  return graph;
}

export async function withGraphDatabase(name, verify) {
  const tmpHandle = await createTempDir('gitnexus-lbug-');
  const dbPath = path.join(tmpHandle.dbPath, 'lbug');
  try {
    await database.initLbug(dbPath);
    await verify({ dbPath, tmpHandle, repoId: name });
  } finally {
    try {
      await database.closeLbug();
    } finally {
      await tmpHandle.cleanup();
    }
  }
}

/** Exercise the same registry discovery and read-only MCP backend as the CLI. */
export async function withIndexedBackend(name, seed, verify) {
  const registry = await createTempDir('gitnexus-lbug-');
  const previous = process.env.GITNEXUS_HOME;
  process.env.GITNEXUS_HOME = registry.dbPath;
  try {
    await withGraphDatabase(name, async (handle) => {
      const storage = handle.tmpHandle.dbPath;
      const repo = path.join(registry.dbPath, 'repo');
      fs.mkdirSync(repo);
      const metadata = {
        repoPath: repo,
        storagePath: storage,
        indexedAt: new Date().toISOString(),
        lastCommit: '',
      };
      for (const statement of seed) await database.executeQuery(statement);
      await database.flushWAL();
      await saveMeta(storage, metadata);
      await registerRepo(repo, metadata, { name, storagePath: storage });
      await initLbugWithDb(name, database.getDatabase(), handle.dbPath);
      const backend = new LocalBackend();
      try {
        await backend.init();
        await verify(handle, backend);
      } finally {
        try {
          await backend.dispose();
        } finally {
          await closePool(name);
        }
      }
    });
  } finally {
    if (previous === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = previous;
    await registry.cleanup();
  }
}

export async function withPersistedGraph(name, root, graph, verify) {
  await withGraphDatabase(name, async ({ dbPath, tmpHandle }) => {
    await database.loadGraphToLbug(graph, root, tmpHandle.dbPath);
    await initLbugWithDb(name, database.getDatabase(), dbPath);
    try {
      const execute = (query, params) =>
        params ? executeParameterized(name, query, params) : executeQuery(name, query);
      await verify(execute);
    } finally {
      await closePool(name);
    }
  });
}
