import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import lbug from '@ladybugdb/core';
import type { LbugValue } from '@ladybugdb/core';
import type { BridgeHandle, BridgeMeta, StoredContract, CrossLink, RepoSnapshot } from './types.js';
import { BRIDGE_SCHEMA_QUERIES, BRIDGE_SCHEMA_VERSION } from './bridge-schema.js';
import { dedupeContracts, dedupeCrossLinks } from './normalization.js';

export function contractNodeId(
  repo: string,
  contractId: string,
  role: string,
  filePath: string,
): string {
  return createHash('sha256').update(`${repo}\0${contractId}\0${role}\0${filePath}`).digest('hex');
}

export async function openBridgeDb(dbPath: string): Promise<BridgeHandle> {
  const parentDir = path.dirname(dbPath);
  await fsp.mkdir(parentDir, { recursive: true });
  const db = new lbug.Database(dbPath, 0, false, false); // writable
  const conn = new lbug.Connection(db);
  return { _db: db, _conn: conn, groupDir: parentDir } as BridgeHandle;
}

export async function ensureBridgeSchema(handle: BridgeHandle): Promise<void> {
  const conn = handle._conn as lbug.Connection;
  for (const q of BRIDGE_SCHEMA_QUERIES) {
    try {
      await conn.query(q);
    } catch (err: any) {
      const msg = err?.message ?? '';
      if (!msg.includes('already exists')) throw err;
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
    const result = Array.isArray(queryResult) ? queryResult[0] : queryResult;
    return (await result.getAll()) as T[];
  }
  const queryResult = await conn.query(cypher);
  const result = Array.isArray(queryResult) ? queryResult[0] : queryResult;
  return (await result.getAll()) as T[];
}

export async function closeBridgeDb(handle: BridgeHandle): Promise<void> {
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

async function retryRename(src: string, dst: string, attempts = 3): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await fsp.rename(src, dst);
      return;
    } catch (err: any) {
      if (!RETRY_CODES.has(err.code) || i === attempts) throw err;
      await new Promise((r) => setTimeout(r, 100 * Math.pow(2, i - 1)));
    }
  }
}

/* ------------------------------------------------------------------ */
/*  writeBridgeMeta / readBridgeMeta                                  */
/* ------------------------------------------------------------------ */

export async function writeBridgeMeta(groupDir: string, meta: BridgeMeta): Promise<void> {
  const target = path.join(groupDir, 'meta.json');
  const tmp = `${target}.tmp.${Date.now()}`;
  await fsp.writeFile(tmp, JSON.stringify(meta, null, 2), 'utf-8');
  await fsp.rename(tmp, target);
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

export async function writeBridge(groupDir: string, input: WriteBridgeInput): Promise<void> {
  await fsp.mkdir(groupDir, { recursive: true });
  const contracts = dedupeContracts(input.contracts);
  const crossLinks = dedupeCrossLinks(input.crossLinks);

  const finalPath = path.join(groupDir, 'bridge.lbug');
  const tmpPath = path.join(groupDir, 'bridge.lbug.tmp');
  const bakPath = path.join(groupDir, 'bridge.lbug.bak');

  // Clean up any leftover tmp
  try {
    await fsp.rm(tmpPath, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  // 1. Create temp DB, insert all data
  const handle = await openBridgeDb(tmpPath);
  await ensureBridgeSchema(handle);

  // Insert contracts
  for (const c of contracts) {
    const id = contractNodeId(c.repo, c.contractId, c.role, c.symbolRef.filePath);
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
  }

  // Insert repo snapshots
  for (const [repoId, snap] of Object.entries(input.repoSnapshots)) {
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
  }

  // Insert cross-links (tolerating missing nodes).
  // Use repo-scoped matching: find FROM node by (repo, role=consumer) and TO by (repo, role=provider)
  // with symbolRef matching, because link.contractId is the consumer's ID which may differ
  // from the provider's contractId (e.g. wildcard consumer vs method-level provider).
  const findContractNode = async (
    repo: string,
    role: 'consumer' | 'provider',
    symbolUid: string,
    filePath: string,
    symbolName: string,
  ): Promise<string | null> => {
    if (symbolUid) {
      const uidRows = await queryBridge<{ id: string }>(
        handle,
        `MATCH (c:Contract) WHERE c.repo = $repo AND c.role = $role
         AND c.symbolUid = $symbolUid RETURN c.id AS id LIMIT 1`,
        { repo, role, symbolUid },
      );
      if (uidRows.length > 0) return uidRows[0].id;
    }

    const refRows = await queryBridge<{ id: string }>(
      handle,
      `MATCH (c:Contract) WHERE c.repo = $repo AND c.role = $role
       AND c.filePath = $filePath AND c.symbolName = $symbolName
       RETURN c.id AS id LIMIT 1`,
      { repo, role, filePath, symbolName },
    );
    if (refRows.length > 0) return refRows[0].id;

    const fileRows = await queryBridge<{ id: string }>(
      handle,
      `MATCH (c:Contract) WHERE c.repo = $repo AND c.role = $role
       AND c.filePath = $filePath
       RETURN c.id AS id LIMIT 2`,
      { repo, role, filePath },
    );
    if (fileRows.length === 1) return fileRows[0].id;
    return null;
  };

  for (const link of crossLinks) {
    const fromId = await findContractNode(
      link.from.repo,
      'consumer',
      link.from.symbolUid,
      link.from.symbolRef.filePath,
      link.from.symbolRef.name,
    );
    const toId = await findContractNode(
      link.to.repo,
      'provider',
      link.to.symbolUid,
      link.to.symbolRef.filePath,
      link.to.symbolRef.name,
    );
    if (!fromId || !toId) continue;
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
  }

  // 2. Close temp DB
  await closeBridgeDb(handle);

  // 3. Atomic swap: old→.bak, tmp→final, rm .bak
  try {
    await fsp.access(finalPath);
    await retryRename(finalPath, bakPath);
  } catch {
    /* no existing db */
  }
  await retryRename(tmpPath, finalPath);
  try {
    await fsp.rm(bakPath, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  // 4. Write meta.json
  await writeBridgeMeta(groupDir, {
    version: BRIDGE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    missingRepos: input.missingRepos,
  });
}

/* ------------------------------------------------------------------ */
/*  openBridgeDbReadOnly                                               */
/* ------------------------------------------------------------------ */

export async function openBridgeDbReadOnly(groupDir: string): Promise<BridgeHandle | null> {
  const dbPath = path.join(groupDir, 'bridge.lbug');
  try {
    await fsp.access(dbPath);
  } catch {
    // Check for .bak recovery
    const bakPath = path.join(groupDir, 'bridge.lbug.bak');
    try {
      await fsp.access(bakPath);
      await fsp.rename(bakPath, dbPath);
    } catch {
      return null;
    }
  }
  // Version gate: check meta.json version compatibility
  const meta = await readBridgeMeta(groupDir);
  if (meta.version > 0 && meta.version !== BRIDGE_SCHEMA_VERSION) {
    return null; // incompatible schema version — fallback to JSON or re-sync
  }

  try {
    const db = new lbug.Database(dbPath, 0, false, true); // readOnly
    const conn = new lbug.Connection(db);
    return { _db: db, _conn: conn, groupDir } as BridgeHandle;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  bridgeExists                                                       */
/* ------------------------------------------------------------------ */

export async function bridgeExists(groupDir: string): Promise<boolean> {
  const handle = await openBridgeDbReadOnly(groupDir);
  if (!handle) return false;
  await closeBridgeDb(handle);
  return true;
}
