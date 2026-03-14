# Replace KuzuDB with LadybugDB

**Date:** 2026-03-13
**Status:** Brainstorm complete
**Branch:** `ladybug-db`

## What We're Building

A full migration from KuzuDB (archived Oct 2025) to LadybugDB v0.15 — its community fork and successor. This is a 1:1 replacement: swap the dependency, rename all internal references, and verify feature parity. No new LadybugDB features will be adopted in this migration.

### Context

- KuzuDB was acquired by Apple and archived in October 2025
- LadybugDB forked the project and released v0.15 (March 2026)
- The core API shape (Database, Connection, PreparedStatement, QueryResult) is preserved
- LadybugDB uses the same Cypher query language, columnar storage, and embedded architecture

## Why This Approach

**Single atomic PR ("Big Bang")** — all changes in one PR rather than layered.

- The migration touches interdependent pieces (packages, imports, file names, variable names, DB file paths, tests) that don't work in isolation
- Intermediate broken states would complicate CI and review
- A full rename ensures no stale "kuzu" references linger in the codebase
- Users will rebuild their graph from scratch (`npx gitnexus analyze`), avoiding file format compatibility risks between KuzuDB v0.11 and LadybugDB v0.15

## Key Decisions

1. **Rebuild, not migrate** — Users re-run `npx gitnexus analyze` after upgrading. No attempt to convert existing `.gitnexus/kuzu` database files. On startup, if the old `kuzu` path exists, log a warning suggesting re-index and delete the stale file.

2. **Full rename** — All internal references change from `kuzu` to `lbug`:
   - Files: `kuzu-adapter.ts` → `lbug-adapter.ts`
   - Directories: `src/core/kuzu/` → `src/core/lbug/`
   - Variables/functions: `initKuzu()` → `initLbug()`, `closeKuzu()` → `closeLbug()`, `withKuzuDb()` → `withLbugDb()`
   - DB file path: `.gitnexus/kuzu` → `.gitnexus/lbug`
   - Test files: `kuzu-core-adapter.test.ts` → `lbug-core-adapter.test.ts`

3. **Both runtimes** — Migrate Node.js (`kuzu` → `lbug`) and WASM (`kuzu-wasm` → `lbug-wasm`)

4. **Keep bug workarounds** — Port existing N-API workarounds (skipped `.close()`, stdout silencing, `dangerouslyIgnoreUnhandledErrors`) as-is. Remove them in a follow-up once confirmed fixed in v0.15.

5. **Migration only** — No adoption of new LadybugDB features (autoCheckpoint, enableChecksums, progress callbacks). Strict 1:1 parity.

## Scope of Changes

### Package Changes

| Current | New | Location |
|---------|-----|----------|
| `kuzu` ^0.11.3 | `lbug` (latest v0.15) | `gitnexus/package.json` |
| `kuzu-wasm` ^0.11.1 | `lbug-wasm` (latest) | `gitnexus-web/package.json` |

### Files to Rename

**gitnexus/ (CLI + MCP):**
- `src/core/kuzu/kuzu-adapter.ts` → `src/core/lbug/lbug-adapter.ts`
- `src/core/kuzu/schema.ts` → `src/core/lbug/schema.ts`
- `src/core/kuzu/csv-generator.ts` → `src/core/lbug/csv-generator.ts`
- `src/mcp/core/kuzu-adapter.ts` → `src/mcp/core/lbug-adapter.ts`
- `test/integration/kuzu-core-adapter.test.ts` → `test/integration/lbug-core-adapter.test.ts`
- `test/integration/kuzu-pool.test.ts` → `test/integration/lbug-pool.test.ts`

**gitnexus-web/ (Browser):**
- `src/core/kuzu/kuzu-adapter.ts` → `src/core/lbug/lbug-adapter.ts`
- `src/core/kuzu/schema.ts` → `src/core/lbug/schema.ts`
- `src/core/kuzu/csv-generator.ts` → `src/core/lbug/csv-generator.ts`
- `src/types/kuzu-wasm.d.ts` → `src/types/lbug-wasm.d.ts` (or remove if lbug-wasm ships its own types)

### API Changes to Handle

| KuzuDB | LadybugDB | Notes |
|--------|-----------|-------|
| `require("kuzu")` | `require("lbug")` | Package import |
| `import('kuzu-wasm')` | `import('lbug-wasm')` | WASM dynamic import |
| `new kuzu.Database(path)` | `new lbug.Database(path)` | Constructor shape preserved |
| `new kuzu.Database(path, 0, false, true)` | `new lbug.Database(path, 0, false, true)` | Read-only mode — verify param order in v0.15 |
| `kuzu.FS.writeFile()` | `lbug.FS.writeFile()` | WASM virtual filesystem |
| `kuzu.init()` | `lbug.setWorkerPath()` + init | WASM initialization changed — verify exact sequence |

### Constructor Parameter Mapping

KuzuDB v0.11: `Database(path, bufferPoolSize?, enableCompression?, readOnly?)`
LadybugDB v0.15: `Database(path, bufferManagerSize?, enableCompression?, readOnly?, maxDBSize?, autoCheckpoint?, checkpointThreshold?, throwOnWalReplayFailure?, enableChecksums?)`

The first 4 params appear compatible (with `bufferPoolSize` renamed to `bufferManagerSize`). Since we pass positional args, this should work — but must be verified.

### Consumers to Update (import paths)

- `src/server/api.ts` — imports from core adapter
- `src/core/search/bm25-index.ts` — imports `queryFTS`
- `src/core/wiki/graph-queries.ts` — uses pool adapter
- `src/core/embeddings/embedding-pipeline.ts` — queries/stores embeddings
- `src/storage/repo-manager.ts` — defines `kuzuPath` → `lbugPath`
- `src/cli/analyze.ts`, `mcp.ts`, `wiki.ts`, `eval-server.ts`, `tool.ts`, `augment.ts` — CLI commands
- `test/global-setup.ts` — direct kuzu import
- `test/helpers/test-db.ts`, `test-indexed-db.ts`, `test-graph.ts` — test infrastructure

### Extensions to Verify

- `INSTALL fts` / `LOAD EXTENSION fts` — FTS extension must be available in LadybugDB v0.15
- Vector index (`CREATE_VECTOR_INDEX`) — must work with FLOAT[384] embeddings
- Backtick-escaped table names (Struct, Enum, etc.) — should work but verify

### Storage Path Change

- Old: `<repo-root>/.gitnexus/kuzu`
- New: `<repo-root>/.gitnexus/lbug`

## Open Questions

_All questions resolved during brainstorming._

## Resolved Questions

1. **File format migration?** — No. Rebuild from scratch via `npx gitnexus analyze`.
2. **WASM support?** — Yes. `lbug-wasm` is available at https://docs.ladybugdb.com/client-apis/wasm/
3. **Bug workarounds?** — Keep initially, remove in follow-up.
4. **Internal naming?** — Full rename from kuzu to lbug.
5. **New features?** — Migration only. No new LadybugDB features.
6. **PR strategy?** — Single atomic PR.

## Risk Areas

1. **Constructor param compatibility** — Positional args may have shifted between v0.11 and v0.15. Must verify the exact Database constructor signature.
2. **FTS/Vector extensions** — May have been renamed or have different installation APIs in v0.15.
3. **WASM API divergence** — The web adapter uses `hasNext()/getNext()` while Node uses `getAll()`. Need to verify both APIs exist in LadybugDB.
4. **N-API stability** — The workarounds for segfaults may or may not still be needed. Keeping them is safe but adds tech debt.
5. **CI/build** — Native binary compilation may differ. GitHub Actions workflow may need updated build steps for `lbug`.
