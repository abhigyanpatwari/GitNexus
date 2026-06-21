/**
 * Disk-backed scope store + lazy `ScopeTree` (out-of-core scope index — kernel scope-resolution
 * out-of-core index).
 *
 * ## Why this exists
 *
 * The scope-resolution resident floor is dominated by the per-`Scope` binding
 * payload (`Scope.bindings` / `typeBindings` / `ownedDefs`) — ~17-20 GB for one
 * language on the Linux kernel — held in `preExtractedByPath` AND aliased by the
 * finalize `scopeTree` through the whole emit phase. The emit passes never read
 * `parsed.scopes` directly; they reach scopes EXCLUSIVELY through
 * `scopeTree.getScope(id)` (a point lookup) and `getChildren(id)`. So the heavy
 * scope payload can move to disk behind that point lookup without changing what
 * any consumer observes: every consumer reads a `Scope` BY VALUE (its `bindings`
 * / `ownedDefs` contents, `parent`, `range`), never by object identity.
 *
 * {@link persistScopeShards} writes the scopes to per-file JSON shards (one file
 * = one shard, so a file's whole parent-chain — which never crosses filePath —
 * stays within one shard) using the same `mapReplacer` + def-interning reviver
 * the ParsedFile store proved byte-identical (#1983 / def-object interning). {@link DiskBackedScopeTree}
 * serves `getScope` from a bounded LRU of decoded shards plus a small resident
 * skeleton (`scopeId -> {shard, childIds, parent}`), so only the working set of
 * scopes is resident, not all of them.
 *
 * Default-off: only constructed when `GITNEXUS_DISK_SCOPE_INDEX` is set. The
 * resident `buildScopeTree` path is untouched otherwise.
 */

import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Scope, ScopeId, ScopeTree, SymbolDefinition } from 'gitnexus-shared';
import { buildScopeTree } from 'gitnexus-shared';
import { mapReplacer } from './parse-cache.js';
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

  const skeleton = new Map<ScopeId, ScopeSkeletonEntry>();
  let shardIndex = 0;
  for (const [, fileScopes] of byFile) {
    const shard = `s${shardIndex++}.json`;
    writeFileSync(path.join(dir, shard), JSON.stringify(fileScopes, mapReplacer), 'utf-8');
    for (const s of fileScopes) {
      skeleton.set(s.id, {
        shard,
        parent: s.parent,
        childIds: childIds.get(s.id) ?? [],
      });
    }
  }
  return skeleton;
};

/**
 * A `ScopeTree` that serves `getScope` from disk shards via a bounded LRU,
 * holding only `maxResidentShards` decoded shards + the resident skeleton. Drop-in
 * for the in-heap `buildScopeTree` result for the methods scope-resolution
 * actually calls — `getScope` (the hot one), `getChildren`, `getParent`,
 * `getAncestors`, `has`, `size`. `byId` (a full materialization) is only used by
 * the `INGESTION_EMIT_SCOPES=1` debug path and is unsupported here — the two flags
 * are mutually exclusive.
 */
export class DiskBackedScopeTree implements ScopeTree {
  private readonly dir: string;
  private readonly skeleton: ReadonlyMap<ScopeId, ScopeSkeletonEntry>;
  private readonly maxResidentShards: number;
  /** Decoded shards, most-recently-used last (Map preserves insertion order). */
  private readonly lru = new Map<string, Map<ScopeId, Scope>>();

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
    throw new Error(
      'DiskBackedScopeTree.byId is unsupported (INGESTION_EMIT_SCOPES is incompatible with GITNEXUS_DISK_SCOPE_INDEX).',
    );
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
    return this.loadShard(meta.shard).get(id);
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
  private loadShard(shard: string): Map<ScopeId, Scope> {
    const cached = this.lru.get(shard);
    if (cached !== undefined) {
      // Touch: move to MRU end.
      this.lru.delete(shard);
      this.lru.set(shard, cached);
      return cached;
    }
    const pool = new Map<string, string>();
    const defPool = new Map<string, SymbolDefinition>();
    const raw = readFileSync(path.join(this.dir, shard), 'utf-8');
    const fileScopes = JSON.parse(raw, makeInterningReviver(pool, defPool)) as Scope[];
    const decoded = new Map<ScopeId, Scope>();
    for (const s of fileScopes) decoded.set(s.id, s);
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
    return this.active.byId; // throws in disk mode (DiskBackedScopeTree.byId)
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
