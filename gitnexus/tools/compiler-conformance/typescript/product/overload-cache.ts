import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runtimeParseIdentity } from '../../../../test/helpers/runtime-parse-identity.js';
import {
  loadParseCache,
  pruneCache,
  saveParseCache,
  type ParseCache,
} from '../../../../src/storage/parse-cache.js';
import {
  getDurableParsedFileDir,
  pruneAndSaveDurableParsedFileStore,
} from '../../../../src/storage/parsedfile-store.js';
import { compareProject } from '../check.mjs';

test('the persisted parse cache retains the selected TypeScript overload for each call', async (t) => {
  const root = path.resolve(
    import.meta.dirname,
    '../../../../test/fixtures/compiler-conformance/typescript-overload-scopes',
  );
  const storage = await mkdtemp(path.join(os.tmpdir(), 'gitnexus-ts-overloads-'));
  t.after(() => rm(storage, { recursive: true, force: true }));
  const identity = await runtimeParseIdentity();
  const cache: ParseCache = {
    identity,
    storagePath: storage,
    writeStoragePath: storage,
    entries: new Map(),
    usedKeys: new Set(),
    onDiskKeys: new Set(),
  };
  const cold = await compareProject(root, { parseCache: cache, workerPoolSize: 1 });
  assert.equal(cold.pipeline.usedWorkerPool, true);
  assert.equal(cold.counts.CALLS, 3);
  pruneCache(cache, cache.usedKeys);
  const keys = await saveParseCache(storage, cache);
  await pruneAndSaveDurableParsedFileStore(
    getDurableParsedFileDir(storage),
    identity.base,
    new Set(keys),
  );
  const restored = await loadParseCache(storage, identity, storage);
  assert.ok(restored);
  const warm = await compareProject(root, { parseCache: restored, workerPoolSize: 1 });
  assert.equal(warm.pipeline.usedWorkerPool, false);
  assert.equal(warm.counts.CALLS, 3);
});
