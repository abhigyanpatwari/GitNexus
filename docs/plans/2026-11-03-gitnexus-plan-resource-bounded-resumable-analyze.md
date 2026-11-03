# GitNexus Engineering Plan — resource-bounded, resumable analyze

> Task: implement [GitNexus #3598](https://github.com/abhigyanpatwari/GitNexus/issues/3598), without performance degradation.
> Depth: Deep; form: full; impact depth: 3. Planning only; implementation requires the LFG plan gate.
> Evidence verified at commit f641342d1fcbfdcb764c5e478db0f69e6cea899a on fix/ci-timing-download-retries.
> Index commit matches HEAD, but analyzer provenance is not established against current source; graph symbol identities also disagree with source. **Stale analyzer provenance — source-weighted limitation.** PDG unavailable. No refresh or build performed.
> Evidence provenance schema 2; global dirty digest 305f776a6b7dae0c761b813156861754467d5410fce87ece8bda66d0ea6d377c; 58 sorted cited paths; exact generated plan path excluded.

## 1. Objective

Deliver a verified graph and keyword index before optional embeddings finish. Bound retained embedding inputs and queued work by resources, resume paid work after interruption, and report graph and vector readiness independently. Preserve throughput, query latency, embedding text/coverage, and ordinary analysis performance. Memory savings obtained by silently doing less work do not satisfy the request.

The acceptance scenarios are: bounded large-corpus input retention; the new graph queryable during and after embedding failure; unchanged-generation retries processing only unfinished units; safe recovery at every publication/write boundary; selective invalidation with reasons; truthful status/query capabilities; independent phase progress; and a short synthetic regression suite plus measured before/after performance.

## 2. Current Behaviour

- [verified] `queryEmbeddableNodes` reads each eligible label into `allNodes`, including content; the File fallback also materializes its result. `runEmbeddingPipeline` retains nodes, an identity set, hashes, stale IDs, and per-batch expanded texts before sub-batch embedding (`gitnexus/src/core/embeddings/embedding-pipeline.ts:162–277, 606–615, 648–788, 844–865`). Small inference batches therefore do not bound corpus input retention.
- [verified] The pipeline announces an active window before mutation; the default window is 5,000 nodes rounded to batch boundaries. It replaces exact row IDs and removes all rows for nodes with failed chunks (`embedding-pipeline.ts:283–319, 595, 726–729, 775–785, 969–1044`). Preserve these correctness rules.
- [verified] `runFullAnalysisInner` completes graph/FTS work and graph integrity checks before embeddings, but closes and publishes the database and freshness metadata only afterward (`gitnexus/src/core/run-analyze.ts:4759–4782, 4977–5044, 5434–5536`). The shared-store publication wrapper also waits for the inner analysis to return (`run-analyze.ts:1528–1541`).
- [verified] The analyze checkpoint callback drains WAL before recording completed windows. Staged recovery validates a retained staging family and filters unsafe node groups; it is useful existing behavior, not a missing feature (`run-analyze.ts:4995–5041`; `gitnexus/src/storage/embedding-recovery.ts:50–112`; `gitnexus/src/core/embeddings/staged-embedding-recovery.ts:117–185`).
- [verified] Checkpoints record model/dimensions/provider, pending IDs and optional staging/schema identity, but do not contain a complete persisted work manifest keyed to source coverage and analyzer identity (`gitnexus/src/storage/repo-meta.ts:47–53, 502–549`).
- [verified] `getIndexIncompleteReasons` includes embedding pending state, and status requires this entire list to be empty for current metadata. The MCP vector lane probes row counts and queries the graph database without using a completed-vector-generation receipt (`gitnexus/src/core/index-freshness.ts:134–175`; `gitnexus/src/cli/status.ts:321–330`; `gitnexus/src/mcp/local/local-backend.ts:4348–4478`).
- [verified] Analyze maps the embedding percentage to 90–98% overall. SSE correctly waits for the job's terminal status rather than trusting the pipeline's `ready` event (`run-analyze.ts:4980–4988`; `gitnexus/src/server/sse-progress.ts:60–75`).

## 3. Relevant Architecture

- [verified] Analyze owns an exclusive index lock; graph writes use the singleton adapter and its checkpoint driver. The read pool opens separate read-only native databases. Its injected in-process database mechanism does not establish cross-process read/write support (`run-analyze.ts:1451–1491`; `gitnexus/src/core/lbug/pool-adapter.ts:658–714, 993–1019`).
- [verified] `streamQuery` explicitly refuses to run with the singleton WAL driver active. Wrapping the current all-content query in this function while embedding writes continue would violate an existing invariant (`gitnexus/src/core/lbug/lbug-adapter.ts:1959–2004`).
- [verified] Vector results already return node IDs and are then hydrated through graph queries. A separate vector database can preserve this lookup shape (`local-backend.ts:4406–4426, 4485–4515`). Native vector-index creation still uses adapter-specific behavior, so changing only the injected query function is insufficient.
- [verified] Shared graphs are immutable, and pending embeddings currently prevent their publication. `resolveGraphPath` recognizes shared-store commit paths; local storage defaults to `lbug` (`gitnexus/src/core/shared-store-analyze.ts:377–407`; `gitnexus/src/storage/shared-store.ts:264–282`).
- [verified] `--memory-budget` is explicitly a main-thread V8 heap limit, with independent worker heaps. Native pools and embedding threads have separate sizing (`gitnexus/src/cli/index.ts:175–179`; `gitnexus/src/cli/analyze.ts:623–660`; `gitnexus/src/core/ingestion/workers/worker-pool.ts:691–702, 1035–1085`; `gitnexus/src/core/lbug/lbug-config.ts:479–513`; `gitnexus/src/core/embeddings/config.ts:74–109`).
- [verified] The three production embedding callers are analyze, `embeddingsSyncCommand`, and the `/api/embed` handler. Their checkpoint orchestration is duplicated (`run-analyze.ts:4977`; `gitnexus/src/cli/embeddings-sync.ts:197–245`; `gitnexus/src/server/api.ts:2278–2337`).

## 4. GitNexus Findings

All calls used `repo: "/workspace"`. The overview records HEAD f641342… and a 1.6.12 npm-distribution analyzer running Node 24.19.0. The local runner resolves to `npx gitnexus@latest`; there is no global executable. This session's Node is 22.23.3. Same package version is not proof of matching analyzer bytes. Refresh was skipped because provenance is unverified and the local graph is held by another process; no process was stopped.

| Tool and target | Result | Consequence |
| --- | --- | --- |
| `query(search_query: "embedding pipeline checkpoint staged graph publication runAnalyze")` | Definitions led to embedding and freshness modules; no relevant process chains | Use targeted source reads for execution order. |
| `context(runEmbeddingPipeline, file_path: .../embedding-pipeline.ts)` | Found lines 581–1106; one incoming integration-test file | Production dynamic-import callers are missing from the graph result. |
| `impact(runEmbeddingPipeline, file_path: ..., upstream, maxDepth: 3)` | **UNKNOWN**, “No callers resolved” | Text references establish analyze, sync, and server callers; zero is not an all-clear. |
| `impact(runFullAnalysisInner, upstream, maxDepth: 3)` | **CRITICAL**, 8 impacted; d=1: `runFullAnalysis`, `runNative`, `runViaPool` | Returned UID names a benchmark `gc` function. Source confirms only `runFullAnalysis`; benchmark references are calls to `gc`, not this coordinator. Do not edit those benchmarks. |
| `impact(decideEmbeddingResume, file_path: .../embedding-checkpoint.ts, upstream, maxDepth: 3)` | **HIGH**, d=1: `runFullAnalysisInner`, `embeddingsSyncCommand`, `createServer` | All three production entrypoints need recovery parity tests. |
| `impact(semanticSearch, file_path: .../local-backend.ts, upstream, maxDepth: 3)` | **CRITICAL**, d=1: `_queryImpl`; 11 reported affected processes | Source confirms `_queryImpl` at line 3429. Several deeper process names are inconsistent with source; treat expansion as untrusted. |
| `impact(resolveBudgetHeap, file_path: .../cli/analyze.ts, upstream, maxDepth: 3)` | LOW; d=1: `ensureHeap` | Preserve its heap-only contract and test CLI respawn/watch propagation. |

[graph] Deep-mode overview, clusters and processes resources were read; bounded summaries identify Storage, Lbug, Ingestion and Cli areas. They are not exhaustive dependency inventories. `context(runAnalyze, .../run-analyze.ts)` was empty because the real coordinator is `runFullAnalysisInner`; `context(publishSharedGraph, .../storage/shared-store.ts)` was empty because source locates it in `core/shared-store-analyze.ts`.

## 5. Statement-Level PDG Findings

`pdg_query(mode: "controls", target: "gitnexus/src/core/embeddings/embedding-pipeline.ts")` returned **“no PDG layer”**. No CDG/REACHING_DEF edges are claimed. A build-current, isolated index refresh with `--index-only --pdg` belongs to execution, before editing central symbols.

These are **source-derived ordering constraints**, not reconstructed PDG edges:

1. [verified] Validate identities before model requests or deleting rows (`embedding-pipeline.ts:606–615`). Streaming must retain whole-manifest identity validation before mutation, using disk-backed validation when necessary.
2. [verified] Persist the active-window intent before delete/insert; checkpoint durable rows before completed progress (`embedding-pipeline.ts:775–785`; `run-analyze.ts:4995–5041`).
3. [verified] A current content hash on one chunk does not prove the complete chunk set survived. A failed node is removed as a whole (`embedding-pipeline.ts:992–1014`).
4. [verified] The database must be durable and published before advancing metadata; a collapse verdict aborts staged publication (`run-analyze.ts:4763–4774, 5434–5521`). Moving publication earlier must carry these checks with it.
5. [verified] Expanding all chunks of a node batch before inference can exceed an input-byte budget even with a bounded node count (`embedding-pipeline.ts:844–865`). Both content loading and chunk expansion require backpressure.
6. [inferred] Rewriting megabyte-scale `RepoMeta` after every small unit, repeatedly scanning labels for pagination, or rebuilding HNSW per unit could erase the throughput benefit. `saveMeta` serializes the whole metadata document and its legacy mirror (`gitnexus/src/storage/repo-manager.ts:323–333`). Use a compact job journal for frequent updates.

## 6. Proposed Changes

The following are design decisions to implement and measure, not claims that the new behavior exists.

### A. Separate graph publication from vector work

In `runFullAnalysisInner` and `runFullAnalysis`, extract a graph-finalization boundary into a new `core/analysis-publication.ts` helper. It owns graph identity/integrity verification, FTS outcome, durable native close, graph/metadata publication, registry registration and parse-cache publication. Execute this boundary before loading the embedding model. Preserve legitimate FTS opt-outs/degraded states; never label unavailable keyword search as available.

Use a versioned, compact publication receipt to reconcile a crash between graph-file publication and metadata publication. Record intended generation, source-coverage digest, analyzer identity and schema identity before switching the graph. Recovery either finishes publication of a verified generation or retains the prior one; it must not trust a newer timestamp alone. New generation filenames allow Windows readers to retain old handles without requiring overwrite of an open file. Extend `resolveGraphPath` and storage validation to accept only an owned, validated generation path; legacy local `lbug` and existing shared-store paths remain readable. No cross-slot paths or symlink escapes.

Create a **separate vector database per generation**, using the existing LadybugDB vector schema and index format, behind a new `core/embeddings/vector-store.ts`. Its writer exclusively owns an unpublished file; graph readers open the already published graph. Once vector coverage is verified and the vector file is checkpointed/closed, atomically publish a small pointer that binds it to the graph generation. Readers never open the active vector writer's file. A graph-preserving embedding failure cannot roll back or mark that graph as an incomplete graph write.

This avoids a second full-graph copy for every embedding job and avoids changing the native engine's locking model. It adds a second database handle during embeddings and vector queries; account for its pool in the resource budget and measure its cost. Keep graph-only runs on their current fast path. Do not build graph tables/FTS inside the vector-only database. Do not pass its handle through the graph singleton or inadvertently allocate two default-sized native pools.

Update `publishSharedGraph` to publish verified graph facts independently of vector debt. Keep pending vector work checkout-owned; completed immutable vector artifacts may be reused only under a matching identity. Update store seeding, pointer validation and reclamation together; a pending job pins its graph and vector artifacts. A sibling checkout must never clean or mutate them.

### B. Persist a deterministic, bounded work manifest

Replace the all-content reader inside `runEmbeddingPipeline` with a new `core/embeddings/embedding-work-manifest.ts` source. For each graph generation, build one durable manifest in label/id order containing identifiers, source bounds, selection information and unit boundaries. Use a key-only ordered scan plus bounded primary-key fetches; evaluate its native query plan first. If ordering cannot stay within the native memory budget, use bounded sorted runs on disk. Never use growing OFFSET pagination or a full content query per page.

Preflight duplicate/invalid IDs across the entire manifest before any delete or provider call. Keep the File fallback only when all eligible symbol labels are empty; a failed label read remains an error. Persist the selection receipt so resume does not re-enumerate completed units. Store identifiers/fingerprints rather than a second copy of raw source in the manifest. Read content from the pinned graph generation, respecting its full/symbol/none retention policy; never substitute changing working-tree text during a job.

Bound units by input bytes, expected vector bytes and node count. Bound chunk text, update metadata, encoded HTTP bodies, returned vectors and prefetch together; prefetch at most one additional unit and retain one active durable write unit. Large nodes must use bounded content/chunk production preserving current text, overlap, Unicode and line semantics. A node too large for the supported AST working set must take an existing semantically valid bounded path, or fail explicitly before mutation; never silently truncate or claim completion. Inability to handle the synthetic oversized case remains a failed acceptance criterion, not a permitted corpus omission.

Move corpus-size identity/hash/pending maps out of the live work queue: use manifest records and indexed vector-store lookups in bounded batches. A small-corpus in-memory optimization is permitted only under the same byte limit and restart semantics. Hash each changed node once. Reuse the existing prepared/batched writes; do not replace them with one new query preparation per row.

### C. One durable job protocol for all embedding callers

Add `core/embeddings/embedding-job.ts` and a filesystem-only `storage/embedding-job.ts` journal. Adapt `runEmbeddingPipeline`, `decideEmbeddingResume`, analyze, embeddings sync and `/api/embed` to that protocol. Preserve existing public function signatures with optional adapter/options additions until all callers migrate; the completed feature must leave no unbounded production entrypoint.

Job identity includes graph generation and covered-content digest (dirty worktrees included), source revision, analyzer/parser identity, graph and vector schema fingerprints, provider/model/dimensions, text/chunking identity, and effective text-producing options. Do not include credentials or secret-derived identity data. Batch size, worker count and memory budget are scheduling choices: lowering them must not invalidate already completed vectors or alter persisted unit identity.

For each unit: (1) fsync active intent; (2) replace all chunk rows for affected nodes; (3) validate complete per-node chunk counts/indices and hashes; (4) drain/checkpoint native writes; (5) atomically persist/fsync the completed cursor and counts; (6) advance. One unit may be active at a time. A crash after durable rows but before cursor publication may replay that one unit idempotently. Previously acknowledged units must not call the provider again. Partial failures remain durable pending records, with no successful coverage claim.

Use a compact cursor plus append-only/segmented failed-unit records, not a growing pending-ID array rewritten with full repository metadata each window. Validate journal checksums/version and artifact ownership. On journal loss/corruption, preserve artifacts, derive only provable complete units, and log uncertainty; do not accept isolated matching hashes as completion.

An unchanged compatible graph takes an embedding-only resume path before parse/resolve/graph-write work. For a source/analyzer/schema change, validate the graph anew but reuse vectors whose complete chunk sets and embedding-input fingerprints still match. Provider/model/dimension or text changes invalidate the affected vector space/input set, not an otherwise valid graph. Explain invalidation before requests. Preserve explicit `--drop-embeddings` and existing `--force` meaning; a forced rebuild may discard scheduling receipts while still preserving provably reusable embeddings as existing recovery tests require.

Legacy monolithic indexes remain readable. Migrate their complete vector groups through the existing bounded spill path only when a vector write is needed; never re-embed merely to relocate storage. Keep the old readable artifact until publication succeeds. Legacy interrupted checkpoints retain their strict validation; do not infer a generation identity they never recorded. Avoid changing the graph schema fingerprint solely for vector storage: `EMBEDDING_SCHEMA` is already excluded (`gitnexus/src/core/lbug/schema.ts:719–729, 819–835`). Validate downgrade behavior explicitly: new metadata must never coexist with an obsolete canonical `lbug` that an older binary could mistake for the current graph. Retain rollback artifacts under generation-specific names and document the required rebuild for binaries that do not support the new format.

### D. Budget the full resource envelope without changing existing flag semantics

Add a pure `core/analysis-resource-budget.ts` resolver and a new `--resource-budget <mb>` total-budget option. Preserve `--memory-budget` as the main-heap override. Resolve once at the entrypoint and pass explicit immutable budgets through analyze and embedding adapters; avoid global configuration that leaks between server jobs. The automatic total ceiling uses effective process/container memory with headroom; record the selected allocations.

Account for main heap and native graph working set, worker V8/native allocations, graph and vector native pools, ONNX/sidecar runtime, byte queues, buffers and headroom. Count worker RSS correctly: worker threads share process RSS, while a model subprocess must be counted separately. Reuse `effectiveRamBytes`, CPU limits, existing pool safety floors and worker drain behavior. Release parser capacity before embedding; reuse the released budget instead of reserving all phases simultaneously. Reject impossible explicit combinations before destructive work; do not silently reinterpret an unbounded native-pool override as a compliant hard cap.

Retain existing concurrency when it fits. Use bounded parallel input preparation/inference only when CPU, provider policy and memory allow; serialize database mutations and cursor advancement. Backpressure must pause admission rather than kill a worker inside native code. A configured application budget cannot promise an OS-enforced RSS ceiling for arbitrary native allocations: expose reservations and measured peak, include cgroup stress validation, and fail clearly when minimum viable native/model allocations do not fit.

### E. Readiness and progress become separate, compatible fields

Extend `RepoMeta` with versioned graph/vector generation receipts and a compact job reference. Keep the existing aggregate `incompleteReasons` for compatibility, adding graph-specific completeness/freshness and embedding progress fields. A pending embedding job must not force a graph rebuild or hide the newly current graph. Keep existing vector capability status strings: pending/failed/unverified vector coverage reports `unavailable` with a reason; only a complete artifact reports `vector-index`, or `exact-scan` when complete coverage exists but HNSW is unavailable. Retry exhaustion remains visible as failed/incomplete vector work.

Gate the MCP vector lane **before** model initialization or vector-table queries. Resolve and pin a matching published vector generation; hydrate IDs from that same graph generation. Generation mismatch returns graph/keyword results with the reason. Preserve concurrent BM25/vector dispatch and exact-scan limits. Update the exported semantic-search path used outside MCP as well as `LocalBackend.semanticSearch`; do not leave a server-only route reading stale in-graph vectors.

Extend `EmbeddingProgress` and server job progress with graph phase, embedding phase, unit totals/completed/reused/pending/failed, active unit and known node/chunk counts. Define categories without double counting: completed (new) + reused + pending + failed = total; active is a subset of pending. Completion advances only after durable acknowledgement. Retried failures move categories explicitly. Count unknown totals as unknown until the manifest is ready; model download is a separate indicator. CLI prints graph completion and an independent embedding fraction. SSE remains open until job terminality, and the public serializer must explicitly copy only safe numeric/enumerated progress fields (`gitnexus/src/server/ops-snapshot.ts:227–234`).

## 7. Implementation Sequence

Each step ends with focused checks and a coherent commit. Steps 2–5 provide inert helpers/adapters until the integration switch in step 6; do not expose half-migrated production behavior.

1. **Re-anchor and establish the performance baseline.** Use an isolated checkout because this tree has unrelated edits. Build current source with `npm run build`; index that checkout with its explicit local `dist/cli/index.js analyze --index-only --pdg`. Re-run impacts and bounded PDG slices. Investigate graph UID mismatches if still present. Add a short corpus/measurement harness and real-native feasibility tests for separate graph readers, vector writer, generation publication, bounded manifest reads and Windows open handles. Compare the proposed reader/writer path to current behavior before committing to integration. Route back to this plan if the architecture cannot meet the performance requirement.
2. **Add resource contracts and manifest reader.** Tests cover compatibility of heap-only flags, total-budget accounting, stable units, failed reads, duplicate IDs, and maximum live bytes. Keep existing parse algorithms and language-provider hooks unchanged.
3. **Add vector generation storage and durable journal.** Implement exclusive vector ownership, compact job persistence, one-active-unit acknowledgement, complete chunk receipts and safe artifact cleanup. Test all interruption boundaries with real native storage and a deterministic fake provider.
4. **Adapt the embedding pipeline.** Stream content/chunks through bounded units, preserve rejection isolation and all-or-none node recovery, perform bounded cache lookups, and build HNSW once at completion. Verify embedding-input fingerprints and row parity against the baseline.
5. **Add graph/vector publication and reader compatibility.** Implement prepared/publication recovery, safe generation resolution, legacy lookup, query gating and per-artifact pools. Validate both warm and newly started readers while a vector writer is held open.
6. **Integrate all writers and surfaces.** Publish graph/metadata/registry/cache before embedding; add the embedding-only resume branch; use the same job runner for sync and server. Wire shared-store pinning/cleanup, status and phase progress. Enable the new path only when these consumers work together. Keep graph-only and unchanged no-op paths free of model/vector/spool initialization.
7. **Run the regression and performance matrix; document behavior.** Run focused and full checks below. Record raw paired samples and environment, compare total and phase times, peak memory, query latency and retry request counts. Update RUNBOOK and CLI/resource-budget documentation. Regenerate intentional goldens once at the end; do not replace baselines to conceal regressions.
8. **Graph change analysis and review.** Run `detect_changes(scope: "all")` before each commit; partial/truncated results are unresolved. After implementation refresh the graph and invoke `gitnexus-review` on the implementation branch, separately including local changes if any. Do not push or open a PR automatically.

## 8. Test Strategy

Existing tests to extend (located at the pinned source; representative pipeline, memory and native recovery cases source-read):

| Existing file | Required regression coverage |
| --- | --- |
| `gitnexus/test/unit/embedding-pipeline.test.ts` | Current-hash interrupted windows, window-before-write order, exact-key replacement, input rejection isolation, File fallback; assert bounded content AND expanded text/vector bytes. |
| `gitnexus/test/unit/embedding-checkpoint.test.ts` | Identity changes, legacy kinds, force/drop compatibility, failed retry exhaustion remaining observable. |
| `gitnexus/test/unit/analyze-memory-budget.test.ts` | Existing heap-only CLI contract remains; add total-budget conflicts and watch propagation in a new resource-budget test. |
| `gitnexus/test/integration/analyze-staged-embedding-recovery.test.ts` | Keep durable-group reuse, second-crash recovery, changed/deleted nodes, model mismatch, and explicit drop. Existing suite skips Windows; new publication tests must cover it. |
| `gitnexus/test/integration/embedding-identity-integrity.test.ts` | Identity validity, unique composite keys, complete chunk sets and cold reopen. |
| `gitnexus/test/unit/local-backend-lazy-vector.test.ts` | Pending/mismatched artifacts cause zero vector/model requests; complete artifact keeps lazy loading and ranking. |
| `gitnexus/test/unit/server-sse-payload.test.ts` | Safe additive progress fields; graph-ready is nonterminal; exactly one final event reflecting failures. |
| `gitnexus/test/integration/shared-store-embedding-reuse.test.ts` | A sibling's graph/vector publication and cleanup cannot lose durable work. |

New tests, with concrete scenarios:

- `test/unit/embedding-work-manifest.test.ts`: many small nodes, few huge nodes, Unicode, duplicate IDs on different pages, label-read failure, deleted nodes, low budget, budget change on retry → stable manifest identity, complete text coverage, bounded live bytes, no provider calls before identity preflight.
- `test/unit/analysis-resource-budget.test.ts`: cgroup smaller than host, explicit heap/worker/native overrides, graph/vector phases, tiny budgets → allocations fit or fail before mutation; worker concurrency is preserved when feasible.
- `test/integration/analyze-phase-publication.test.ts`: stop before graph publish → old graph; stop immediately after it → new graph/FTS available; stop between file and metadata publication → recovery reconciles the intended generation without exposing a half graph. Test cold process readers and continuously querying warm readers.
- `test/integration/embedding-job-restart.test.ts`: kill a child before active intent, after intent, during a multi-chunk write, after WAL durability but before completed cursor, after cursor, during HNSW build, and after vector-file publication before pointer publication → at most the active unit replayed, acknowledged units submit zero requests, complete final chunk sets with no duplicates. Repeated crashes, ENOSPC, checkpoint failure, journal corruption and cancellation preserve the published graph.
- `test/integration/embedding-resource-bounds.test.ts`: lazy synthetic 10k/100k/1m-node input descriptors and controlled content payloads → the queue high-water mark is capped independently of corpus size. Do not allocate the complete fixture in the test process. Use a smaller real-native case to verify the reader's allocations and a large-node case to expose expansion, not just node-count bounds.
- `test/integration/vector-generation-compatibility.test.ts`: legacy monolithic index, interrupted legacy checkpoint, local/shared/external/branch storage, Windows open reader, simultaneous sync/analyze, model/dimension change, no FTS/VECTOR extension → correct ownership, graph availability, honest vector mode and stable existing result shapes.

Execution commands, run under `gitnexus/` (scripts verified in package.json):

```sh
npm run build
npx tsc --noEmit
npm test -- test/unit/embedding-pipeline.test.ts test/unit/embedding-checkpoint.test.ts test/unit/analyze-memory-budget.test.ts test/unit/local-backend-lazy-vector.test.ts test/unit/server-sse-payload.test.ts
npm run test:integration -- test/integration/analyze-staged-embedding-recovery.test.ts test/integration/embedding-identity-integrity.test.ts test/integration/shared-store-embedding-reuse.test.ts
npm test
node --import tsx bench/embedding-inputs/measure.cjs --check
node --import tsx bench/embedding-identities/measure.cjs --check
```

The build is necessary for shared-package output and real CLI integration tests. Add the newly created tests to the focused commands. Introduce `bench/analyze-resume/measure.mjs` in step 1 with documented arguments; that command is **proposed**, not an existing runnable tool. Do not run it before creation. Planning ran no tests or benchmarks.

Performance protocol: compare the same corpus, source features, Node/native versions, hardware, model/provider, request limits and resource budget, using separate isolated stores. Alternate baseline/candidate order with warmup and at least seven measured pairs; increase samples if noisy. Include cold graph-only analyze, warm no-op, tiny incremental edit, all-cached vectors, fresh embeddings, local inference, a deterministic fast HTTP provider, interrupted resume, and warm/cold graph+keyword+vector queries during embedding. Measure total elapsed time, phase durations, nodes/chunks per second, p50/p95 query latency, CPU, process plus sidecar peak RSS, live queue bytes, native pool reservations, disk bytes and provider requests. Include index/manifest creation, migration and final HNSW time; do not hide costs outside the timer. Preserve ranking and input/output fingerprints.

**Performance acceptance:** no repeatable throughput loss or query-latency regression against the pinned baseline at comparable resources. Do not translate the user's requirement into an arbitrary allowed slowdown. Publish raw paired samples and uncertainty; inconclusive measurements are unresolved, not a pass. A stricter optional memory budget naturally changes available resources: compare both implementations under that same budget and separately check default behavior. Any repeatable degradation routes back to tuning/design before shipment.

## 9. Risk and Impact Analysis

- **CRITICAL coordinator / query path, HIGH resume policy:** no code edit is authorized by this planning artifact alone. The LFG proceed decision should explicitly acknowledge these disclosed changes, satisfying GUARDRAILS maintainer sign-off. Recheck impact on the actual implementation checkout.
- **Every reported d=1 dependent is accounted for:** `runFullAnalysis` gets graph-boundary integration; `runNative`/`runViaPool` are rejected graph false positives after source search; analyze/sync/server resume callers get parity tests; `_queryImpl` gets vector gating/ranking tests; `ensureHeap` gets old-flag/new-budget compatibility tests. Missing dynamic-import callers were added through source verification.
- **Publication and native safety:** data-before-metadata ordering, generation pinning, WAL driver shutdown, no native-thread termination, and Windows handles are mandatory. Keep current collapse and scope-incompleteness diagnostics. A generation identifier alone does not certify contents.
- **Storage/migration:** graph schema and vector schema have separate validity; don't force graph rebuilds for vector-only changes. No destructive legacy migration. Keep source artifacts until verified publication. Two native handles and on-disk manifests cost resources; measurements decide acceptability.
- **Partial vectors:** matching row hashes, exhausted retries, `ready`, or successful HNSW creation are not proof of full coverage. New pending/failed jobs cannot appear as complete vector capability.
- **Graph availability:** validate graph queries through both MCP and HTTP, including fresh processes, while the vector write handle remains open. Existing readers continuing to see only the old graph does not satisfy #3598.
- **Scope:** CLI/core/storage/server/tests plus necessary benchmark/documentation files only. No language-resolution changes, dependency upgrades, CI/release/security-configuration changes, or edits to existing dirty files. External storage ownership and public-progress redaction remain intact.

## 10. Files Expected to Change

Existing symbol names below were source-verified; all proposed new files/symbols are explicitly new.

| File(s) | Responsibility |
| --- | --- |
| `gitnexus/src/core/run-analyze.ts` | `runFullAnalysis`, `runFullAnalysisInner`: graph publication and embedding-only resume. |
| `gitnexus/src/core/embeddings/embedding-pipeline.ts`, `types.ts`, `config.ts` | `runEmbeddingPipeline`, internal readers, `EmbeddingProgress`, `resolveEmbeddingConfig`: bounded units, adapter dependencies, safe progress. |
| `gitnexus/src/core/embedding-checkpoint.ts` | `decideEmbeddingResume` and checkpoint factories: shared protocol and legacy compatibility. |
| `gitnexus/src/storage/repo-meta.ts`, `embedding-recovery.ts` | `RepoMeta`, recovery reference validation: versioned generation/job receipts. |
| `gitnexus/src/storage/shared-store.ts`, `storage-resolver.ts`; `gitnexus/src/core/shared-store-analyze.ts` | Generation resolution, owned-path validation, `publishSharedGraph`/seeding and pinned-artifact cleanup integration. |
| `gitnexus/src/core/lbug/pool-adapter.ts`, `lbug-adapter.ts`, `lbug-config.ts` | Distinct read/write adapter lifetimes, bounded native reads, explicit per-handle pool reservations; retain legacy callers. |
| `gitnexus/src/core/index-freshness.ts`; `gitnexus/src/cli/status.ts` | Graph freshness independent from embedding debt. |
| `gitnexus/src/cli/index.ts`, `analyze.ts`, `embeddings-sync.ts` | New total-resource flag, existing heap contract, common embedding runner and phase output. |
| `gitnexus/src/core/ingestion/workers/worker-pool.ts` | Pass budget allocation to pool sizing/drain; preserve native-safe lifecycle. |
| `gitnexus/src/mcp/local/local-backend.ts`; `gitnexus/src/server/api.ts` | Matching vector-generation reads, all writer entrypoints and HTTP progress. |
| `gitnexus/src/server/analyze-job.ts`, `ops-snapshot.ts` | Optional typed phase counters and explicit safe serialization. |
| **New:** `gitnexus/src/core/analysis-publication.ts`, `analysis-resource-budget.ts` | Publication protocol and pure budget resolution. |
| **New:** `gitnexus/src/core/embeddings/embedding-work-manifest.ts`, `embedding-job.ts`, `vector-store.ts`; `gitnexus/src/storage/embedding-job.ts` | Bounded work source, execution protocol, vector-only adapter, filesystem-only journal. |
| Existing/new tests in §8; **new** `gitnexus/bench/analyze-resume/measure.mjs` | Crash matrix, performance and bounded-retention evidence. |
| `RUNBOOK.md` and relevant CLI documentation | Resource option, graph/vector status, recovery and measured limits. |

This is a cross-module change, not a two-file fix. Additional caller wiring discovered by the fresh graph belongs in the execution drift report; architectural expansion returns to the plan gate.

## 11. Reusable Implementation Context

```json
{
  "implementation_context": {
    "task_summary": "Implement #3598: resource-bounded analyze, early graph publication, durable embedding-only resume, truthful readiness/progress, with no performance degradation.",
    "acceptance_criteria": [
      "New verified graph and keyword queries work during/after embedding failure.",
      "Retained content, expanded chunks, vectors and prefetch fit an explicit resource envelope independently of corpus size.",
      "On compatible retry, acknowledged units cause no provider requests; at most the active unit replays.",
      "All crash boundaries converge to complete unique per-node chunk sets.",
      "Invalidation is selective and explained; graph and vector identities are separate.",
      "CLI/MCP/HTTP report graph freshness, embedding progress and actual vector readiness independently.",
      "Synthetic scaling tests and paired default/constrained performance measurements show no repeatable regression."
    ],
    "evidence_provenance": {
      "schema_version": 2,
      "head_commit": "f641342d1fcbfdcb764c5e478db0f69e6cea899a",
      "generated_plan_path": "docs/plans/2026-11-03-gitnexus-plan-resource-bounded-resumable-analyze.md",
      "global_dirty_digest": {
        "algorithm": "sha256",
        "canonicalization": "gitnexus-evidence-provenance-v2 NUL-framed UTF-8 records",
        "value": "305f776a6b7dae0c761b813156861754467d5410fce87ece8bda66d0ea6d377c"
      },
      "cited_path_manifest": [
        {
          "path": "AGENTS.md",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:6525593affddf3aff06d2e7e9d855505a5f5135dd8cb6d5f67a552e1ac5cf912",
          "index_digest": "sha256:6525593affddf3aff06d2e7e9d855505a5f5135dd8cb6d5f67a552e1ac5cf912",
          "worktree_digest": "sha256:6525593affddf3aff06d2e7e9d855505a5f5135dd8cb6d5f67a552e1ac5cf912",
          "untracked_digest": "absent"
        },
        {
          "path": "CONTRIBUTING.md",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:c149877030512c90bc2e8a9557c40d03ec8df0cb62f9a6c28a8e8c4f52de3265",
          "index_digest": "sha256:c149877030512c90bc2e8a9557c40d03ec8df0cb62f9a6c28a8e8c4f52de3265",
          "worktree_digest": "sha256:c149877030512c90bc2e8a9557c40d03ec8df0cb62f9a6c28a8e8c4f52de3265",
          "untracked_digest": "absent"
        },
        {
          "path": "GUARDRAILS.md",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:e04523426887f8597b28c7796f3fc7deb188e74653e9b5b377b75cdb7ed3d472",
          "index_digest": "sha256:e04523426887f8597b28c7796f3fc7deb188e74653e9b5b377b75cdb7ed3d472",
          "worktree_digest": "sha256:e04523426887f8597b28c7796f3fc7deb188e74653e9b5b377b75cdb7ed3d472",
          "untracked_digest": "absent"
        },
        {
          "path": "RUNBOOK.md",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:212110530525091c631dc9a3957bc08e0da5cd2bac2d30a21abb00739af72d34",
          "index_digest": "sha256:212110530525091c631dc9a3957bc08e0da5cd2bac2d30a21abb00739af72d34",
          "worktree_digest": "sha256:212110530525091c631dc9a3957bc08e0da5cd2bac2d30a21abb00739af72d34",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/bench/analyze-resume/measure.mjs",
          "object_kind": {
            "head": "absent",
            "index": "absent",
            "worktree": "absent",
            "untracked": "absent"
          },
          "state": "absent",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "absent",
          "index_digest": "absent",
          "worktree_digest": "absent",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/bench/embedding-identities/measure.cjs",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:7f8a9dd6bff3ddec82fc35565b4992e71a936ccf68c3e3e374391cf950099e14",
          "index_digest": "sha256:7f8a9dd6bff3ddec82fc35565b4992e71a936ccf68c3e3e374391cf950099e14",
          "worktree_digest": "sha256:7f8a9dd6bff3ddec82fc35565b4992e71a936ccf68c3e3e374391cf950099e14",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/bench/embedding-inputs/measure.cjs",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:c07314078597b01ee35f232ddd940f0ac0ab7678b1fdd7768d579d3d4ff8f22b",
          "index_digest": "sha256:c07314078597b01ee35f232ddd940f0ac0ab7678b1fdd7768d579d3d4ff8f22b",
          "worktree_digest": "sha256:c07314078597b01ee35f232ddd940f0ac0ab7678b1fdd7768d579d3d4ff8f22b",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/package.json",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:397c5d4c8566655d42b89d138a6d9f705e33014b348868631f4746df7a06edcf",
          "index_digest": "sha256:397c5d4c8566655d42b89d138a6d9f705e33014b348868631f4746df7a06edcf",
          "worktree_digest": "sha256:397c5d4c8566655d42b89d138a6d9f705e33014b348868631f4746df7a06edcf",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/scripts/bench/fts-evict-reload-rss.mjs",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:0889bfe3b4d83a4751dda0e5db9400140bda04e4a6f0d5fe5291057d67b7085a",
          "index_digest": "sha256:0889bfe3b4d83a4751dda0e5db9400140bda04e4a6f0d5fe5291057d67b7085a",
          "worktree_digest": "sha256:0889bfe3b4d83a4751dda0e5db9400140bda04e4a6f0d5fe5291057d67b7085a",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/cli/analyze.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:f7ab0d38351c9c63c323016633be3093a1b0f2548e8474cb00b83de2d1420286",
          "index_digest": "sha256:f7ab0d38351c9c63c323016633be3093a1b0f2548e8474cb00b83de2d1420286",
          "worktree_digest": "sha256:f7ab0d38351c9c63c323016633be3093a1b0f2548e8474cb00b83de2d1420286",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/cli/embeddings-sync.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:3c62c4b91255422c481dfc27bf2e6fd216590ae922880d78a7812b45f46e02d6",
          "index_digest": "sha256:3c62c4b91255422c481dfc27bf2e6fd216590ae922880d78a7812b45f46e02d6",
          "worktree_digest": "sha256:3c62c4b91255422c481dfc27bf2e6fd216590ae922880d78a7812b45f46e02d6",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/cli/index.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:348cceda59baf473b6348b764435fd92bdea3bab045f94024991e2d22ab23acd",
          "index_digest": "sha256:348cceda59baf473b6348b764435fd92bdea3bab045f94024991e2d22ab23acd",
          "worktree_digest": "sha256:348cceda59baf473b6348b764435fd92bdea3bab045f94024991e2d22ab23acd",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/cli/status.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:6a08ce4ae25072d8e4b0edcc1f0b3bf1d0a6bdd5fb0d1170c342c3cf9f6be9a8",
          "index_digest": "sha256:6a08ce4ae25072d8e4b0edcc1f0b3bf1d0a6bdd5fb0d1170c342c3cf9f6be9a8",
          "worktree_digest": "sha256:6a08ce4ae25072d8e4b0edcc1f0b3bf1d0a6bdd5fb0d1170c342c3cf9f6be9a8",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/analysis-publication.ts",
          "object_kind": {
            "head": "absent",
            "index": "absent",
            "worktree": "absent",
            "untracked": "absent"
          },
          "state": "absent",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "absent",
          "index_digest": "absent",
          "worktree_digest": "absent",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/analysis-resource-budget.ts",
          "object_kind": {
            "head": "absent",
            "index": "absent",
            "worktree": "absent",
            "untracked": "absent"
          },
          "state": "absent",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "absent",
          "index_digest": "absent",
          "worktree_digest": "absent",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/embedding-checkpoint.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:402a2501b355ea457f074802246f2de99e9ddf028502f5e874e74f411444ab08",
          "index_digest": "sha256:402a2501b355ea457f074802246f2de99e9ddf028502f5e874e74f411444ab08",
          "worktree_digest": "sha256:402a2501b355ea457f074802246f2de99e9ddf028502f5e874e74f411444ab08",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/embeddings/config.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:7ba8ae915a989c161ca262dc3d3501dc0d33b3c6085159a829a08db572256de3",
          "index_digest": "sha256:7ba8ae915a989c161ca262dc3d3501dc0d33b3c6085159a829a08db572256de3",
          "worktree_digest": "sha256:7ba8ae915a989c161ca262dc3d3501dc0d33b3c6085159a829a08db572256de3",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/embeddings/embedding-identity.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:9c954921fd985fda7cc904f1c1daa64e231ac4cfae8c7148a00deea274841eab",
          "index_digest": "sha256:9c954921fd985fda7cc904f1c1daa64e231ac4cfae8c7148a00deea274841eab",
          "worktree_digest": "sha256:9c954921fd985fda7cc904f1c1daa64e231ac4cfae8c7148a00deea274841eab",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/embeddings/embedding-job.ts",
          "object_kind": {
            "head": "absent",
            "index": "absent",
            "worktree": "absent",
            "untracked": "absent"
          },
          "state": "absent",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "absent",
          "index_digest": "absent",
          "worktree_digest": "absent",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/embeddings/embedding-pipeline.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:a680386f29e36826df87f09ddcd34042841e24059e7737806f5b31c944b3706c",
          "index_digest": "sha256:a680386f29e36826df87f09ddcd34042841e24059e7737806f5b31c944b3706c",
          "worktree_digest": "sha256:a680386f29e36826df87f09ddcd34042841e24059e7737806f5b31c944b3706c",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/embeddings/embedding-work-manifest.ts",
          "object_kind": {
            "head": "absent",
            "index": "absent",
            "worktree": "absent",
            "untracked": "absent"
          },
          "state": "absent",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "absent",
          "index_digest": "absent",
          "worktree_digest": "absent",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/embeddings/staged-embedding-recovery.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:a5ba08c10aa675cda0163769b996487d7e0d731107da1ecdc892dda78e7a3210",
          "index_digest": "sha256:a5ba08c10aa675cda0163769b996487d7e0d731107da1ecdc892dda78e7a3210",
          "worktree_digest": "sha256:a5ba08c10aa675cda0163769b996487d7e0d731107da1ecdc892dda78e7a3210",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/embeddings/types.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:fd2269f5aa16cf736e1f0d0a3d458f1585a1aeaf226a9a5ec236ef4bc2064381",
          "index_digest": "sha256:fd2269f5aa16cf736e1f0d0a3d458f1585a1aeaf226a9a5ec236ef4bc2064381",
          "worktree_digest": "sha256:fd2269f5aa16cf736e1f0d0a3d458f1585a1aeaf226a9a5ec236ef4bc2064381",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/embeddings/vector-store.ts",
          "object_kind": {
            "head": "absent",
            "index": "absent",
            "worktree": "absent",
            "untracked": "absent"
          },
          "state": "absent",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "absent",
          "index_digest": "absent",
          "worktree_digest": "absent",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/index-freshness.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:600340cfd3edd52d709be4bd94e05150596364ec5962901135db8f8ba399faae",
          "index_digest": "sha256:600340cfd3edd52d709be4bd94e05150596364ec5962901135db8f8ba399faae",
          "worktree_digest": "sha256:600340cfd3edd52d709be4bd94e05150596364ec5962901135db8f8ba399faae",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/ingestion/utils/effective-ram.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:01590b626cba51e9d46fb5d0ea595957a7df81084603e8a59f131bf398460ad9",
          "index_digest": "sha256:01590b626cba51e9d46fb5d0ea595957a7df81084603e8a59f131bf398460ad9",
          "worktree_digest": "sha256:01590b626cba51e9d46fb5d0ea595957a7df81084603e8a59f131bf398460ad9",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/ingestion/workers/worker-pool.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:4d9d62bb2f66f9377e1bbae9cd0c4719e1b3508beba48913a6317152640ec145",
          "index_digest": "sha256:4d9d62bb2f66f9377e1bbae9cd0c4719e1b3508beba48913a6317152640ec145",
          "worktree_digest": "sha256:4d9d62bb2f66f9377e1bbae9cd0c4719e1b3508beba48913a6317152640ec145",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/lbug/lbug-adapter.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:8239a813a3b8b14b29e4b726be20b1466f28c0375d7dda4ba4460d8c518d53d9",
          "index_digest": "sha256:8239a813a3b8b14b29e4b726be20b1466f28c0375d7dda4ba4460d8c518d53d9",
          "worktree_digest": "sha256:8239a813a3b8b14b29e4b726be20b1466f28c0375d7dda4ba4460d8c518d53d9",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/lbug/lbug-config.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:de2fef03409fd536b2c3afc3153a0cf59c75d1f65db9d4bff9f819caefbe1090",
          "index_digest": "sha256:de2fef03409fd536b2c3afc3153a0cf59c75d1f65db9d4bff9f819caefbe1090",
          "worktree_digest": "sha256:de2fef03409fd536b2c3afc3153a0cf59c75d1f65db9d4bff9f819caefbe1090",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/lbug/pool-adapter.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:baccd1bac94981eac6fd801c52814d5aca64027725bea962606dbe60bd7aa435",
          "index_digest": "sha256:baccd1bac94981eac6fd801c52814d5aca64027725bea962606dbe60bd7aa435",
          "worktree_digest": "sha256:baccd1bac94981eac6fd801c52814d5aca64027725bea962606dbe60bd7aa435",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/lbug/schema.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:289aa7b015e5c9a40fe5a58b7cef06c9bdb2d9165373e3ecae0ffe0e9f46dfdf",
          "index_digest": "sha256:289aa7b015e5c9a40fe5a58b7cef06c9bdb2d9165373e3ecae0ffe0e9f46dfdf",
          "worktree_digest": "sha256:289aa7b015e5c9a40fe5a58b7cef06c9bdb2d9165373e3ecae0ffe0e9f46dfdf",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/run-analyze.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:b755a7ec51a8a487fd4a5dfd1c1e6b8743b95a871f1d2473338b4f8f6ea90dd5",
          "index_digest": "sha256:b755a7ec51a8a487fd4a5dfd1c1e6b8743b95a871f1d2473338b4f8f6ea90dd5",
          "worktree_digest": "sha256:b755a7ec51a8a487fd4a5dfd1c1e6b8743b95a871f1d2473338b4f8f6ea90dd5",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/shared-store-analyze.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:5aa5948076c18b603f1909b3d4c917aa692b9cf0f7ad1f0753b477f47a01d41e",
          "index_digest": "sha256:5aa5948076c18b603f1909b3d4c917aa692b9cf0f7ad1f0753b477f47a01d41e",
          "worktree_digest": "sha256:5aa5948076c18b603f1909b3d4c917aa692b9cf0f7ad1f0753b477f47a01d41e",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/mcp/local/local-backend.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:8aa5c739428a672d22e39a4fe0fd72be9abd35fc3833f19bf8b2c6e2a2b36dcb",
          "index_digest": "sha256:8aa5c739428a672d22e39a4fe0fd72be9abd35fc3833f19bf8b2c6e2a2b36dcb",
          "worktree_digest": "sha256:8aa5c739428a672d22e39a4fe0fd72be9abd35fc3833f19bf8b2c6e2a2b36dcb",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/server/analyze-job.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:53da3f880d5e7ad08e32b4560d96ac92efa1d9e4101a98d4d6bf6cb4bcff0576",
          "index_digest": "sha256:53da3f880d5e7ad08e32b4560d96ac92efa1d9e4101a98d4d6bf6cb4bcff0576",
          "worktree_digest": "sha256:53da3f880d5e7ad08e32b4560d96ac92efa1d9e4101a98d4d6bf6cb4bcff0576",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/server/api.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:0796c4615860ced37d08f1a61e3b4d75891b9ea871990d33a57a311a4e8eb47e",
          "index_digest": "sha256:0796c4615860ced37d08f1a61e3b4d75891b9ea871990d33a57a311a4e8eb47e",
          "worktree_digest": "sha256:0796c4615860ced37d08f1a61e3b4d75891b9ea871990d33a57a311a4e8eb47e",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/server/ops-snapshot.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:1ce520f885d470dba4dba4f6c3d4cf25af5c9ffd5259f77e9e942baa8b35980b",
          "index_digest": "sha256:1ce520f885d470dba4dba4f6c3d4cf25af5c9ffd5259f77e9e942baa8b35980b",
          "worktree_digest": "sha256:1ce520f885d470dba4dba4f6c3d4cf25af5c9ffd5259f77e9e942baa8b35980b",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/server/sse-progress.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:fe36f78d27050ae939cf0f0bd22e16a54c8fa754c7d9414e4b470da2a4585ad8",
          "index_digest": "sha256:fe36f78d27050ae939cf0f0bd22e16a54c8fa754c7d9414e4b470da2a4585ad8",
          "worktree_digest": "sha256:fe36f78d27050ae939cf0f0bd22e16a54c8fa754c7d9414e4b470da2a4585ad8",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/storage/embedding-job.ts",
          "object_kind": {
            "head": "absent",
            "index": "absent",
            "worktree": "absent",
            "untracked": "absent"
          },
          "state": "absent",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "absent",
          "index_digest": "absent",
          "worktree_digest": "absent",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/storage/embedding-recovery.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:b01ff4af596ad37f537b11ef9c54cc8858f79408cc061f15649b2336c1e84ce6",
          "index_digest": "sha256:b01ff4af596ad37f537b11ef9c54cc8858f79408cc061f15649b2336c1e84ce6",
          "worktree_digest": "sha256:b01ff4af596ad37f537b11ef9c54cc8858f79408cc061f15649b2336c1e84ce6",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/storage/repo-manager.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:ae9a7ea8f2e3d8e630494310176f07e815aab0042ddf2535875c6074c1d1da29",
          "index_digest": "sha256:ae9a7ea8f2e3d8e630494310176f07e815aab0042ddf2535875c6074c1d1da29",
          "worktree_digest": "sha256:ae9a7ea8f2e3d8e630494310176f07e815aab0042ddf2535875c6074c1d1da29",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/storage/repo-meta.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:1fd29de696da92b0379341d1825de7b946c20ed4e20b341f2368f19213b46e78",
          "index_digest": "sha256:1fd29de696da92b0379341d1825de7b946c20ed4e20b341f2368f19213b46e78",
          "worktree_digest": "sha256:1fd29de696da92b0379341d1825de7b946c20ed4e20b341f2368f19213b46e78",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/storage/shared-store.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:509a05c5573c463337c44af5a5c59207e1f88a6a6154ef30df87f0398ac7b3c1",
          "index_digest": "sha256:509a05c5573c463337c44af5a5c59207e1f88a6a6154ef30df87f0398ac7b3c1",
          "worktree_digest": "sha256:509a05c5573c463337c44af5a5c59207e1f88a6a6154ef30df87f0398ac7b3c1",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/storage/storage-resolver.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:7e2395f0cfa16b135f18ae44b4a2809b2ccd2d6006ca3f48567bf2fbe57f8757",
          "index_digest": "sha256:7e2395f0cfa16b135f18ae44b4a2809b2ccd2d6006ca3f48567bf2fbe57f8757",
          "worktree_digest": "sha256:7e2395f0cfa16b135f18ae44b4a2809b2ccd2d6006ca3f48567bf2fbe57f8757",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/integration/analyze-phase-publication.test.ts",
          "object_kind": {
            "head": "absent",
            "index": "absent",
            "worktree": "absent",
            "untracked": "absent"
          },
          "state": "absent",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "absent",
          "index_digest": "absent",
          "worktree_digest": "absent",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/integration/analyze-staged-embedding-recovery.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:68f572fc65126eab6ea033d28a22f9e1025746545181760e62cfce1adf12fd13",
          "index_digest": "sha256:68f572fc65126eab6ea033d28a22f9e1025746545181760e62cfce1adf12fd13",
          "worktree_digest": "sha256:68f572fc65126eab6ea033d28a22f9e1025746545181760e62cfce1adf12fd13",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/integration/embedding-identity-integrity.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:f706e6341466878b3e4708cd9e6de7924721ed34807dd3c2c6d23a315785a2a1",
          "index_digest": "sha256:f706e6341466878b3e4708cd9e6de7924721ed34807dd3c2c6d23a315785a2a1",
          "worktree_digest": "sha256:f706e6341466878b3e4708cd9e6de7924721ed34807dd3c2c6d23a315785a2a1",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/integration/embedding-job-restart.test.ts",
          "object_kind": {
            "head": "absent",
            "index": "absent",
            "worktree": "absent",
            "untracked": "absent"
          },
          "state": "absent",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "absent",
          "index_digest": "absent",
          "worktree_digest": "absent",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/integration/embedding-resource-bounds.test.ts",
          "object_kind": {
            "head": "absent",
            "index": "absent",
            "worktree": "absent",
            "untracked": "absent"
          },
          "state": "absent",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "absent",
          "index_digest": "absent",
          "worktree_digest": "absent",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/integration/shared-store-embedding-reuse.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:33f8d89e66a8600c92965c08dada1dd658621b8aa8edccfa034a6ef8a3e30d80",
          "index_digest": "sha256:33f8d89e66a8600c92965c08dada1dd658621b8aa8edccfa034a6ef8a3e30d80",
          "worktree_digest": "sha256:33f8d89e66a8600c92965c08dada1dd658621b8aa8edccfa034a6ef8a3e30d80",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/integration/vector-generation-compatibility.test.ts",
          "object_kind": {
            "head": "absent",
            "index": "absent",
            "worktree": "absent",
            "untracked": "absent"
          },
          "state": "absent",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "absent",
          "index_digest": "absent",
          "worktree_digest": "absent",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/unit/analysis-resource-budget.test.ts",
          "object_kind": {
            "head": "absent",
            "index": "absent",
            "worktree": "absent",
            "untracked": "absent"
          },
          "state": "absent",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "absent",
          "index_digest": "absent",
          "worktree_digest": "absent",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/unit/analyze-memory-budget.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:eef96d7af6d47b242c7a4d46848641a7a8975c7967b058177cce40f0673ec934",
          "index_digest": "sha256:eef96d7af6d47b242c7a4d46848641a7a8975c7967b058177cce40f0673ec934",
          "worktree_digest": "sha256:eef96d7af6d47b242c7a4d46848641a7a8975c7967b058177cce40f0673ec934",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/unit/embedding-checkpoint.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:850c9b5e3e3ce8eedb02a1a41d2665d1f671a969dd4424df8d0ad7c05e47ee0f",
          "index_digest": "sha256:850c9b5e3e3ce8eedb02a1a41d2665d1f671a969dd4424df8d0ad7c05e47ee0f",
          "worktree_digest": "sha256:850c9b5e3e3ce8eedb02a1a41d2665d1f671a969dd4424df8d0ad7c05e47ee0f",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/unit/embedding-pipeline.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:eb8cd73dffebecbcb68033ed1b7b884ec0fa077f8023ca83066a50d83a053955",
          "index_digest": "sha256:eb8cd73dffebecbcb68033ed1b7b884ec0fa077f8023ca83066a50d83a053955",
          "worktree_digest": "sha256:eb8cd73dffebecbcb68033ed1b7b884ec0fa077f8023ca83066a50d83a053955",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/unit/embedding-work-manifest.test.ts",
          "object_kind": {
            "head": "absent",
            "index": "absent",
            "worktree": "absent",
            "untracked": "absent"
          },
          "state": "absent",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "absent",
          "index_digest": "absent",
          "worktree_digest": "absent",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/unit/local-backend-lazy-vector.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:0a371ca3a3b81b00f67144cc768a4d3ed0be9a80e8a3812409fcbd61e9ee1689",
          "index_digest": "sha256:0a371ca3a3b81b00f67144cc768a4d3ed0be9a80e8a3812409fcbd61e9ee1689",
          "worktree_digest": "sha256:0a371ca3a3b81b00f67144cc768a4d3ed0be9a80e8a3812409fcbd61e9ee1689",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/unit/server-sse-payload.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:985f982509a800162beb58b3fc274a9cf432aaf8b1bc3a49611a95f8b24834fe",
          "index_digest": "sha256:985f982509a800162beb58b3fc274a9cf432aaf8b1bc3a49611a95f8b24834fe",
          "worktree_digest": "sha256:985f982509a800162beb58b3fc274a9cf432aaf8b1bc3a49611a95f8b24834fe",
          "untracked_digest": "absent"
        }
      ]
    },
    "primary_symbols": [
      {
        "symbol": "runFullAnalysisInner",
        "file": "gitnexus/src/core/run-analyze.ts",
        "lines": "1566–5794",
        "role": "Graph and embedding phase orchestration; CRITICAL graph impact, IDs unreliable",
        "source_verified": true
      },
      {
        "symbol": "runEmbeddingPipeline",
        "file": "gitnexus/src/core/embeddings/embedding-pipeline.ts",
        "lines": "581–1106",
        "role": "Bounded source, checkpoint windows, complete chunk persistence; UNKNOWN upstream",
        "source_verified": true
      },
      {
        "symbol": "decideEmbeddingResume",
        "file": "gitnexus/src/core/embedding-checkpoint.ts",
        "lines": "190–290",
        "role": "Resume identity/flags and common caller policy; HIGH impact",
        "source_verified": true
      },
      {
        "symbol": "LocalBackend.semanticSearch",
        "file": "gitnexus/src/mcp/local/local-backend.ts",
        "lines": "4348–4528",
        "role": "Generation-ready vector lane and graph hydration; CRITICAL impact",
        "source_verified": true
      },
      {
        "symbol": "resolveBudgetHeap",
        "file": "gitnexus/src/cli/analyze.ts",
        "lines": "623–660",
        "role": "Preserve heap-only flag contract; LOW impact",
        "source_verified": true
      }
    ],
    "related_symbols": [
      {
        "symbol": "runFullAnalysis",
        "relationship": "CALLS runFullAnalysisInner",
        "relevance": "exclusive index lock and shared-store publication"
      },
      {
        "symbol": "queryEmbeddableNodes",
        "relationship": "called by runEmbeddingPipeline",
        "relevance": "all-content materialization"
      },
      {
        "symbol": "contentHashForNode",
        "relationship": "called by pipeline",
        "relevance": "stable text identity; no semantic shortcuts"
      },
      {
        "symbol": "batchInsertEmbeddings",
        "relationship": "called by pipeline",
        "relevance": "validated exact-key replacement"
      },
      {
        "symbol": "buildVectorIndex",
        "relationship": "called by pipeline",
        "relevance": "adapter-specific HNSW operation; publish once complete"
      },
      {
        "symbol": "embeddingsSyncCommand",
        "relationship": "calls pipeline and resume policy",
        "relevance": "production parity"
      },
      {
        "symbol": "createServer",
        "relationship": "contains /api/embed caller",
        "relevance": "production parity and safe API progress"
      },
      {
        "symbol": "_queryImpl",
        "relationship": "calls LocalBackend.semanticSearch",
        "relevance": "concurrent keyword/vector lanes"
      },
      {
        "symbol": "getIndexIncompleteReasons",
        "relationship": "status consumer",
        "relevance": "aggregate legacy incomplete reasons"
      },
      {
        "symbol": "publishSharedGraph",
        "relationship": "called by runFullAnalysis",
        "relevance": "immutable store publication and pending vector ownership"
      },
      {
        "symbol": "resolveGraphPath",
        "relationship": "storage path resolution",
        "relevance": "safe generation/legacy compatibility"
      },
      {
        "symbol": "resolveEmbeddingRecovery",
        "relationship": "legacy checkpoint validation",
        "relevance": "owned staging file families"
      },
      {
        "symbol": "recoverStagedEmbeddings",
        "relationship": "legacy recovery",
        "relevance": "reuse complete groups with bounded vector spill"
      },
      {
        "symbol": "saveMeta",
        "relationship": "metadata publication",
        "relevance": "full metadata serialized; avoid per-unit rewrites"
      },
      {
        "symbol": "streamQuery",
        "relationship": "native read adapter",
        "relevance": "must not run with singleton WAL driver"
      },
      {
        "symbol": "ensureHeap",
        "relationship": "calls resolveBudgetHeap",
        "relevance": "CLI respawn compatibility"
      },
      {
        "symbol": "createWorkerPool",
        "relationship": "resource consumer",
        "relevance": "worker caps and native-safe lifecycle"
      },
      {
        "symbol": "estimateBufferPool",
        "relationship": "native resource sizing",
        "relevance": "preserve page-size/COPY floors"
      },
      {
        "symbol": "publicOpsProgress",
        "relationship": "SSE serializer",
        "relevance": "explicit safe optional fields"
      },
      {
        "symbol": "resolveEmbeddingIdentity",
        "relationship": "resume identity",
        "relevance": "secret-free provider/model/dimensions"
      }
    ],
    "execution_path": [
      "Current: lock -> graph parse/resolve/write/FTS/verify -> embedding windows -> final close/swap/meta/registry/cache -> shared publication.",
      "Proposed: lock -> verify compatible published graph/job for fast resume; otherwise build/verify/publish graph and metadata -> immutable graph reader + exclusive unpublished vector writer -> intent/write/checkpoint/ack units -> verify complete coverage/HNSW -> publish matching vector pointer."
    ],
    "pdg_constraints": [],
    "pdg_availability": "No PDG layer. Source-derived constraints in section 5; no reconstructed PDG edges.",
    "architectural_patterns": [
      {
        "pattern": "One canonical writer lock",
        "example_location": "gitnexus/src/core/run-analyze.ts:1451",
        "usage_guidance": "Recheck storage/source identity under lock; never let sync/analyze/server race publication."
      },
      {
        "pattern": "Immutable published graph, separately owned unpublished vectors",
        "example_location": "gitnexus/src/core/shared-store-analyze.ts:377",
        "usage_guidance": "Extend existing immutable shared-store behavior to phase publication; budget separate native handles."
      },
      {
        "pattern": "Exact-key replacement and complete node groups",
        "example_location": "gitnexus/src/core/embeddings/embedding-pipeline.ts:283",
        "usage_guidance": "Retain idempotent replacement and chunk completeness checks."
      },
      {
        "pattern": "Lazy vector lane",
        "example_location": "gitnexus/src/mcp/local/local-backend.ts:4359",
        "usage_guidance": "Gate completeness before model import; keep keyword/graph lane available."
      }
    ],
    "files_to_modify": [
      {
        "file": "gitnexus/src/core/run-analyze.ts",
        "symbols": [
          "runFullAnalysis",
          "runFullAnalysisInner"
        ],
        "intended_change": "Publish verified graph before embedding; compatible embedding-only resume"
      },
      {
        "file": "gitnexus/src/core/embeddings/embedding-pipeline.ts",
        "symbols": [
          "runEmbeddingPipeline",
          "queryEmbeddableNodes",
          "semanticSearch"
        ],
        "intended_change": "Bound source/chunk/vector work; adapter-backed vector reads and writes"
      },
      {
        "file": "gitnexus/src/core/embeddings/types.ts",
        "symbols": [
          "EmbeddingProgress"
        ],
        "intended_change": "Add optional durable phase counters"
      },
      {
        "file": "gitnexus/src/core/embeddings/config.ts",
        "symbols": [
          "resolveEmbeddingConfig"
        ],
        "intended_change": "Pass bounded scheduling options without changing text identity"
      },
      {
        "file": "gitnexus/src/core/embedding-checkpoint.ts",
        "symbols": [
          "decideEmbeddingResume",
          "mintInterruptedCheckpoint",
          "mintPartialCheckpoint"
        ],
        "intended_change": "Shared recovery and legacy migration"
      },
      {
        "file": "gitnexus/src/storage/repo-meta.ts",
        "symbols": [
          "RepoMeta",
          "EmbeddingRecoveryReference"
        ],
        "intended_change": "Versioned generation receipts and job reference"
      },
      {
        "file": "gitnexus/src/storage/embedding-recovery.ts",
        "symbols": [
          "resolveEmbeddingRecovery"
        ],
        "intended_change": "Validate legacy/new artifact ownership"
      },
      {
        "file": "gitnexus/src/storage/shared-store.ts",
        "symbols": [
          "resolveGraphPath"
        ],
        "intended_change": "Resolve owned immutable generation or legacy path"
      },
      {
        "file": "gitnexus/src/storage/storage-resolver.ts",
        "symbols": [
          "inspectCodeIndexDB"
        ],
        "intended_change": "Validate new generation resolution"
      },
      {
        "file": "gitnexus/src/core/shared-store-analyze.ts",
        "symbols": [
          "publishSharedGraph"
        ],
        "intended_change": "Separate shared graph validity from checkout vector debt; seed/pin/reclaim consistently"
      },
      {
        "file": "gitnexus/src/core/lbug/pool-adapter.ts",
        "symbols": [
          "initLbug"
        ],
        "intended_change": "Generation-pinned graph/vector readers with explicit native reservations"
      },
      {
        "file": "gitnexus/src/core/lbug/lbug-adapter.ts",
        "symbols": [
          "streamQuery"
        ],
        "intended_change": "Bounded read adapter; preserve checkpoint-driver exclusion"
      },
      {
        "file": "gitnexus/src/core/lbug/lbug-config.ts",
        "symbols": [
          "estimateBufferPool",
          "setBufferPoolSizeHint"
        ],
        "intended_change": "Budget all concurrent native pools"
      },
      {
        "file": "gitnexus/src/core/index-freshness.ts",
        "symbols": [
          "getIndexIncompleteReasons"
        ],
        "intended_change": "Separate graph completeness while preserving aggregate reasons"
      },
      {
        "file": "gitnexus/src/cli/status.ts",
        "symbols": [],
        "intended_change": "Expose graph freshness and vector/job readiness separately"
      },
      {
        "file": "gitnexus/src/cli/index.ts",
        "symbols": [],
        "intended_change": "Add total resource-budget flag; retain heap-only flag contract"
      },
      {
        "file": "gitnexus/src/cli/analyze.ts",
        "symbols": [
          "resolveBudgetHeap",
          "ensureHeap"
        ],
        "intended_change": "Budget propagation and phase-specific progress"
      },
      {
        "file": "gitnexus/src/cli/embeddings-sync.ts",
        "symbols": [
          "embeddingsSyncCommand"
        ],
        "intended_change": "Use shared durable embedding job"
      },
      {
        "file": "gitnexus/src/core/ingestion/workers/worker-pool.ts",
        "symbols": [
          "resolveWorkerHeapCapMb",
          "createWorkerPool"
        ],
        "intended_change": "Respect explicit phase allocation; preserve safe drain"
      },
      {
        "file": "gitnexus/src/mcp/local/local-backend.ts",
        "symbols": [
          "LocalBackend.semanticSearch"
        ],
        "intended_change": "Gate on complete matching vectors before model work; hydrate same-generation graph"
      },
      {
        "file": "gitnexus/src/server/api.ts",
        "symbols": [],
        "intended_change": "Use same embedding job and generation-aware vector search"
      },
      {
        "file": "gitnexus/src/server/analyze-job.ts",
        "symbols": [
          "AnalyzeJobProgress"
        ],
        "intended_change": "Optional counters without new terminal status values"
      },
      {
        "file": "gitnexus/src/server/ops-snapshot.ts",
        "symbols": [
          "publicOpsProgress"
        ],
        "intended_change": "Explicit safe numeric/enumerated progress serialization"
      },
      {
        "file": "gitnexus/src/core/analysis-publication.ts",
        "symbols": [],
        "intended_change": "NEW: graph publication and crash reconciliation"
      },
      {
        "file": "gitnexus/src/core/analysis-resource-budget.ts",
        "symbols": [],
        "intended_change": "NEW: pure resource allocation and admission policy"
      },
      {
        "file": "gitnexus/src/core/embeddings/embedding-work-manifest.ts",
        "symbols": [],
        "intended_change": "NEW: durable deterministic work manifest and bounded source"
      },
      {
        "file": "gitnexus/src/core/embeddings/embedding-job.ts",
        "symbols": [],
        "intended_change": "NEW: shared resumable execution protocol"
      },
      {
        "file": "gitnexus/src/core/embeddings/vector-store.ts",
        "symbols": [],
        "intended_change": "NEW: isolated vector-only native adapter"
      },
      {
        "file": "gitnexus/src/storage/embedding-job.ts",
        "symbols": [],
        "intended_change": "NEW: filesystem-only compact job journal"
      },
      {
        "file": "gitnexus/bench/analyze-resume/measure.mjs",
        "symbols": [],
        "intended_change": "NEW: paired throughput/memory/restart/query harness"
      },
      {
        "file": "RUNBOOK.md",
        "symbols": [],
        "intended_change": "Document phase recovery, new resource option and limits"
      }
    ],
    "tests": [
      {
        "file": "gitnexus/test/unit/embedding-pipeline.test.ts",
        "scenarios": [
          "Existing: interrupted-window hashes, before-write intent, fallback and rejection isolation, bounded expansion"
        ]
      },
      {
        "file": "gitnexus/test/unit/embedding-checkpoint.test.ts",
        "scenarios": [
          "Existing: identity/force/drop/legacy cases; visible failed retry exhaustion"
        ]
      },
      {
        "file": "gitnexus/test/unit/analyze-memory-budget.test.ts",
        "scenarios": [
          "Existing: heap-only CLI flag compatibility"
        ]
      },
      {
        "file": "gitnexus/test/integration/analyze-staged-embedding-recovery.test.ts",
        "scenarios": [
          "Existing: completed vector reuse, second crash, changed/deleted nodes, model mismatch and drop"
        ]
      },
      {
        "file": "gitnexus/test/integration/embedding-identity-integrity.test.ts",
        "scenarios": [
          "Existing: exact identities and complete unique chunk sets"
        ]
      },
      {
        "file": "gitnexus/test/unit/local-backend-lazy-vector.test.ts",
        "scenarios": [
          "Existing: pending/mismatch causes no model or vector requests"
        ]
      },
      {
        "file": "gitnexus/test/unit/server-sse-payload.test.ts",
        "scenarios": [
          "Existing: additive safe counters and exactly one honest terminal event"
        ]
      },
      {
        "file": "gitnexus/test/integration/shared-store-embedding-reuse.test.ts",
        "scenarios": [
          "Existing: safe sibling reuse/publication and pending-job pinning"
        ]
      },
      {
        "file": "gitnexus/test/unit/embedding-work-manifest.test.ts",
        "scenarios": [
          "NEW: lazy large corpus, duplicate IDs, failed labels, stable byte-bounded units"
        ]
      },
      {
        "file": "gitnexus/test/unit/analysis-resource-budget.test.ts",
        "scenarios": [
          "NEW: cgroups, overrides, native floors, phase allocations and watch propagation"
        ]
      },
      {
        "file": "gitnexus/test/integration/analyze-phase-publication.test.ts",
        "scenarios": [
          "NEW: before/after graph publication crashes and cold/warm reader availability"
        ]
      },
      {
        "file": "gitnexus/test/integration/embedding-job-restart.test.ts",
        "scenarios": [
          "NEW: interruption at intent/write/durable/cursor/HNSW/pointer boundaries; at most active unit replay"
        ]
      },
      {
        "file": "gitnexus/test/integration/embedding-resource-bounds.test.ts",
        "scenarios": [
          "NEW: lazy 10k/100k/1m descriptors and real-native bounded-retention check"
        ]
      },
      {
        "file": "gitnexus/test/integration/vector-generation-compatibility.test.ts",
        "scenarios": [
          "NEW: legacy/shared/external/branch storage; Windows; concurrent writers; missing extensions"
        ]
      }
    ],
    "verification_commands": [
      "cd gitnexus && npm run build",
      "cd gitnexus && npx tsc --noEmit",
      "cd gitnexus && npm test -- test/unit/embedding-pipeline.test.ts test/unit/embedding-checkpoint.test.ts test/unit/analyze-memory-budget.test.ts test/unit/local-backend-lazy-vector.test.ts test/unit/server-sse-payload.test.ts",
      "cd gitnexus && npm run test:integration -- test/integration/analyze-staged-embedding-recovery.test.ts test/integration/embedding-identity-integrity.test.ts test/integration/shared-store-embedding-reuse.test.ts",
      "cd gitnexus && npm test",
      "cd gitnexus && node --import tsx bench/embedding-inputs/measure.cjs --check",
      "cd gitnexus && node --import tsx bench/embedding-identities/measure.cjs --check"
    ],
    "risks": [
      "CRITICAL coordinator/query and HIGH resume impact require gate acknowledgement; graph expansion has UID inconsistencies.",
      "Native reader/writer lifetime and publication crash windows; Windows handles.",
      "Additional vector pool and manifest I/O may regress performance; measure before integration.",
      "Large-node chunking and native query materialization may exceed budgets.",
      "Legacy/shared-store compatibility; incomplete vectors must never appear complete."
    ],
    "assumptions": [
      "Prove separate vector database feasibility and throughput with real-native concurrent-reader tests at the same budget before integration.",
      "Inspect native query plan and scaling to prove bounded manifest reads avoid repeated label scans and unbounded native content retention.",
      "Verify large-node input equivalence and peak memory; route back if chunker redesign is required.",
      "Verify Windows and local-model execution environments; disclose unavailable validation."
    ],
    "open_questions": [
      "Determine budget/queue/concurrency defaults from measurements; no performance claim is established.",
      "Refresh graph with source-current analyzer in execution and confirm/fallback on symbol UID mismatches.",
      "Validate downgrade behavior for new generation pointers before enabling the format."
    ],
    "avoid": [
      "Do not repeat full repository discovery; use this context and targeted drift checks.",
      "Do not modify pre-existing CI/eval/benchmark changes or untracked tooling files.",
      "Do not edit code before the LFG gate and fresh impact analysis; do not commit before complete detect_changes and required tests.",
      "Do not interpret UNKNOWN or the inconsistent current graph as proof of low impact.",
      "Do not replace memory-budget heap semantics or bypass native COPY safety floors.",
      "Do not materialize corpus content/hash maps; do not use repeated OFFSET pagination.",
      "Do not claim streaming JavaScript alone bounds native query allocations.",
      "Do not terminate native-active workers or use the singleton streamQuery with its WAL driver active.",
      "Do not publish partial vectors as complete, silently truncate content, or omit failed work.",
      "Do not re-embed completed compatible units, copy the full graph for each embedding job, or rebuild HNSW per unit.",
      "Do not discard legacy vectors before successful migration/publication.",
      "Do not weaken performance acceptance, remove features, change baselines to mask regressions, or claim unmeasured results.",
      "Do not alter CI/release/security config, push, or publish a PR as part of this plan."
    ],
    "index_refresh": {
      "status": "skipped",
      "reason": "Current index HEAD but analyzer-source equivalence unverified; graph UID mismatch; no PDG; another process owns local graph. Planning must not rebuild dist.",
      "runner": "node .gitnexus/run.cjs -> npx gitnexus@latest",
      "recorded_cli_version": "1.6.12",
      "recorded_runtime": "v24.19.0",
      "planning_runtime": "v22.23.3"
    },
    "validation_status": "Planning source review only; no production changes, tests, benchmarks or commits performed."
  }
}
```

## 12. Assumptions and Open Questions

- [assumed] A vector-only LadybugDB plus a published read-only graph can meet current latency and throughput. Prove with real-native cold/warm concurrent-reader benchmarks in step 1; the additional pool must fit the same resource envelope.
- [assumed] A single key-only scan plus bounded content fetches can avoid repeated full scans and unbounded native materialization. Inspect the installed engine's query behavior and measure scaling. Do not assume `ORDER BY id LIMIT` uses an index or that JavaScript streaming bounds native allocations.
- [assumed] Very large single-node chunking can preserve embedding input semantics within the configured envelope. Test actual chunker behavior before claiming compliance; if it requires a broader chunker redesign, deepen this plan rather than silently truncating or widening the budget.
- [assumed] Linux and Windows runners, plus a representative local embedding runtime, are available during execution. If unavailable, record the platform/runtime gap and do not declare its acceptance tests passed.
- **Open implementation gate:** exact budget defaults, queue byte caps and overlap/concurrency settings must come from measurements; preserve existing useful concurrency whenever memory permits. No performance improvement or non-regression has been measured during planning.
- **Evidence limitation:** matching graph HEAD does not repair the npm analyzer identity mismatch or inconsistent graph UIDs. Source is authoritative. Build-current graph/PDG verification must precede implementation; if the mismatch persists, record source-derived impact plus unresolved graph coverage.
- **Compatibility decision:** introduce `--resource-budget` for the whole analysis process family while preserving `--memory-budget`. Public metadata additions remain optional; legacy status aggregation remains available. Downgrade binaries that do not understand new generation pointers must fail clearly or use the retained legacy graph, never manufacture current freshness.
- **Working tree:** `.github/scripts/evolution-runner.py`, `eval/tests/test_evolution_runner.py`, and `gitnexus/bench/analyze-phase-breakdown.md` were already dirty; untracked tooling files also existed. They are outside this task. The evidence snapshot records them without including their contents in this plan.
- **Deferred:** distributed embedding workers, new database engines, provider-specific acceleration, full graph-ingestion out-of-core redesign, partial-vector serving, automatic background scheduling, and unrelated graph-identity repairs. They are not required to implement this phase boundary; if resource validation proves one necessary, re-plan explicitly.

## 13. Definition of Done

- [ ] Graph/keyword publication is independently durable and visible to new readers before embedding completes; failures preserve that new graph.
- [ ] At fixed configuration, retained input/chunk/vector queues remain bounded as corpus size grows, including large nodes and failed work; total-resource reservations and observed memory are reported honestly.
- [ ] Compatible retries skip parse/graph rebuilding and completed embedding requests; only unfinished work plus at most the active interrupted unit is replayed.
- [ ] Every crash boundary passes with exact complete chunk sets, unique keys and no lost acknowledged work; invalidation reasons explain retained versus recomputed work.
- [ ] Graph freshness, embedding coverage and vector readiness are distinct across CLI, MCP, HTTP and SSE; pending/failed vectors cannot masquerade as complete.
- [ ] Legacy indexes/checkpoints, explicit force/drop, shared stores, external/branch storage and Windows readers retain safe behavior.
- [ ] Paired performance evidence shows no repeatable regression at comparable resources, with fingerprints proving equivalent work. Unmeasured platforms and inconclusive results remain disclosed limitations.
- [ ] Required tests/typecheck pass, graph impact/change analysis is complete, and the LFG review verdict and remaining findings are reported. No unrelated edits, push or PR publication.
