/** Parser cache publication shared by an in-process writer and its exit supervisor. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  loadParseCache,
  persistParseCacheChunk,
  pruneCache,
  saveParseCache,
  type ParseCache,
} from '../storage/parse-cache.js';
import { mergeStagedDurableParsedFileStore } from '../storage/parsedfile-store.js';
import {
  embeddingJobDirectory,
  openEmbeddingJobFile,
  syncEmbeddingJobDirectory,
} from '../storage/embedding-job.js';
import { withStoreLock } from '../storage/shared-store-lifecycle.js';
import type { SharedStoreLayout } from '../storage/shared-store.js';
import type { RepoMeta } from '../storage/repo-meta.js';
import { listStoreMetaRoots } from './shared-store-analyze.js';

interface CachePublicationOptions {
  storagePath: string;
  metadataDirectory: string;
  cacheRoot: string;
  /** The exact published graph's handoff; never scan generation history. */
  publishedGeneration?: string;
  sharedStore?: SharedStoreLayout;
  collectBranchKeys: (
    root: string,
    exclude: string,
  ) => Promise<{ keys: Set<string>; complete: boolean }>;
  log: (message: string) => void;
}

/** Called only after graph publication, under the ordinary index lock. */
export async function publishAnalysisParseCache(
  cache: ParseCache,
  options: CachePublicationOptions,
): Promise<void> {
  const { storagePath, metadataDirectory, cacheRoot, sharedStore, collectBranchKeys, log } =
    options;
  const publish = async () => {
    const listing = sharedStore
      ? await listStoreMetaRoots(sharedStore)
      : { roots: [storagePath], complete: true };
    const siblingKeys = new Set<string>();
    let complete = listing.complete;
    for (const root of listing.roots) {
      const folded = await collectBranchKeys(root, metadataDirectory);
      for (const key of folded.keys) siblingKeys.add(key);
      if (!folded.complete) complete = false;
    }
    // Re-read inside the publication lock: another checkout can have saved
    // since parsing began. Metadata alone never admits an incompatible shard.
    const retained = await loadParseCache(
      cacheRoot,
      cache.identity,
      cache.writeStoragePath ?? cacheRoot,
    );
    cache.storagePath = cacheRoot;
    cache.onDiskKeys = new Set();
    for (const key of retained.onDiskKeys ?? []) {
      if (
        !cache.stagedKeys?.has(key) &&
        !cache.staleKeys?.has(key) &&
        (cache.usedKeys.has(key) || !complete || siblingKeys.has(key))
      )
        cache.onDiskKeys.add(key);
    }
    for (const [key, value] of retained.entries) {
      if (
        !cache.usedKeys.has(key) &&
        !cache.stagedKeys?.has(key) &&
        !cache.staleKeys?.has(key) &&
        (!complete || siblingKeys.has(key))
      )
        cache.entries.set(key, value);
    }
    if (complete) {
      for (const key of siblingKeys) cache.usedKeys.add(key);
    } else {
      log('Parse cache: a branch meta was unreadable — retaining all cached chunks (#2106).');
      for (const key of cache.entries.keys()) cache.usedKeys.add(key);
      for (const key of cache.onDiskKeys) cache.usedKeys.add(key);
    }
    const pruned = pruneCache(cache, cache.usedKeys);
    if (pruned > 0) log(`Parse cache: pruned ${pruned} stale chunk entries`);
    const savedKeys = await saveParseCache(cacheRoot, cache);
    await mergeStagedDurableParsedFileStore(
      cacheRoot,
      cache.writeStoragePath ?? cacheRoot,
      cache.identity.base,
      new Set(savedKeys),
    );
  };
  await (sharedStore ? withStoreLock(sharedStore, 'cache', publish) : publish());
  if (options.publishedGeneration) {
    const root = await embeddingJobDirectory(metadataDirectory);
    await fs.rm(path.join(root, receiptName(options.publishedGeneration)), { force: true });
    await syncEmbeddingJobDirectory(root);
  }
}

// This contains only chunk keys, never ASTs, graph data or source content.
// The fixed ceiling fits the phase headroom; failure merely leaves this
// optional cache unpublished, and never changes graph/embedding correctness.
const MAX_HANDOFF_BYTES = 16 * 1024 * 1024;
const KEY = /^[a-f0-9]{64}$/;
interface CacheHandoff {
  version: 1;
  generation: string;
  stage: string;
  identity: ParseCache['identity'];
  used: string[];
  staged: string[];
  stale: string[];
}
const checksum = (payload: string) => createHash('sha256').update(payload).digest('hex');
const receiptName = (generation: string) => {
  if (!/^[a-f0-9]{32}$/.test(generation)) throw new Error('Invalid cache publication generation');
  return `analysis-cache-${generation}.json`;
};

async function ownedStage(root: string, relative: string): Promise<string> {
  if (!/^parse-rebuild\/run\.[A-Za-z0-9]{6}$/.test(relative))
    throw new Error('Invalid prepared parser cache stage');
  let current = await embeddingJobDirectory(root);
  for (const part of relative.split('/'))
    current = await embeddingJobDirectory(path.join(current, part));
  return current;
}

/** Flush only memory fallback shards. Existing live shards stay in place;
 * the supervisor will re-read their current identity under the cache lock. */
export async function stageAnalysisParseCache(
  root: string,
  generation: string,
  cache: ParseCache,
): Promise<void> {
  root = await embeddingJobDirectory(root);
  const name = receiptName(generation);
  if (!cache.writeStoragePath)
    throw new Error('Prepared parser cache has no owned staging directory');
  const relative = path.relative(root, cache.writeStoragePath).split(path.sep).join('/');
  await ownedStage(root, relative);
  // Bound each selection before copying or serializing it. Unknown/malformed
  // keys cannot become filesystem paths.
  for (const keys of [cache.entries, cache.usedKeys, cache.stagedKeys, cache.staleKeys]) {
    if (!keys) continue;
    if (keys.size > Math.floor(MAX_HANDOFF_BYTES / 3 / 70))
      throw new Error('Prepared parser cache key set exceeds its bound');
    for (const key of keys.keys())
      if (!KEY.test(key)) throw new Error('Prepared parser cache contains an invalid key');
  }
  for (const [key, value] of cache.entries) await persistParseCacheChunk(cache, key, value);
  if (cache.entries.size)
    throw new Error('Could not persist prepared parser cache fallback shards');
  const payload: CacheHandoff = {
    version: 1,
    generation,
    stage: relative,
    identity: cache.identity,
    used: [...cache.usedKeys],
    staged: [...(cache.stagedKeys ?? [])],
    stale: [...(cache.staleKeys ?? [])],
  };
  const serialized = JSON.stringify(payload);
  const bytes = Buffer.from(JSON.stringify({ payload, checksum: checksum(serialized) }));
  if (bytes.length > MAX_HANDOFF_BYTES)
    throw new Error('Prepared parser cache receipt exceeds its bound');
  const temporary = path.join(root, `.${name}.${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, path.join(root, name));
    await syncEmbeddingJobDirectory(root);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** The published graph binds the generation, parser identity and used keys.
 * Missing cache state is optional; malformed state is never used as a cache. */
export async function loadAnalysisParseCache(
  root: string,
  metadata: RepoMeta,
): Promise<ParseCache | undefined> {
  const generation = metadata.graphGeneration?.id;
  if (!generation) throw new Error('Cache publication requires a published graph generation');
  root = await embeddingJobDirectory(root);
  const file = path.join(root, receiptName(generation));
  let opened;
  try {
    opened = await openEmbeddingJobFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const { handle, stat } = opened;
  let bytes: Buffer;
  try {
    if (stat.size > MAX_HANDOFF_BYTES) throw new Error('Unverified prepared parser cache receipt');
    bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length !== stat.size) throw new Error('Prepared parser cache receipt changed');
    bytes = bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
  const envelope = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
  const payload = envelope.payload as CacheHandoff;
  const keys = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((key) => typeof key === 'string' && KEY.test(key));
  if (
    !payload ||
    envelope.checksum !== checksum(JSON.stringify(payload)) ||
    payload.version !== 1 ||
    payload.generation !== generation ||
    typeof payload.stage !== 'string' ||
    !payload.identity ||
    typeof payload.identity.base !== 'string' ||
    typeof payload.identity.pdg !== 'string' ||
    payload.identity.base !== metadata.parseCacheIdentity?.base ||
    (metadata.parseCacheIdentity.pdg &&
      payload.identity.pdg !== metadata.parseCacheIdentity.pdg.identity) ||
    !keys(payload.used) ||
    !keys(payload.staged) ||
    !keys(payload.stale)
  )
    throw new Error('Prepared parser cache does not match the published graph');
  const usedKeys = new Set(metadata.cacheKeys ?? []);
  if (
    payload.used.length !== usedKeys.size ||
    new Set(payload.used).size !== usedKeys.size ||
    payload.used.some((key) => !usedKeys.has(key))
  )
    throw new Error('Prepared parser cache selection differs from the published graph');
  return {
    identity: payload.identity,
    entries: new Map(),
    usedKeys,
    writeStoragePath: await ownedStage(root, payload.stage),
    stagedKeys: new Set(payload.staged),
    staleKeys: new Set(payload.stale),
  };
}
