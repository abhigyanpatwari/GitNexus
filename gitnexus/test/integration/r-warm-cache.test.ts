/**
 * R: a second run answered from the durable parse cache builds the same graph.
 *
 * Every other R integration test is a cold run. The deferred-owner pass (`ownerId`,
 * HAS_METHOD / HAS_PROPERTY) and the NAMESPACE export refinement (`isExported`) are the two
 * post-parse steps that change the merged graph, and on a warm run they work from cached
 * parsed files with no worker. This compares a warm run with a cold one, element by element,
 * and pins the shape the comparison stands on so that two equally empty graphs cannot pass.
 *
 * Needs the compiled worker (`dist/`); locally the suite skips without it.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  FIXTURES,
  getRelationships,
  runPipelineFromRepo,
  type PipelineResult,
} from './resolvers/helpers.js';
import { createTempDirPool } from '../helpers/temp-dir-pool.js';
import { runtimeParseIdentity } from '../helpers/runtime-parse-identity.js';
import {
  loadParseCache,
  pruneCache,
  saveParseCache,
  type ParseCache,
} from '../../src/storage/parse-cache.js';
import {
  getDurableParsedFileDir,
  pruneAndSaveDurableParsedFileStore,
} from '../../src/storage/parsedfile-store.js';

const parseIdentity = await runtimeParseIdentity();
const DIST_WORKER = path.resolve(
  __dirname,
  '..',
  '..',
  'dist',
  'core',
  'ingestion',
  'workers',
  'parse-worker.js',
);
const hasDistWorker = fs.existsSync(DIST_WORKER);
if (!hasDistWorker && process.env.CI) {
  throw new Error(
    'dist/parse-worker.js missing on CI: the R warm-cache test would silently skip. ' +
      'Ensure the build runs before this suite.',
  );
}

const pool = createTempDirPool('gn-r-warm-');

interface Runs {
  readonly cold: PipelineResult;
  readonly warm: PipelineResult;
}

/** Analyse a copy of `fixture` cold with a fresh durable cache, save it, then analyse again warm. */
async function coldThenWarm(fixture: string): Promise<Runs> {
  const repoRoot = pool.fromFixture(path.join(FIXTURES, fixture));
  const storage = pool.dir();
  const coldCache: ParseCache = {
    identity: parseIdentity,
    entries: new Map(),
    usedKeys: new Set(),
    storagePath: storage,
    writeStoragePath: storage,
    onDiskKeys: new Set(),
  };
  const cold = await runPipelineFromRepo(repoRoot, () => undefined, {
    skipGraphPhases: true,
    parseCache: coldCache,
    workerPoolSize: 1,
  });
  pruneCache(coldCache, coldCache.usedKeys);
  const savedKeys = await saveParseCache(storage, coldCache);
  await pruneAndSaveDurableParsedFileStore(
    getDurableParsedFileDir(storage),
    parseIdentity.base,
    new Set(savedKeys),
  );
  const warmCache = await loadParseCache(storage, parseIdentity, storage);
  const warm = await runPipelineFromRepo(repoRoot, () => undefined, {
    skipGraphPhases: true,
    parseCache: warmCache ?? undefined,
    workerPoolSize: 1,
  });
  return { cold, warm };
}

/** Every definition node with the properties the post-parse passes write. */
function definitions(result: PipelineResult): string[] {
  const out: string[] = [];
  result.graph.forEachNode((n) => {
    if (!['Function', 'Class', 'Method', 'Property'].includes(n.label)) return;
    const owner = n.properties.ownerId === undefined ? '-' : String(n.properties.ownerId);
    out.push(
      `${n.label}|${n.properties.filePath}|${n.properties.name}|exported=${String(
        n.properties.isExported,
      )}|owner=${owner}`,
    );
  });
  return out.sort();
}

function edges(result: PipelineResult, types: readonly string[]): string[] {
  return types
    .flatMap((type) => getRelationships(result, type))
    .map(
      (e) =>
        `${e.rel.type}|${e.rel.sourceId}|${e.rel.targetId}|${e.rel.reason}|${e.rel.confidence}`,
    )
    .sort();
}

describe.skipIf(!hasDistWorker)('R warm durable cache (r-packages)', () => {
  let runs: Runs;
  beforeAll(async () => {
    vi.stubEnv('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000');
    runs = await coldThenWarm('r-packages');
  }, 120_000);

  it('really was answered from the cache, without a worker pool', () => {
    expect(runs.cold.usedWorkerPool).toBe(true);
    expect(runs.warm.usedWorkerPool).toBe(false);
  });

  it('keeps the owner of every R6 / RefClass / S4 member, and exactly the members of a cold run', () => {
    const owned = (r: PipelineResult) =>
      edges(r, ['HAS_METHOD', 'HAS_PROPERTY']).map((e) => e.split('|').slice(0, 3).join('|'));
    expect(owned(runs.warm)).toEqual(owned(runs.cold));
    expect(getRelationships(runs.warm, 'HAS_METHOD')).toHaveLength(11);
    expect(getRelationships(runs.warm, 'HAS_PROPERTY')).toHaveLength(12);
  });

  it('stamps ownerId on the 23 members, with the owning class node id', () => {
    const members: { id: string; owner: unknown }[] = [];
    runs.warm.graph.forEachNode((n) => {
      if (n.label === 'Method' || n.label === 'Property') {
        members.push({ id: n.id, owner: n.properties.ownerId });
      }
    });
    const owners = members.filter((m) => typeof m.owner === 'string');
    expect(owners).toHaveLength(23);
    for (const m of owners) {
      expect(runs.warm.graph.getNode(String(m.owner))?.label, m.id).toBe('Class');
    }
  });

  it('keeps isExported and ownerId on every definition identical to the cold run', () => {
    const cold = definitions(runs.cold);
    expect(definitions(runs.warm)).toEqual(cold);
    // The comparison stands on both values being present.
    expect(cold.some((d) => d.includes('exported=false'))).toBe(true);
    expect(cold.some((d) => d.includes('exported=true'))).toBe(true);
    expect(cold.some((d) => !d.endsWith('owner=-'))).toBe(true);
  });

  it('builds the same CALLS, EXTENDS and IMPORTS edges, reasons and confidences', () => {
    const types = ['CALLS', 'EXTENDS', 'IMPORTS'];
    const cold = edges(runs.cold, types);
    expect(edges(runs.warm, types)).toEqual(cold);
    expect(cold.length).toBeGreaterThan(10);
  });
});

describe.skipIf(!hasDistWorker)('R warm durable cache (r-package-layout)', () => {
  let runs: Runs;
  beforeAll(async () => {
    vi.stubEnv('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000');
    runs = await coldThenWarm('r-package-layout');
  }, 120_000);

  it('answers from the cache and keeps the NAMESPACE verdicts', () => {
    expect(runs.warm.usedWorkerPool).toBe(false);
    const warm = definitions(runs.warm);
    expect(warm).toEqual(definitions(runs.cold));
    expect(warm).toContain('Function|R/root.R|root_exported|exported=true|owner=-');
    expect(warm).toContain('Function|R/root.R|root_hidden|exported=false|owner=-');
    expect(warm).toContain('Function|pkgs/nested/R/nested.R|nested_hidden|exported=false|owner=-');
  });

  it('keeps the CALLS edges from tests/ and scripts/ into the package', () => {
    const types = ['CALLS'];
    expect(edges(runs.warm, types)).toEqual(edges(runs.cold, types));
    expect(edges(runs.warm, types)).toHaveLength(5);
  });
});
