# 2026-04-30-001 — LadybugDB Connection Centralisation

**Status:** proposed · **Author:** GPT-5.5 with system-architect, code-analyzer, and researcher agents · **Reviewer:** TBD · **PR:** TBD

## Context

The `@ladybugdb/core` 0.16.0 upgrade exposed how scattered the LadybugDB lifecycle is across GitNexus. The upgrade had to touch every raw `new lbug.Database(...)` site to preserve the pre-0.16 compression behavior and avoid the default 8 TB `mmap` path. The same codebase also has several independent lock-error classifiers, retry loops, result unwrappers, and stdout-silencing paths.

The audit found:

| Surface                       | Current state                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| `new lbug.Database(...)`      | 9 sites across core, pool, bridge, test setup, and extension-install script           |
| `new lbug.Connection(...)`    | 9 production/test setup sites, plus 1 test-only fresh connection                      |
| Lock retry loops              | 3 distinct policies: writer, read pool init, bridge read-only open                    |
| Error classifiers             | 5 distinct classifiers, 6 including an HTTP API local classifier                      |
| QueryResult unwraps           | 12 sites, with bridge throwing on empty arrays while other paths silently index `[0]` |
| Manual Cypher escaping        | 18 value-escape sites with several subtly different escaping rules                    |
| Windows/macOS platform quirks | Close/reopen and native destructor behavior leaks into individual tests               |

Cross-library research (`better-sqlite3`, `@duckdb/node-api`, `lmdb-js`, `level`, upstream `kuzu`, `neo4j-driver`) shows the stable pattern is an engine/database handle plus connection/session objects. DuckDB is the closest analogue with an in-process instance cache. Kuzu/LadybugDB currently do not expose stable typed errors, so centralised message classification is unavoidable until upstream changes.

## Goals

1. Put all LadybugDB `Database` construction behind one module so future constructor/default changes are a single-file edit.
2. Centralise `Connection` construction, result unwrapping, query timeout handling, close semantics, and stdout silencing.
3. Replace scattered lock/busy classifiers with a single `LbugError` taxonomy and named retry policies.
4. Preserve current public behavior through compatibility shims while migrating call sites in reviewable stages.
5. Make platform quirks explicit through a single helper/constant instead of repeated `process.platform` branches in tests.
6. Add opt-in observability for query timing and redacted statement previews without default logging noise.
7. Reduce raw Cypher interpolation on write paths by preferring prepared statements and allow-listed identifiers.

## Non-goals

- Not an ORM, graph model mapper, or query builder.
- Not a schema migration framework.
- Not a transaction manager; LadybugDB's JS driver does not expose a user-managed transaction primitive here.
- Not an attempt to fix upstream Windows file-lock or macOS native-destructor behavior in process.
- Not a rewrite of `extension-loader.ts`, `schema.ts`, or `csv-generator.ts` beyond changing how they acquire handles.

## Target API Sketch

```ts
export interface OpenOptions {
  readOnly?: boolean;
  bufferManagerSize?: number;
  enableCompression?: boolean;
  maxDBSize?: number;
  retry?: RetryPolicy;
}

export interface Engine {
  readonly path: string;
  readonly readOnly: boolean;
  close(): Promise<void>;
}

export const openEngine: (path: string, opts?: OpenOptions) => Promise<Engine>;
```

`openEngine` is the only allowed production wrapper around `new lbug.Database(...)`.

```ts
export type Row<T = Record<string, unknown>> = T;
export type Params = Record<string, lbug.LbugValue>;

export interface Connection {
  readonly label: string;
  query<T = Row>(cypher: string): Promise<T[]>;
  prepared<T = Row>(cypher: string, params: Params): Promise<T[]>;
  stream<T = Row>(cypher: string, onRow: (row: T) => void | Promise<void>): Promise<number>;
  preparedMany(cypher: string, paramsList: Params[]): Promise<void>;
  close(): Promise<void>;
}
```

`Connection` owns `QueryResult | QueryResult[]` unwrap behavior, typed rows, observer events, and timeout wrapping.

```ts
export const acquireWriter: <T>(dbPath: string, fn: (conn: Connection) => Promise<T>) => Promise<T>;
export const closeWriter: () => Promise<void>;
export const isWriterReady: () => boolean;

export const initReader: (repoId: string, dbPath: string) => Promise<void>;
export const initReaderWithEngine: (repoId: string, engine: Engine) => Promise<void>;
export const withReader: <T>(repoId: string, fn: (conn: Connection) => Promise<T>) => Promise<T>;
export const closeReader: (repoId?: string) => Promise<void>;
export const isReaderReady: (repoId: string) => boolean;

export const withBridgeWriter: <T>(
  groupDir: string,
  fn: (conn: Connection) => Promise<T>,
) => Promise<T>;
export const openBridgeReader: (groupDir: string) => Promise<Connection | null>;
```

The public surface is role-based: writer, reader pool, and bridge. Each role can keep its current lifecycle semantics while sharing engine, connection, retry, error, and observability primitives.

```ts
export type LbugErrorKind =
  | 'transient-lock'
  | 'schema-conflict'
  | 'missing-table-column'
  | 'native-crash'
  | 'write-on-readonly'
  | 'extension-unavailable'
  | 'invalid-query'
  | 'timeout'
  | 'driver-contract'
  | 'unknown';

export interface LbugError {
  readonly kind: LbugErrorKind;
  readonly message: string;
  readonly cause: unknown;
  readonly context?: {
    dbPath?: string;
    repoId?: string;
    statementPreview?: string;
    attempts?: number;
  };
}

export const classify: (err: unknown, context?: LbugError['context']) => LbugError;
```

`classify` concentrates unavoidable LadybugDB/Kuzu message matching in one file.

## Placement

New files live under `gitnexus/src/core/lbug/`:

- `engine.ts` — opens native `Database` handles.
- `connection.ts` — wraps `Connection` query/prepare/execute/stream/close.
- `errors.ts` — error taxonomy and classification.
- `retry.ts` — `RetryPolicy` and named policies for writer, reader init, and bridge open.
- `stdio.ts` — `silenceStdout`, `restoreStdout`, and captured real stdout/stderr writers.
- `platform-quirks.ts` — named Windows/macOS close/reopen guards for tests.
- `observability.ts` — opt-in `LbugObserver`.
- `writer.ts` — process-wide writable singleton/session lock.
- `reader-pool.ts` — current pool-adapter behavior with shared primitives.
- `bridge.ts` — bridge writer/reader lifecycle primitives.
- `index.ts` — curated public exports.
- `_internal/` modules for CSV load, embeddings I/O, FTS helpers, and file operations.

During migration, `lbug-adapter.ts` and `pool-adapter.ts` remain compatibility shims. They are deleted only after all consumers import from the role-based API.

## Migration Plan

### Stage 1 — Add primitives with no behavior change

Add `engine.ts`, `connection.ts`, `errors.ts`, `retry.ts`, `stdio.ts`, `platform-quirks.ts`, `observability.ts`, and `index.ts`.

Validation:

- `cd gitnexus && npx tsc --noEmit`
- `cd gitnexus && npm test`
- New unit tests for error classification, retry policy behavior, query result unwrap, observer events, and engine constructor defaults.

### Stage 2 — Migrate `bridge-db.ts`

Move bridge open/close/query/retry/unwrap behavior onto the new primitives while keeping `writeBridge`, `openBridgeDbReadOnly`, `bridgeExists`, metadata helpers, and pure lookup helpers stable.

Validation:

- `cd gitnexus && npx vitest run test/unit/group/bridge-db.test.ts test/unit/group/bridge-db-edge.test.ts`
- Existing bridge read/write tests pass without contract changes.

### Stage 3 — Migrate the read pool and move stdio helpers

Move `pool-adapter.ts` internals into `reader-pool.ts`; leave old exports as shims. Move `silenceStdout` and related globals to `stdio.ts`.

Validation:

- `cd gitnexus && npx vitest run test/integration/lbug-pool.test.ts test/integration/lbug-pool-stability.test.ts test/unit/stdout-silence.test.ts test/unit/bm25-search.test.ts`

### Stage 4 — Migrate writer adapter and delete dead unsafe helpers

Move writer singleton/session-lock behavior to `writer.ts`, internalize CSV load/FTS/embeddings/file operations, and leave `lbug-adapter.ts` as a shim.

Delete `insertNodeToLbug` and `batchInsertNodesToLbug` unless a fresh repo-wide search finds a real consumer; they currently have zero `src/` consumers and rely on raw string interpolation.

Validation:

- `cd gitnexus && npx tsc --noEmit`
- `cd gitnexus && npm test`
- Targeted integration tests for writer busy-retry and embedding cache paths.

### Stage 5 — Drop compatibility shims and rename consumers

Delete `lbug-adapter.ts`, `pool-adapter.ts`, and `mcp/core/lbug-adapter.ts`; update call sites to import from `core/lbug/index.ts` and role-based names.

This is the only intentionally breaking internal rename stage. It can split into smaller PRs by consumer if review risk is high.

Validation:

- `cd gitnexus && npx tsc --noEmit`
- `cd gitnexus && npm test`
- `rg "lbug-adapter|pool-adapter|mcp/core/lbug-adapter" gitnexus/src gitnexus/test` confirms no stale imports.

### Stage 6 — Wire opt-in observability

Attach observers from CLI/MCP/server only when requested by an env var or verbose flag. Default is no observer and no logs.

Validation:

- Unit tests for redaction and preview clipping.
- Manual smoke: tracing enabled emits timing; tracing disabled is silent.

## Backward Compatibility

Stages 1-4 preserve the import surface through shims. Existing symbols are handled as:

- Kept: `loadGraphToLbug`, `getLbugStats`, `loadCachedEmbeddings`, `fetchExistingEmbeddingHashes`, `getEmbeddingTableName`, `deleteNodesForFile`, `loadFTSExtension`, `loadVectorExtension`, `createFTSIndex`, `ensureFTSIndex`, `queryFTS`, `dropFTSIndex`, `isWriteQuery`.
- Renamed after shims: `withLbugDb` -> `acquireWriter`; pool `initLbug` -> `initReader`; pool `executeQuery`/`executeParameterized` -> `withReader(... conn.query/prepared ...)`; `closeLbug` -> `closeWriter` or `closeReader`; `touchRepo` -> `touchReader`; `addPoolCloseListener` -> `onReaderClose`.
- Internalized: `splitRelCsvByLabelPair`, `WriteStreamFactory`, `RelCsvSplitResult`, `getDatabase` (replaced by a test-only internal writer engine accessor).
- Removed hard: `insertNodeToLbug`, `batchInsertNodesToLbug`, subject to a final search before deletion.

## Risks and Mitigations

- Writer session-lock behavior is delicate. Stage 4 must preserve the current lock and retry semantics line-for-line before simplifying.
- Bridge atomic swap must keep sidecar handling and rename order identical. Stage 2 should be reviewed as "same file lifecycle, different query primitive."
- macOS and Windows native close/reopen bugs are upstream constraints. The layer should expose one named test/platform guard rather than spreading skips.
- Stage 5 has the widest diff. It can split by consumer to keep review manageable.

## Open Questions

1. Should `classify` include a CI fixture that fails when LadybugDB starts exposing typed error codes, forcing us to stop string-matching?
2. Should read-pool defaults remain `5 repos / 5 minutes idle / 8 conns`, or should that become configurable in stage 3?
3. Should bridge keep its own writer role, or share `acquireWriter`? The current recommendation is to keep a separate bridge role.
4. Should writer access always require a `dbPath`, or should analyze get an explicit `bindWriter(path)` helper?
5. Should the current `initLbugWithDb` test trick survive if `@ladybugdb/core` fixes the macOS destructor behavior?
6. Should deleted insert helpers be reintroduced later as a parameterised `Connection.insert(...)`, or left out until a real consumer appears?
