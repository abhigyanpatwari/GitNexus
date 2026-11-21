/**
 * Disk-backed scope store + lazy `ScopeTree` (out-of-core scope index — kernel scope-resolution
 * out-of-core index).
 *
 * ## Why this exists
 *
 * The scope-resolution resident floor is dominated by the per-`Scope` binding
 * payload (`Scope.bindings` / `typeBindings` / `ownedDefs`) — ~17-20 GB for one
 * language on the Linux kernel — held in `preExtractedByPath` AND aliased by the
 * finalize `scopeTree` through the whole emit phase. Emitters look up individual
 * scopes, traverse the tree and enumerate scopes by file or across the project.
 *
 * {@link persistScopeShards} writes the scopes to per-file JSON shards (one file
 * = one shard, so a file's whole parent-chain — which never crosses filePath —
 * stays within one shard) using the same `mapReplacer` + def-interning reviver
 * the ParsedFile store proved byte-identical (#1983 / def-object interning). {@link DiskBackedScopeTree}
 * serves `getScope` from a bounded LRU of decoded shards plus a small resident
 * skeleton (`scopeId -> {shard, childIds, parent}`), so only the working set of
 * scopes is resident, not all of them.
 */

import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Scope, ScopeId, ScopeTree, SymbolDefinition } from 'gitnexus-shared';
import { buildScopeTree } from 'gitnexus-shared';
import { mapReplacer } from './parse-cache.js';
import { logger } from '../core/logger.js';
import { makeInterningReviver } from './parsedfile-store.js';

const STORE_DIRNAME = 'scope-index-store';

/** Resident per-scope skeleton — everything `ScopeTree` answers WITHOUT the heavy
 *  binding payload. `shard` names the on-disk file holding the full `Scope`. */
interface ScopeSkeletonEntry {
  readonly shard: string;
  readonly parent: ScopeId | null;
  readonly childIds: ScopeId[];
}

export const getScopeIndexStoreDir = (storagePath: string): string =>
  path.join(storagePath, STORE_DIRNAME);

/**
 * Remove any prior seal's scope shards so a fresh seal starts clean. The shard
 * names are sequential (`s<n>.json`) and the index resets per `persistScopeShards`
 * call, so without this a seal that writes FEWER shards than a previous one (a
 * later language with fewer files, or a later run of a shrunken repo) would leave
 * stale tail shards on disk indefinitely — pure garbage the disk-backed tree
 * never reads, but multi-GB on kernel-scale repos. Idempotent; synchronous to
 * fit the main-thread seal path. Safe to call before each seal: the previously
 * sealed language has finished emit and been released before the next seal runs,
 * so its `DiskBackedScopeTree` never reads these shards again.
 */
export const clearScopeIndexStore = (storagePath: string): void => {
  rmSync(getScopeIndexStoreDir(storagePath), { recursive: true, force: true });
};

const EMPTY: readonly ScopeId[] = Object.freeze([]);

/**
 * Persist `scopes` to per-file shards under `<storagePath>/scope-index-store/`
 * and return the resident skeleton the {@link DiskBackedScopeTree} needs. Sharded
 * by `filePath` (sequential `s<n>.json` names — no filePath→filename encoding),
 * so one file's full scope subtree round-trips together. Synchronous: pass-A runs
 * on the main thread and this replaces an in-heap `buildScopeTree`.
 */
export const persistScopeShards = (
  storagePath: string,
  scopes: readonly Scope[],
): ReadonlyMap<ScopeId, ScopeSkeletonEntry> => {
  const dir = getScopeIndexStoreDir(storagePath);
  // Clear first so a seal that writes fewer shards than the previous one (a
  // later language with fewer files, or a shrunken repo on re-run) leaves no
  // stale `s<n>.json` tail behind. See {@link clearScopeIndexStore}.
  clearScopeIndexStore(storagePath);
  mkdirSync(dir, { recursive: true });

  // Group scope objects by filePath, preserving input order within a file.
  const byFile = new Map<string, Scope[]>();
  for (const s of scopes) {
    const bucket = byFile.get(s.filePath);
    if (bucket) bucket.push(s);
    else byFile.set(s.filePath, [s]);
  }

  // childIds in input order (mirrors buildScopeTree's children buckets).
  const childIds = new Map<ScopeId, ScopeId[]>();
  for (const s of scopes) {
    if (s.parent !== null) {
      const b = childIds.get(s.parent);
      if (b) b.push(s.id);
      else childIds.set(s.parent, [s.id]);
    }
  }

  const shardByFile = new Map<string, string>();
  let shardIndex = 0;
  for (const [filePath, fileScopes] of byFile) {
    const shard = `s${shardIndex++}.json`;
    writeFileSync(path.join(dir, shard), JSON.stringify(fileScopes, mapReplacer), 'utf-8');
    shardByFile.set(filePath, shard);
  }
  // ScopeTree.byId follows input order, even when different files interleave.
  const skeleton = new Map<ScopeId, ScopeSkeletonEntry>();
  for (const s of scopes) {
    skeleton.set(s.id, {
      shard: shardByFile.get(s.filePath)!,
      parent: s.parent,
      childIds: childIds.get(s.id) ?? [],
    });
  }
  return skeleton;
};

interface ScopeShard {
  scopes: Scope[];
  byId: Map<ScopeId, Scope>;
}

/** Point lookups, file views and ordered map iteration share one bounded shard cache. */
export class DiskBackedScopeTree implements ScopeTree, ReadonlyMap<ScopeId, Scope> {
  private readonly dir: string;
  private readonly skeleton: ReadonlyMap<ScopeId, ScopeSkeletonEntry>;
  private readonly maxResidentShards: number;
  /** Decoded shards, most-recently-used last (Map preserves insertion order). */
  private readonly lru = new Map<string, ScopeShard>();
  private readonly liveTypeBindings = new Map<ScopeId, Scope['typeBindings']>();

  constructor(
    storagePath: string,
    skeleton: ReadonlyMap<ScopeId, ScopeSkeletonEntry>,
    maxResidentShards = 64,
  ) {
    this.dir = getScopeIndexStoreDir(storagePath);
    this.skeleton = skeleton;
    this.maxResidentShards = Math.max(1, maxResidentShards);
  }

  get size(): number {
    return this.skeleton.size;
  }

  get byId(): ReadonlyMap<ScopeId, Scope> {
    return this;
  }

  keys() {
    return this.skeleton.keys();
  }

  *values() {
    for (const [id, meta] of this.skeleton) yield this.readScope(id, meta.shard);
  }

  *entries(): Generator<[ScopeId, Scope]> {
    for (const scope of this.values()) yield [scope.id, scope];
  }

  [Symbol.iterator]() {
    return this.entries();
  }

  forEach(
    callback: (value: Scope, key: ScopeId, map: ReadonlyMap<ScopeId, Scope>) => void,
    thisArg?: unknown,
  ): void {
    for (const scope of this.values()) callback.call(thisArg, scope, scope.id, this);
  }

  get(id: ScopeId): Scope | undefined {
    return this.getScope(id);
  }

  getFileScopes(moduleScope: ScopeId): readonly Scope[] {
    const meta = this.skeleton.get(moduleScope);
    if (!meta) return [];
    const shard = this.loadShard(meta.shard);
    if (!shard.byId.has(moduleScope))
      throw new ScopeShardReadError(`Missing module scope ${moduleScope} in shard ${meta.shard}`);
    return shard.scopes;
  }

  /** Register before the first read so later inference is visible across shard evictions. */
  retainTypeBindings(scope: Scope): void {
    this.liveTypeBindings.set(scope.id, scope.typeBindings);
  }

  has(id: ScopeId): boolean {
    return this.skeleton.has(id);
  }

  getChildren(id: ScopeId): readonly ScopeId[] {
    return this.skeleton.get(id)?.childIds ?? EMPTY;
  }

  getScope(id: ScopeId): Scope | undefined {
    const meta = this.skeleton.get(id);
    if (meta === undefined) return undefined;
    return this.readScope(id, meta.shard);
  }

  private readScope(id: ScopeId, shard: string): Scope {
    const scope = this.loadShard(shard).byId.get(id);
    if (!scope) throw new ScopeShardReadError(`Missing scope ${id} in shard ${shard}`);
    return scope;
  }

  getParent(id: ScopeId): Scope | undefined {
    const parent = this.skeleton.get(id)?.parent;
    return parent === null || parent === undefined ? undefined : this.getScope(parent);
  }

  getAncestors(id: ScopeId): readonly ScopeId[] {
    const out: ScopeId[] = [];
    let cur = this.skeleton.get(id)?.parent ?? null;
    const seen = new Set<ScopeId>();
    while (cur !== null && !seen.has(cur)) {
      seen.add(cur);
      out.push(cur);
      cur = this.skeleton.get(cur)?.parent ?? null;
    }
    return out;
  }

  /** Load + decode a shard, touch it as MRU, evict the LRU tail past the cap. */
  private loadShard(shard: string): ScopeShard {
    const cached = this.lru.get(shard);
    if (cached !== undefined) {
      // Touch: move to MRU end.
      this.lru.delete(shard);
      this.lru.set(shard, cached);
      return cached;
    }
    const pool = new Map<string, string>();
    const defPool = new Map<string, SymbolDefinition>();
    let decoded: ScopeShard;
    try {
      const raw = readFileSync(path.join(this.dir, shard), 'utf-8');
      const fileScopes = JSON.parse(raw, makeInterningReviver(pool, defPool)) as Scope[];
      if (!Array.isArray(fileScopes)) throw new Error('Expected an array of scopes');
      const byId = new Map<ScopeId, Scope>();
      for (let i = 0; i < fileScopes.length; i++) {
        const scope = fileScopes[i];
        const typeBindings = this.liveTypeBindings.get(scope.id);
        if (typeBindings !== undefined) fileScopes[i] = { ...scope, typeBindings };
        byId.set(scope.id, fileScopes[i]);
      }
      decoded = { scopes: fileScopes, byId };
    } catch (cause) {
      throw new ScopeShardReadError(`Failed to read scope shard ${shard}`, { cause });
    }
    this.lru.set(shard, decoded);
    if (this.lru.size > this.maxResidentShards) {
      const oldest = this.lru.keys().next().value as string | undefined;
      if (oldest !== undefined) this.lru.delete(oldest);
    }
    return decoded;
  }
}

/**
 * A `ScopeTree` that starts fully resident (validated by `buildScopeTree`, used
 * by finalize / propagate / resolve, which may mutate `Scope.typeBindings` in
 * place) and then {@link seal}s to a {@link DiskBackedScopeTree} just before emit.
 *
 * Sealing is what actually frees the ~17-20 GB of `Scope.bindings`: the resident
 * tree is held BY THE MODEL'S frozen index bundle, so it cannot be swapped out
 * from the outside. This wrapper IS that held object — `seal()` mutates its own
 * (non-frozen) internal field to null the resident tree from the inside, after
 * persisting it, so the model's reference now points at the disk-backed serving
 * path and the heavy scopes become collectible (once the emit-side ParsedFiles
 * also drop their `scopes`). Idempotent; a no-op before `seal()` keeps today's
 * fully-resident behavior byte-identical.
 */
export class TransitionalScopeTree implements ScopeTree {
  // Stays resident until the explicit disk override or an eligible provider's
  // pre-emit heap-pressure check requests a seal.
  private resident: ScopeTree | null;
  private disk: DiskBackedScopeTree | null = null;

  constructor(scopes: readonly Scope[]) {
    this.resident = buildScopeTree(scopes); // validates invariants + serves the resident phase
  }

  /** Persist the resident scopes, switch to disk-backed serving, and drop the
   *  resident tree so its scope/binding payload can be reclaimed. Idempotent. */
  seal(storagePath: string, maxResidentShards?: number): void {
    if (this.disk !== null || this.resident === null) return;
    const skeleton = persistScopeShards(storagePath, [...this.resident.byId.values()]);
    this.disk = new DiskBackedScopeTree(storagePath, skeleton, maxResidentShards);
    this.resident = null;
  }

  get sealed(): boolean {
    return this.disk !== null;
  }

  get sealedTree(): DiskBackedScopeTree | null {
    return this.disk;
  }

  private get active(): ScopeTree {
    const t: ScopeTree | null = this.disk ?? this.resident;
    if (t === null)
      throw new Error(
        'TransitionalScopeTree has no active backing (resident dropped without seal).',
      );
    return t;
  }

  get size(): number {
    return this.active.size;
  }
  get byId(): ReadonlyMap<ScopeId, Scope> {
    return this.active.byId;
  }
  has(id: ScopeId): boolean {
    return this.active.has(id);
  }
  getScope(id: ScopeId): Scope | undefined {
    return this.active.getScope(id);
  }
  getParent(id: ScopeId): Scope | undefined {
    return this.active.getParent(id);
  }
  getChildren(id: ScopeId): readonly ScopeId[] {
    return this.active.getChildren(id);
  }
  getAncestors(id: ScopeId): readonly ScopeId[] {
    return this.active.getAncestors(id);
  }
}

/** A persisted scope can no longer be served. Emission must propagate this
 * error even if a per-file CFG or taint failure would normally be isolated. */
export class ScopeShardReadError extends Error {}

/** A pressure-triggered seal owns its directory until the last emit reader.
 * Explicitly selected stores can belong to callers retaining a scope tree. */
export function trySealTemporaryScopeTree(
  tree: TransitionalScopeTree,
  storagePath: string,
): Disposable | undefined {
  let directory: string | undefined;
  const cleanup = () => {
    if (directory === undefined) return;
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch (err) {
      logger.warn({ err }, 'Could not remove temporary scope shards');
    }
  };
  try {
    mkdirSync(storagePath, { recursive: true });
    directory = mkdtempSync(path.join(storagePath, 'scope-spill-'));
    tree.seal(directory);
  } catch (err) {
    cleanup();
    logger.warn(
      { err },
      'Could not spill scopes to disk under heap pressure; continuing with resident scopes',
    );
    return undefined;
  }
  logger.info('Spilled scope bindings to disk under heap pressure');
  return { [Symbol.dispose]: cleanup };
}
