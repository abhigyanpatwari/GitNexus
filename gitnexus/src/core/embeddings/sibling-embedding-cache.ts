/**
 * Cross-branch embedding reuse (#3631).
 *
 * Every branch slot of a repository owns a full LadybugDB, and until now its
 * CodeEmbedding rows were computed from scratch: two branches differing by
 * one file paid the full embedding cost twice. This module lets a run copy
 * embedding rows from SIBLING indexes of the same repository (the flat slot,
 * the other `branches/*` slots, or the other checkout slots of the shared
 * store) instead of calling the embedder for them.
 *
 * Two donor shapes exist, and each is gated on the artifact its rows are
 * actually read from:
 *
 *   - INLINE donors (this module): slots whose CodeEmbedding rows were
 *     written by the inline pipeline itself. Their meta carries an
 *     `embeddingIdentity` stamp — the digests of the run that wrote those
 *     very rows. A slot carrying `vectorGeneration` or `embeddingJob` was
 *     last written by the staged publication job: its graph table is NOT
 *     the artifact its identity describes (the published vectors live
 *     under `embeddings/<identity>/vectors`, gated by the space record),
 *     so it never qualifies here.
 *   - PUBLISHED donors (embedding-job.ts): a sibling's sealed vector
 *     artifact, read through the publication job's provenance-checking
 *     reuse sources. Same identity gate, same content-hash keying.
 *
 * The cache is keyed by CONTENT HASH, never by node id: node ids are
 * branch-local graph identities, while a content hash (see
 * `contentHashForNode`) names the exact text that was embedded. A sibling
 * row is eligible only when the sibling slot's persisted identity digests
 * match the consuming run on BOTH halves —
 *
 *   - `vectorIdentity` (provider + model + dimensions): the vectors must
 *     live in the same vector space. The content hash alone cannot prove
 *     this: it folds in the model id only for non-default models.
 *   - `inputIdentity` (EMBEDDING_TEXT_VERSION + chunking + retention +
 *     length caps): the chunk rows must have been produced from the same
 *     inputs, or a "hit" could copy chunk boundaries the current run
 *     would never produce.
 *
 * The cache is DEMAND-DRIVEN. Creation reads only sibling metas — no
 * database is opened. A sibling's row METADATA (nodeId, chunkIndex, lines,
 * contentHash — never the vector column) is scanned lazily, the first time
 * a lookup reaches that sibling, and a claim's vectors are fetched for
 * exactly that one node, only when a lookup actually hits. A run that
 * needs nothing from its siblings pays nothing for them.
 *
 * Completeness is judged PER NODE, never per hash: `contentHashForNode`
 * does not mix in the node id, so two distinct nodes can share one hash,
 * and grouping by hash alone would merge their chunk sets and discard
 * both. A node's set claims its hash only when its chunks are exactly
 * 0..n-1 under one stored hash form. The sibling DB persists no expected
 * chunk count per node, so the count anchor is the sibling's own
 * completion state: a sibling that stopped mid-write (`incrementalInProgress`,
 * an interrupted embedding checkpoint, or a staged recovery record) is
 * either skipped outright or has its half-persisted nodes excluded —
 * their rows may be a contiguous prefix of the full set, which contiguity
 * alone cannot distinguish from complete.
 *
 * Copying is best-effort throughout: a sibling that is missing, locked,
 * legacy-shaped (no contentHash column), or identity-mismatched is skipped
 * and the run embeds fresh, exactly as if the cache did not exist. Rows
 * are copied INTO the target database (no shared vector table), and a
 * copied row keeps the start/end lines of the index it came from — the
 * same line provenance the existing same-index restore already accepts
 * when a file is edited above an unchanged node.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import lbug from '@ladybugdb/core';
import { closeLbugConnection, openLbugConnection } from '../lbug/lbug-config.js';
import { closeQueryResults } from '../lbug/query-result-utils.js';
import { EMBEDDING_TABLE_NAME } from '../lbug/schema.js';
import { logger } from '../logger.js';
import { loadMeta, type RepoMeta } from '../../storage/repo-manager.js';
import { BRANCHES_DIR } from '../../storage/branch-index.js';
import {
  resolveGraphPath,
  storeRootOfCheckoutSlot,
  type SharedStoreLayout,
} from '../../storage/shared-store.js';
import type { CachedEmbeddingMeta } from './embedding-restore-spill.js';
import type { CachedEmbedding } from './types.js';

export interface SiblingSlotDiscovery {
  /** The consuming slot's meta directory (excluded from the result). */
  targetMetaDir: string;
  /** The repository storage root holding the flat slot and `branches/`. */
  storagePath: string;
  /** Present when the target lives in a shared store's checkout slot. */
  sharedStore?: SharedStoreLayout;
}

async function listSubDirs(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

/**
 * Enumerate the meta directories of every sibling slot of the target slot:
 * for a local repo, the flat slot plus every `branches/*` slot; for a
 * shared-store checkout, every checkout slot of the store plus each
 * checkout's own `branches/*` slots. The target itself is excluded.
 * Missing directories simply yield fewer siblings.
 */
export async function findSiblingSlotDirs(options: SiblingSlotDiscovery): Promise<string[]> {
  const target = path.resolve(options.targetMetaDir);
  const dirs: string[] = [];
  if (options.sharedStore) {
    const checkoutDirs = await listSubDirs(options.sharedStore.checkoutsDir);
    dirs.push(...checkoutDirs);
    for (const checkout of checkoutDirs) {
      dirs.push(...(await listSubDirs(path.join(checkout, BRANCHES_DIR))));
    }
  } else {
    dirs.push(
      options.storagePath,
      ...(await listSubDirs(path.join(options.storagePath, BRANCHES_DIR))),
    );
  }
  return [...new Set(dirs.map((dir) => path.resolve(dir)))].filter((dir) => dir !== target).sort();
}

/**
 * The same enumeration as {@link findSiblingSlotDirs}, derived from a slot
 * directory alone — for consumers (the staged publication job) that know
 * their own slot but were never handed the run's storage layout. A branch
 * slot's siblings are its flat slot, its fellow branches, and — when the
 * flat slot is a shared-store checkout — the store's other checkouts and
 * their branches.
 */
export async function findSiblingSlotDirsForSlot(slotDir: string): Promise<string[]> {
  const resolved = path.resolve(slotDir);
  const parent = path.dirname(resolved);
  const dirs: string[] = [];
  const addCheckoutFamily = async (checkoutDir: string): Promise<void> => {
    const storeRoot = storeRootOfCheckoutSlot(checkoutDir);
    if (!storeRoot) return;
    for (const checkout of await listSubDirs(path.join(storeRoot, 'checkouts'))) {
      if (path.resolve(checkout) === path.resolve(checkoutDir)) continue;
      dirs.push(checkout, ...(await listSubDirs(path.join(checkout, BRANCHES_DIR))));
    }
  };
  if (path.basename(parent) === BRANCHES_DIR) {
    const flatSlot = path.dirname(parent);
    dirs.push(flatSlot, ...(await listSubDirs(parent)));
    await addCheckoutFamily(flatSlot);
  } else {
    dirs.push(...(await listSubDirs(path.join(resolved, BRANCHES_DIR))));
    await addCheckoutFamily(resolved);
  }
  return [...new Set(dirs.map((dir) => path.resolve(dir)))]
    .filter((dir) => dir !== resolved)
    .sort();
}

/**
 * Node ids whose rows in this sibling may be half-persisted even when a
 * row carries the current content hash. A checkpoint without an explicit
 * kind predates the kind field and marks an interrupted run (an absent
 * kind ≡ 'interrupted'); only interrupted checkpoints leave pending nodes
 * half-written — a 'partial' checkpoint's pending nodes hold no rows at
 * all, and 'unverified-count' carries none. A staged recovery record
 * means the last staged build stopped mid-flight, and its unsafe nodes
 * are excluded for the same reason.
 */
export function siblingUnsafeNodeIds(meta: RepoMeta | undefined): Set<string> {
  const unsafe = new Set<string>();
  const checkpoint = meta?.embeddingCheckpoint;
  if (checkpoint && (checkpoint.kind === undefined || checkpoint.kind === 'interrupted')) {
    for (const nodeId of checkpoint.pendingNodeIds ?? []) unsafe.add(nodeId);
  }
  for (const nodeId of meta?.embeddingCheckpoint?.recovery?.unsafeNodeIds ?? []) unsafe.add(nodeId);
  return unsafe;
}

/** One node's complete chunk set in a sibling, as claimed from metadata. */
export interface SiblingClaim {
  /** The content hash exactly as stored in the sibling's rows. */
  storedHash: string;
  /** The claimed node's chunk metadata, sorted by chunkIndex. */
  metas: CachedEmbeddingMeta[];
}

/**
 * Build the claim map for one sibling from its rows' metadata. Claims are
 * judged per node (see the module header): a node claims its hash when
 * its chunks are exactly 0..n-1 under one stored hash form, and the first
 * complete set wins when two nodes share a hash. A claim is indexed under
 * its stored hash AND — for the full `hash:inputsDigest` form that
 * source-aware (hydrated) nodes are stored under — under the bare hash
 * prefix, because pipeline lookups arrive in both forms, exactly like the
 * pipeline's same-slot freshness filter accepts both.
 */
export function buildSiblingClaims(
  metas: readonly CachedEmbeddingMeta[],
  unsafeNodeIds: ReadonlySet<string>,
): Map<string, SiblingClaim> {
  const byNode = new Map<string, CachedEmbeddingMeta[]>();
  for (const meta of metas) {
    if (meta.contentHash === undefined) continue;
    const list = byNode.get(meta.nodeId);
    if (list) list.push(meta);
    else byNode.set(meta.nodeId, [meta]);
  }
  const claims = new Map<string, SiblingClaim>();
  for (const [nodeId, rows] of byNode) {
    if (unsafeNodeIds.has(nodeId)) continue;
    const sorted = [...rows].sort((a, b) => a.chunkIndex - b.chunkIndex);
    const storedHash = sorted[0]?.contentHash;
    if (storedHash === undefined) continue;
    if (!sorted.every((meta, i) => meta.chunkIndex === i && meta.contentHash === storedHash)) {
      continue;
    }
    const claim: SiblingClaim = { storedHash, metas: sorted };
    if (!claims.has(storedHash)) claims.set(storedHash, claim);
    const separator = storedHash.indexOf(':');
    if (separator > 0) {
      const bare = storedHash.slice(0, separator);
      if (!claims.has(bare)) claims.set(bare, claim);
    }
  }
  return claims;
}

export interface SiblingEmbeddingCacheOptions {
  /** Candidate sibling meta directories, in preference order. */
  slotDirs: string[];
  /** This run's identity digests; both must match a sibling's stamp. */
  identities: { vectorIdentity: string; inputIdentity: string };
  /** This run's vector width; copied vectors must match it exactly. */
  dimensions: number;
  /** Graph DB paths that must never be harvested (the run's own DB). */
  excludeDbPaths?: readonly string[];
  /** Aborts pending scans/fetches between siblings. */
  signal?: AbortSignal;
}

/** A verified sibling claim: the node's rows, ready to copy. */
export interface SiblingEmbeddingClaim {
  /** The content hash exactly as stored in the sibling's rows. */
  storedHash: string;
  /** The donor node's rows (donor nodeId, sibling line ranges). */
  rows: CachedEmbedding[];
}

export interface SiblingEmbeddingCache {
  /**
   * Resolve one content hash to a verified sibling claim, or undefined
   * when no eligible sibling holds a complete set for it. Scans and
   * fetches are lazy and stop at the first sibling that satisfies the
   * lookup.
   */
  lookup(contentHash: string): Promise<SiblingEmbeddingClaim | undefined>;
  /** Close every sibling database handle opened by lookups. */
  dispose(): Promise<void>;
}

interface SiblingDonor {
  dbPath: string;
  unsafeNodeIds: ReadonlySet<string>;
  scanned: boolean;
  claims: Map<string, SiblingClaim> | undefined;
  handle: Awaited<ReturnType<typeof openLbugConnection>> | undefined;
  fetchedRows: Map<string, CachedEmbedding[]>;
  failedClaims: Set<string>;
}

/**
 * Create the demand-driven sibling cache for one run. Eligibility is
 * decided from sibling METAS ONLY — no database is opened here. A slot
 * qualifies when its `embeddingIdentity` stamp matches this run on both
 * digests and nothing marks its graph rows as another writer's artifact
 * or a write still in flight (see the module header). Returns undefined
 * when no sibling qualifies, so callers can skip the feature cleanly.
 */
export async function createSiblingEmbeddingCache(
  options: SiblingEmbeddingCacheOptions,
): Promise<SiblingEmbeddingCache | undefined> {
  const donors: SiblingDonor[] = [];
  for (const slotDir of options.slotDirs) {
    const meta = await loadMeta(slotDir);
    const recorded = meta?.embeddingIdentity;
    if (!recorded) continue;
    if (recorded.vectorIdentity !== options.identities.vectorIdentity) continue;
    if (recorded.inputIdentity !== options.identities.inputIdentity) continue;
    // The stamp must vouch for the rows actually read. A slot carrying a
    // publication record was last written by the staged job, whose
    // vectors live in the published artifact — not in this graph table.
    if (meta?.vectorGeneration || meta?.embeddingJob) continue;
    // A sibling mid-write can hold a truncated chunk set that looks
    // contiguous; never read from one.
    if (meta?.incrementalInProgress) continue;
    if (meta?.embeddingDims !== undefined && meta.embeddingDims !== options.dimensions) continue;
    const dbPath = resolveGraphPath(slotDir, meta);
    if (options.excludeDbPaths?.includes(dbPath)) continue;
    try {
      const stat = await fs.stat(dbPath);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }
    donors.push({
      dbPath,
      unsafeNodeIds: siblingUnsafeNodeIds(meta),
      scanned: false,
      claims: undefined,
      handle: undefined,
      fetchedRows: new Map(),
      failedClaims: new Set(),
    });
  }
  if (donors.length === 0) return undefined;

  const ensureHandle = async (
    donor: SiblingDonor,
  ): Promise<NonNullable<SiblingDonor['handle']>> => {
    if (!donor.handle) {
      donor.handle = await openLbugConnection(lbug, donor.dbPath, {
        readOnly: true,
        // Sibling DBs are read-only inputs; a WAL replay failure must not
        // fail the consuming run — the sibling is skipped instead.
        throwOnWalReplayFailure: false,
      });
    }
    return donor.handle;
  };

  const scanSiblingMetas = async (donor: SiblingDonor): Promise<CachedEmbeddingMeta[]> => {
    const handle = await ensureHandle(donor);
    // Metadata columns only — the vector column is never read for a scan,
    // so an unwanted sibling costs one narrow pass, not a full spill.
    const queryResult = await handle.conn.query(
      `MATCH (e:${EMBEDDING_TABLE_NAME})
       RETURN e.nodeId AS nodeId, e.chunkIndex AS chunkIndex,
              e.startLine AS startLine, e.endLine AS endLine,
              e.contentHash AS contentHash`,
    );
    try {
      const metas: CachedEmbeddingMeta[] = [];
      let vectorIndex = 0;
      for (const result of Array.isArray(queryResult) ? queryResult : [queryResult]) {
        while (await result.hasNext()) {
          const row = await result.getNext();
          metas.push({
            nodeId: String(row.nodeId ?? ''),
            chunkIndex: Number(row.chunkIndex ?? 0),
            startLine: Number(row.startLine ?? 0),
            endLine: Number(row.endLine ?? 0),
            contentHash:
              typeof row.contentHash === 'string' && row.contentHash ? row.contentHash : undefined,
            vectorIndex: vectorIndex++,
          });
        }
      }
      return metas;
    } finally {
      await closeQueryResults(queryResult);
    }
  };

  const fetchClaimRows = async (
    donor: SiblingDonor,
    claim: SiblingClaim,
  ): Promise<CachedEmbedding[] | undefined> => {
    const cached = donor.fetchedRows.get(claim.storedHash);
    if (cached) return cached;
    const handle = await ensureHandle(donor);
    const statement = await handle.conn.prepare(
      `MATCH (e:${EMBEDDING_TABLE_NAME}) WHERE e.nodeId = $nodeId
       RETURN e.nodeId AS nodeId, e.chunkIndex AS chunkIndex,
              e.startLine AS startLine, e.endLine AS endLine,
              e.contentHash AS contentHash, e.embedding AS embedding`,
    );
    let queryResult;
    try {
      queryResult = await handle.conn.execute(statement, {
        nodeId: claim.metas[0].nodeId,
      });
      const rows: CachedEmbedding[] = [];
      for (const result of Array.isArray(queryResult) ? queryResult : [queryResult]) {
        while (await result.hasNext()) {
          const row = await result.getNext();
          rows.push({
            nodeId: String(row.nodeId ?? ''),
            chunkIndex: Number(row.chunkIndex ?? 0),
            startLine: Number(row.startLine ?? 0),
            endLine: Number(row.endLine ?? 0),
            contentHash: typeof row.contentHash === 'string' ? row.contentHash : undefined,
            embedding: Array.from(row.embedding as ArrayLike<number>),
          });
        }
      }
      // Verify the fetched rows against the claim before trusting them:
      // the same count the metadata promised, contiguous from 0, one
      // stored hash, and every vector at this run's width.
      rows.sort((a, b) => a.chunkIndex - b.chunkIndex);
      if (rows.length !== claim.metas.length) return undefined;
      if (!rows.every((row, i) => row.chunkIndex === i && row.contentHash === claim.storedHash)) {
        return undefined;
      }
      if (!rows.every((row) => row.embedding.length === options.dimensions)) return undefined;
      donor.fetchedRows.set(claim.storedHash, rows);
      return rows;
    } finally {
      if (queryResult) await closeQueryResults(queryResult);
    }
  };

  return {
    async lookup(contentHash: string): Promise<SiblingEmbeddingClaim | undefined> {
      for (const donor of donors) {
        options.signal?.throwIfAborted();
        try {
          if (!donor.scanned) {
            donor.claims = buildSiblingClaims(await scanSiblingMetas(donor), donor.unsafeNodeIds);
            donor.scanned = true;
          }
          const claim = donor.claims?.get(contentHash);
          if (!claim || donor.failedClaims.has(claim.storedHash)) continue;
          const rows = await fetchClaimRows(donor, claim);
          if (!rows) {
            donor.failedClaims.add(claim.storedHash);
            continue;
          }
          return { storedHash: claim.storedHash, rows };
        } catch (err) {
          if (options.signal?.aborted) throw err;
          // A sibling that cannot be read (locked, legacy-shaped, gone)
          // is skipped, never fatal — the run embeds fresh instead.
          logger.debug(
            `Sibling embedding lookup skipped a sibling: ${err instanceof Error ? err.message : String(err)}`,
          );
          donor.scanned = true;
          donor.claims = new Map();
        }
      }
      return undefined;
    },
    async dispose(): Promise<void> {
      for (const donor of donors) {
        if (!donor.handle) continue;
        const handle = donor.handle;
        donor.handle = undefined;
        try {
          await closeLbugConnection(handle);
        } catch {
          // Best-effort: the sibling was a read-only input.
        }
      }
    },
  };
}

/**
 * Rewrite claimed sibling rows for the node they are copied INTO: the
 * donor's node id is replaced with the target's, rows are sorted by
 * chunkIndex, and the stored content hash and the donor's line ranges are
 * kept — the hash is the proof the text matched, and the lines are the
 * donor index's provenance for that unchanged text.
 */
export function materializeSiblingRows(
  rows: readonly CachedEmbedding[],
  targetNodeId: string,
): CachedEmbedding[] {
  return rows
    .map((row) => ({ ...row, nodeId: targetNodeId }))
    .sort((a, b) => a.chunkIndex - b.chunkIndex);
}
