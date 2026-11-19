/**
 * Language gating of R's post-parse work.
 *
 * R's package-config walk (`DESCRIPTION`/`NAMESPACE` discovery) and its whole-graph owner attach are
 * language-specific work. Shared pipeline code must not run them for a repo that has no R files:
 * a non-R repo pays nothing (no directory walk, no manifest read).
 *
 * Observation point: `node:fs/promises` `open` (manifests are read through one opened handle). `loadRPackageConfig` imports the module's default
 * export, so a spy on that object sees the loader wherever it lives (before or after it moves into
 * `languages/r/`). A depth-3 `DESCRIPTION` decoy makes the walk observable: reading it is impossible
 * without the breadth-first search reaching it.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { runPipelineFromRepo, writeFixtureRepo } from './resolvers/helpers.js';
import { cleanupTempDirSync } from '../helpers/test-db.js';
import { rProvider } from '../../src/core/ingestion/languages/r.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { runChunkedParseAndResolve } from '../../src/core/ingestion/pipeline-phases/parse-impl.js';
import {
  emptyParseCache,
  loadParseCache,
  saveParseCache,
  type ParseCache,
} from '../../src/storage/parse-cache.js';
import { TEST_PARSE_IDENTITY } from '../helpers/cache-identity.js';

const MANIFEST = /[\\/](DESCRIPTION|NAMESPACE)$/;

const roots: string[] = [];
const makeRepo = (files: Record<string, string>): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-r-post-parse-gating-'));
  roots.push(root);
  writeFixtureRepo(root, files);
  return root;
};

const DECOYS = {
  DESCRIPTION: 'Package: decoy\nVersion: 0.0.1\n',
  NAMESPACE: 'export(f)\n',
  'pkg/sub/deep/DESCRIPTION': 'Package: deepdecoy\nVersion: 0.0.1\n',
  'pkg/sub/deep/NAMESPACE': 'export(g)\n',
};

const manifestReads = (spy: { mock: { calls: unknown[][] } }): string[] =>
  spy.mock.calls
    .map((args) => String(args[0]))
    .filter((p) => MANIFEST.test(p))
    .map((p) => p.replace(/\\/g, '/'));

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  for (const root of roots) cleanupTempDirSync(root);
});

// Cold worker-pool startups otherwise flake against the 5s default ready budget
// on a loaded runner, failing for reasons unrelated to R parsing or resolution.
// Safe under `pool: 'forks'`: the env stub is process-global, but each file gets its own process.
beforeAll(() => vi.stubEnv('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000'));
afterAll(() => vi.unstubAllEnvs());

describe('R post-parse gating', () => {
  // R's package-config walk runs inside `LanguageProvider.postParse`, which the parse phase calls only
  // for languages with parsed files, so a repo with no R files never reads a manifest.
  it('a non-R repo with DESCRIPTION/NAMESPACE decoys never reads a manifest', async () => {
    const root = makeRepo({ 'src/main.py': 'def main():\n    return 1\n', ...DECOYS });
    const open = vi.spyOn(fsp, 'open');

    await runPipelineFromRepo(root, () => {});

    expect(manifestReads(open)).toEqual([]);
  }, 60000);

  it('rProvider.postParse is never invoked for a non-R repo and once for an R repo', async () => {
    const postParse = vi.spyOn(rProvider, 'postParse');

    await runPipelineFromRepo(
      makeRepo({ 'src/main.py': 'def main():\n    return 1\n', ...DECOYS }),
      () => {},
    );
    expect(postParse).toHaveBeenCalledTimes(0);

    await runPipelineFromRepo(makeRepo({ 'R/a.R': 'f <- function() 1\n', ...DECOYS }), () => {});
    expect(postParse).toHaveBeenCalledTimes(1);
  }, 120000);

  it('collects exported types after refining R package visibility in a mixed repo', async () => {
    const sources = {
      'R/types.R': [
        'Box <- R6Class("Box", public=list(counter=1L))',
        'Slot <- setClass("Slot", slots=c(value="numeric"))',
      ].join('\n'),
      'src/other.ts': 'export function message(): string { return "ok" }',
    };
    const root = makeRepo({
      ...sources,
      DESCRIPTION: 'Package: testpkg\n',
      NAMESPACE: 'export(Box)\n',
    });
    const scanned = Object.entries(sources).map(([path, source]) => ({
      path,
      size: Buffer.byteLength(source),
    }));
    const storage = makeRepo({});
    const stage = () => fs.mkdtempSync(path.join(storage, 'stage-'));
    const cache = emptyParseCache(TEST_PARSE_IDENTITY, {
      storagePath: storage,
      writeStoragePath: stage(),
    });
    const parse = (parseCache: ParseCache) =>
      runChunkedParseAndResolve(
        createKnowledgeGraph(),
        scanned,
        Object.keys(sources),
        scanned.length,
        root,
        Date.now(),
        () => {},
        { parseCache, workerPoolSize: 1 },
      );
    const cold = await parse(cache);
    await saveParseCache(storage, cache);
    const warm = await parse(await loadParseCache(storage, TEST_PARSE_IDENTITY, stage()));
    expect(cold.reparsedFileCount).toBe(scanned.length);
    expect(warm.reparsedFileCount).toBe(0);

    for (const { exportedTypeMap } of [cold, warm]) {
      expect(exportedTypeMap.get('src/other.ts')?.get('message')).toBe('string');
      expect(exportedTypeMap.get('R/types.R')?.has('counter')).toBeFalsy();
      expect(exportedTypeMap.get('R/types.R')?.has('value')).toBeFalsy();
    }
  }, 60000);

  it('control: an R repo with the same layout reads the root DESCRIPTION (the spy sees the loader)', async () => {
    const root = makeRepo({ 'R/a.R': 'f <- function() 1\n', ...DECOYS });
    const open = vi.spyOn(fsp, 'open');

    await runPipelineFromRepo(root, () => {});

    const reads = manifestReads(open);
    expect(reads.some((p) => p === path.join(root, 'DESCRIPTION').replace(/\\/g, '/'))).toBe(true);
  }, 60000);
});
