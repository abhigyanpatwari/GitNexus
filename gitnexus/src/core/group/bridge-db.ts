import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import lbug from '@ladybugdb/core';
import type { LbugValue } from '@ladybugdb/core';
import type { BridgeHandle, BridgeMeta, StoredContract, CrossLink, RepoSnapshot } from './types.js';
import { BRIDGE_SCHEMA_QUERIES, BRIDGE_SCHEMA_VERSION } from './bridge-schema.js';
import {
  closeLbugConnection,
  openLbugConnection,
  type LbugConnectionHandle,
} from '../lbug/lbug-config.js';
import { dedupeContracts, dedupeCrossLinks } from './normalization.js';

/**
 * Sidecar files that LadybugDB creates next to a `bridge.lbug` file.
 *
 * - `.wal` — write-ahead log; persists across opens but must be associated
 *   with the same database instance (LadybugDB 0.16.0 enforces this via a
 *   database-id check and rejects opens with the diagnostic
 *   `"Database ID for temporary file 'X.wal' does not match the current
 *   database. This file may have been left behind from a previous database
 *   with the same name"`).
 * - `.shadow` — non-blocking concurrent checkpoint sidecar (added in
 *   LadybugDB 0.15.4); same pairing constraint as `.wal`.
 *
 * `bridge-db` writes to a `bridge.lbug.tmp.<random>` file and then atomically renames
 * it into place. The rename only moves the main file; sidecars must be
 * cleaned up explicitly or the next writer trips the database-id check.
 */
const LBUG_SIDECAR_SUFFIXES = ['.wal', '.shadow'] as const;

async function removeLbugFile(basePath: string): Promise<void> {
  const candidates = [basePath, ...LBUG_SIDECAR_SUFFIXES.map((s) => `${basePath}${s}`)];
  for (const f of candidates) {
    try {
      await fsp.rm(f, { recursive: true, force: true });
    } catch {
      /* best-effort: caller will surface real errors via the open path */
    }
  }
}

/**
 * Remove all stale `bridge.lbug.tmp.*` files (and their sidecars) from a
 * group directory.  With randomBytes-based temp names, a crashed writeBridge
 * leaves behind a uniquely-named tmp file that no future run will target by
 * name — so we glob for the prefix and clean up everything matching.
 */
async function cleanStaleBridgeTmpFiles(groupDir: string): Promise<void> {
  try {
    const entries = await fsp.readdir(groupDir);
    const staleBases = entries.filter(
      (e) => e.startsWith('bridge.lbug.tmp.') && !LBUG_SIDECAR_SUFFIXES.some((s) => e.endsWith(s)),
    );
    for (const name of staleBases) {
      await removeLbugFile(path.join(groupDir, name));
    }
  } catch {
    /* best-effort: directory may not exist yet */
  }
}

export function contractNodeId(
  repo: string,
  contractId: string,
  role: string,
  filePath: string,
): string {
  return createHash('sha256').update(`${repo}\0${contractId}\0${role}\0${filePath}`).digest('hex');
}

/* ------------------------------------------------------------------ */
/*  ContractLookupIndex — in-memory lookup for findContractNode       */
/* ------------------------------------------------------------------ */

/**
 * In-memory index of contract node IDs keyed three ways, mirroring the
 * three-tier fallback lookup in {@link findContractNode}. Built once per
 * `writeBridge` call after all contracts are successfully inserted, then
 * consulted for every cross-link — which eliminates the former N+1 query
 * pattern (up to `6 × cross-links` DB round-trips) and turns cross-link
 * resolution into constant-time per link.
 *
 * Keys are deliberately flat strings (not tuples) so `Map<string, ...>`
 * works; the separator `\0` can't occur in any legal repo path / file
 * path / symbol identifier, which makes the encoding injection-safe.
 */
export interface ContractLookupIndex {
  /** tier 1: `repo + role + symbolUid` → contract node id */
  byUid: Map<string, string>;
  /** tier 2: `repo + role + filePath + symbolName` → contract node id */
  byRef: Map<string, string>;
  /** tier 3: `repo + role + filePath` → list of contract node ids in that file */
  byFile: Map<string, string[]>;
}

export function createContractLookupIndex(): ContractLookupIndex {
  return {
    byUid: new Map(),
    byRef: new Map(),
    byFile: new Map(),
  };
}

function uidKey(repo: string, role: string, symbolUid: string): string {
  return `${repo}\0${role}\0${symbolUid}`;
}

function refKey(repo: string, role: string, filePath: string, symbolName: string): string {
  return `${repo}\0${role}\0${filePath}\0${symbolName}`;
}

function fileKey(repo: string, role: string, filePath: string): string {
  return `${repo}\0${role}\0${filePath}`;
}

/**
 * Add a successfully-inserted contract to the lookup index. Must be called
 * AFTER the DB insert succeeds (not before) so failed inserts don't poison
 * the index and cause cross-links to point at non-existent rows.
 */
export function indexContract(
  index: ContractLookupIndex,
  contract: StoredContract,
  nodeId: string,
): void {
  if (contract.symbolUid) {
    index.byUid.set(uidKey(contract.repo, contract.role, contract.symbolUid), nodeId);
  }
  index.byRef.set(
    refKey(contract.repo, contract.role, contract.symbolRef.filePath, contract.symbolRef.name),
    nodeId,
  );
  const fk = fileKey(contract.repo, contract.role, contract.symbolRef.filePath);
  const existing = index.byFile.get(fk);
  if (existing) {
    existing.push(nodeId);
  } else {
    index.byFile.set(fk, [nodeId]);
  }
}

/**
 * Resolve a cross-link endpoint (consumer or provider reference) to an
 * already-inserted contract node id. Returns `null` if no match — the
 * caller is expected to count that as a dropped link in `WriteBridgeReport`.
 *
 * The resolution order matches the pre-cache DB-query behavior:
 *   1. exact `symbolUid` match in the same `(repo, role)` scope
 *   2. exact `(filePath, symbolName)` match
 *   3. if exactly one contract lives in the file → that one (fallback for
 *      legacy graph-assisted extractors that couldn't resolve a symbol name)
 *
 * This is a pure function — no I/O, no DB — so it's trivial to unit-test
 * in isolation (which was the reviewer's main clean-code concern on the
 * original 35-line inner closure in `writeBridge`).
 */
export function findContractNode(
  index: ContractLookupIndex,
  repo: string,
  role: 'consumer' | 'provider',
  symbolUid: string,
  filePath: string,
  symbolName: string,
): string | null {
  if (symbolUid) {
    const uidHit = index.byUid.get(uidKey(repo, role, symbolUid));
    if (uidHit !== undefined) return uidHit;
  }

  const refHit = index.byRef.get(refKey(repo, role, filePath, symbolName));
  if (refHit !== undefined) return refHit;

  const fileCandidates = index.byFile.get(fileKey(repo, role, filePath));
  if (fileCandidates && fileCandidates.length === 1) return fileCandidates[0];

  return null;
}

export async function openBridgeDb(dbPath: string): Promise<BridgeHandle> {
  const parentDir = path.dirname(dbPath);
  await fsp.mkdir(parentDir, { recursive: true });
  const { db, conn } = await openLbugConnection(lbug, dbPath);
  return { _db: db, _conn: conn, groupDir: parentDir } as BridgeHandle;
}

/**
 * LadybugDB returns an error whose message contains this substring when a
 * CREATE NODE TABLE or CREATE REL TABLE statement hits an already-existing
 * table. LadybugDB DDL doesn't support IF NOT EXISTS, and its JS driver
 * doesn't expose typed error codes, so we match on the message substring —
 * the same pattern used by `core/lbug/lbug-adapter.ts`. If a future
 * LadybugDB release changes the wording, update this constant.
 */
const LBUG_ALREADY_EXISTS_MSG = 'already exists';

export async function ensureBridgeSchema(handle: BridgeHandle): Promise<void> {
  const conn = handle._conn as lbug.Connection;
  for (const q of BRIDGE_SCHEMA_QUERIES) {
    try {
      await conn.query(q);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes(LBUG_ALREADY_EXISTS_MSG)) throw err;
    }
  }
}

export async function queryBridge<T>(
  handle: BridgeHandle,
  cypher: string,
  params?: Record<string, LbugValue>,
): Promise<T[]> {
  const conn = handle._conn as lbug.Connection;
  if (params && Object.keys(params).length > 0) {
    const stmt = await conn.prepare(cypher);
    if (!stmt.isSuccess()) {
      const errMsg = await stmt.getErrorMessage();
      throw new Error(`Bridge query prepare failed: ${errMsg}`);
    }
    const queryResult = await conn.execute(stmt, params);
    const result = unwrapQueryResult(queryResult);
    return (await result.getAll()) as T[];
  }
  const queryResult = await conn.query(cypher);
  const result = unwrapQueryResult(queryResult);
  return (await result.getAll()) as T[];
}

/**
 * LadybugDB's `conn.query` / `conn.execute` can return either a single
 * `QueryResult` (for a single statement) or an array of them (when a
 * multi-statement script is dispatched). We always pass a single statement,
 * so the array form is a wrapper we unwrap here — but an empty top-level
 * array would cause `.getAll()` on `undefined` and crash with a confusing
 * stack. Throwing an explicit error makes a driver-contract regression
 * visible immediately instead of masking it.
 */
function unwrapQueryResult(queryResult: lbug.QueryResult | lbug.QueryResult[]): lbug.QueryResult {
  if (Array.isArray(queryResult)) {
    if (queryResult.length === 0) {
      throw new Error('Bridge query returned an empty QueryResult array');
    }
    return queryResult[0];
  }
  return queryResult;
}

export async function closeBridgeDb(handle: BridgeHandle): Promise<void> {
  // CHECKPOINT before close so the WAL/.shadow contents are flushed into
  // the main database file. Without this, LadybugDB 0.16.0's non-blocking
  // checkpoint thread can outlive the close call and leave sidecar pages
  // pending on disk, which makes a subsequent read-side open either race
  // with the WAL replay or trip the database-id check on the sidecars.
  // CHECKPOINT is a no-op when there's nothing pending, so it's cheap.
  try {
    await (handle._conn as lbug.Connection).query('CHECKPOINT');
  } catch {
    /* ignore — older LadybugDB or schemaless DB may not accept it */
  }
  try {
    await (handle._conn as lbug.Connection).close();
  } catch {
    /* ignore */
  }
  try {
    await (handle._db as lbug.Database).close();
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/*  retryRename — handles transient EBUSY/EPERM/EACCES on Windows    */
/* ------------------------------------------------------------------ */

const RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

export async function retryRename(src: string, dst: string, attempts = 3): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await fsp.rename(src, dst);
      return;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!code || !RETRY_CODES.has(code) || i === attempts) throw err;
      await new Promise((r) => setTimeout(r, 100 * Math.pow(2, i - 1)));
    }
  }
}

/* ------------------------------------------------------------------ */
/*  writeBridgeMeta / readBridgeMeta                                  */
/* ------------------------------------------------------------------ */

export async function writeBridgeMeta(groupDir: string, meta: BridgeMeta): Promise<void> {
  const target = path.join(groupDir, 'meta.json');
  const tmp = `${target}.tmp.${randomBytes(8).toString('hex')}`;
  await fsp.writeFile(tmp, JSON.stringify(meta, null, 2), 'utf-8');
  // Use retryRename for consistency with writeBridge's atomic swap — on
  // Windows a concurrent reader can cause EBUSY/EPERM even on a tiny
  // meta.json, and we don't want meta write to be less robust than the
  // bridge.lbug swap it accompanies.
  await retryRename(tmp, target);
}

export async function readBridgeMeta(groupDir: string): Promise<BridgeMeta> {
  try {
    const content = await fsp.readFile(path.join(groupDir, 'meta.json'), 'utf-8');
    return JSON.parse(content) as BridgeMeta;
  } catch {
    return { version: 0, generatedAt: '', missingRepos: [] };
  }
}

/* ------------------------------------------------------------------ */
/*  writeBridge — atomic write-to-temp-then-rename                    */
/* ------------------------------------------------------------------ */

export interface WriteBridgeInput {
  contracts: StoredContract[];
  crossLinks: CrossLink[];
  repoSnapshots: Record<string, RepoSnapshot>;
  missingRepos: string[];
}

/**
 * Non-fatal issues encountered during writeBridge. Callers can log these to
 * surface partial-success state without aborting the whole sync.
 * `sampleErrors` is capped at MAX_SAMPLE_ERRORS per category to bound memory.
 */
export interface WriteBridgeReport {
  contractsInserted: number;
  contractsFailed: number;
  snapshotsInserted: number;
  snapshotsFailed: number;
  linksInserted: number;
  linksFailed: number;
  /** Cross-links skipped because their from/to contract nodes weren't found. */
  linksDroppedMissingNode: number;
  sampleErrors: Array<{
    kind: 'contract' | 'snapshot' | 'link';
    id: string;
    message: string;
  }>;
}

const MAX_SAMPLE_ERRORS = 10;

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return 'unknown error';
  }
}

export async function writeBridge(
  groupDir: string,
  input: WriteBridgeInput,
): Promise<WriteBridgeReport> {
  await fsp.mkdir(groupDir, { recursive: true });
  const contracts = dedupeContracts(input.contracts);
  const crossLinks = dedupeCrossLinks(input.crossLinks);

  const finalPath = path.join(groupDir, 'bridge.lbug');
  const tmpPath = path.join(groupDir, `bridge.lbug.tmp.${randomBytes(8).toString('hex')}`);
  const bakPath = path.join(groupDir, 'bridge.lbug.bak');

  const report: WriteBridgeReport = {
    contractsInserted: 0,
    contractsFailed: 0,
    snapshotsInserted: 0,
    snapshotsFailed: 0,
    linksInserted: 0,
    linksFailed: 0,
    linksDroppedMissingNode: 0,
    sampleErrors: [],
  };

  const recordError = (kind: 'contract' | 'snapshot' | 'link', id: string, err: unknown) => {
    if (report.sampleErrors.length < MAX_SAMPLE_ERRORS) {
      report.sampleErrors.push({ kind, id, message: errMessage(err) });
    }
  };

  // Clean up stale tmp files left behind by previously crashed writeBridge
  // runs.  With randomBytes-based names each run picks a unique path, so
  // the old fixed-name `removeLbugFile(tmpPath)` was a no-op — stale
  // artifacts accumulated.  The glob-based helper finds *all* leftover
  // `bridge.lbug.tmp.*` entries and removes them (including sidecars).
  await cleanStaleBridgeTmpFiles(groupDir);

  // 1. Create temp DB, insert all data.
  //
  // Everything after `openBridgeDb` must run inside a try/finally so that
  // if ANY step before the explicit `closeBridgeDb` throws — schema
  // creation, a contract insert loop that rethrows, a snapshot write, the
  // cross-link loop, or anything else — the handle is still released. A
  // leaked handle holds the native LadybugDB file lock on tmpPath, which
  // (a) leaks a FD and (b) prevents the next writeBridge call from
  // reusing the same tmp slot.
  const handle = await openBridgeDb(tmpPath);
  let handleClosed = false;
  try {
    await ensureBridgeSchema(handle);

    // Build the lookup index incrementally as contracts are inserted, so
    // failed inserts are never in the index (and therefore never resolved
    // by the cross-link loop below). This replaces a previous N+1 query
    // pattern where each link made up to 6 DB round-trips to find its
    // endpoints — see ContractLookupIndex.
    const lookupIndex = createContractLookupIndex();

    // Insert contracts — tolerate individual failures (e.g., a corrupt meta
    // that can't be serialized). The whole sync must not fail because one
    // contract is broken.
    for (const c of contracts) {
      const id = contractNodeId(c.repo, c.contractId, c.role, c.symbolRef.filePath);
      try {
        await queryBridge(
          handle,
          `CREATE (n:Contract {
      id: $id,
      contractId: $contractId,
      type: $type,
      role: $role,
      repo: $repo,
      service: $service,
      symbolUid: $symbolUid,
      filePath: $filePath,
      symbolName: $symbolName,
      confidence: $confidence,
      meta: $meta
    })`,
          {
            id,
            contractId: c.contractId,
            type: c.type,
            role: c.role,
            repo: c.repo,
            service: c.service ?? '',
            symbolUid: c.symbolUid,
            filePath: c.symbolRef.filePath,
            symbolName: c.symbolName,
            confidence: c.confidence,
            meta: JSON.stringify(c.meta),
          },
        );
        report.contractsInserted++;
        // Only index on successful insert — the cross-link loop must never
        // resolve to a row that isn't actually in the DB.
        indexContract(lookupIndex, c, id);
      } catch (err) {
        report.contractsFailed++;
        recordError('contract', id, err);
      }
    }

    // Insert repo snapshots
    for (const [repoId, snap] of Object.entries(input.repoSnapshots)) {
      try {
        await queryBridge(
          handle,
          `CREATE (s:RepoSnapshot {
      id: $id,
      indexedAt: $indexedAt,
      lastCommit: $lastCommit
    })`,
          {
            id: repoId,
            indexedAt: snap.indexedAt,
            lastCommit: snap.lastCommit,
          },
        );
        report.snapshotsInserted++;
      } catch (err) {
        report.snapshotsFailed++;
        recordError('snapshot', repoId, err);
      }
    }

    // Insert cross-links (tolerating missing nodes).
    //
    // `findContractNode` consults the in-memory lookup index built above,
    // not the DB — that's an O(1) pure-function lookup per endpoint instead
    // of the previous 2-3 DB queries. For M cross-links, the previous code
    // issued up to 6M round-trips; this version issues zero.
    //
    // `link.contractId` may differ between the consumer and provider sides
    // (e.g. wildcard consumer `grpc::Service/*` → method-level provider
    // `grpc::Service/Method`) — that's why we resolve each endpoint
    // independently via its own `(repo, role, symbolUid, filePath, symbolName)`
    // tuple rather than matching on contractId.
    for (const link of crossLinks) {
      const linkId = `${link.from.repo}::${link.contractId}->${link.to.repo}::${link.contractId}`;
      try {
        const fromId = findContractNode(
          lookupIndex,
          link.from.repo,
          'consumer',
          link.from.symbolUid,
          link.from.symbolRef.filePath,
          link.from.symbolRef.name,
        );
        const toId = findContractNode(
          lookupIndex,
          link.to.repo,
          'provider',
          link.to.symbolUid,
          link.to.symbolRef.filePath,
          link.to.symbolRef.name,
        );
        if (!fromId || !toId) {
          report.linksDroppedMissingNode++;
          continue;
        }
        await queryBridge(
          handle,
          `
      MATCH (a:Contract), (b:Contract)
      WHERE a.id = $fromId AND b.id = $toId
      CREATE (a)-[:ContractLink {
        matchType: $matchType,
        confidence: $confidence,
        contractId: $contractId,
        fromRepo: $fromRepo,
        toRepo: $toRepo
      }]->(b)
    `,
          {
            fromId,
            toId,
            matchType: link.matchType,
            confidence: link.confidence,
            contractId: link.contractId,
            fromRepo: link.from.repo,
            toRepo: link.to.repo,
          },
        );
        report.linksInserted++;
      } catch (err) {
        report.linksFailed++;
        recordError('link', linkId, err);
      }
    }

    // 2. Close temp DB (happy path). The finally block also calls
    //    closeBridgeDb if we threw above; `handleClosed` prevents a
    //    double-close on the native handle.
    await closeBridgeDb(handle);
    handleClosed = true;
  } finally {
    if (!handleClosed) {
      await closeBridgeDb(handle).catch(() => {
        /* ignore: cleanup path, best effort */
      });
    }
  }

  // 3. Atomic swap: old→.bak, tmp→final, rm .bak
  //
  // The current database file (with its `.wal` / `.shadow` sidecars) is
  // moved aside, then the freshly built tmp database takes its place.
  // We move the sidecars together with the main file so the open below
  // and any external readers see a consistent set; orphan sidecars from
  // the tmp namespace are then removed because LadybugDB looks for them
  // under the renamed-to base name and would reject mismatching IDs.
  try {
    await fsp.access(finalPath);
    await retryRename(finalPath, bakPath);
    for (const suffix of LBUG_SIDECAR_SUFFIXES) {
      try {
        await fsp.access(`${finalPath}${suffix}`);
        await retryRename(`${finalPath}${suffix}`, `${bakPath}${suffix}`);
      } catch {
        /* sidecar absent — nothing to move */
      }
    }
  } catch {
    /* no existing db */
  }
  await retryRename(tmpPath, finalPath);
  for (const suffix of LBUG_SIDECAR_SUFFIXES) {
    // Rename — not delete — so the WAL (which may carry uncommitted-at-
    // close-time pages on a graceful close, depending on
    // `autoCheckpoint` / `checkpointThreshold`) and the `.shadow`
    // checkpoint snapshot stay paired with the database file under its
    // final name. LadybugDB 0.16.0's database-id check rejects an open
    // when the sidecars belong to a different base name.
    try {
      await fsp.access(`${tmpPath}${suffix}`);
      await retryRename(`${tmpPath}${suffix}`, `${finalPath}${suffix}`);
    } catch {
      /* sidecar absent — nothing to move */
    }
  }
  await removeLbugFile(bakPath);

  // 4. Write meta.json
  await writeBridgeMeta(groupDir, {
    version: BRIDGE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    missingRepos: input.missingRepos,
  });

  return report;
}

/* ------------------------------------------------------------------ */
/*  openBridgeDbReadOnly                                               */
/* ------------------------------------------------------------------ */

/**
 * Substrings observed in the message of an `Error` raised by the LadybugDB
 * native open path when Windows still holds an exclusive lock on the file
 * after a writer's `Database.close()` returned. LadybugDB 0.16.0's
 * non-blocking checkpoint thread can briefly outlive the close call, so a
 * read-side opener that races in immediately afterwards sees Win32 error
 * 33 ("The process cannot access the file because another process has
 * locked a portion of the file"). Retrying with a small back-off lets the
 * background thread settle and the OS release the handle.
 */
const LBUG_OPEN_RETRY_PATTERNS = [
  'process cannot access the file',
  'another process has locked',
  'could not set lock',
  'lock held by another process',
];

const LBUG_OPEN_RETRY_ATTEMPTS = 10;
const LBUG_OPEN_RETRY_BASE_MS = 100;
/** Cap individual back-off delays so the total wait is bounded (~3s). */
const LBUG_OPEN_RETRY_MAX_MS = 500;

function isTransientLockError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return LBUG_OPEN_RETRY_PATTERNS.some((p) => msg.includes(p));
}

async function ensureBridgeDbFileAvailable(groupDir: string): Promise<boolean> {
  const dbPath = path.join(groupDir, 'bridge.lbug');
  try {
    await fsp.access(dbPath);
    return true;
  } catch {
    // Check for .bak recovery. Use `retryRename` (not `fsp.rename`) for the
    // exact same reason the rest of this file does: the scenario that
    // triggers bak recovery is an interrupted writer, which on Windows may
    // still be holding an open handle on `.bak` for a few milliseconds when
    // a reader races in. EBUSY/EPERM retries recover that case silently.
    const bakPath = path.join(groupDir, 'bridge.lbug.bak');
    try {
      await fsp.access(bakPath);
      await retryRename(bakPath, dbPath);
      for (const suffix of LBUG_SIDECAR_SUFFIXES) {
        try {
          await fsp.access(`${bakPath}${suffix}`);
          await retryRename(`${bakPath}${suffix}`, `${dbPath}${suffix}`);
        } catch {
          /* sidecar absent */
        }
      }
      return true;
    } catch {
      return false;
    }
  }
}

export async function openBridgeDbReadOnly(groupDir: string): Promise<BridgeHandle | null> {
  const dbPath = path.join(groupDir, 'bridge.lbug');
  if (!(await ensureBridgeDbFileAvailable(groupDir))) return null;

  // Version gate: check meta.json version compatibility
  const meta = await readBridgeMeta(groupDir);
  if (meta.version > 0 && meta.version !== BRIDGE_SCHEMA_VERSION) {
    return null; // incompatible schema version — fallback to JSON or re-sync
  }

  // Open the native handle with a bounded retry on transient OS-level file
  // locks (see LBUG_OPEN_RETRY_PATTERNS). If Connection construction throws
  // AFTER Database was successfully allocated, we'd leak the native Database
  // object — wrap each step separately and tear down the partial handle.
  let lastErr: unknown;
  for (let attempt = 1; attempt <= LBUG_OPEN_RETRY_ATTEMPTS; attempt++) {
    let handle: LbugConnectionHandle | undefined;
    try {
      handle = await openLbugConnection(lbug, dbPath, { readOnly: true });
      // Force the lazy native init now so a transient lock surfaces here
      // (where we can retry) instead of on the first user query.
      await handle.db.init();
      await handle.conn.init();
      return { _db: handle.db, _conn: handle.conn, groupDir } as BridgeHandle;
    } catch (err) {
      lastErr = err;
      if (handle) await closeLbugConnection(handle);
      if (!isTransientLockError(err) || attempt === LBUG_OPEN_RETRY_ATTEMPTS) break;
      const delay = Math.min(LBUG_OPEN_RETRY_BASE_MS * attempt, LBUG_OPEN_RETRY_MAX_MS);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  if (process.env.GITNEXUS_DEBUG_BRIDGE) {
    console.warn(
      `[bridge-db] openBridgeDbReadOnly(${groupDir}) gave up after ` +
        `${LBUG_OPEN_RETRY_ATTEMPTS} attempts: ${
          lastErr instanceof Error ? lastErr.message : String(lastErr)
        }`,
    );
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  bridgeExists                                                       */
/* ------------------------------------------------------------------ */

export async function bridgeExists(groupDir: string): Promise<boolean> {
  if (!(await ensureBridgeDbFileAvailable(groupDir))) return false;
  const meta = await readBridgeMeta(groupDir);
  return meta.version === 0 || meta.version === BRIDGE_SCHEMA_VERSION;
}
