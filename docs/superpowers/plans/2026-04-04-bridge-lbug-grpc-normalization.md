# Bridge.lbug & gRPC Canonical ID Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate contract storage from `contracts.json` to LadybugDB (`bridge.lbug`) and fix gRPC normalization mismatch via proto-aware extraction.

**Architecture:** Two independent components — (1) bridge.lbug: new `bridge-db.ts` module for LadybugDB lifecycle, `bridge-schema.ts` for DDL, consumer migration in storage/service/cross-impact/sync/CLI; (2) gRPC: `buildProtoMap()` + `resolveProtoConflict()` in grpc-extractor, `serviceContractId()`, wildcard matching in matching.ts. Both integrate at `sync.ts` where matching → write happens.

**Tech Stack:** TypeScript, LadybugDB (DuckDB-based graph DB), Vitest, Node.js `node:crypto` for SHA-256.

**Spec:** [`docs/superpowers/specs/2026-04-03-bridge-lbug-grpc-normalization-design.md`](../specs/2026-04-03-bridge-lbug-grpc-normalization-design.md)

---

## File Map

### New Files
| File | Responsibility |
|------|---------------|
| `src/core/group/bridge-schema.ts` | DDL constants for Contract, RepoSnapshot, ContractLink tables; `BRIDGE_SCHEMA_VERSION` |
| `src/core/group/bridge-db.ts` | `openBridgeDb`, `ensureBridgeSchema`, `writeBridge`, `queryBridge`, `closeBridgeDb`, `openBridgeDbReadOnly`, `bridgeExists`, `readBridgeMeta`, `writeBridgeMeta`, `retryRename`, `contractNodeId` |
| `test/unit/group/bridge-db.test.ts` | Unit tests for bridge-db.ts |
| `test/integration/group/bridge-sync.test.ts` | Integration tests for bridge.lbug through syncGroup |

### Modified Files
| File | What Changes |
|------|-------------|
| `src/core/group/types.ts` | Add `BridgeHandle`, `BridgeMeta`, `LegacyContractRegistry`; add `'wildcard'` to `MatchType` |
| `src/core/group/storage.ts` | Remove `writeContractRegistry`, `readContractRegistry`, `CONTRACTS_FILE`; keep as `readContractRegistryJson` (private); add `openBridgeOrFallback` (imports from bridge-db.ts) |
| `src/core/group/matching.ts` | Export `buildProviderIndex`; `runExactMatch` skips gRPC `/*`; add `runWildcardMatch` |
| `src/core/group/extractors/grpc-extractor.ts` | Add `buildProtoMap`, `resolveProtoConflict`, `serviceContractId`; modify 4 source scanners |
| `src/core/group/sync.ts` | Replace `writeContractRegistry` with `writeBridge`; add wildcard pass |
| `src/core/group/cross-impact.ts` | New `runGroupImpact` with `bridgeQuery`; rename old to `runGroupImpactLegacy` |
| `src/core/group/service.ts` | Use `openBridgeOrFallback`; extend `crossImpactFn` with hint |
| `src/cli/group.ts` | Update sync/impact/status commands |
| `src/mcp/tools.ts` | Update tool descriptions (remove `contracts.json` references) |
| `src/mcp/local/local-backend.ts` | Update `groupImpact`, `groupContracts` |
| `test/unit/group/matching.test.ts` | Add wildcard match tests |
| `test/unit/group/grpc-extractor.test.ts` | Add proto map + canonical ID tests |
| `test/unit/group/cross-impact.test.ts` | Direction-dependent Cypher, ref fallback, hint |
| `test/unit/group/sync.test.ts` | Update for bridge.lbug + wildcard pass |
| `test/unit/group/service.test.ts` | Update for openBridgeOrFallback |
| `test/unit/group/storage.test.ts` | Update for removed functions |
| `test/unit/tools.test.ts` | Update tool description assertions if any |
| `test/integration/group/group-impact.test.ts` | Update for bridge.lbug |

---

## Task 1: Types & Schema Foundation

**Files:**
- Modify: `gitnexus/src/core/group/types.ts`
- Create: `gitnexus/src/core/group/bridge-schema.ts`

- [ ] **Step 1: Add new types to `types.ts`**

At the top of `gitnexus/src/core/group/types.ts`, after the existing `MatchType`:

```typescript
// Line 2: update MatchType
export type MatchType = 'exact' | 'manifest' | 'wildcard' | 'bm25' | 'embedding';
```

At the end of `types.ts`, after `OutOfScopeLink`:

```typescript
/**
 * @deprecated Use bridge.lbug instead. Kept for JSON fallback during migration.
 * This is a type alias — ContractRegistry is NOT removed yet.
 * In Task 10 (cleanup), ContractRegistry will be renamed to LegacyContractRegistry
 * and all imports updated. For now, both names work.
 */
export type LegacyContractRegistry = ContractRegistry;

/** Opaque handle to an open bridge LadybugDB. */
export interface BridgeHandle {
  /** Internal — do not access directly. */
  readonly _db: unknown;
  readonly _conn: unknown;
  readonly groupDir: string;
}

export interface BridgeMeta {
  version: number;
  generatedAt: string;
  missingRepos: string[];
}
```

- [ ] **Step 2: Create `bridge-schema.ts`**

Create `gitnexus/src/core/group/bridge-schema.ts`:

```typescript
/**
 * Bridge LadybugDB schema for cross-repo Contract Registry.
 * Separate from per-repo schema in lbug/schema.ts.
 */

export const BRIDGE_SCHEMA_VERSION = 1;

export const CONTRACT_SCHEMA = `
CREATE NODE TABLE Contract (
  id STRING,
  contractId STRING,
  type STRING,
  role STRING,
  repo STRING,
  service STRING DEFAULT '',
  symbolUid STRING DEFAULT '',
  filePath STRING DEFAULT '',
  symbolName STRING DEFAULT '',
  confidence DOUBLE DEFAULT 0.0,
  meta STRING DEFAULT '{}',
  PRIMARY KEY (id)
)`;

export const REPO_SNAPSHOT_SCHEMA = `
CREATE NODE TABLE RepoSnapshot (
  id STRING,
  indexedAt STRING DEFAULT '',
  lastCommit STRING DEFAULT '',
  PRIMARY KEY (id)
)`;

export const CONTRACT_LINK_SCHEMA = `
CREATE REL TABLE ContractLink (
  FROM Contract TO Contract,
  matchType STRING,
  confidence DOUBLE,
  contractId STRING,
  fromRepo STRING,
  toRepo STRING
)`;

export const BRIDGE_SCHEMA_QUERIES = [
  CONTRACT_SCHEMA,
  REPO_SNAPSHOT_SCHEMA,
  CONTRACT_LINK_SCHEMA,
];
```

- [ ] **Step 3: Verify build**

Run: `cd gitnexus && npm run build`
Expected: Clean build, no errors.

- [ ] **Step 4: Commit**

```bash
git add gitnexus/src/core/group/types.ts gitnexus/src/core/group/bridge-schema.ts
git commit -m "feat(group): add BridgeHandle/BridgeMeta types and bridge schema DDL"
```

---

## Task 2: Bridge DB Core — Open, Schema, Query, Close

**Files:**
- Create: `gitnexus/src/core/group/bridge-db.ts`
- Create: `gitnexus/test/unit/group/bridge-db.test.ts`

- [ ] **Step 1: Write failing tests for open/schema/query/close**

Create `gitnexus/test/unit/group/bridge-db.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  openBridgeDb,
  ensureBridgeSchema,
  queryBridge,
  closeBridgeDb,
} from '../../../src/core/group/bridge-db.js';

describe('bridge-db core', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('test_openBridgeDb_creates_file_and_closes', async () => {
    const dbPath = path.join(tmpDir, 'test.lbug');
    const handle = await openBridgeDb(dbPath);
    expect(handle).toBeDefined();
    expect(handle.groupDir).toBe(tmpDir);
    await closeBridgeDb(handle);
    // File should exist after close
    await expect(fs.access(dbPath)).resolves.toBeUndefined();
  });

  it('test_ensureBridgeSchema_creates_tables_idempotent', async () => {
    const dbPath = path.join(tmpDir, 'test.lbug');
    const handle = await openBridgeDb(dbPath);
    await ensureBridgeSchema(handle);
    // Run again — should not throw
    await ensureBridgeSchema(handle);
    // Verify tables exist by inserting a dummy node
    const rows = await queryBridge<{ cnt: number }>(
      handle,
      'MATCH (c:Contract) RETURN count(c) AS cnt',
    );
    expect(rows[0].cnt).toBe(0);
    await closeBridgeDb(handle);
  });

  it('test_queryBridge_returns_inserted_data', async () => {
    const dbPath = path.join(tmpDir, 'test.lbug');
    const handle = await openBridgeDb(dbPath);
    await ensureBridgeSchema(handle);
    await queryBridge(handle, `CREATE (c:Contract {
      id: 'abc123', contractId: 'http::GET::/api', type: 'http', role: 'provider',
      repo: 'backend', confidence: 0.9
    })`);
    const rows = await queryBridge<{ repo: string; confidence: number }>(
      handle,
      'MATCH (c:Contract) RETURN c.repo AS repo, c.confidence AS confidence',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].repo).toBe('backend');
    expect(rows[0].confidence).toBe(0.9);
    await closeBridgeDb(handle);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd gitnexus && npx vitest run test/unit/group/bridge-db.test.ts`
Expected: FAIL — `bridge-db.js` doesn't exist.

- [ ] **Step 3: Implement bridge-db.ts core functions**

Create `gitnexus/src/core/group/bridge-db.ts`:

```typescript
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { BridgeHandle, BridgeMeta, StoredContract, CrossLink, RepoSnapshot } from './types.js';
import { BRIDGE_SCHEMA_QUERIES, BRIDGE_SCHEMA_VERSION } from './bridge-schema.js';

// LadybugDB native binding — same import path as pool-adapter.ts:19
import lbug from '@ladybugdb/core';

export function contractNodeId(
  repo: string, contractId: string, role: string, filePath: string,
): string {
  return createHash('sha256')
    .update(`${repo}\0${contractId}\0${role}\0${filePath}`)
    .digest('hex');
}

export async function openBridgeDb(dbPath: string): Promise<BridgeHandle> {
  const parentDir = path.dirname(dbPath);
  await fsp.mkdir(parentDir, { recursive: true });
  // LadybugDB constructor: (path, bufferManagerSize, enableCompression, readOnly)
  // See pool-adapter.ts:265-270 for reference
  const db = new lbug.Database(dbPath, 0, false, false); // writable
  const conn = new lbug.Connection(db);
  return { _db: db, _conn: conn, groupDir: parentDir } as BridgeHandle;
}

export async function ensureBridgeSchema(handle: BridgeHandle): Promise<void> {
  const conn = handle._conn as any;
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
  params?: Record<string, unknown>,
): Promise<T[]> {
  const conn = handle._conn as any;
  if (params && Object.keys(params).length > 0) {
    // Parameterized query — same pattern as pool-adapter.ts:524-532
    const stmt = await conn.prepare(cypher);
    if (!stmt.isSuccess()) {
      const errMsg = await stmt.getErrorMessage();
      throw new Error(`Prepare failed: ${errMsg}`);
    }
    const queryResult = await conn.execute(stmt, params);
    const result = Array.isArray(queryResult) ? queryResult[0] : queryResult;
    return (await result.getAll()) as T[];
  }
  const result = await conn.query(cypher);
  return (Array.isArray(result) ? await result[0].getAll() : await result.getAll()) as T[];
}

export async function closeBridgeDb(handle: BridgeHandle): Promise<void> {
  try {
    const conn = handle._conn as any;
    await conn.close();  // async — must await before renaming files on Windows
  } catch { /* ignore */ }
  try {
    const db = handle._db as any;
    await db.close();
  } catch { /* ignore */ }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd gitnexus && npx vitest run test/unit/group/bridge-db.test.ts`
Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add gitnexus/src/core/group/bridge-db.ts gitnexus/test/unit/group/bridge-db.test.ts
git commit -m "feat(group): bridge-db core — open, schema, query, close"
```

---

## Task 3: Bridge DB — writeBridge, readBridgeMeta, openBridgeDbReadOnly

**Files:**
- Modify: `gitnexus/src/core/group/bridge-db.ts`
- Modify: `gitnexus/test/unit/group/bridge-db.test.ts`

- [ ] **Step 1: Write failing tests for writeBridge round-trip**

Append to `gitnexus/test/unit/group/bridge-db.test.ts`:

```typescript
import {
  writeBridge,
  openBridgeDbReadOnly,
  readBridgeMeta,
  bridgeExists,
} from '../../../src/core/group/bridge-db.js';
import type { StoredContract, CrossLink, RepoSnapshot } from '../../../src/core/group/types.js';

describe('writeBridge + read', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-write-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const makeContract = (overrides: Partial<StoredContract> = {}): StoredContract => ({
    contractId: 'http::GET::/api/users',
    type: 'http',
    role: 'provider',
    symbolUid: 'uid-1',
    symbolRef: { filePath: 'src/routes.ts', name: 'getUsers' },
    symbolName: 'getUsers',
    confidence: 0.85,
    meta: {},
    repo: 'backend',
    ...overrides,
  });

  it('test_writeBridge_creates_bridge_lbug_file', async () => {
    await writeBridge(tmpDir, {
      contracts: [makeContract()],
      crossLinks: [],
      repoSnapshots: { backend: { indexedAt: '2026-01-01', lastCommit: 'abc' } },
      missingRepos: ['missing-repo'],
    });
    const exists = await bridgeExists(tmpDir);
    expect(exists).toBe(true);
  });

  it('test_writeBridge_contracts_queryable', async () => {
    await writeBridge(tmpDir, {
      contracts: [makeContract(), makeContract({ repo: 'frontend', role: 'consumer' })],
      crossLinks: [],
      repoSnapshots: {},
      missingRepos: [],
    });
    const handle = await openBridgeDbReadOnly(tmpDir);
    expect(handle).not.toBeNull();
    const rows = await queryBridge<{ repo: string }>(handle!, 'MATCH (c:Contract) RETURN c.repo AS repo');
    expect(rows).toHaveLength(2);
    await closeBridgeDb(handle!);
  });

  it('test_writeBridge_meta_json_persists_missingRepos', async () => {
    await writeBridge(tmpDir, {
      contracts: [],
      crossLinks: [],
      repoSnapshots: {},
      missingRepos: ['repo-a', 'repo-b'],
    });
    const meta = await readBridgeMeta(tmpDir);
    expect(meta.missingRepos).toEqual(['repo-a', 'repo-b']);
    expect(meta.version).toBeGreaterThan(0);
    expect(meta.generatedAt).toBeTruthy();
  });

  it('test_writeBridge_repoSnapshots_queryable', async () => {
    await writeBridge(tmpDir, {
      contracts: [],
      crossLinks: [],
      repoSnapshots: { 'hr/backend': { indexedAt: '2026-01-01', lastCommit: 'abc' } },
      missingRepos: [],
    });
    const handle = await openBridgeDbReadOnly(tmpDir);
    const rows = await queryBridge<{ id: string; indexedAt: string }>(
      handle!,
      'MATCH (s:RepoSnapshot) RETURN s.id AS id, s.indexedAt AS indexedAt',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('hr/backend');
    expect(rows[0].indexedAt).toBe('2026-01-01');
    await closeBridgeDb(handle!);
  });

  it('test_writeBridge_crossLinks_queryable', async () => {
    const provider = makeContract({ repo: 'backend', role: 'provider' });
    const consumer = makeContract({ repo: 'frontend', role: 'consumer', filePath: 'src/api.ts', symbolName: 'fetchUsers' });
    const link: CrossLink = {
      from: { repo: 'frontend', symbolUid: '', symbolRef: { filePath: 'src/api.ts', name: 'fetchUsers' } },
      to: { repo: 'backend', symbolUid: 'uid-1', symbolRef: { filePath: 'src/routes.ts', name: 'getUsers' } },
      type: 'http',
      contractId: 'http::GET::/api/users',
      matchType: 'exact',
      confidence: 1.0,
    };
    await writeBridge(tmpDir, {
      contracts: [provider, consumer],
      crossLinks: [link],
      repoSnapshots: {},
      missingRepos: [],
    });
    const handle = await openBridgeDbReadOnly(tmpDir);
    const rows = await queryBridge<{ fromRepo: string; toRepo: string; matchType: string }>(
      handle!,
      'MATCH (a:Contract)-[l:ContractLink]->(b:Contract) RETURN l.fromRepo AS fromRepo, l.toRepo AS toRepo, l.matchType AS matchType',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].fromRepo).toBe('frontend');
    expect(rows[0].toRepo).toBe('backend');
    expect(rows[0].matchType).toBe('exact');
    await closeBridgeDb(handle!);
  });

  it('test_openBridgeDbReadOnly_returns_null_for_missing', async () => {
    const handle = await openBridgeDbReadOnly(path.join(tmpDir, 'nonexistent'));
    expect(handle).toBeNull();
  });

  it('test_bridgeExists_false_for_missing', async () => {
    expect(await bridgeExists(path.join(tmpDir, 'nonexistent'))).toBe(false);
  });

  it('test_writeBridge_overwrites_previous', async () => {
    await writeBridge(tmpDir, {
      contracts: [makeContract()],
      crossLinks: [],
      repoSnapshots: {},
      missingRepos: [],
    });
    await writeBridge(tmpDir, {
      contracts: [makeContract({ repo: 'new-repo' })],
      crossLinks: [],
      repoSnapshots: {},
      missingRepos: [],
    });
    const handle = await openBridgeDbReadOnly(tmpDir);
    const rows = await queryBridge<{ repo: string }>(handle!, 'MATCH (c:Contract) RETURN c.repo AS repo');
    expect(rows).toHaveLength(1);
    expect(rows[0].repo).toBe('new-repo');
    await closeBridgeDb(handle!);
  });

  it('test_readBridgeMeta_returns_defaults_for_missing', async () => {
    const meta = await readBridgeMeta(path.join(tmpDir, 'nonexistent'));
    expect(meta.version).toBe(0);
    expect(meta.generatedAt).toBe('');
    expect(meta.missingRepos).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd gitnexus && npx vitest run test/unit/group/bridge-db.test.ts`
Expected: FAIL — `writeBridge` etc. not exported.

- [ ] **Step 3: Implement writeBridge, readBridgeMeta, openBridgeDbReadOnly, bridgeExists**

Append to `gitnexus/src/core/group/bridge-db.ts`:

```typescript
const RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

async function retryRename(src: string, dst: string, attempts = 3): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try { await fsp.rename(src, dst); return; } catch (err: any) {
      if (!RETRY_CODES.has(err.code) || i === attempts) throw err;
      await new Promise(r => setTimeout(r, 100 * Math.pow(2, i - 1)));
    }
  }
}

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

export async function writeBridge(
  groupDir: string,
  data: {
    contracts: StoredContract[];
    crossLinks: CrossLink[];
    repoSnapshots: Record<string, RepoSnapshot>;
    missingRepos: string[];
  },
): Promise<void> {
  const tempPath = path.join(groupDir, 'bridge.lbug.tmp');
  const finalPath = path.join(groupDir, 'bridge.lbug');

  await fsp.rm(tempPath, { force: true });
  const tempHandle = await openBridgeDb(tempPath);
  try {
    await ensureBridgeSchema(tempHandle);

    // Insert contracts
    for (const c of data.contracts) {
      const id = contractNodeId(c.repo, c.contractId, c.role, c.symbolRef.filePath);
      await queryBridge(tempHandle, `CREATE (n:Contract {
        id: $id, contractId: $contractId, type: $type, role: $role,
        repo: $repo, service: $service, symbolUid: $symbolUid,
        filePath: $filePath, symbolName: $symbolName,
        confidence: $confidence, meta: $meta
      })`, {
        id, contractId: c.contractId, type: c.type, role: c.role,
        repo: c.repo, service: c.service ?? '', symbolUid: c.symbolUid,
        filePath: c.symbolRef.filePath, symbolName: c.symbolName,
        confidence: c.confidence, meta: JSON.stringify(c.meta),
      });
    }

    // Insert cross-links
    for (const link of data.crossLinks) {
      const fromId = contractNodeId(
        link.from.repo, link.contractId, 'consumer', link.from.symbolRef.filePath,
      );
      const toId = contractNodeId(
        link.to.repo, link.contractId, 'provider', link.to.symbolRef.filePath,
      );
      await queryBridge(tempHandle, `
        MATCH (a:Contract), (b:Contract)
        WHERE a.id = $fromId AND b.id = $toId
        CREATE (a)-[:ContractLink {
          matchType: $matchType, confidence: $confidence,
          contractId: $contractId, fromRepo: $fromRepo, toRepo: $toRepo
        }]->(b)
      `, {
        fromId, toId,
        matchType: link.matchType, confidence: link.confidence,
        contractId: link.contractId,
        fromRepo: link.from.repo, toRepo: link.to.repo,
      });
    }

    // Insert repo snapshots
    for (const [repoPath, snap] of Object.entries(data.repoSnapshots)) {
      await queryBridge(tempHandle, `CREATE (s:RepoSnapshot {
        id: $id, indexedAt: $indexedAt, lastCommit: $lastCommit
      })`, { id: repoPath, indexedAt: snap.indexedAt, lastCommit: snap.lastCommit });
    }

    await closeBridgeDb(tempHandle);
  } catch (err) {
    await closeBridgeDb(tempHandle).catch(() => {});
    await fsp.rm(tempPath, { force: true });
    throw err;
  }

  // Atomic swap
  const bakPath = path.join(groupDir, 'bridge.lbug.bak');
  await fsp.rm(bakPath, { force: true });
  try { await fsp.access(finalPath); await retryRename(finalPath, bakPath); } catch {}
  await retryRename(tempPath, finalPath);
  await fsp.rm(bakPath, { force: true });

  // Write meta.json
  await writeBridgeMeta(groupDir, {
    version: BRIDGE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    missingRepos: data.missingRepos,
  });
}

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
  try {
    const db = new lbug.Database(dbPath, 0, false, true); // readOnly
    const conn = new lbug.Connection(db);
    // Version check
    const meta = await readBridgeMeta(groupDir);
    if (meta.version > 0 && meta.version !== BRIDGE_SCHEMA_VERSION) {
      conn.close(); db.close();
      return null;
    }
    return { _db: db, _conn: conn, groupDir } as BridgeHandle;
  } catch {
    return null;
  }
}

export async function bridgeExists(groupDir: string): Promise<boolean> {
  const handle = await openBridgeDbReadOnly(groupDir);
  if (!handle) return false;
  await closeBridgeDb(handle);
  return true;
}

// NOTE: openBridgeOrFallback lives in storage.ts (not bridge-db.ts) per spec.
// It uses readContractRegistryJson (private in storage.ts) for JSON fallback.
// See Task 7 Step 4 for the implementation.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd gitnexus && npx vitest run test/unit/group/bridge-db.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add gitnexus/src/core/group/bridge-db.ts gitnexus/test/unit/group/bridge-db.test.ts
git commit -m "feat(group): bridge-db writeBridge, readBridgeMeta, openBridgeDbReadOnly"
```

---

## Task 4: gRPC Proto Map — buildProtoMap & resolveProtoConflict

**Files:**
- Modify: `gitnexus/src/core/group/extractors/grpc-extractor.ts`
- Modify: `gitnexus/test/unit/group/grpc-extractor.test.ts`

- [ ] **Step 1: Write failing tests for buildProtoMap**

Add to `gitnexus/test/unit/group/grpc-extractor.test.ts` a new `describe('buildProtoMap')` block. Tests:

- `test_buildProtoMap_single_proto_parses_package_service_methods` — create a temp dir with a `.proto` file containing `package com.example; service UserService { rpc GetUser(...) returns (...); rpc ListUsers(...) returns (...); }`, call `buildProtoMap(tmpDir)`, assert map has key `'UserService'` with one entry: `{ package: 'com.example', serviceName: 'UserService', methods: ['GetUser', 'ListUsers'], protoPath: ... }`.
- `test_buildProtoMap_no_package_declaration` — proto without `package` → `package: ''`.
- `test_buildProtoMap_no_protos_returns_empty` — empty dir → empty map.
- `test_buildProtoMap_conflicting_names` — two protos with same service name different packages → array of 2.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd gitnexus && npx vitest run test/unit/group/grpc-extractor.test.ts -t "buildProtoMap"`
Expected: FAIL.

- [ ] **Step 3: Implement buildProtoMap**

Add to `gitnexus/src/core/group/extractors/grpc-extractor.ts`:

```typescript
export interface ProtoServiceInfo {
  package: string;
  serviceName: string;
  methods: string[];
  protoPath: string;
}

export async function buildProtoMap(repoPath: string): Promise<Map<string, ProtoServiceInfo[]>> {
  const map = new Map<string, ProtoServiceInfo[]>();
  const protoFiles = await glob('**/*.proto', { cwd: repoPath, absolute: false, nodir: true });

  for (const rel of protoFiles) {
    const content = readSafe(repoPath, rel);
    if (!content) continue;

    const pkgMatch = content.match(/^\s*package\s+([\w.]+)\s*;/m);
    const pkg = pkgMatch?.[1] ?? '';

    const serviceBlocks = extractServiceBlocks(content);
    for (const block of serviceBlocks) {
      const rpcRe = /rpc\s+(\w+)\s*\(/g;
      const methods: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = rpcRe.exec(block.body)) !== null) {
        methods.push(m[1]);
      }
      const info: ProtoServiceInfo = {
        package: pkg,
        serviceName: block.name,
        methods,
        protoPath: rel,
      };
      const existing = map.get(block.name) ?? [];
      existing.push(info);
      map.set(block.name, existing);
    }
  }
  return map;
}
```

- [ ] **Step 4: Write failing tests for resolveProtoConflict**

Tests for: single candidate → returns it; multiple → directory proximity; no candidates → null.

- [ ] **Step 5: Implement resolveProtoConflict**

```typescript
export function resolveProtoConflict(
  serviceName: string,
  sourceFilePath: string,
  candidates: ProtoServiceInfo[],
): ProtoServiceInfo | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const sourceDir = path.dirname(sourceFilePath);
  let best = candidates[0];
  let bestScore = 0;
  for (const c of candidates) {
    const protoDir = path.dirname(c.protoPath);
    let shared = 0;
    const min = Math.min(sourceDir.length, protoDir.length);
    for (let i = 0; i < min; i++) {
      if (sourceDir[i] === protoDir[i]) shared++; else break;
    }
    if (shared > bestScore) { bestScore = shared; best = c; }
  }
  return best;
}
```

- [ ] **Step 6: Add serviceContractId helper**

```typescript
export function serviceContractId(pkg: string, serviceName: string): string {
  const prefix = pkg ? `${pkg}.${serviceName}` : serviceName;
  return `grpc::${prefix}/*`;
}
```

- [ ] **Step 7: Run all grpc-extractor tests**

Run: `cd gitnexus && npx vitest run test/unit/group/grpc-extractor.test.ts`
Expected: All PASS.

- [ ] **Step 8: Commit**

```bash
git add gitnexus/src/core/group/extractors/grpc-extractor.ts gitnexus/test/unit/group/grpc-extractor.test.ts
git commit -m "feat(group): buildProtoMap, resolveProtoConflict, serviceContractId"
```

---

## Task 5: gRPC Source Scanners — Proto-Aware Resolution

**Files:**
- Modify: `gitnexus/src/core/group/extractors/grpc-extractor.ts`
- Modify: `gitnexus/test/unit/group/grpc-extractor.test.ts`

- [ ] **Step 1: Write failing tests for proto-resolved Go provider**

Test: given a temp dir with a `.proto` (`package com.example; service UserService { rpc GetUser... }`) and a Go source file with `RegisterUserServiceServer`, calling `extract()` should produce a contract with `contractId: 'grpc::com.example.UserService/*'` and `confidence: 0.8`.

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Modify `GrpcExtractor.extract()` to build protoMap and pass to scanners**

In `GrpcExtractor.extract()`, add at the top:
```typescript
const protoMap = await buildProtoMap(repoPath);
```

Then pass `protoMap` to each scanner method. Modify each scanner (Go, Java, Python, TS) to accept `protoMap` as a parameter and resolve via `resolveProtoConflict()`.

For Go provider (`scanGoProviders`):
```typescript
private scanGoProviders(content: string, filePath: string, protoMap: Map<string, ProtoServiceInfo[]>): ExtractedContract[] {
  // ... existing regex ...
  const serviceName = m[1];
  const candidates = protoMap.get(serviceName);
  const proto = resolveProtoConflict(serviceName, filePath, candidates ?? []);
  const cid = proto
    ? serviceContractId(proto.package, proto.serviceName)
    : serviceOnlyContractId(serviceName);
  const conf = proto ? 0.8 : 0.65;
  // ... push makeContract(cid, 'provider', filePath, ..., conf, ...) ...
}
```

Apply similar changes to Go consumer (conf: proto ? 0.75 : 0.55), Java, Python, TS scanners.

For TS scanner — keep per-method contracts but add package:
```typescript
const proto = resolveProtoConflict(serviceName, filePath, protoMap.get(serviceName) ?? []);
const pkg = proto?.package ?? '';
const cid = contractId(pkg, serviceName, methodName);
```

- [ ] **Step 4: Write test for fallback (no proto → reduced confidence)**

Test: Go source with `RegisterFooServer` but no `.proto` file → `contractId: 'grpc::Foo/*'`, `confidence: 0.65`.

- [ ] **Step 5: Run all grpc-extractor tests**

Run: `cd gitnexus && npx vitest run test/unit/group/grpc-extractor.test.ts`
Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
git add gitnexus/src/core/group/extractors/grpc-extractor.ts gitnexus/test/unit/group/grpc-extractor.test.ts
git commit -m "feat(group): proto-aware gRPC source scanners with confidence adjustments"
```

---

## Task 6: Matching — buildProviderIndex, runExactMatch skip, runWildcardMatch

**Files:**
- Modify: `gitnexus/src/core/group/matching.ts`
- Modify: `gitnexus/test/unit/group/matching.test.ts`

- [ ] **Step 1: Write failing tests for wildcard matching**

Add tests to `gitnexus/test/unit/group/matching.test.ts`:

- `test_runExactMatch_skips_grpc_wildcard_contracts` — consumer with `grpc::com.example.UserService/*` and provider with same → NOT matched as exact (both in unmatched).
- `test_runExactMatch_does_not_skip_http_wildcards` — HTTP wildcards still work.
- `test_runWildcardMatch_fq_service_match` — consumer `grpc::com.example.userservice/*` matches provider `grpc::com.example.userservice/GetUser`.
- `test_runWildcardMatch_bare_name_match` — consumer `grpc::userservice/*` matches provider `grpc::com.example.userservice/GetUser`.
- `test_runWildcardMatch_skips_wildcard_providers` — wildcard consumer vs wildcard provider → no match.
- `test_runWildcardMatch_confidence_min` — confidence = min(provider, consumer).
- `test_runWildcardMatch_matchType_is_wildcard` — CrossLink has `matchType: 'wildcard'`.
- `test_runWildcardMatch_contractId_is_consumers` — CrossLink has consumer's contractId.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Extract `buildProviderIndex` from `runExactMatch`**

```typescript
export function buildProviderIndex(contracts: StoredContract[]): Map<string, StoredContract[]> {
  const providers = contracts.filter((c) => c.role === 'provider');
  const index = new Map<string, StoredContract[]>();
  for (const p of providers) {
    const key = normalizeContractId(p.contractId);
    const list = index.get(key) || [];
    list.push(p);
    index.set(key, list);
  }
  return index;
}
```

- [ ] **Step 4: Modify `runExactMatch` to skip gRPC wildcards and accept optional index**

```typescript
function isGrpcWildcard(contractId: string): boolean {
  return contractId.startsWith('grpc::') && contractId.endsWith('/*');
}

export function runExactMatch(
  contracts: StoredContract[],
  providerIndex?: Map<string, StoredContract[]>,
): MatchResult {
  const index = providerIndex ?? buildProviderIndex(contracts);
  // Filter OUT gRPC wildcard consumers from exact matching — they go to wildcard pass
  const consumers = contracts.filter((c) => c.role === 'consumer' && !isGrpcWildcard(c.contractId));
  // ... rest same as before, using `index` instead of building one ...
  // normalUnmatched already excludes matched contracts.
  // gRPC wildcards were never passed to exact matching, so they're NOT in normalUnmatched.
  // Re-add them to unmatched for the wildcard pass.
  const grpcWildcardContracts = contracts.filter((c) => isGrpcWildcard(c.contractId));
  // Dedup: normalUnmatched won't contain wildcards (they were filtered from consumers/providers)
  const unmatched = [...normalUnmatched, ...grpcWildcardContracts];
  return { matched, unmatched };
}
```

- [ ] **Step 5: Implement `runWildcardMatch`**

```typescript
export function runWildcardMatch(
  unmatched: StoredContract[],
  providerIndex: Map<string, StoredContract[]>,
): { matched: CrossLink[]; remaining: StoredContract[] } {
  const wildcardConsumers = unmatched.filter(
    (c) => c.role === 'consumer' && isGrpcWildcard(c.contractId),
  );
  const matched: CrossLink[] = [];
  const matchedConsumerIds = new Set<string>();

  for (const consumer of wildcardConsumers) {
    const normalized = normalizeContractId(consumer.contractId);
    const fqService = normalized.slice(normalized.indexOf('::') + 2, -2);

    for (const [key, providers] of providerIndex) {
      if (!key.startsWith('grpc::') || key.endsWith('/*')) continue;
      const afterPrefix = key.slice(6);
      const slashIdx = afterPrefix.indexOf('/');
      if (slashIdx < 0) continue;
      const providerFqService = afterPrefix.slice(0, slashIdx);

      const isMatch = providerFqService === fqService
        || (!fqService.includes('.') && providerFqService.endsWith('.' + fqService));

      if (!isMatch) continue;

      for (const provider of providers) {
        if (provider.repo === consumer.repo) {
          if (!provider.service || !consumer.service || provider.service === consumer.service) continue;
        }
        matched.push({
          from: { repo: consumer.repo, service: consumer.service, symbolUid: consumer.symbolUid, symbolRef: consumer.symbolRef },
          to: { repo: provider.repo, service: provider.service, symbolUid: provider.symbolUid, symbolRef: provider.symbolRef },
          type: consumer.type,
          contractId: consumer.contractId,
          matchType: 'wildcard',
          confidence: Math.min(provider.confidence, consumer.confidence),
        });
        matchedConsumerIds.add(`${consumer.repo}::${consumer.contractId}`);
      }
    }
  }

  const remaining = unmatched.filter((c) => {
    if (c.role !== 'consumer' || !isGrpcWildcard(c.contractId)) return true;
    return !matchedConsumerIds.has(`${c.repo}::${c.contractId}`);
  });

  return { matched, remaining };
}
```

- [ ] **Step 6: Run tests**

Run: `cd gitnexus && npx vitest run test/unit/group/matching.test.ts`
Expected: All PASS.

- [ ] **Step 7: Commit**

```bash
git add gitnexus/src/core/group/matching.ts gitnexus/test/unit/group/matching.test.ts
git commit -m "feat(group): buildProviderIndex, runExactMatch gRPC skip, runWildcardMatch"
```

---

## Task 7: Sync — writeBridge + Wildcard Pass

**Files:**
- Modify: `gitnexus/src/core/group/sync.ts`
- Modify: `gitnexus/src/core/group/storage.ts`
- Modify: `gitnexus/test/unit/group/sync.test.ts`

- [ ] **Step 1: Write failing test for sync creating bridge.lbug**

In `gitnexus/test/unit/group/sync.test.ts`, add test: `syncGroup` with `groupDir` option produces a `bridge.lbug` file (use `bridgeExists()`), NOT a `contracts.json`.

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Update sync.ts**

Replace `writeContractRegistry` import with `writeBridge` from bridge-db. Update the matching + write section:

```typescript
import { writeBridge } from './bridge-db.js';
import { buildProviderIndex, runExactMatch, runWildcardMatch } from './matching.js';

// ... inside syncGroup, after extraction ...
const providerIndex = buildProviderIndex(autoContracts);
const { matched: exactLinks, unmatched } = runExactMatch(autoContracts, providerIndex);
const { matched: wildcardLinks } = runWildcardMatch(unmatched, providerIndex);
const crossLinks: CrossLink[] = [...manifestResult.crossLinks, ...exactLinks, ...wildcardLinks];
const allContracts: StoredContract[] = [...manifestResult.contracts, ...autoContracts];

if (opts?.groupDir && !opts.skipWrite) {
  await writeBridge(opts.groupDir, {
    contracts: allContracts,
    crossLinks,
    repoSnapshots,
    missingRepos,
  });
}
```

- [ ] **Step 4: Update storage.ts — add openBridgeOrFallback, keep old API temporarily**

Do NOT remove `writeContractRegistry`/`readContractRegistry` yet — `service.ts` and `cli/group.ts` still depend on them. They will be removed in Task 10 after all consumers are migrated.

Add `openBridgeOrFallback` to `storage.ts` (per spec — it lives here, not in bridge-db.ts, because it uses private `readContractRegistryJson`):

```typescript
import { openBridgeDbReadOnly, closeBridgeDb, readBridgeMeta } from './bridge-db.js';
import type { BridgeHandle, BridgeMeta, LegacyContractRegistry } from './types.js';

// Rename existing readContractRegistry to readContractRegistryJson (keep export temporarily)
async function readContractRegistryJson(groupDir: string): Promise<LegacyContractRegistry | null> {
  const filePath = path.join(groupDir, CONTRACTS_FILE);
  try {
    const content = await fsp.readFile(filePath, 'utf-8');
    return JSON.parse(content) as LegacyContractRegistry;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function openBridgeOrFallback(groupDir: string): Promise<
  { type: 'bridge'; handle: BridgeHandle; meta: BridgeMeta }
  | { type: 'json'; registry: LegacyContractRegistry; deprecationWarning: string }
  | { type: 'none' }
> {
  const handle = await openBridgeDbReadOnly(groupDir);
  if (handle) {
    const meta = await readBridgeMeta(groupDir);
    return { type: 'bridge', handle, meta };
  }
  const registry = await readContractRegistryJson(groupDir);
  if (registry) {
    return {
      type: 'json',
      registry,
      deprecationWarning: 'contracts.json is deprecated. Run "gitnexus group sync <name>" to migrate to bridge.lbug.',
    };
  }
  return { type: 'none' };
}
```

- [ ] **Step 5: Update storage.test.ts — add openBridgeOrFallback tests**

Add tests for bridge/json/none fallback paths. Keep existing `writeContractRegistry`/`readContractRegistry` tests (they still pass, functions not removed yet).

- [ ] **Step 6: Run sync tests**

Run: `cd gitnexus && npx vitest run test/unit/group/sync.test.ts`
Expected: All PASS.

- [ ] **Step 7: Commit**

```bash
git add gitnexus/src/core/group/sync.ts gitnexus/src/core/group/storage.ts gitnexus/test/unit/group/sync.test.ts gitnexus/test/unit/group/storage.test.ts
git commit -m "feat(group): sync writes to bridge.lbug with wildcard matching pass"
```

---

## Task 8: Cross-Impact — Cypher-Based Phase 2

**Files:**
- Modify: `gitnexus/src/core/group/cross-impact.ts`
- Modify: `gitnexus/test/unit/group/cross-impact.test.ts`

- [ ] **Step 1: Write failing tests for new runGroupImpact with bridgeQuery**

Tests for:
- Upstream direction: Cypher matches provider side, fans out to consumer repo.
- Downstream direction: Cypher matches consumer side, fans out to provider repo.
- Ref fallback: empty symbolUid still matches via filePath+symbolName.
- Subgroup filtering on fan-out side.
- Confidence ordering (high-confidence links processed first).

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Rename current `runGroupImpact` → `runGroupImpactLegacy`**

Keep the current function unchanged but renamed. Export both.

- [ ] **Step 4: Implement new `runGroupImpact` with `bridgeQuery`**

Update `GroupImpactOptions` interface in `cross-impact.ts`:
```typescript
export interface GroupImpactOptions {
  groupName: string;
  target: string;
  repoPath: string;
  direction: 'upstream' | 'downstream';
  bridgeQuery: <T>(cypher: string, params: Record<string, unknown>) => Promise<T[]>;
  localImpactFn: (target: string, direction: string) => Promise<unknown>;
  crossImpactFn: (
    targetGroupPath: string,
    symbolUid: string,
    direction: string,
    hint?: { filePath: string; symbolName: string },
  ) => Promise<unknown | null>;
  maxDepth?: number;
  minConfidence?: number;
  subgroup?: string;
  timeout?: number;
  crossDepth?: number;
}
```

Phase 2 loop must pass `hint` when `fanOutUid` is empty:
```typescript
for (const row of rows) {
  if (Date.now() > wallDeadline) { truncated = true; break; }
  if (crossDepth < 1) break;

  // Pass hint for name-based fallback when UID is empty (gRPC contracts)
  const hint = row.fanOutUid
    ? undefined
    : { filePath: row.fanOutFilePath, symbolName: row.fanOutSymbolName };
  const remote = await opts.crossImpactFn(row.fanOutRepo, row.fanOutUid, opts.direction, hint);

  // Guard: impact() returns { error: ... } on not-found (truthy but not a real result)
  if (remote && typeof remote === 'object' && !('error' in (remote as Record<string, unknown>))) {
    // ... count as successful fan-out ...
  }
}
```

Key constants:
```typescript
const UPSTREAM_QUERY = `
MATCH (consumer:Contract)-[l:ContractLink]->(provider:Contract)
WHERE provider.repo = $sourceRepo
  AND (provider.symbolUid IN $localUids
       OR (NOT provider.symbolUid IN $localUids AND (provider.filePath + '::' + provider.symbolName) IN $localRefs))
  AND l.confidence >= $minConfidence
  AND ($subgroup IS NULL OR consumer.repo = $subgroup OR consumer.repo STARTS WITH $subgroup + '/')
RETURN consumer.repo AS fanOutRepo, consumer.symbolUid AS fanOutUid,
       consumer.filePath AS fanOutFilePath, consumer.symbolName AS fanOutSymbolName,
       provider.symbolUid AS matchedLocalUid,
       l.matchType AS matchType, l.confidence AS confidence, l.contractId AS contractId
ORDER BY l.confidence DESC`;

const DOWNSTREAM_QUERY = `...`; // mirror with consumer/provider swapped
```

- [ ] **Step 5: Run tests**

Run: `cd gitnexus && npx vitest run test/unit/group/cross-impact.test.ts`
Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
git add gitnexus/src/core/group/cross-impact.ts gitnexus/test/unit/group/cross-impact.test.ts
git commit -m "feat(group): Cypher-based cross-impact with direction-dependent queries"
```

---

## Task 9: Service Layer — openBridgeOrFallback Integration

**Files:**
- Modify: `gitnexus/src/core/group/service.ts`
- Modify: `gitnexus/test/unit/group/service.test.ts`

- [ ] **Step 1: Write failing tests**

Tests for `groupImpact`:
- With bridge.lbug → uses new `runGroupImpact` with `bridgeQuery`.
- With JSON fallback → uses `runGroupImpactLegacy` with registry.
- With no data → returns error.
- `crossImpactFn` hint param: empty UID → name-based fallback; error-object guard.

Tests for `groupStatus`:
- With bridge → reads meta.json + RepoSnapshot Cypher query.
- With JSON → reads from legacy registry.

Tests for `groupContracts`:
- With bridge → Cypher query with type/repo filters.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Update service.ts**

Import `openBridgeOrFallback`, `queryBridge`, `closeBridgeDb`, `readBridgeMeta` from `bridge-db.ts`. Update `groupImpact()`, `groupContracts()`, `groupStatus()` to use `openBridgeOrFallback` with bridge/json/none branching.

Extend `crossImpactFn` with `hint` parameter and error-object guard (as specified in the design).

- [ ] **Step 4: Run tests**

Run: `cd gitnexus && npx vitest run test/unit/group/service.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add gitnexus/src/core/group/service.ts gitnexus/test/unit/group/service.test.ts
git commit -m "feat(group): service layer uses openBridgeOrFallback with bridge/json/none"
```

---

## Task 10: CLI, MCP Tools, Remaining Tests & Cleanup

**Files:**
- Modify: `gitnexus/src/cli/group.ts`
- Modify: `gitnexus/src/mcp/tools.ts`
- Modify: `gitnexus/src/mcp/local/local-backend.ts`
- Modify: `gitnexus/test/unit/tools.test.ts`
- Modify: `gitnexus/test/integration/group/group-impact.test.ts`
- Create: `gitnexus/test/integration/group/bridge-sync.test.ts`

- [ ] **Step 1: Update CLI group.ts**

Update `sync` command: remove `readContractRegistry` references. The sync command calls `syncGroup` which now writes to bridge.lbug internally.

Update `impact` command: use `openBridgeOrFallback` check instead of `readContractRegistry`. Print deprecation warning from result if JSON fallback.

Update `status` command: similar migration.

- [ ] **Step 2: Update MCP tool descriptions**

In `gitnexus/src/mcp/tools.ts`:

```typescript
// group_sync description:
'Rebuild the Contract Registry (bridge.lbug) for a group: extract HTTP/gRPC/topic contracts, apply manifest links, exact-match and wildcard cross-links.'

// group_contracts description:
'Inspect contracts and cross-links from the group bridge graph.'
```

- [ ] **Step 3: Update local-backend.ts (verify pass-through)**

`groupImpact` and `groupContracts` in `local-backend.ts` already delegate to `GroupService` (lines 2469, 2473). Verify they don't directly use `readContractRegistry` — if not, no changes needed here.

- [ ] **Step 4: Cleanup storage.ts — remove old API**

Now that all consumers (sync, service, CLI) use the new bridge path:
- Remove `writeContractRegistry` (public export)
- Remove `readContractRegistry` (public export) — `readContractRegistryJson` (private) remains for fallback
- Remove `CONTRACTS_FILE` constant
- Rename `ContractRegistry` to `LegacyContractRegistry` in `types.ts` (the alias added in Task 1 becomes the only name; update all imports in cross-impact.ts, storage.ts, service.ts)
- Update `storage.test.ts`: remove tests for deleted functions, add/keep tests for `openBridgeOrFallback`
- Update `test/unit/group/types.test.ts` if it asserts on `ContractRegistry` name

- [ ] **Step 5: Write bridge-sync integration test**

Create `gitnexus/test/integration/group/bridge-sync.test.ts` with end-to-end test: create group config → sync → verify bridge.lbug exists → query contracts via Cypher → verify cross-links.

- [ ] **Step 6: Update existing integration tests**

Update `test/integration/group/group-impact.test.ts` to work with bridge.lbug instead of contracts.json.

- [ ] **Step 7: Run full test suite**

Run: `cd gitnexus && npx vitest run test/unit/group/ test/unit/tools.test.ts test/integration/group/`
Expected: All PASS.

- [ ] **Step 8: Build check**

Run: `cd gitnexus && npm run build`
Expected: Clean build.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(group): CLI/MCP cleanup, old API removal, integration tests"
```

---

## Execution Notes

### LadybugDB API Reference (from pool-adapter.ts)
- **Import:** `import lbug from '@ladybugdb/core'` (pool-adapter.ts:19)
- **Constructor:** `new lbug.Database(path, bufferManagerSize, enableCompression, readOnly)` — 4 positional args (pool-adapter.ts:265-270)
- **Writable:** `new lbug.Database(path, 0, false, false)`
- **Read-only:** `new lbug.Database(path, 0, false, true)`
- **Parameterized query:** `const stmt = await conn.prepare(cypher); stmt.isSuccess(); const result = await conn.execute(stmt, params)` (pool-adapter.ts:524-532)
- **Result extraction:** `const rows = await result.getAll()` (pool-adapter.ts:531)
- **stdout suppression:** pool-adapter uses `silenceStdout()`/`restoreStdout()` around DB operations — bridge-db should do the same if LadybugDB prints warnings

### DDL Syntax
- Follow `schema.ts` pattern: backtick-wrapped template literals, `PRIMARY KEY (id)` as separate clause (not inline), try/catch for "already exists" errors instead of `IF NOT EXISTS`
- Verify actual DDL syntax works during Task 1 Step 3 (build check)

### Known Issues to Address During Implementation
- **CrossLink dedup:** If proto+source contracts create duplicate CrossLinks (same `from.repo, to.repo, contractId`), dedup in `writeBridge` before inserting
- **gRPC symbolName quality:** When passing `hint.symbolName` for fan-out, strip technical prefixes (`Register`, `New`, `Server`, `Client`, `Stub`) to get the bare service name for `impact()` resolution. Add a `stripGrpcPrefix(name: string)` helper in grpc-extractor.ts
- **`BridgeHandle` typing:** `_db` and `_conn` are `unknown` in the interface (opaque). Cast to `any` in bridge-db.ts internally. If better typing is needed, import `lbug.Database`/`lbug.Connection` types
- **`LegacyContractRegistry` imports:** Update imports in `cross-impact.ts`, `storage.ts`, `service.ts` to use `LegacyContractRegistry` instead of `ContractRegistry`
- **`fromRepo`/`toRepo` denormalization:** Included in schema but not used by current Cypher queries. Keep for now; remove if not needed after all tests pass
- **`readSafe` reuse:** `buildProtoMap` uses `readSafe` which is module-level in grpc-extractor.ts (not exported). This is fine since `buildProtoMap` lives in the same file
- **`groupStatus` contractsStale:** Must query `RepoSnapshot` nodes from bridge.lbug and compare `indexedAt` with per-repo `meta.json`. Implement in Task 9 service layer
- **Integration test fixtures:** Use existing `test/fixtures/group/test-monorepo/` for bridge-sync integration tests
- **Validation command:** Use `npm run build` (which runs `node scripts/build.js` including tsc) for build validation
- **Cypher RETURN completeness:** Ensure both Cypher queries return `matchedLocalFilePath` and `matchedLocalSymbolName` per spec (Task 8)
- **`local-backend.ts` may need no changes:** `groupImpact`/`groupContracts` already delegate to `GroupService` (lines 2469, 2473). Verify during Task 10
- **Test coverage gaps vs spec:** Spec lists corrupted bridge, fallback precedence, read-only rejection scenarios. Ensure bridge-db.test.ts covers all of them (Task 3 tests partially cover; add missing during Task 10)
- **`types.test.ts` updates:** If any tests assert on `ContractRegistry` name, update to `LegacyContractRegistry` during Task 10 cleanup
- **UX standardization:** All commands return `{ error: "No contract data. Run 'gitnexus group sync <name>'." }` when no data source — implement consistently in Task 9 (service layer)
