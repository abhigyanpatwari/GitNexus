# Design: Bridge.lbug Storage & gRPC Canonical ID Normalization

**Date:** 2026-04-03
**PR:** #606 (cross-repo impact analysis via repository groups)
**Trigger:** Review feedback from abhigyanpatwari on PR #626 ([review](https://github.com/abhigyanpatwari/GitNexus/pull/626#pullrequestreview-4055362547))
**Status:** Draft

## Context

PR #606 adds cross-repo impact analysis (`group_impact`) using a Contract Registry stored as `contracts.json`. The PR #626 reviewer requested two changes before merge:

1. **Contract storage → bridge.lbug**: The virtual bridge graph needs Cypher-queryable edges for cross-repo impact traversal instead of static JSON.
2. **gRPC normalization mismatch**: `grpc::ServiceName/*` (from source code scanners) vs `grpc::pkg.Service/Method` (from .proto files) normalize differently, causing silent matching failures in cross-repo scenarios.

## Component 1: Bridge.lbug — Contract Storage in LadybugDB

### Architecture

One writable LadybugDB per group at `groups/<name>/bridge.lbug`. This DB is a **single file** (not a directory — LadybugDB/DuckDB uses file-based storage; see `lbug-adapter.ts:140`). It contains the Contract Registry as a queryable graph — contracts as nodes, cross-links as edges.

```
groups/
  my-group/
    group.yaml        # Group config (unchanged)
    bridge.lbug       # LadybugDB file (replaces contracts.json)
    meta.json         # Bridge metadata: { version, generatedAt, missingRepos }
```

### Schema

New tables in bridge.lbug (separate from per-repo schema in `schema.ts`):

**Node tables:**

```sql
CREATE NODE TABLE IF NOT EXISTS Contract (
  id          STRING PRIMARY KEY,   -- full SHA-256 hex (64 chars) of "{repo}\0{contractId}\0{role}\0{filePath}"
  contractId  STRING,               -- "http::GET /api/users", "grpc::pkg.Svc/Method"
  type        STRING,               -- "http" | "grpc" | "topic" | "lib" | "custom"
  role        STRING,               -- "provider" | "consumer"
  repo        STRING,               -- repo path within group (e.g. "hr/hiring/backend")
  service     STRING DEFAULT '',    -- service boundary within monorepo (from StoredContract.service, set by assignService() in sync.ts)
  symbolUid   STRING DEFAULT '',
  filePath    STRING DEFAULT '',
  symbolName  STRING DEFAULT '',
  confidence  DOUBLE DEFAULT 0.0,
  meta        STRING DEFAULT '{}'   -- JSON-serialized Record<string, unknown>
);

CREATE NODE TABLE IF NOT EXISTS RepoSnapshot (
  id         STRING PRIMARY KEY,    -- repo path within group (e.g. "hr/hiring/backend")
  indexedAt  STRING DEFAULT '',
  lastCommit STRING DEFAULT ''
);
```

**Relation table:**

```sql
CREATE REL TABLE IF NOT EXISTS ContractLink (
  FROM Contract TO Contract,
  matchType   STRING,     -- "exact" | "manifest" | "wildcard" | "bm25" | "embedding"
  confidence  DOUBLE,
  contractId  STRING,     -- consumer's contractId (consistent with runExactMatch which stores consumer.contractId)
  fromRepo    STRING,     -- denormalized source repo for index-only lookups
  toRepo      STRING      -- denormalized target repo for index-only lookups
);
```

`fromRepo` / `toRepo` are denormalized onto ContractLink to avoid expensive JOINs when filtering by repo.

**Bridge metadata** is stored as `meta.json` in the group directory (alongside `bridge.lbug`). Contains:

```typescript
interface BridgeMeta {
  version: number;          // BRIDGE_SCHEMA_VERSION from bridge-schema.ts
                            // On version mismatch: writeBridge() recreates from scratch (no ALTER TABLE).
                            // openBridgeDbReadOnly() checks version; returns null if incompatible.
  generatedAt: string;      // ISO timestamp of last sync
  missingRepos: string[];   // repos that failed to sync (preserved for groupStatus)
}
```

`missingRepos` is stored in `meta.json` rather than as DB nodes because it's metadata about the sync process, not queryable graph data. `groupStatus()` reads it from `meta.json` (matching the current behavior where it reads `registry.missingRepos`).

### Contract Primary Key

The `Contract.id` uses a **full SHA-256 hash** (64 hex chars) to avoid both delimiter collisions and birthday-problem collisions. Contract IDs contain `::` and `/` which make composite string keys ambiguous.

```typescript
import { createHash } from 'node:crypto';

function contractNodeId(repo: string, contractId: string, role: string, filePath: string): string {
  return createHash('sha256')
    .update(`${repo}\0${contractId}\0${role}\0${filePath}`)
    .digest('hex'); // full 64 hex chars — no truncation
}
```

**Why full hash:** LadybugDB PRIMARY KEY is the only uniqueness enforcement mechanism (no UNIQUE constraints on columns). A truncated hash risks silent overwrites on collision. Full SHA-256 makes collisions astronomically improbable.

**Why `filePath` in the hash:** A proto-file contract (`filePath: "proto/user.proto"`) and a source-resolved contract (`filePath: "src/server.go"`) for the same `contractId` + `role` + `repo` are **different Contract nodes**. Both are stored — matching works by `contractId`, not by `id`. See "No Dedup Between Proto and Source" below.

### New Module: `bridge-db.ts`

Location: `gitnexus/src/core/group/bridge-db.ts`

**Public API:**

```typescript
/**
 * Open or create a LadybugDB at the given file path (writable mode).
 * Used internally by writeBridge() for temp DB. Not typically called by consumers.
 */
export async function openBridgeDb(dbPath: string): Promise<BridgeHandle>;

/** Apply schema (CREATE TABLE IF NOT EXISTS). Idempotent. */
export async function ensureBridgeSchema(handle: BridgeHandle): Promise<void>;

/**
 * Write contract data to a new bridge.lbug, then atomically swap it into place.
 * Creates a temporary DB at bridge.lbug.tmp, inserts all data, then renames
 * tmp → final. If insertion fails, the existing bridge.lbug is untouched.
 */
export async function writeBridge(
  groupDir: string,
  data: {
    contracts: StoredContract[];
    crossLinks: CrossLink[];
    repoSnapshots: Record<string, RepoSnapshot>;
    missingRepos: string[];
  },
): Promise<void>;

/** Execute a read query against the bridge graph. */
export async function queryBridge<T>(
  handle: BridgeHandle,
  cypher: string,
  params?: Record<string, unknown>,
): Promise<T[]>;

/** Close the bridge DB connection. Must be called after openBridgeDbReadOnly(). */
export async function closeBridgeDb(handle: BridgeHandle): Promise<void>;

/**
 * Open bridge.lbug in read-only mode (for MCP/CLI reads).
 * Returns null if file is missing or corrupt (wraps open in try/catch).
 * Caller MUST call closeBridgeDb() when done.
 *
 * Usage (read path):
 *   const handle = await openBridgeDbReadOnly(groupDir);
 *   if (!handle) { /* fallback */ }
 *   const rows = await queryBridge(handle, cypher, params);
 *   await closeBridgeDb(handle);
 */
export async function openBridgeDbReadOnly(groupDir: string): Promise<BridgeHandle | null>;

/**
 * Check if bridge.lbug exists and is openable.
 * Delegates to openBridgeDbReadOnly + closeBridgeDb.
 */
export async function bridgeExists(groupDir: string): Promise<boolean>;
```

**BridgeHandle** is an opaque wrapper around a LadybugDB `Database` + `Connection`, similar to how `pool-adapter.ts` manages per-repo DBs but simpler (single connection, no pool needed — bridge writes are sequential during sync, reads are single-query).

**Lifecycle clarification:**
- **Write path:** `writeBridge(groupDir, data)` — manages its own DB lifecycle internally (open temp → write → close → rename). Callers don't need open/close.
- **Read path:** `openBridgeDbReadOnly()` + `queryBridge()` + `closeBridgeDb()` — callers manage the handle. This is used by `groupContracts()`, `groupImpact()`, etc.

### Transaction Safety

`writeBridge()` uses a **write-to-temp-then-rename** strategy. DuckDB/LadybugDB does not support rollback of DDL operations (DROP/CREATE TABLE), so we cannot rely on database transactions for atomic replacement. Since LadybugDB stores databases as single files, `fs.rename` is an atomic file operation on POSIX and near-atomic on Windows.

**Strategy:**

```typescript
async function writeBridge(groupDir: string, data: ...): Promise<void> {
  const tempPath = path.join(groupDir, 'bridge.lbug.tmp');
  const finalPath = path.join(groupDir, 'bridge.lbug');

  // 1. Write to a temporary bridge DB file
  await fs.rm(tempPath, { force: true });
  const tempHandle = await openBridgeDb(tempPath);
  try {
    await ensureBridgeSchema(tempHandle);
    // Bulk insert Contract nodes (COPY or individual inserts)
    // Bulk insert ContractLink edges
    // Insert RepoSnapshot nodes
    await closeBridgeDb(tempHandle);
  } catch (err) {
    await closeBridgeDb(tempHandle).catch(() => {});
    await fs.rm(tempPath, { force: true });
    throw err;
  }

  // 2. Atomic swap: rename temp → final (move old to .bak, rename temp, remove .bak)
  //    retryRename() handles Windows EBUSY/EPERM/EACCES with exponential backoff.
  const bakPath = path.join(groupDir, 'bridge.lbug.bak');
  await fs.rm(bakPath, { force: true });
  try { await fs.access(finalPath); await retryRename(finalPath, bakPath); } catch {}
  await retryRename(tempPath, finalPath);
  await fs.rm(bakPath, { force: true });

  // 3. Write meta.json via atomic temp-file rename (meta.json.tmp → meta.json)
  await writeBridgeMeta(groupDir, {
    version: BRIDGE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    missingRepos: data.missingRepos,
  });
}

/** Rename with retry for Windows file-locking errors. */
const RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
async function retryRename(src: string, dst: string, attempts = 3): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try { await fs.rename(src, dst); return; } catch (err: any) {
      if (!RETRY_CODES.has(err.code) || i === attempts) throw err;
      await new Promise(r => setTimeout(r, 100 * Math.pow(2, i - 1)));
    }
  }
}
```

**Guarantees:**
- If insertion fails, `bridge.lbug.tmp` is cleaned up; `bridge.lbug` is untouched
- The rename sequence (old→bak, tmp→final, rm bak) minimizes the window where neither exists
- Windows EBUSY/EPERM/EACCES: `retryRename()` retries 3 times with exponential backoff (100ms, 200ms, 400ms)
- If crash occurs between renames: `bridge.lbug.bak` exists and can be restored manually; `openBridgeDbReadOnly()` checks for `.bak` as a recovery hint
- meta.json is written last via atomic temp-file rename (`meta.json.tmp` → `meta.json`); if meta write fails after successful DB swap, data is fresh but `generatedAt` and `missingRepos` are stale — next sync fixes both
- If EBUSY/EPERM/EACCES persists after 3 retries, sync fails with an explicit error suggesting to close MCP readers and retry

**Corruption recovery:** If `bridge.lbug` exists but is unreadable, `openBridgeDbReadOnly()` returns `null`. Callers treat this the same as "no bridge" and follow the backward compatibility flow (see below).

### Lifecycle

**Write path** (`group sync`):
1. `syncGroup()` extracts contracts and runs matching (unchanged)
2. Instead of `writeContractRegistry(groupDir, registry)` → calls `writeBridge(groupDir, data)`
3. `writeBridge()` manages its own DB lifecycle internally (open temp → write → close → rename)

**Read path** (`group_impact`, `group_contracts`, `group_status`):
1. Open bridge.lbug in read-only mode
2. Execute Cypher queries
3. Close when done

### Consumer Migration

| Consumer | Before | After |
|----------|--------|-------|
| `cross-impact.ts: runGroupImpact()` | Iterates `registry.crossLinks[]` in JS | Cypher query against bridge.lbug |
| `service.ts: groupContracts()` | `readContractRegistry()` → filter in JS | Cypher: `MATCH (c:Contract) WHERE c.type = $type RETURN ...`. Note: pre-existing bug where `--unmatched` uses `consumer.contractId` to check providers — out of scope for this PR but noted for follow-up. |
| `service.ts: groupImpact()` | Passes `registry` object | Passes `BridgeHandle` (or bridge executor fn) |
| `service.ts: groupStatus()` | `readContractRegistry()` for generatedAt + missingRepos + repoSnapshots | Uses `openBridgeOrFallback()`: bridge → reads `meta.json` + Cypher `MATCH (s:RepoSnapshot) RETURN s`; json → reads from `LegacyContractRegistry`; none → returns empty status |
| `cli/group.ts: status` | `readContractRegistry()` | Uses service layer (unchanged CLI output) |
| `cli/group.ts: impact` | Checks `readContractRegistry()` | Uses `openBridgeOrFallback()` (see backward compat) |

### Deleted / Renamed Code

- `storage.ts`: `writeContractRegistry()`, `readContractRegistry()` removed (public API); `CONTRACTS_FILE` removed. `readContractRegistryJson()` kept as private fallback.
- `types.ts`: `ContractRegistry` **renamed to `LegacyContractRegistry`** (not deleted). It's still used by: `cross-impact.ts` (JSON fallback path in `openBridgeOrFallback`), `storage.ts` (private `readContractRegistryJson`), and potentially `service.ts` (backward compat). All imports updated to use the new name. The type is marked `@deprecated`.
- `contracts.json` files no longer created by `group sync`

### Cross-Impact: New `GroupImpactOptions` Interface

The current `GroupImpactOptions` has `registry: ContractRegistry` for JS iteration. After migration, it receives a bridge query function instead:

```typescript
export interface GroupImpactOptions {
  groupName: string;
  target: string;
  repoPath: string;
  direction: 'upstream' | 'downstream';
  // CHANGED: replaces `registry: ContractRegistry`
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

**How the caller connects bridge to `runGroupImpact`** (in `service.ts: groupImpact()`):

```typescript
const result = await openBridgeOrFallback(groupDir);
if (result.type === 'none') return { error: 'Run group_sync first.' };
if (result.type === 'json') {
  // Legacy path: current runGroupImpact is renamed to runGroupImpactLegacy
  // and preserved unchanged (accepts `registry: LegacyContractRegistry`).
  // New runGroupImpact accepts `bridgeQuery`.
  return runGroupImpactLegacy({ ...opts, registry: result.registry });
}
// Bridge path:
const handle = result.handle;
try {
  return await runGroupImpact({
    ...opts,
    bridgeQuery: (cypher, params) => queryBridge(handle, cypher, params),
  });
} finally {
  await closeBridgeDb(handle);
}
```

**How `runGroupImpact` builds Cypher parameters from Phase 1 results:**

```typescript
// After Phase 1 local impact:
const uids = collectPhase1Uids(local);       // Set<string> of symbol IDs
const phase1Refs = collectPhase1Refs(local);  // Set<string> of "filePath::symbolName"

// Normalize subgroup before passing to Cypher
const normalizedSubgroup = opts.subgroup?.trim().replace(/\/+$/, '') || null;

// Phase 2: Execute direction-dependent Cypher query
interface CrossImpactRow {
  fanOutRepo: string; fanOutUid: string; fanOutFilePath: string; fanOutSymbolName: string;
  matchedLocalUid: string; matchedLocalFilePath: string; matchedLocalSymbolName: string;
  matchType: string; confidence: number; contractId: string;
}
const rows = await opts.bridgeQuery<CrossImpactRow>(
  direction === 'upstream' ? UPSTREAM_QUERY : DOWNSTREAM_QUERY,
  {
    sourceRepo: opts.repoPath,
    localUids: [...uids],
    localRefs: [...phase1Refs],
    minConfidence: opts.minConfidence ?? 0.5,
    subgroup: normalizedSubgroup,
  },
);
```

### Cross-Impact Cypher Queries

Phase 2 of `runGroupImpact()` needs **two direction-dependent queries** to preserve the current upstream/downstream semantics from `cross-impact.ts:142-161`.

**Upstream query** (direction = 'upstream'): "I'm changing this symbol — who consumes it?"
The local impact found symbols in the source repo. We look for cross-links where the **target** (provider) matches a local symbol, and fan out to the **source** (consumer) side:

```cypher
MATCH (consumer:Contract)-[l:ContractLink]->(provider:Contract)
WHERE provider.repo = $sourceRepo
  AND (provider.symbolUid IN $localUids
       OR (NOT provider.symbolUid IN $localUids AND (provider.filePath + '::' + provider.symbolName) IN $localRefs))
  AND l.confidence >= $minConfidence
  AND ($subgroup IS NULL OR consumer.repo = $subgroup OR consumer.repo STARTS WITH $subgroup + '/')
RETURN consumer.repo AS fanOutRepo,
       consumer.symbolUid AS fanOutUid,
       consumer.filePath AS fanOutFilePath,
       consumer.symbolName AS fanOutSymbolName,
       provider.symbolUid AS matchedLocalUid,
       provider.filePath AS matchedLocalFilePath,
       provider.symbolName AS matchedLocalSymbolName,
       l.matchType AS matchType,
       l.confidence AS confidence,
       l.contractId AS contractId
ORDER BY l.confidence DESC
```

**Downstream query** (direction = 'downstream'): "I'm changing this symbol — what does it consume?"
The local impact found symbols in the source repo. We look for cross-links where the **source** (consumer) matches a local symbol, and fan out to the **target** (provider) side:

```cypher
MATCH (consumer:Contract)-[l:ContractLink]->(provider:Contract)
WHERE consumer.repo = $sourceRepo
  AND (consumer.symbolUid IN $localUids
       OR (NOT consumer.symbolUid IN $localUids AND (consumer.filePath + '::' + consumer.symbolName) IN $localRefs))
  AND l.confidence >= $minConfidence
  AND ($subgroup IS NULL OR provider.repo = $subgroup OR provider.repo STARTS WITH $subgroup + '/')
RETURN provider.repo AS fanOutRepo,
       provider.symbolUid AS fanOutUid,
       provider.filePath AS fanOutFilePath,
       provider.symbolName AS fanOutSymbolName,
       consumer.symbolUid AS matchedLocalUid,
       consumer.filePath AS matchedLocalFilePath,
       consumer.symbolName AS matchedLocalSymbolName,
       l.matchType AS matchType,
       l.confidence AS confidence,
       l.contractId AS contractId
ORDER BY l.confidence DESC
```

**Key differences from current JS code preserved:**
- **UID matching** (`cross-impact.ts:142-145`): Cypher checks `symbolUid IN $localUids`
- **Ref fallback** (`cross-impact.ts:146`, `linkMatchesRefs` at line 58-71): Cypher checks `filePath + '::' + symbolName IN $localRefs` when `symbolUid NOT IN $localUids`. This **preserves exact current semantics**: the JS code does `const refMatch = !uidMatch && linkMatchesRefs(...)` where `!uidMatch` means "UID didn't match the affected set" (regardless of whether UID is empty or stale). The Cypher `NOT ... IN $localUids` is equivalent.
- **Direction-dependent fan-out** (`cross-impact.ts:160-161`): Upstream fans out to `consumer.repo`, downstream fans out to `provider.repo`
- **Subgroup filter** (`cross-impact.ts:163`): Applied to the fan-out side, not the source side
- **Subgroup normalization**: `$subgroup` is normalized by the caller before passing to Cypher: `subgroup?.trim().replace(/\/+$/, '') || null`. This matches `inSubgroup()` from `cross-impact.ts:73-77` which does `subgroup.replace(/\/+$/, '')`. The Cypher `starts_with` check also needs the `=` case: `target.repo = $subgroup OR starts_with(target.repo, $subgroup + '/')`
- **Fan-out side info**: Query returns `fanOutFilePath` and `fanOutSymbolName` in addition to `fanOutUid` to support name-based fallback when UID is empty

### Fan-Out with Empty symbolUid (gRPC contracts)

The current `crossImpactFn` in `service.ts:189-199` uses `impactByUid()` which requires a valid UID (`MATCH (n) WHERE n.id = $uid`). gRPC contracts have `symbolUid: ''`, so `impactByUid('')` returns null — the fan-out silently fails.

**Solution:** Extend `crossImpactFn` to fall back to name-based impact when UID is empty:

```typescript
crossImpactFn: async (targetGroupPath: string, uid: string, d: string, hint?: { filePath: string; symbolName: string }) => {
  const registryName = config.repos[targetGroupPath];
  if (!registryName) return null;
  try {
    const repoObj = await this.port.resolveRepo(registryName);
    // If UID is available, use it (existing path)
    if (uid) {
      return this.port.impactByUid(repoObj.id, uid, d, impactOpts);
    }
    // Fallback: search by symbol name in the target repo.
    // impact() resolves by name with priority ordering (Class > Interface > Function > ...),
    // see local-backend.ts:1896. It does NOT support filePath scoping — if two symbols
    // share the same name, the highest-priority label wins. This is a known limitation
    // for gRPC fan-out: if "UserService" exists as both a Class and a Function in the
    // target repo, the Class is chosen. In practice, gRPC service implementations are
    // typically unique names within a repo, so this is acceptable.
    if (hint?.symbolName) {
      const result = await this.port.impact(repoObj, {
        target: hint.symbolName,
        direction: d as 'upstream' | 'downstream',
        ...impactOpts,
      });
      // impact() returns { error: ... } on not-found instead of null.
      // Must check for error to avoid counting failures as successful fan-out
      // (runGroupImpact truthy-checks the result at cross-impact.ts:176).
      if (result && typeof result === 'object' && 'error' in result) return null;
      return result;
    }
    return null;
  } catch {
    return null;
  }
},
```

The `hint` parameter carries `fanOutFilePath` and `fanOutSymbolName` from the Cypher query result. The caller (`runGroupImpact`) passes it when `fanOutUid` is empty:

```typescript
// In cross-impact.ts Phase 2 loop:
const result = await opts.crossImpactFn(
  row.fanOutRepo,
  row.fanOutUid,
  opts.direction,
  row.fanOutUid ? undefined : { filePath: row.fanOutFilePath, symbolName: row.fanOutSymbolName },
);
```

This ensures gRPC cross-links actually trigger remote impact analysis via name-based search, not silent null returns.

### Future: Multi-Hop Traversal (crossDepth > 1)

With bridge.lbug, multi-hop becomes a recursive Cypher query. Out of scope for this PR but the schema supports it.

### Backward Compatibility

**Unified fallback function:** All consumers (CLI, service, MCP) use a single `openBridgeOrFallback(groupDir)` helper:

```typescript
async function openBridgeOrFallback(groupDir: string): Promise<
  { type: 'bridge'; handle: BridgeHandle; meta: BridgeMeta }
  | { type: 'json'; registry: LegacyContractRegistry; deprecationWarning: string }
  | { type: 'none' }
> {
  // 1. Try bridge.lbug
  const handle = await openBridgeDbReadOnly(groupDir);
  if (handle) {
    const meta = await readBridgeMeta(groupDir);
    return { type: 'bridge', handle, meta };
  }
  // 2. Fallback to contracts.json (with deprecation warning)
  const registry = await readContractRegistryJson(groupDir);
  if (registry) {
    // Return deprecation info in result — caller decides how to surface it.
    // CLI prints warning; MCP includes it in response metadata (NOT console.warn,
    // which would corrupt JSON-RPC protocol stream).
    return { type: 'json', registry, deprecationWarning: 'contracts.json is deprecated. Run "gitnexus group sync <name>" to migrate to bridge.lbug.' };
  }
  // 3. Nothing found
  return { type: 'none' };
}
```

**Edge cases** (consistent behavior):
- Group has `contracts.json` but no `bridge.lbug` → fallback to JSON with deprecation warning
- Group has both → bridge.lbug wins (tried first), JSON ignored
- Group has corrupted `bridge.lbug` → `openBridgeDbReadOnly()` returns null → fallback to JSON if available, otherwise error
- Group has corrupted `bridge.lbug` + no JSON → error: "Run group_sync first"
- No `contracts.json` and no `bridge.lbug` → error: "Run group_sync first"

**Key principle:** Corrupted bridge is NOT a hard error — it falls through to JSON like any "missing" bridge. Only when no data source is available does the user see an error.

## Component 2: gRPC Canonical ID — Proto-Aware Extraction

### Problem

The gRPC extractor generates two incompatible contract ID formats:

| Source | Format | Example |
|--------|--------|---------|
| `.proto` file | `grpc::package.Service/Method` | `grpc::com.example.UserService/GetUser` |
| Go `NewXClient()` | `grpc::ServiceName/*` | `grpc::UserService/*` |
| Java `ImplBase` | `grpc::ServiceName/*` | `grpc::UserService/*` |
| Python `Stub()` | `grpc::ServiceName/*` | `grpc::UserService/*` |
| TS `@GrpcMethod()` | `grpc::Service/Method` | `grpc::UserService/GetUser` |

After normalization, `grpc::userservice/*` never matches `grpc::com.example.userservice/GetUser`.

### Solution: Proto Map

**New function** in `grpc-extractor.ts`:

```typescript
interface ProtoServiceInfo {
  package: string;           // "com.example" (empty string if no package declaration)
  serviceName: string;       // "UserService"
  methods: string[];         // ["GetUser", "ListUsers", ...]
  protoPath: string;         // "proto/user.proto" (for disambiguation)
}

/** Scan .proto files in repo, build serviceName → package+methods map. */
export async function buildProtoMap(repoPath: string): Promise<Map<string, ProtoServiceInfo[]>>;
```

**Implementation:**
1. Glob `**/*.proto` in repoPath (reuse existing .proto scanning logic from lines 80-155)
2. Parse `package`, `service`, `rpc` declarations (regex-based, same as current .proto parsing)
3. If `.proto` has no `package` declaration, `package` is empty string `''` — `contractId` becomes `grpc::ServiceName/Method` (no dot prefix)
4. Build `Map<serviceName, ProtoServiceInfo[]>` — key is bare service name (e.g. "UserService"), value is array (handles conflicts where two .proto files define the same service name with different packages)

**Modified extraction flow:**

```
GrpcExtractor.extract(executor, repoPath, handle)
  ├─ protoMap = buildProtoMap(repoPath)           // NEW: build once per repo
  ├─ extractFromProtoFiles(executor, repoPath)    // unchanged — already full IDs
  ├─ extractFromGoSource(executor, protoMap)       // CHANGED: resolve via protoMap
  ├─ extractFromJavaSource(executor, protoMap)     // CHANGED
  ├─ extractFromPythonSource(executor, protoMap)   // CHANGED
  ├─ extractFromTsSource(executor, protoMap)       // CHANGED: resolve package via protoMap
  └─ dedupe()                                      // unchanged (see below)
```

### symbolUid for gRPC Contracts

Currently, all gRPC contracts have `symbolUid: ''` (see `grpc-extractor.ts:70`). This is by design — the gRPC extractor doesn't query the graph for symbol UIDs because the contract represents a network boundary, not a code-level symbol.

**This means `impactByUid` fan-out won't work for gRPC contracts.** Two levels of fallback are needed:

1. **Bridge Cypher queries** (finding cross-links): Use ref fallback — `filePath + '::' + symbolName IN $localRefs` when UID is empty (see Cross-Impact Cypher Queries above).
2. **Remote fan-out** (`crossImpactFn`): Current `impactByUid()` in `service.ts:189-199` requires a valid UID (`MATCH (n) WHERE n.id = $uid`). With empty UID, it returns null — fan-out silently fails. **This must be extended** with a name-based fallback (see "Fan-Out with Empty symbolUid" in Cross-Impact section below).

### No Dedup Between Proto and Source Contracts

Proto-file contracts and source-resolved contracts are **both kept as separate Contract nodes** in bridge.lbug, even when they share the same `contractId`. This is correct because:

1. They have different `filePath` values (e.g., `proto/user.proto` vs `src/server.go`)
2. They have different `symbolRef` — the proto entry points to the `.proto` definition, the source entry points to the actual Go/Java/Python code
3. During cross-impact analysis, developers need to see the **source code** file that implements/calls the service, not the `.proto` definition file
4. ContractLink matching works by `contractId`, not by Contract node `id` — both nodes participate in the same cross-links

The existing `dedupe()` key `contractId|role|filePath` already handles this correctly: proto (`filePath: "proto/user.proto"`) and source (`filePath: "src/server.go"`) have different keys and both survive.

**What dedupe still prevents:** True duplicates — e.g., if the same Go file is scanned twice, or if two different regex patterns match the same `RegisterXServer()` call.

### Proto Map Disambiguation

When multiple .proto files define the same service name with different packages, disambiguation uses **directory proximity** heuristic (not import path parsing, since Go/Java/Python scanners don't track imports):

```typescript
function resolveProtoConflict(
  serviceName: string,
  sourceFilePath: string,
  candidates: ProtoServiceInfo[],
): ProtoServiceInfo | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // Score by directory proximity: shared path prefix length
  const sourceDir = path.dirname(sourceFilePath);
  let best = candidates[0];
  let bestScore = 0;
  for (const c of candidates) {
    const protoDir = path.dirname(c.protoPath);
    const shared = commonPrefixLength(sourceDir, protoDir);
    if (shared > bestScore) {
      bestScore = shared;
      best = c;
    }
  }
  return best;
}
```

### Per-Scanner Resolution: Service-Level vs Method-Level Contracts

**Design decision:** When a source scanner (Go/Java/Python) resolves via proto map, it generates a **single service-level contract** with a synthesized `contractId`, NOT one contract per method. This avoids false-positive explosion.

**Rationale:** `RegisterUserServiceServer()` or `NewUserServiceClient()` is evidence that the code *uses the service* — not evidence that it calls *every method*. Expanding to per-method contracts with high confidence would be misleading.

**Provider resolution (example: Go):**

```typescript
// Before:
contracts.push({ contractId: serviceOnlyContractId('UserService'), confidence: 0.8 });
// → grpc::UserService/*

// After:
const candidates = protoMap.get('UserService');
const proto = resolveProtoConflict('UserService', sourceFilePath, candidates ?? []);
if (proto) {
  // Single service-level contract with canonical package prefix
  contracts.push({
    contractId: serviceContractId(proto.package, proto.serviceName),
    // → grpc::com.example.UserService/*
    confidence: 0.8,  // unchanged — still service-level evidence
    filePath: sourceFilePath,
  });
} else {
  contracts.push({
    contractId: serviceOnlyContractId('UserService'),
    confidence: 0.65,  // reduced — unresolved, no package
    filePath: sourceFilePath,
  });
}
```

**New helper:**
```typescript
function serviceContractId(pkg: string, serviceName: string): string {
  const prefix = pkg ? `${pkg}.${serviceName}` : serviceName;
  return `grpc::${prefix}/*`;
}
```

This produces `grpc::com.example.UserService/*` — a wildcard with the correct package prefix. It will match `.proto`-extracted `grpc::com.example.UserService/GetUser` via wildcard matching (see below).

**Consumer resolution (example: Go consumer):**

```typescript
const candidates = protoMap.get('UserService');
const proto = resolveProtoConflict('UserService', sourceFilePath, candidates ?? []);
if (proto) {
  contracts.push({
    contractId: serviceContractId(proto.package, proto.serviceName),
    confidence: 0.75,  // proto-resolved consumer
    role: 'consumer',
    filePath: sourceFilePath,
  });
} else {
  contracts.push({
    contractId: serviceOnlyContractId('UserService'),
    confidence: 0.55,  // reduced — unresolved consumer
    role: 'consumer',
    filePath: sourceFilePath,
  });
}
```

**TS `@GrpcMethod` resolution:** TS already has method-level info — keep producing per-method contracts:

```typescript
const candidates = protoMap.get(serviceName);
const proto = resolveProtoConflict(serviceName, sourceFilePath, candidates ?? []);
const pkg = proto?.package ?? '';
const cid = contractId(pkg, serviceName, methodName);
// → grpc::com.example.UserService/GetUser (per-method, with package)
```

Four source scanners (Go, Java, Python, TS) receive `protoMap` and use `resolveProtoConflict()`. The `.proto` extraction is unchanged — it already produces full canonical IDs.

### Confidence Adjustments

| Scenario | Before | After | Rationale |
|----------|--------|-------|-----------|
| .proto rpc (provider) | 0.85 | 0.85 | Unchanged — gold standard, per-method |
| Go/Java/Python register (provider), proto-resolved | 0.8 | 0.8 | Service-level with package prefix |
| Go/Java/Python register (provider), no proto | 0.8 | 0.65 | Reduced — wildcard, no package |
| Go/Java/Python client (consumer), proto-resolved | 0.7 | 0.75 | Slight boost — canonical package known |
| Go/Java/Python client (consumer), no proto | 0.7 | 0.55 | Reduced — wildcard, no package |
| TS `@GrpcMethod`, proto-resolved | 0.8 | 0.8 | Per-method with package from proto |
| TS `@GrpcMethod`, no proto | 0.8 | 0.8 | Per-method, no package — unchanged |

### Matching: Wildcard Fallback and `matchType`

For `grpc::*/*` contracts (service-level wildcards), add wildcard matching as a **separate pass** after `runExactMatch()`.

**Critical: `runExactMatch` must exclude gRPC wildcard contracts.** If both consumer and provider have `grpc::com.example.UserService/*`, they would match as `exact` with `confidence: 1.0` — false positive. Wildcard-to-wildcard and wildcard-to-method matching is handled exclusively by `runWildcardMatch()`.

`runExactMatch` is modified to **skip gRPC wildcard contracts** (contracts where `contractId` starts with `grpc::` AND ends with `/*`). These contracts are passed through to `unmatched` and handled by the wildcard pass. HTTP wildcard contracts (`http::*::/path`) are NOT affected — they don't end with `/*` and continue to use existing `findMatchingKeys` logic.

**New and modified functions** in `matching.ts`:

```typescript
/** Build a normalized contractId → contracts index. Exported for reuse by wildcard pass. */
export function buildProviderIndex(
  contracts: StoredContract[],
): Map<string, StoredContract[]>;

/**
 * Updated signature: accepts optional pre-built index.
 * Skips gRPC wildcard contracts (contractId starting with "grpc::" and ending with "/*")
 * — these appear in `unmatched` for the wildcard pass.
 */
export function runExactMatch(
  contracts: StoredContract[],
  providerIndex?: Map<string, StoredContract[]>,
): MatchResult;

interface WildcardMatchResult {
  matched: CrossLink[];
  remaining: StoredContract[];
}

export function runWildcardMatch(
  unmatched: StoredContract[],
  providerIndex: Map<string, StoredContract[]>,
): WildcardMatchResult;
```

`buildProviderIndex()` is extracted from the existing private logic inside `runExactMatch()` and exported. **Keys in the returned Map are `normalizeContractId(contract.contractId)`** — i.e., lowercased package parts for gRPC. This is critical for case-insensitive matching in `runWildcardMatch()`. The index includes gRPC wildcard providers (they won't match in exact pass but `runWildcardMatch` explicitly skips them via `key.endsWith('/*')` check). `runExactMatch()` is updated to accept an optional pre-built index.

**Implementation:**

1. Filter `unmatched` for consumers with `contractId` ending in `/*`
2. For each wildcard consumer, extract the bare service name:
   ```typescript
   // "grpc::com.example.userservice/*" → "com.example.userservice"
   // "grpc::userservice/*" → "userservice"
   const normalizedWildcard = normalizeContractId(consumer.contractId);
   const fqServiceFromConsumer = normalizedWildcard.slice(
     normalizedWildcard.indexOf('::') + 2, -2); // strip "grpc::" and "/*"
   ```
3. Search `providerIndex` for **non-wildcard** providers whose FQ service matches:
   ```typescript
   // Only match providers that have actual method-level IDs (not wildcards themselves)
   for (const [key, providers] of providerIndex) {
     if (!key.startsWith('grpc::') || key.endsWith('/*')) continue; // skip non-grpc and wildcards
     const afterPrefix = key.slice(6); // strip "grpc::"
     const slashIdx = afterPrefix.indexOf('/');
     if (slashIdx < 0) continue;
     const fqServiceFromProvider = afterPrefix.slice(0, slashIdx);
     // Exact match on FQ service, or bare-name match if consumer has no package
     if (fqServiceFromProvider === fqServiceFromConsumer
         || (!fqServiceFromConsumer.includes('.') && fqServiceFromProvider.endsWith('.' + fqServiceFromConsumer))) {
       // Match found
     }
   }
   ```
4. Create CrossLink with `matchType: 'wildcard'`, `contractId: consumer.contractId` (the wildcard ID — consistent with `runExactMatch` which always stores `consumer.contractId`)
5. **Confidence:** `min(provider.confidence, consumer.confidence)` — no additional penalty. The wildcard penalty is already baked into the consumer's reduced confidence (0.55-0.75 depending on proto resolution). Applying an additional 0.5× multiplier would push values below `minConfidence` threshold.

**Why no 0.5× multiplier:** With consumer confidence 0.55 (no proto) and provider 0.85, `0.5 × min(0.55, 0.85) = 0.275` — well below the default `minConfidence: 0.5`. The wildcard feature would be dead by default. Instead, the penalty is in the source confidence itself (0.55 vs 0.7 baseline), which keeps wildcard matches viable at default thresholds.

**Sync integration:**

```typescript
// In syncGroup():
const providerIndex = buildProviderIndex(autoContracts);
const { matched: exactLinks, unmatched } = runExactMatch(autoContracts, providerIndex);
const { matched: wildcardLinks, remaining } = runWildcardMatch(unmatched, providerIndex);
const crossLinks = [...manifestResult.crossLinks, ...exactLinks, ...wildcardLinks];
```

**Note:** `runExactMatch` and `runWildcardMatch` operate on `autoContracts` only — manifest contracts are already matched by `ManifestExtractor` and added separately. This prevents duplicate links.

## Testing Strategy

### Bridge.lbug Tests

**Unit tests** (`test/unit/group/bridge-db.test.ts`):
- Schema creation (idempotent, re-run safe)
- Write + read contracts round-trip (verify all fields including filePath)
- Write + read cross-links round-trip (verify fromRepo/toRepo denormalization)
- Multiple contracts with same contractId but different filePath → both stored
- RepoSnapshot persistence (keyed by repo path within group)
- meta.json persistence (version from BRIDGE_SCHEMA_VERSION, generatedAt, missingRepos)
- missingRepos survives write + read cycle via meta.json
- Write-to-temp-then-rename: old data fully replaced, new data correct
- Read-only mode rejects writes (error thrown)
- Failed insert: bridge.lbug untouched, bridge.lbug.tmp cleaned up
- Atomic rename: .bak created during swap, removed after success
- Windows EBUSY/EPERM/EACCES retry: retryRename handles concurrent read-only handles
- Full SHA-256 PK: verify no truncation (64 hex chars)
- Corrupted bridge.lbug: `openBridgeDbReadOnly()` returns null
- `bridgeExists()`: true when DB opens, false when missing or corrupt
- Bridge.lbug is a file, not a directory

**Integration tests** (`test/integration/group/bridge-sync.test.ts`):
- `syncGroup()` creates bridge.lbug with correct data
- `groupContracts()` reads from bridge.lbug (filtered by type, repo)
- `groupContracts()` with `--unmatched` flag after wildcard canonicalization
- `groupImpact()` traverses bridge.lbug cross-links (upstream direction)
- `groupImpact()` traverses bridge.lbug cross-links (downstream direction)
- `groupStatus()` returns missingRepos from meta.json and repoSnapshots from Cypher query
- `groupStatus()` contractsStale check uses RepoSnapshot nodes from bridge.lbug
- Backward compat: group with only contracts.json → fallback with deprecation warning
- Backward compat: group with both contracts.json and bridge.lbug → bridge.lbug wins
- Backward compat: corrupted bridge.lbug + contracts.json exists → fallback to JSON
- Backward compat: corrupted bridge.lbug + no JSON → error "Run group_sync first"
- Backward compat: no contracts.json and no bridge.lbug → error "Run group_sync first"
- Re-sync overwrites previous bridge.lbug data

### gRPC Canonical ID Tests

**Unit tests** (`test/unit/group/grpc-extractor.test.ts` — extend existing):
- `buildProtoMap()`: single proto, multiple protos, no protos in repo
- `buildProtoMap()`: proto without `package` declaration → `package: ''`, contractId = `grpc::ServiceName/Method`
- `buildProtoMap()`: conflicting service names (same name, different packages) → array with both entries
- `resolveProtoConflict()`: single candidate → returns it
- `resolveProtoConflict()`: multiple candidates → picks closest by directory
- `resolveProtoConflict()`: no candidates → returns null
- Proto-resolved extraction: Go provider + .proto → `grpc::pkg.Service/*` (service-level, NOT per-method)
- Proto-resolved extraction: Java consumer + .proto → `grpc::pkg.Service/*` (service-level)
- Proto-resolved extraction: TS `@GrpcMethod` + .proto → `grpc::pkg.Service/Method` (per-method, with package)
- Fallback: no .proto → `grpc::ServiceName/*` with reduced confidence (0.65 provider, 0.55 consumer)
- No dedup between proto and source: both kept as separate entries with different filePaths
- symbolUid is empty for all gRPC contracts (by design)

**Unit tests** (`test/unit/group/matching.test.ts` — extend existing):
- `runWildcardMatch()`: `grpc::com.example.userservice/*` matches `grpc::com.example.userservice/GetUser` (FQ match)
- `runWildcardMatch()`: `grpc::userservice/*` matches `grpc::com.example.userservice/GetUser` (bare-name match)
- `runWildcardMatch()`: does NOT match `grpc::com.example.otherservice/GetUser`
- `runWildcardMatch()`: does NOT match non-grpc contracts
- `runWildcardMatch()`: does NOT match wildcard providers (`grpc::Service/*` consumer vs `grpc::Service/*` provider → skip)
- `runWildcardMatch()`: confidence = min(provider, consumer) — no 0.5× multiplier
- `runWildcardMatch()`: contractId on link = consumer's contractId (consistent with runExactMatch)
- `runWildcardMatch()`: matchType = 'wildcard'
- `runExactMatch()`: skips gRPC `/*` contracts (no wildcard-wildcard exact match); HTTP wildcards unaffected
- `runExactMatch()`: wildcard contracts appear in unmatched output
- Exact match runs first; wildcard only processes remaining unmatched
- Manifest contracts not passed to exact/wildcard match (no duplicate links)

### Cross-Impact Tests

**Unit tests** (`test/unit/group/cross-impact.test.ts` — extend existing):
- Phase 2 upstream: query matches on provider side, fans out to consumer repo
- Phase 2 downstream: query matches on consumer side, fans out to provider repo
- UID matching works against bridge DB
- Ref fallback matching works when symbolUid is empty (gRPC contracts)
- Ref fallback matching works when symbolUid is non-empty but stale (not in localUids) — preserves current `!uidMatch` semantics
- Subgroup filtering applied to fan-out side, not source side
- Confidence filtering via Cypher WHERE clause
- Direction-specific Cypher query equivalence with current JS loop
- Fan-out with empty symbolUid: crossImpactFn falls back to name-based search via hint
- Fan-out with valid symbolUid: crossImpactFn uses impactByUid (existing path)
- Subgroup normalization: trailing `/` stripped before Cypher, `team/a` matches `team/a` and `team/a/sub`
- Deprecation warning returned in result (not console.warn) when JSON fallback used

## Files Changed

### New Files
| File | Purpose |
|------|---------|
| `src/core/group/bridge-db.ts` | Bridge LadybugDB lifecycle, schema, read/write, atomic rename |
| `src/core/group/bridge-schema.ts` | Schema DDL constants + BRIDGE_SCHEMA_VERSION for bridge.lbug |
| `test/unit/group/bridge-db.test.ts` | Bridge DB unit tests |
| `test/integration/group/bridge-sync.test.ts` | Bridge DB integration tests |

### Modified Files
| File | Changes |
|------|---------|
| `src/core/group/sync.ts` | Replace `writeContractRegistry()` with `writeBridge()`; add `runWildcardMatch()` pass on `autoContracts` only (not manifest) |
| `src/core/group/service.ts` | Use `openBridgeOrFallback()`; extend `crossImpactFn` with `hint` param for name-based fallback when UID empty |
| `src/core/group/cross-impact.ts` | Accept bridge executor; two direction-dependent Cypher queries with UID+ref fallback |
| `src/core/group/storage.ts` | Remove `writeContractRegistry()`, `readContractRegistry()`, `CONTRACTS_FILE`; keep `readContractRegistryJson()` as private fallback; add `openBridgeOrFallback()` (imports `openBridgeDbReadOnly`, `closeBridgeDb`, `readBridgeMeta` from `bridge-db.ts`) |
| `src/core/group/types.ts` | Add `BridgeHandle`, `BridgeMeta` types; rename `ContractRegistry` → `LegacyContractRegistry` (@deprecated) |
| `src/core/group/extractors/grpc-extractor.ts` | Add `buildProtoMap()`, `resolveProtoConflict()`, `serviceContractId()`; modify 4 source scanners; keep service-level contracts (no per-method expansion for Go/Java/Python) |
| `src/core/group/matching.ts` | Export `buildProviderIndex()` (normalized keys); `runExactMatch` skips gRPC `/*` contracts; add `runWildcardMatch()` excluding wildcard providers; add `'wildcard'` to MatchType |
| `src/cli/group.ts` | Update `sync`, `impact`, `status` to use `openBridgeOrFallback()` |
| `src/mcp/local/local-backend.ts` | Update `groupImpact()`, `groupContracts()` to use `openBridgeOrFallback()` |
| `test/unit/group/grpc-extractor.test.ts` | Add proto map, service-level canonical ID, no-package proto, TS per-method resolution tests |
| `test/unit/group/matching.test.ts` | Add `runWildcardMatch()` tests: wildcard-provider exclusion, no multiplier, matchType checks |
| `test/unit/group/cross-impact.test.ts` | Direction-specific Cypher equivalence, ref fallback for empty UID |
| `test/unit/group/sync.test.ts` | Update for bridge.lbug writes + wildcard on autoContracts only |
| `test/unit/group/service.test.ts` | Update for bridge.lbug reads + openBridgeOrFallback |

### Deleted / Renamed
| File/Symbol | Reason |
|-------------|--------|
| `storage.ts: writeContractRegistry()` | Replaced by bridge-db.ts |
| `storage.ts: readContractRegistry()` | Replaced by bridge-db.ts (JSON fallback kept as private `readContractRegistryJson()`) |
| `storage.ts: CONTRACTS_FILE` | No longer used |
| `types.ts: ContractRegistry` | **Renamed** to `LegacyContractRegistry` (@deprecated); still used by JSON fallback path |
| `contracts.json` files | No longer created by `group sync` |

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| LadybugDB write perf during sync | Bulk COPY (same pattern as lbug-adapter.ts), not individual inserts |
| Bridge DB data loss on failed sync | Write-to-temp-then-rename: old file untouched until new file fully written; .bak recovery hint |
| Bridge DB lock during concurrent reads | Write-to-temp eliminates lock contention; retryRename for Windows EBUSY/EPERM/EACCES |
| Bridge DB corruption | Falls through to JSON fallback (not a hard error); only errors if no data source available |
| Proto map parse errors on malformed .proto | Regex-based parsing with try/catch, skip unparseable files |
| Proto map conflicts (same service name) | Directory proximity heuristic; no import path parsing needed |
| Proto without package declaration | `package: ''` → contractId = `grpc::ServiceName/Method` (tested) |
| Backward compat: existing groups have contracts.json | `openBridgeOrFallback()`: bridge.lbug first, then JSON, then error |
| ContractLink JOIN perf for repo filtering | Denormalized `fromRepo`/`toRepo` on relation avoid JOINs |
| Wildcard false positives (general) | No per-method expansion for service-level evidence; confidence penalty in source extraction |
| Wildcard bare-name cross-package false positive | `grpc::userservice/*` can match `grpc::other.userservice/GetUser` (different package). Accepted risk: bare-name consumers (no proto) already have reduced confidence (0.55); false positives surface as low-confidence cross-links. Users can raise `minConfidence` to filter. A future improvement could require FQ match only when consumer has package prefix. |
| gRPC symbolUid empty | Ref fallback in Cypher queries (filePath+symbolName match); name-based fan-out with error-object guard |
| missingRepos data loss | Stored in meta.json alongside bridge.lbug |

## Implementation Notes

Issues identified during spec review that are best addressed during TDD implementation rather than in the design doc:

1. **Swap partial failure recovery (#3):** If `temp→final` rename fails after `final→bak`, `bridge.lbug` is missing. Implementation should check for `.bak` in `openBridgeDbReadOnly()` and auto-restore if `bridge.lbug` is absent.
2. **`meta.json` read failure (#4):** `readBridgeMeta()` should return sensible defaults (`{ version: 0, generatedAt: '', missingRepos: [] }`) if file is missing/corrupt, not throw. `openBridgeOrFallback` should handle this gracefully.
3. **Proto+source dedup and matching identity (#5):** Two Contract nodes with same `(repo, contractId)` but different `filePath` will both mark as matched via `${repo}::${contractId}`. This means both proto and source entries mark as matched simultaneously — correct for `unmatched` filtering. But `runExactMatch` may create duplicate CrossLinks (one per node). Implementation should dedup CrossLinks by `(from.repo, to.repo, contractId)`.
4. **gRPC symbolName quality (#6):** Extractors store technical names (`RegisterUserServiceServer`, `NewUserServiceClient`). The name-based fallback may not find the actual symbol in the target repo. Implementation should extract the service name from these patterns (strip `Register`/`New`/`Server`/`Client` prefixes) before passing as `hint.symbolName`.
5. **DDL syntax compatibility (#11):** Schema DDL in this spec uses `IF NOT EXISTS` and inline `PRIMARY KEY`. Verify against actual LadybugDB/DuckDB version used in the project. If incompatible, adapt to match `schema.ts` conventions (separate PRIMARY KEY clause, no IF NOT EXISTS with try/catch wrapper).
6. **`fromRepo`/`toRepo` denormalization (#9):** Current Cypher queries don't use them. Remove from schema if no concrete use case emerges during implementation. Keep if needed for future index-only scans.
7. **`no data source` UX per command (#12):** `groupStatus` returns empty status; `groupImpact`/`groupContracts` return error. Standardize during implementation: all commands that require data return `{ error: "No contract data. Run 'gitnexus group sync <name>'." }`.
8. **Blast radius (#10):** `src/mcp/tools.ts` tool descriptions reference `contracts.json` — update text. Tests `storage.test.ts`, `types.test.ts`, `group-impact.test.ts` also need updates — add to implementation plan.
9. **Fallback ownership (#8):** `openBridgeOrFallback()` lives in `storage.ts`. `cross-impact.ts` does NOT do fallback — it receives either `bridgeQuery` or `registry` from `service.ts`. Service layer owns the fallback decision.
