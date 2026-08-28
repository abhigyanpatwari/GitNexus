# Guardrails — GitNexus

Rules for **human contributors** and **AI agents**. Complements `AGENTS.md` (workflows) and `CONTRIBUTING.md` (PR process).

## Scope (least privilege)

- **Read:** Source, tests, docs, public config as needed.
- **Write:** Only files required for the fix or feature; no unrelated formatting or refactors.
- **Execute:** Tests, typecheck, documented CLI commands. No destructive commands on user data without approval.
- **Off-limits:** Other people's machines, production deployments you don't own, credentials you lack permission to use.

Maintainer may widen scope per task.

---

## Non-negotiables

1. **Never commit secrets** — API keys, tokens, real `.env` values, private URLs, session cookies. Use `.env.example` with placeholders.
2. **Never rename with find-and-replace** in GitNexus-indexed projects — use `rename` MCP tool with `dry_run: true` first, review `graph` vs `text_search` edits. No separate `gitnexus rename` CLI exists.
3. **Run impact analysis before editing shared symbols** — `impact` (upstream) for functions/classes/methods others call. Do not ignore HIGH/CRITICAL without maintainer sign-off.
4. **Run `detect_changes` before commit** — confirm diffs map to expected symbols/processes when the graph is available.
5. **Preserve embeddings** — plain `npx gitnexus analyze` now preserves any embeddings recorded in the index metadata (`.gitnexus/gitnexus.json`, mirrored to the legacy `meta.json`) — the previous behavior wiped them. Use `--embeddings` to also generate vectors for new/changed nodes; use `--drop-embeddings` only when an explicit wipe is intended (e.g., model swap).
6. **Never `terminate()` a worker that may be inside a native call** — killing a worker thread mid-N-API aborts the entire process (`Napi::Error` → `std::terminate` → SIGABRT, #2432), so a timeout meant to trigger a graceful fallback takes the whole run down instead. Any worker running native code (tree-sitter grammars, LadybugDB, Icebug) must either reach a JS-visible safe point first — the parse pool's `shutdownDrainMs` handshake in `src/core/ingestion/workers/worker-pool.ts` — or be abandoned with `unref()` and left to exit on its own. A one-shot worker that ends after a single `postMessage` needs no `terminate()` at all: it exits by itself. This bites hardest on the path you cannot test locally, because the abort only reproduces once the native module actually loads.

---

## Signs (recurring failure patterns)

Format: **Trigger → Instruction → Reason**. Append new Signs when the same mistake repeats.

### Stale graph after edits

- **Trigger:** MCP warns index is behind `HEAD`, or search doesn't match latest commit.
- **Do:** `npx gitnexus analyze` (plus `--embeddings` if used). Runs incrementally by default — the pipeline parses every file every run (cross-file resolution requires it), but tree-sitter dispatch is skipped for unchanged file chunks via the content-addressed cache, and only changed-file rows (plus their importers, transitively) are rewritten in LadybugDB. When the effective write set exceeds ~50% of the repo's files (minimum 50 files), the run transparently switches to the full wipe + bulk-COPY write plan and logs "switching to a full DB write" — expected behavior, not a bug, and file-level bookkeeping stays incremental. That same line also appears — regardless of write-set size, even for a one-file change — when a LadybugDB extension the existing index depends on cannot load on this machine (VECTOR, #2623; FTS, #2841), because a DB carrying those indexes refuses all row-level DML until the extension is loaded; run `gitnexus doctor` for live extension status and re-run with `GITNEXUS_LBUG_EXTENSION_INSTALL=auto` (with network access) to allow one bounded install attempt. The rebuild is one-shot: it clears the indexes, so the next run goes back to the incremental plan.
- **Why:** Tools query LadybugDB from last analyze; git changes are invisible until re-indexed.

### Index seems corrupt or "incremental" is misbehaving

- **Trigger:** `analyze` produces unexpected results, or `incrementalInProgress` is set in the index metadata (`.gitnexus/gitnexus.json` / legacy `meta.json`), or the index is in a half-state after a crash.
- **Do:** `npx gitnexus analyze --force` to rebuild from scratch. The dirty-flag check forces this automatically when a previous incremental run didn't complete cleanly, but `--force` is the manual escape hatch. A dirty-flag recovery rebuild parks the interrupted run's sidecars beside the DB as `lbug.wal.dirty-recovery` / `lbug.shadow.dirty-recovery` for post-mortem debugging — harmless, and removable with `npx gitnexus clean --lbug-sidecars`. Safe to delete the `.gitnexus/parse-cache/` directory (and any legacy `.gitnexus/parse-cache.json`) at any time — content-addressed, will be regenerated.
- **Why:** Incremental writeback is selective DB row replacement; if the on-disk state is inconsistent for any reason, a full rebuild is the cheapest path back to a known-good index.

### Embeddings vanished after analyze

- **Trigger:** Semantic search quality drops; `stats.embeddings` in the index metadata (`gitnexus.json` / legacy `meta.json`) is 0 after refresh.
- **Do:** Re-run `npx gitnexus analyze --embeddings` to regenerate. Check the analyze log for a `Warning: could not load cached embeddings` line — if present, the cache restore failed (corrupt DB / schema mismatch) and the rebuild had nothing to preserve. If you intentionally passed `--drop-embeddings`, this is expected.
- **Why:** Plain `analyze` preserves prior vectors by re-inserting them after the rebuild; ways to end up at zero include an explicit `--drop-embeddings`, a cache-load failure (now logged), or a model/dimension change that invalidates the cache — but zero is no longer the only embedding-loss signature to watch for; see the Sign below for the non-zero, partial-failure case. A dirty-recovery run that cannot move the crashed WAL aside now either discards it (logged: forensics lost, embeddings still preserved) or fails fast with a lock error naming the holder — it never silently zeroes embeddings.

### Analyze finishes but embeddings are incomplete (partial embedding index)

- **Trigger:** `npx gitnexus status` reports `incompleteReasons: ["embedding-checkpoint-pending"]` (or the human-readable "Index incomplete reasons" line); `stats.embeddings` is honest and **non-zero**, and the preceding analyze log showed a `Warning: N node(s) lost their embeddings to embedding-endpoint failures` line (#2790).
- **Do:** Re-run plain `npx gitnexus analyze` — no `--embeddings` flag needed. A retained `embeddingCheckpoint` in the index metadata forces embedding generation for exactly the pending nodes regardless of flags, and clears once they succeed. `--drop-embeddings` abandons the pending nodes instead of retrying them; `--force` also discards the checkpoint (with a warning) and rebuilds without resuming it.
- **Why:** A long analyze run against a flaky HTTP embedding endpoint tolerates bounded sub-batch failures instead of aborting the whole run: it deletes the affected nodes' embedding rows (so they hold zero rows, never a partial set) and records those nodes as pending in `embeddingCheckpoint`. `stats.embeddings` stays an honest, non-zero count of everything that did succeed, so this state never trips the "Embeddings vanished" Sign above — `embedding-checkpoint-pending` is the only reliable signal.

### Scope extraction is incomplete

- **Trigger:** `npx gitnexus status` reports `incompleteReasons: ["scope-extraction-failed"]` when files were omitted, or `incompleteReasons: ["scope-extraction-unverified"]` when the index predates the completeness receipt or its metadata is unreadable. `impact`/`context` reports the same uncertainty as `epistemic: "lower-bound"`; confirmed omissions set `causes.scopeExtractionFiles > 0`.
- **Do:** Re-run `npx gitnexus analyze` (`--force` for a full graph rebuild). If the reason persists, inspect the scope-extraction warnings and treat impact counts as floors until the affected source is supported or corrected.
- **Why:** Parsing continued, but scope captures for the reported file count could not be produced even after the main-thread fallback. Calls, inheritance, imports, or accesses originating there may therefore be absent from the graph.

### Analyze reports INCOMPLETE with a collapsed graph write

- **Trigger:** `npx gitnexus status` reports `incompleteReasons: ["graph-write-collapsed"]`; the analyze summary printed `Repository indexed INCOMPLETELY` naming an expected and a persisted relationship count, and the CLI exited non-zero.
- **Do:** Re-run `npx gitnexus analyze --force`. If it recurs, check free disk space on the volume holding `.gitnexus/`, confirm no second `analyze` is running against the same repo (both stage through `.gitnexus/csv`), then run `npx gitnexus doctor`.
- **Why:** The run finished and wrote metadata, but far fewer relationships are readable back than the pipeline produced. Nothing throws: the DB holds rows and the metadata is valid, so every query answers with missing edges rather than an error — a confident empty answer, which is worse than a failure because it looks like a result. Unlike `incremental-in-progress` and `embedding-checkpoint-pending`, which describe a run that did what it said and left work for next time, this one means most of your edges are gone, so it is the one incomplete reason that also fails the exit code. The check compares in-memory totals (including rows streamed out of the heap) against the post-write count, refuses to answer when the count cannot be read, and is skipped on incremental runs where whole-scope counts are not comparable.

### MCP lists no repos

- **Trigger:** MCP stderr says no indexed repos.
- **Do:** `npx gitnexus analyze` in the target repo; verify `npx gitnexus list` shows it.
- **Why:** MCP discovers repos via `~/.gitnexus/registry.json`, populated by analyze.

### Wrong repo in multi-repo setups

- **Trigger:** Query/impact results belong to another project.
- **Do:** Call `list_repos`, then pass `repo` on subsequent tools.
- **Why:** Default target is ambiguous when multiple repos are registered.

### LadybugDB lock / "database busy"

- **Trigger:** Errors opening `.gitnexus/lbug` while MCP and analyze both run.
- **Do:** Stop overlapping processes (one writer at a time). Retry analyze or restart MCP.
- **Why:** Embedded DB expects single-process ownership. `@ladybugdb/core` 0.18.0 also reports this contention as `"Only one write transaction at a time is allowed in the system."` — our busy/lock retry matcher (`isDbBusyError` in `src/core/lbug/lbug-config.ts`) recognizes this exact string too, so it's auto-retried the same as any other lock error. If you see that exact message, it's the same "one writer at a time" issue above, not a new failure mode.

---

## Publishing & supply chain

- **npm:** Do not publish from unreviewed automation. Bump version intentionally; tag releases to match `package.json`.
- **Dependencies:** Minimal, auditable `package.json` changes; run tests and CI after lockfile updates.
- **License:** PolyForm Noncommercial 1.0.0 — do not relicense without maintainer approval.

---

## Escalation

Stop and ask a **human maintainer** when:

- Impact analysis shows HIGH/CRITICAL risk and the task still requires the change.
- You need to alter CI, release, or security-sensitive config.
- Requirements conflict (e.g. "speed up analyze" vs "must keep all embeddings on huge repo").
- You are unsure whether data loss is acceptable (`clean`, forced migrations, schema changes).

---

## Related docs

- [ARCHITECTURE.md](ARCHITECTURE.md) — components and data flow
- [RUNBOOK.md](RUNBOOK.md) — commands for recovery
- [CONTRIBUTING.md](CONTRIBUTING.md) — PR and commit expectations
