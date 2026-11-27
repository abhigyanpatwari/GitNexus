import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadParseCache, pruneCache, saveParseCache } from '../../src/storage/parse-cache.js';
import {
  getDurableParsedFileDir,
  pruneAndSaveDurableParsedFileStore,
} from '../../src/storage/parsedfile-store.js';
import { runtimeParseIdentity } from '../helpers/runtime-parse-identity.js';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

const fixture = fileURLToPath(new URL('../fixtures/fastapi-resource-lifetime/', import.meta.url));

describe('Python dependency resource lifetimes', () => {
  let graph: Awaited<ReturnType<typeof runPipelineFromRepo>>['graph'];

  beforeAll(async () => {
    ({ graph } = await runPipelineFromRepo(fixture, () => {}, {}));
  }, 120_000);

  function targets(source: string, type: string) {
    const owner = graph.nodes.find((n) => n.properties.name === source && n.label === 'Function');
    if (!owner) throw new Error(`Missing fixture function ${source}`);
    return graph.relationships
      .filter((edge) => edge.sourceId === owner.id && edge.type === type)
      .map((edge) => {
        const target = graph.getNode(edge.targetId);
        if (!target) throw new Error(`Missing target ${edge.targetId}`);
        return target;
      });
  }

  it('lets a reader follow the handler to the provider, binding, and explicit cleanup site', () => {
    expect(targets('studies', 'CALLS').map((n) => n.properties.name)).toContain('request_session');
    const resources = targets('request_session', 'OWNS_RESOURCE');
    expect(resources.map((n) => n.properties.name)).toEqual(['session']);
    expect(resources[0].properties.startLine).toBe(4);
    const closes = graph.relationships.filter(
      (edge) => edge.sourceId === resources[0].id && edge.type === 'CLEANUP_AT',
    );
    expect(closes).toHaveLength(1);
    expect(graph.getNode(closes[0].targetId)?.properties).toMatchObject({
      filePath: 'database.py',
      startLine: 8,
      endLine: 8,
    });
  });

  it('records the context-manager exit for a yielded binding', () => {
    const resources = targets('managed_session', 'MANAGES_CONTEXT');
    expect(resources.map((n) => n.properties.name)).toEqual(['open_session']);
    expect(targets('managed_session', 'OWNS_RESOURCE')).toEqual([]);
    const exit = graph.relationships.find(
      (edge) => edge.sourceId === resources[0].id && edge.type === 'CLEANUP_AT',
    );
    if (!exit) throw new Error('Missing context-manager exit');
    expect(exit.reason).toBe('context-manager exit');
    expect(graph.getNode(exit.targetId)?.properties).toMatchObject({ startLine: 12, endLine: 13 });
  });

  it('leaves opaque factory returns and cleanup of a different binding unknown', () => {
    expect(targets('borrowed_session', 'OWNS_RESOURCE')).toEqual([]);
    expect(targets('unrelated_cleanup', 'OWNS_RESOURCE')).toEqual([]);
    expect(targets('studies', 'OWNS_RESOURCE')).toEqual([]);
    expect(targets('conditional_cleanup', 'OWNS_RESOURCE')).toEqual([]);
  });
});

it('recovers the same lifetime facts from the durable parse cache', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gitnexus-resource-lifetime-'));
  try {
    const identity = await runtimeParseIdentity();
    const cache = await loadParseCache(dir, identity, dir);
    const cold = await runPipelineFromRepo(fixture, () => {}, {
      parseCache: cache,
      workerPoolSize: 1,
    });
    expect(cold.usedWorkerPool).toBe(true);
    pruneCache(cache, cache.usedKeys);
    const keys = await saveParseCache(dir, cache);
    await pruneAndSaveDurableParsedFileStore(
      getDurableParsedFileDir(dir),
      identity.base,
      new Set(keys),
    );
    const warm = await runPipelineFromRepo(fixture, () => {}, {
      parseCache: await loadParseCache(dir, identity, dir),
      workerPoolSize: 1,
    });
    expect(warm.usedWorkerPool).toBe(false);
    const facts = (result: typeof cold) =>
      result.graph.relationships
        .filter((r) => ['OWNS_RESOURCE', 'MANAGES_CONTEXT', 'CLEANUP_AT'].includes(r.type))
        .map((r) => r.id)
        .sort();
    expect(facts(cold)).toHaveLength(4);
    expect(facts(warm)).toEqual(facts(cold));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);
