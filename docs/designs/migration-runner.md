---
name: migration-runner
type: bug
risk: low
impacted: [c3_lbug_schema, c3_lbug_lbug_adapter]
status: proposed
date: 2026-06-06
branch: bugfix/batch-160-migration-runner
base: origin/main-afk @ 76d8c30
closes: [#160]
---

<!--
AI-READERS — load only the sections your task needs.

| Task          | Sections (skip if absent)                  |
|---------------|--------------------------------------------|
| implement     | ## Components, ## Contracts, ## Invariants |
| code-review   | ## Invariants, ## KeyDecisions, ## Contracts |
| qa            | ## Flows, ## EdgeCases                     |
| scope-impact  | ## BlastRadius, ## CrossCutting            |
-->

# Solution Design: migration-runner

**Blast** d1=`schema.ts` (add `SCHEMA_MIGRATIONS` array, ~30 LOC) + `lbug-adapter.ts` (insert migration loop in `doInitLbug`, ~15 LOC) + 2 new regression tests in `lbug-core-adapter.test.ts` (~120 LOC) · d2=`initLbug` callers (no change) · d3=`withTestLbugDB` users (migrations now run automatically on every test DB open)

## Problem & Approach

**Why** — `gitnexus/src/core/lbug/schema.ts` exports 30 `*_MIGRATION` and `*_MIGRATION_N` constants. The core adapter's `doInitLbug` only iterates `SCHEMA_QUERIES` (the `CREATE NODE TABLE` statements). Migrations are never invoked. A user upgrading from a prior GitNexus version sees "Cannot find property X for node" errors on any property that was added in an `_MIGRATION[_N]` (e.g. #86's `parameterCount`/`returnType`, Method's `parameterAnnotations`, Route's 8 columns).

**Solution** — Add an explicit `SCHEMA_MIGRATIONS` array in `schema.ts`. After `doInitLbug` runs `SCHEMA_QUERIES`, iterate `SCHEMA_MIGRATIONS` and execute each via `conn.query()`. Each migration string is split on `;` first to handle the 2 multi-statement migrations (`FUNCTION_SCHEMA_MIGRATION_2`, `ROUTE_SCHEMA_MIGRATION`) — LadybugDB's `conn.query(statement)` API takes one statement at a time. All migrations use the Kùzu-native `ALTER TABLE X ADD <col> <type>` form; idempotency on existing DBs is achieved by the runner catching Kùzu's `Runtime exception: ... already has property` error and treating it as a no-op. See [[feedback-kuzu-alter-table-no-if-not-exists]] for the Kùzu limitation that forced this design.

**Why not auto-discover at runtime** (regex over export names) — fragile; the codebase already uses explicit arrays (`NODE_SCHEMA_QUERIES`, `REL_SCHEMA_QUERIES`, `SCHEMA_QUERIES`); consistent with house style. One-line addition: append to `SCHEMA_MIGRATIONS` array, no plumbing change.

## Components

**d=1 files modified:**
- `gitnexus/src/core/lbug/schema.ts` — add `SCHEMA_MIGRATIONS` array (one-line per migration) + a JSDoc comment explaining how to add a new migration
- `gitnexus/src/core/lbug/lbug-adapter.ts` — add migration loop in `doInitLbug` after the `SCHEMA_QUERIES` loop, with statement-splitting for multi-statement migrations

**d=1 new test:**
- `gitnexus/test/integration/lbug-core-adapter.test.ts` — add 1 regression test: run `initLbug` on a fresh DB, then create a Function node, query `parameterCount`/`returnType` — must succeed. (The existing 3 labels() tests already exercise the migration runner implicitly by running on a fresh DB.)

## Contracts

| Contract | Before | After |
|---|---|---|
| Fresh DB: `initLbug(dbPath)` runs all `SCHEMA_QUERIES` + all `SCHEMA_MIGRATIONS` | Runs `SCHEMA_QUERIES` only; `SCHEMA_MIGRATIONS` are dead code | Runs both, in order |
| Existing DB: `initLbug(dbPath)` applies missing migrations | `SCHEMA_MIGRATIONS` are dead code; new columns never added | `SCHEMA_MIGRATIONS` applied; runner swallows Kùzu's `already has property` for re-ADD idempotency |
| `MATCH (f:Function) RETURN f.parameterCount` on an existing DB that was missing the column | "Cannot find property parameterCount for f" | returns the count (or NULL for old rows) |
| `MATCH (r:Route) RETURN r.responseKeys` on an existing DB | "Cannot find property responseKeys for r" | returns the value (or NULL) |
| Adding a new `*_MIGRATION_N+1` constant | One-line addition + silent (doesn't run) | One-line addition + append to `SCHEMA_MIGRATIONS` array (one more line) |

## Invariants

1. **`SCHEMA_MIGRATIONS` is a complete list** of every `*_MIGRATION[_N]` constant in `schema.ts`. New migrations must be appended to this array. The JSDoc comment on the array makes this explicit.
2. **Migrations run after schema creation** in `doInitLbug`. Order: `SCHEMA_QUERIES` (create tables) → `SCHEMA_MIGRATIONS` (add columns). Reversing the order would fail because tables don't exist yet.
3. **Migrations are idempotent on existing DBs** — the runner catches Kùzu's `Runtime exception: ... already has property` error (raised on re-ADD of an existing column) and treats it as a no-op. Kùzu's `ALTER TABLE` has neither `IF NOT EXISTS` nor a `COLUMN` keyword, so the runner cannot rely on either — the catch is the only idempotency mechanism. See [[feedback-kuzu-alter-table-no-if-not-exists]] for the engine constraint.
4. **Multi-statement migrations are split on `;` before passing to `conn.query()`.** LadybugDB's `Connection.query(statement)` API takes one statement at a time. The 2 affected migrations (`FUNCTION_SCHEMA_MIGRATION_2`, `ROUTE_SCHEMA_MIGRATION`) are split at the migration runner, not in `schema.ts` (less churn).
5. **Migration execution is silent on `already has property` and `already exists` errors** (defensive) — if a future migration accidentally targets a column that exists, the runner won't fail the DB open.
6. **No new tests for the multi-language `*_MIGRATION` group** — the existing per-table test (`python-function-properties.test.ts`) covers Function. The multi-language migrations are structurally identical (same `ALTER TABLE X ADD col TYPE` pattern) and would be tested by their respective language integration tests.

## Key Decisions

**KD-1: Explicit `SCHEMA_MIGRATIONS` array, not runtime auto-discovery.** Consistent with `NODE_SCHEMA_QUERIES` and `REL_SCHEMA_QUERIES` arrays. Auditable. The "one-line addition" acceptance criterion is met: append to the array (the new migration constant is already a one-line addition). Auto-discovery (regex over export names) is fragile to name drift and refactors; AST-based discovery adds build complexity for zero benefit.

**KD-2: Split multi-statement migrations at the runner, not in `schema.ts`.** `schema.ts` is the source of truth for migrations; it stays unchanged structurally. The runner's statement-splitting is a 3-line helper. If a future migration has 3+ statements, the same runner handles it.

**KD-3: No transaction wrapper around the migration loop.** LadybugDB executes each `ALTER TABLE` in its own implicit transaction. A wrapper would add complexity for no benefit — partial migration failure (e.g., the 3rd `ALTER` fails) is acceptable because the 1st and 2nd are idempotent (caught on retry) and the 3rd will be retried on next `initLbug`.

**KD-4: Defensive `already has property` error suppression.** Kùzu's `ALTER TABLE ... ADD <col> <type>` throws on re-ADD against an existing column, so the runner catches that error to keep migrations idempotent. The error is still propagated for non-idempotency cases (any other migration error) and not silently dropped — it surfaces in logs for diagnosis.

**KD-5: Test the runner via the public `initLbug` API, not by directly invoking internal functions.** This is the integration-test contract: "open a fresh DB, run `initLbug`, create a Function, query `parameterCount`." Mirrors the existing `python-function-properties.test.ts` pattern.

## Flows

### Flow 1 — Fresh DB open (current + post-fix)

```mermaid
sequenceDiagram
    autonumber
    participant Caller as initLbug caller<br/>(CLI / test helper)
    participant LB as lbug-adapter.initLbug
    participant Init as doInitLbug
    participant Conn as lbug.Connection
    participant DB as lbug.Database (file)

    Caller->>LB: initLbug(dbPath)
    LB->>Init: doInitLbug(dbPath)
    Init->>DB: open (or create)
    Init->>Conn: new Connection(db)

    Note over Init,Conn: SCHEMA_QUERIES loop (existing)
    loop for each query in SCHEMA_QUERIES
        Init->>Conn: conn.query(CREATE TABLE ...)
    end

    Note over Init,Conn: NEW: SCHEMA_MIGRATIONS loop
    loop for each migration in SCHEMA_MIGRATIONS
        Init->>Init: split on ';' → [stmt1, stmt2, ...]
        loop for each stmt (skip empty)
            Init->>Conn: conn.query(stmt)
        end
    end

    Init-->>LB: { db, conn }
    LB-->>Caller: ready
```

### Flow 2 — Existing DB open (regression scenario)

```mermaid
sequenceDiagram
    autonumber
    participant Caller as initLbug caller
    participant Init as doInitLbug
    participant Conn as lbug.Connection
    participant DB as Existing lbug.Database

    Caller->>Init: initLbug(existingDbPath)
    Init->>DB: open (existing)
    Init->>Conn: new Connection(db)

    Note over Init,Conn: SCHEMA_QUERIES loop (CREATE TABLE IF NOT EXISTS — no-op for existing)
    Init->>Conn: conn.query(CREATE TABLE Function IF NOT EXISTS ...)
    Note right of Conn: silently succeeds (table exists)

    Note over Init,Conn: NEW: SCHEMA_MIGRATIONS loop
    loop for each migration
        Init->>Init: split on ';'
        loop for each stmt
            Init->>Conn: conn.query(ALTER TABLE Function ADD parameterCount INT32)
            Note right of Conn: throws "already has property" on existing DB
        end
    end
    Note right of Conn: catch-block swallows "already has property"<br/>(no error propagates)

    Note over Caller,DB: Caller can now query: MATCH (f:Function) RETURN f.parameterCount
    Caller->>Conn: conn.query(...)
    Conn-->>Caller: rows with parameterCount populated
```

## EdgeCases

1. **Multi-statement migration with whitespace** — `FUNCTION_SCHEMA_MIGRATION_2` has format `ALTER TABLE X ADD ... INT32; ALTER TABLE X ADD ... STRING`. After split on `;` and `trim()`, both statements are valid. Empty strings from the split are skipped.

2. **Multi-statement migration with comments** — None of the current migrations have SQL comments. If a future one does, the runner must handle `--` line comments before the split (or just keep the split naive and let comments pass through, since Kùzu parser may accept them).

3. **Empty `SCHEMA_MIGRATIONS` array** — Not possible (current count is 30). If a future refactor empties the array, the loop is a no-op. Defensive.

4. **Connection failure mid-migration** — LadybugDB connection is created BEFORE the migration loop. If a migration fails, the connection is still open and the DB is initialized but partially migrated. Next `initLbug` retries the migrations (idempotent). Acceptable.

5. **Race conditions on concurrent `initLbug`** — `doInitLbug` runs under `runWithSessionLock` (scout confirmed). Concurrent init for the same DB is serialized. Migrations are idempotent on retry.

6. **What if a future migration targets a column that already exists?** — The runner suppresses both `already has property` (Kùzu's wording) and `already exists` (legacy wording) errors. The migration is skipped on second run, no brick. The error is logged for diagnosis.

## BlastRadius

| Tier | Files / Components | Impact |
|---|---|---|
| **d=1 (modified)** | `gitnexus/src/core/lbug/schema.ts` (add `SCHEMA_MIGRATIONS` array, ~30 LOC) | direct |
| | `gitnexus/src/core/lbug/lbug-adapter.ts` (insert migration loop + split helper, ~15 LOC) | direct |
| **d=1 (new test)** | `gitnexus/test/integration/lbug-core-adapter.test.ts` (2 new tests, ~120 LOC total) | direct |
| **d=2 (read-only)** | `gitnexus/src/cli/analyze.ts` (calls `initLbug` — no change) | read-only |
| | `gitnexus/test/helpers/test-indexed-db.ts` (calls `initLbug` — no change) | read-only |
| | All integration tests using `withTestLbugDB` (now exercise migrations on every fresh DB — pass-through) | read-only |
| **d=3 (regression gates)** | `python-function-properties.test.ts` (Function schema + migration) | must pass — also exercises the runner |
| | `lbug-core-adapter.test.ts` (existing 14 tests) | must pass |

## CrossCutting

- **`[[db-is-ladybugdb]]`**: directly relevant. The fix uses the Kùzu-native `conn.query(statement)` API and respects its single-statement constraint via runtime splitting.
- **`[[feedback-kuzu-alter-table-no-if-not-exists]]`**: directly relevant. Kùzu's `ALTER TABLE` parser rejects the `COLUMN` keyword and has no `IF NOT EXISTS` clause — every migration string in `schema.ts` uses `ALTER TABLE X ADD <col> <type>` (no `COLUMN`, no `IF NOT EXISTS`) and the runner swallows Kùzu's `Runtime exception: ... already has property` to keep re-runs idempotent. Do not "fix" migrations by adding `IF NOT EXISTS` — see the memory for the parser error.
- **`[[stale-index-zero-results]]`**: relevant. The runner fixes a class of "0 results that look like a stale index but are actually a missing column" bugs. A user upgrading to a GitNexus version with this PR will get the missing columns on next `analyze` without needing `--force`.
- **`[[route-fix-regression]]`**: not relevant. No route extraction involved.

## Autonomous Decisions

- **AD-1**: Explicit array (Option A) over auto-discovery (Option B) and AST (Option C). Rationale: consistent with existing patterns, auditable, no runtime cost.
- **AD-2**: Multi-statement migration splitting happens in the runner, not in `schema.ts`. Rationale: minimal churn, no test changes, centralizes the splitting logic.
- **AD-3**: Suppress `already has property` and `already exists` errors in the migration loop. Rationale: Kùzu's `ALTER TABLE` has no `IF NOT EXISTS` clause, so re-running on a populated DB will always throw on re-ADD; the catch is the only idempotency mechanism. Errors are still caught and propagated only for non-idempotency cases.
- **AD-4**: No transaction wrapper. Rationale: implicit per-statement transactions are sufficient; explicit transaction adds complexity for no benefit.
- **AD-5**: The 1 new regression test is the public-API contract test (open fresh DB → create Function → query `parameterCount`). Sufficient to demonstrate the runner works. Multi-language migrations are structurally identical to the 2 representative migrations and are covered by their respective language integration tests.
- **AD-6**: Defer #141 (Go fixture follow-up) — not in this batch.
- **AD-7**: Defer any further `_MIGRATION_3+` future-proofing work — the explicit array pattern handles any new migration via 1-line addition.

## Verification

| Test | Expected | Gate |
|---|---|---|
| `gitnexus/test/integration/lbug-core-adapter.test.ts` — new test `migrations run on initLbug, add columns to existing schema` | fresh DB, create Function node, query `parameterCount`/`returnType` — succeeds | must |
| `gitnexus/test/integration/python-function-properties.test.ts` (existing 7 tests) | all pass (also exercises the runner on every fresh DB) | must |
| `gitnexus/test/integration/lbug-core-adapter.test.ts` (existing 14 tests + 1 hardening re-open test) | all pass | must |
| `npx vitest run` (full suite) | 5752+ pass, 0 new fail | must |
| `npx tsc --noEmit` | clean | must |
| `npx gitnexus detect_changes` post-merge | scoped to d=1 files | must |
| Manual: `gh issue close 160` with implementation summary | closed | must |
