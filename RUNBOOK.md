# Runbook — GitNexus

Short, copy-paste operations for **local development**, **MCP**, and **CI**. Commands assume a Unix shell; on Windows use Git Bash or equivalent paths.

## Prerequisites

- **Node.js** ≥ 20 (`gitnexus-web/package.json` `engines`).  
- **Git** (analyze requires a git repository).  
- From repo root, install and build the CLI package:

```bash
cd gitnexus
npm install
npm run build
```

Use `npx gitnexus …` from any path after global/published install, or `node dist/cli/index.js …` when developing from `gitnexus/` with a local build.

---

## Index out of date / “stale” tools

**Symptom:** MCP or resources warn the index is behind `HEAD`, or results don’t reflect recent commits.

**Fix (from the target repo root):**

```bash
npx gitnexus analyze
```

**Force full rebuild** (same commit but suspect corruption or changed ignore rules):

```bash
npx gitnexus analyze --force
```

**Check status:**

```bash
npx gitnexus status
```

**List what MCP knows about:**

```bash
npx gitnexus list
```

**Scope extraction incomplete:** `npx gitnexus status` reports
`incompleteReasons: ["scope-extraction-failed"]` when one or more files still
lack scope captures after the worker and fallback passes. `impact` and `context`
then report a lower bound with `causes.scopeExtractionFiles` set to the affected
file count. Re-run `npx gitnexus analyze --force`; if the reason remains, inspect
the scope-extraction warnings for the unsupported or malformed source file.
Every pre-existing index remains unverified until it is analyzed once by a
version that writes the completeness receipt. An older index or unreadable completeness record reports
`incompleteReasons: ["scope-extraction-unverified"]`; re-analyze it before treating
empty impact results as exact.

**Invalid symbol identity:** `query`, `context`, or `impact` can return
`The index returned an invalid symbol identity` with recovery guidance instead
of returning malformed results. Rebuild from the affected repository root with
`npx gitnexus analyze --force`. If the error returns, retain the failing command,
GitNexus/Node versions and `gitnexus doctor` output for investigation. This check
detects blank IDs and NUL-containing identity fields; it does not prove that
every otherwise plausible name, path or source range is correct.

**MCP freshness after rebuilding:** a warm session refreshes its index reference
when it opens the replacement graph, including a rebuild at the same commit.
A busy reader keeps its old reference until it can reopen. During an observed
graph/metadata publication gap, freshness is `unknown`; retry after analysis
finishes rather than treating that response as current.

---

## Embeddings

**First time with vectors** (slower, more disk/RAM):

```bash
npx gitnexus analyze --embeddings
```

Chunking defaults to AST boundaries with a 1,200-character budget and 120-character overlap.
Set `GITNEXUS_EMBEDDING_CHUNK_SIZE`, `GITNEXUS_EMBEDDING_CHUNK_OVERLAP`, and
`GITNEXUS_EMBEDDING_CHUNK_STRATEGY=ast|fixed` to override them. The size must be a
safe integer of at least 2, and overlap must be a nonnegative integer smaller
than the size. Blank values use the configured defaults. Smaller chunks can
increase embedding requests. Class inputs retain declarations and fields;
method implementations remain searchable through their own nodes. Unsupported
parsers and indivisible oversized expressions use bounded character windows;
Class parser failures retain metadata only.
AST overlap repeats only whole statements that fit the overlap budget. Preceding
context excludes text already in the next chunk, avoiding duplicate model input.

Full-retention indexes read original source for classes and long or truncated
snippets, after skipping unchanged nodes. This preserves indentation, tails
beyond the FTS snippet cap, and source ranges. The source must match the indexed
file fingerprint: if embedding sync reports missing or changed source, restore
the checkout or run `gitnexus analyze` before retrying. Older non-git indexes
did not store file fingerprints. From that checkout, run `gitnexus analyze`
once, then retry `gitnexus embeddings sync` or the server's embedding job.
Sync cannot safely reconstruct the old snapshot's fingerprints from current
files, so it requires reanalysis instead of reading unverified source.
Symbol/none retention never reads checkout content for embedding; limited retained snippets use
conservative enclosing ranges. Changed chunk policies and source-aware layouts
refresh affected vectors once; unchanged short default inputs retain their hashes.
Recovering source beyond the old snippet cap can increase vector counts and
initial embedding time; unchanged nodes still skip source reads and inference.
When a file changes, verified identical inputs and ranges reuse their existing
vectors and refresh only the cached fingerprint. Changed tails and incomplete
checkpoint groups still regenerate their vectors.

For paired performance measurements, build both checkouts and run from `gitnexus/`:
`node --expose-gc bench/embedding-chunking/measure.mjs /path/to/baseline /path/to/candidate /tmp/chunk-bench.json`.
The `embedding-chunking-benchmark` job in `.github/workflows/ci-tests.yml` builds
the comparison revision and candidate, runs this benchmark with `--source`, and
uploads the JSON samples and log as `embedding-chunking-performance` for 30 days.
The benchmark uses the local embedding model and saves raw samples outside the
repository. Recorded paired measurements and their environment are in
`gitnexus/bench/embedding-chunking/baseline.json`. These are diagnostic references,
not machine-independent timing gates. Compare per-cohort median/p95, input counts,
and memory observations;
it does not substitute for native analyze and persistence tests.
To include source verification and the stored-snippet cap in the comparison, run
`node --expose-gc bench/embedding-chunking/measure.mjs /path/to/baseline /path/to/candidate /tmp/chunk-bench.json --source`.
The large-function and medium-statement cohorts expose extra coverage and overlap
costs; compare complete-source candidates separately from older capped inputs.

**Important:** If you already had embeddings, a plain `npx gitnexus analyze` **preserves** them (Non-negotiable 5 in [GUARDRAILS.md](GUARDRAILS.md)) — pass `--embeddings` when you also want vectors generated for new or changed nodes, and `--drop-embeddings` only for a deliberate wipe. See `stats.embeddings` in `.gitnexus/gitnexus.json` (or its legacy `meta.json` mirror; 0 means none) — but that figure isn't always freshly measured: if a run's embedding-count query can't answer, it carries the previous run's number forward instead of writing a wrong zero. For a certified read, check `capabilities.vectorSearch.status` instead — it reads `unavailable` (never a stale count) whenever GitNexus can't vouch for the live vector index.

**Embedding work interrupted after graph publication:** The graph and keyword index become available before embedding work starts. An embedding failure makes analyze exit nonzero while keeping that graph available and retaining acknowledged embedding work. `npx gitnexus status --json` reports graph freshness separately from embedding progress and vector readiness. Resume with:

```bash
npx gitnexus analyze
```

No `--embeddings` flag is needed for a retained job. `npx gitnexus embeddings sync` also resumes work against an already published graph. Compatible acknowledged units do not call the provider again; a unit interrupted before acknowledgement may replay. A source or embedding-configuration change revalidates reuse, and changing worker counts or memory budgets does not invalidate paid vectors. `--drop-embeddings` deliberately abandons retained vectors. `--force` rebuilds the graph while retaining compatible paid work for reuse.

Older indexes may instead carry an `embeddingCheckpoint` and report `embedding-checkpoint-pending`. Plain analyze recovers that checkpoint, including any explicitly referenced staging data, before migrating it. Historical vectors without verified provider/model provenance are retained without being relabeled as output from the current model.

**Collapsed graph write (analyze exits NON-ZERO and says INCOMPLETE):** A run can finish writing metadata while only a fraction of the relationships it produced are readable back from the index — edges collapsing to a small share of what was built, or a `CodeRelation` table that never materialized (which reads as a persisted count of zero). Because the metadata IS written and the DB does hold rows, nothing looks broken: queries answer with missing edges rather than an error, which is a confident empty answer rather than a failure. `npx gitnexus status` reports `incompleteReasons: ["graph-write-collapsed"]`, the analyze summary prints `Repository indexed INCOMPLETELY` with the expected and persisted counts, and the CLI exits non-zero so automation is not told an unusable index is fine.

Recovery is a full rebuild:

```bash
npx gitnexus analyze --force
```

If it recurs, the cause is almost always environmental rather than a code defect: check free disk space on the volume holding `.gitnexus/`, make sure no second `analyze` is running against the same repo (both use `.gitnexus/csv` for staging), then run `npx gitnexus doctor`. The check compares in-memory relationship totals (including streamed rows) against what the DB hands back, and is deliberately skipped on incremental runs, where the two counts are not comparable.

**Weak semantic recall despite existing embeddings:** If paraphrased queries look like keyword-only search, the distance cutoff may be too strict for the embedding model. CLI and MCP `query` default to `0.6`. From the indexed repository, try a broader cutoff:

```bash
GITNEXUS_VECTOR_MAX_DISTANCE=0.8 npx gitnexus query "how are expired sessions removed" --limit 10
```

Compare target inclusion and ranking against the default; a broader cutoff also admits less relevant hits. Set the variable in the MCP/serve launch environment and restart that process when tuning a server. A cutoff change needs no reindex and setting it only during `analyze` does not persist it. If the index has no vectors, generate embeddings first; if the embedding model or dimensions differ between indexing and querying, align that configuration and regenerate vectors. See [Vector cutoff tuning](README.md#vector-cutoff-tuning) for validation rules and the limited `voyage-code-4` evidence from #3457.

**Large repos:** Analyze may skip or limit embedding work when node counts are very high; watch CLI output.

---

## MCP: no repos / empty tools

**Symptom:** `GitNexus: No indexed repos yet` on stderr when starting MCP.

**Fix:** In each project you want indexed:

```bash
cd /path/to/repo
npx gitnexus analyze
```

Restart the editor MCP session if needed. The server **refreshes the registry lazily**; new analyzes are picked up without necessarily reinstalling MCP.

**Symptom:** Wrong repo when multiple are indexed — pass `repo` on tools or use `list_repos` first.

---

## Clean slate (corrupt or huge `.gitnexus`)

**Current repo only** (prompts for confirmation):

```bash
npx gitnexus clean
```

**Skip confirmation:**

```bash
npx gitnexus clean --force
```

**All registered repos:**

```bash
npx gitnexus clean --all --force
```

Then re-run `npx gitnexus analyze` (and `--embeddings` if you need vectors).

---

## Local bridge for the web UI

```bash
cd gitnexus
npx gitnexus serve
# default http://127.0.0.1:4747 — see serve --help for port/host
```

Use when the browser UI should talk to **local** indexed repos instead of WASM-only mode.

---

## CLI equivalents of MCP tools

Useful for debugging without an editor:

```bash
cd gitnexus
npx gitnexus query "authentication flow" --repo MyRepo
npx gitnexus context SomeSymbol --repo MyRepo
npx gitnexus impact SomeSymbol --direction upstream --repo MyRepo
npx gitnexus cypher "MATCH (n) RETURN count(n) LIMIT 1" --repo MyRepo
```

---

## CI failures (contributors)

Orchestrator: `.github/workflows/ci.yml`.

| Job | Typical local repro |
|-----|---------------------|
| **quality** | `cd gitnexus && npx tsc --noEmit` |
| **unit-tests** | `cd gitnexus && npx vitest run test/unit` |
| **integration** | `cd gitnexus && npx vitest run test/integration` (see workflow matrix for groups) |
| **e2e** | Triggered when `gitnexus-web/` changes; `cd gitnexus-web && E2E=1 npx playwright test` (requires `gitnexus serve` + `npm run dev`) |

**Note:** Pushes that touch only certain markdown paths may be skipped by `paths-ignore` in CI — see workflow file for exact patterns.

---

## Query memory limit

**Symptom:** a CLI, MCP, or HTTP server process exits with code **70** and
`GitNexus stopped: process memory reached …` on stderr.

The pooled-read guard detected memory above its process-wide budget. Native
query allocations are outside both V8's heap limit and LadybugDB's buffer pool.
The Node binding cannot interrupt them, so the guard exits the process to
release memory. Every request in that process is interrupted; restart the
CLI/server or reconnect the MCP client. A read-only query does not require a
reindex after this exit.

To diagnose a repeat, set `GITNEXUS_QUERY_TRACE=1` in the query/server environment
and retain stderr. It includes query text but not bound parameters. Review the
output before sharing it with [issue #3696](https://github.com/abhigyanpatwari/GitNexus/issues/3696).
Set `GITNEXUS_QUERY_MAX_RSS_MB=<MiB>` to change the limit; `0` disables it. The
default is max(8 GiB, 25% of available RAM), capped at 75% of available RAM,
including a reported container/runtime constraint.

RSS is checked at query start/end and every 200 ms while reads run. On macOS,
queries lasting at least one second also sample physical footprint at most
once per second, including compressed/swapped memory. If the OS footprint
command is unavailable, monitoring falls back to RSS. Sampling is a mitigation,
not a hard OS memory limit: rapid allocation or a blocked event loop can outrun
it. Writes during `analyze` are outside this guard.

The caller's 30-second read deadline covers prepare, execution, and row
materialization. Timing out does not cancel native work: monitoring and its
checked-out connection remain owned by that work until it settles. An impact
frontier is separately capped at 100,000 relationship rows per depth. A capped
walk stops and reports `partial: true`. Both `risk` and `riskSharedAxes` retain
HIGH/CRITICAL or report UNKNOWN instead of LOW/MEDIUM. This row cap does not bound the database's
intermediate allocations. Narrow the target or relation filters before relying
on a partial result.

## Memory / analyze crashes

Analyze re-execs Node with a **large old-space heap** when needed (`analyze.ts`). If you still OOM on huge repos, close other processes, avoid `--embeddings` for a first pass, or analyze a smaller path if supported by your workflow.

`--resource-budget <MiB>` admits the analyzer process family within one memory
reservation: the frontend, main heap, parser workers, native graph/vector pools,
embedding model, bounded input queue, and headroom. For example:

```bash
npx gitnexus analyze --embeddings --resource-budget 8192 --memory-budget 1024 --workers 2
```

Node propagates the main V8 heap flag to parser workers, so each worker reserves
at least the `--memory-budget` allocation. Explicit settings that do not fit
the family budget fail before work starts. Without a family override,
GitNexus fixes the family ceiling at 75% of effective process/container RAM,
divided among concurrent auto-sync analyses. Automatic heap, worker and native
pool allocations must fit that ceiling; it never grows to accommodate them.
Explicit heap, worker or pool requests that cannot fit are rejected before work.
Small hosts may need an HTTP embedding provider or more RAM for the local model.
The budget controls
admission and queue sizes; it is not an operating-system RSS limit. Watch mode
accepts the same family budget and drains active work before shutdown.

`Unable to allocate memory` / `The buffer pool is full` during graph writes
refers to LadybugDB's native buffer pool. Increasing `NODE_OPTIONS`,
`--memory-budget`, or worker heap limits does not resize that pool. Recognized
pool exhaustion aborts analysis instead of retrying with row skipping.

If the host has enough memory, set an explicit pool size in **bytes**, then
rebuild. For example, 3 GiB is `3221225472` bytes:

```bash
GITNEXUS_LBUG_BUFFER_POOL_SIZE=3221225472 npx gitnexus analyze --force
```

The override bypasses automatic pool sizing. Budget for the Node heap, parse
workers, other native allocations, and the OS alongside it; a larger pool can
exhaust the host. Outside bounded analysis, `GITNEXUS_LBUG_BUFFER_POOL_SIZE=0`
selects LadybugDB's native 80%-of-RAM default. Analysis and embedding admission
reject zero because that native allocation cannot fit alongside their other
reservations. Unset the variable for automatic sizing, or set an explicit byte
limit of at least 8 MiB that fits the resource budget. If memory is insufficient,
exclude generated/vendor directories or use a larger host.

A measured graph-write collapse aborts a staged build before publication,
leaving the previous index, if any, intact. An in-place run cannot roll back:
it records `graph-write-collapsed` and exits nonzero. Rebuild a previously
collapsed index with `--force` after addressing memory, disk space, or the
reported COPY error; do not rely on its incomplete query results.

---

## LadybugDB / lock errors

Only one process should open a repo's `.gitnexus/lbug` store at a time. If MCP and a second `analyze` run conflict, stop one process, then retry `analyze` or restart MCP.

If the error text is `"Only one write transaction at a time is allowed in the system."` instead of a lock/busy message, it's the same underlying conflict — our retry matcher (`isDbBusyError` in `src/core/lbug/lbug-config.ts`) recognizes this exact string and auto-retries it. The fix if it still surfaces after retries is the same: stop the overlapping process.

---

## File acquisition/reclaim guard recovery

The portable file-lock backend uses `analyze.lock.guard` beside `analyze.lock`.
Every acquisition, including an empty slot, exclusively creates the guard before
inspecting, reclaiming, creating, and verifying the main lock. It removes the
guard before returning a workload handle or waiting on a live workload holder.
Linux abstract-socket and Windows named-pipe locking are unchanged.

A stalled or crashed guard owner blocks file acquisition even when its PID is
dead, its metadata is incomplete, or no main lock exists. **The guard is never
automatically stolen.** Guard contention times out after at most 30 seconds,
capped by the remaining acquisition timeout. This separate ceiling applies even
when `GITNEXUS_INDEX_LOCK_TIMEOUT_MS` is zero or negative (unbounded workload wait).
A guard-cleanup failure rejects acquisition; it must not start unprotected work.

Manual recovery is an outage procedure, not an age/PID-based cleanup:

1. Identify the exact lock directory named in the error. This shared primitive
   also protects group sync and registry operations, not just repo analysis.
2. Stop **all relevant writers** and prevent restart: editor/agent hooks, watch
   processes, scheduled jobs, services, and any containers sharing the directory.
   Account for paused processes and every host with access. If quiescence cannot
   be established, do not remove the guard. PID metadata is diagnostic only.
3. While restart remains disabled, inspect and preserve the guard/main records
   for diagnosis, then remove only that directory's orphan `analyze.lock.guard`
   and, if present, its orphan `analyze.lock`. Do not remove databases or sidecars
   as part of lock recovery. Do not use a recursive or wildcard cleanup.
4. Ensure all participating writers use the guarded version and the same locking
   backend/domain, then restart in a controlled fashion.

**Upgrade requires a coordinated stop/upgrade/restart.** Concurrent older
versions ignore the guard and can still displace live locks; mixed-version
mutual exclusion is not guaranteed. The file protocol assumes reliable atomic
local-filesystem `O_EXCL` creation and cooperating processes. Network/distributed
filesystems, external file replacement, and uncoordinated manual deletion are not
covered. A process crash while holding the short-lived guard trades automatic
recovery for fail-closed safety. Denied file creation returns a non-owning
`lockFree` handle only when neither workload lock nor acquisition guard exists;
unreadable paths fail closed. No staging sweep runs without ownership. Analysis,
registry transactions, group synchronization, and embeddings sync refuse
`lockFree` handles, including an otherwise up-to-date analysis on a file-backend
read-only mount.
The socket backend can still acquire ownership on a read-only index mount.
Heterogeneous permissions are not proof that another process cannot write.

If guard cleanup fails after this attempt created its workload record, acquisition
is refused and token-exact workload cleanup is attempted before returning the
error. Failed or unverifiable cleanup must be diagnosed under the same quiesced
recovery procedure above; never delete a possibly active successor's record.

---

## Where to dig deeper

- Architecture overview: [ARCHITECTURE.md](ARCHITECTURE.md)  
- Agent safety rules: [GUARDRAILS.md](GUARDRAILS.md)  
- Tests: [TESTING.md](TESTING.md)
