# GitNexus Engineering Plan — resource-bounded, resumable analyze

> Task: finish [GitNexus #3598](https://github.com/abhigyanpatwari/GitNexus/issues/3598), without performance degradation.
> Deepen cycle 1; full form; impact depth 3. This revision reconciles completed work and changes two integration decisions. It does not claim feature completion.
> Evidence: HEAD 8c6b680f3071025189804ffebac2fd3bc8bf1232 on `feat/resource-bounded-resumable-analyze`. Build-current local index matches HEAD, schema-4 analyzer receipt and working-tree content. Connected MCP graph resources have a native engine mismatch; local backend queries work. PDG has partial/source-offset limitations (§5).
> Evidence provenance schema 2; global dirty digest 0a9c85780067d9afcd0764f307b60891e3cee927ee11eaeb5ec7826d10fd82cd; 86 sorted cited paths; only this generated plan path excluded. No production/test/config edits, builds or test executions in this Deepen pass.

## 1. Objective

Publish a verified graph and keyword index before optional embeddings finish. Bound queued content, expanded chunks and vector work by resources, preserve durable paid work across interruption, and report graph freshness separately from embedding readiness. Preserve existing text/chunk semantics, graph-only/no-op/incremental performance, throughput and query latency at comparable resources.

This revision replaces the original unconditional private-graph immutability/rollback promise with the repository's existing staged versus in-place guarantees. It also replaces in-process native teardown on exit-only CLI/server paths with an actual process-exit boundary. Neither change relaxes the issue's requirement that **after verified graph publication, embedding failure leaves that new graph available**.

## 2. Current Behaviour

- [verified] Thirteen commits are present, including the original plan. Twelve provide feasibility evidence and implementation pieces (§7). The common bounded controller still has **no production caller**. Analyze, embeddings sync and `/api/embed` still call `runEmbeddingPipeline` (`gitnexus/src/core/run-analyze.ts:4995`, `gitnexus/src/cli/embeddings-sync.ts:198`, `gitnexus/src/server/api.ts:2289`). The feature is not active end to end.
- [verified] `runFullAnalysis` locks the resolved slot, re-resolves it under the lock, calls its inner coordinator, then handles shared-store publication and releases the lock (`gitnexus/src/core/run-analyze.ts:1450–1575`). The new controller expects its caller to hold that lock.
- [verified] Private incremental writes normally mutate the existing graph. Atomic incremental copying is opt-in; shared commit graphs are immutable. The coordinator currently deletes `existingMeta.graphPath` after private-graph preparation, so it cannot simply accept a newly introduced private generation path without updated routing (`run-analyze.ts:2817–2840`).
- [verified] CLI and server workers set `skipNativeCloseOnExit: true`. The close choice is at `run-analyze.ts:5497–5500`. `closeLbugBeforeExit` checkpoints but leaves native handles alive and defers sidecar housekeeping (`gitnexus/src/core/lbug/lbug-adapter.ts:2521–2532`). Strict native release helpers do not make it safe to override this workaround.
- [verified] CLI skill generation consumes the live `pipelineResult` (`gitnexus/src/cli/analyze.ts:1697` onward). The worker IPC projection deliberately excludes it because serializing the KnowledgeGraph materializes corpus-sized arrays and loses behavior (`gitnexus/src/server/analyze-worker-ipc.ts:1–94`).
- [verified] `runPublishedEmbeddingJob` validates graph receipts and resource reservations, persists a graph-bound job, lazily opens the source/provider, and publishes only after native close. Its reuse source is currently only `metadata.vectorGeneration`; it does not reuse a different interrupted job even though its log promises retained compatible work (`gitnexus/src/core/embeddings/embedding-job.ts:116–330`).
- [verified] The staged publication helper requires an owned staging filename and writes a distinct generation file; it has no explicit in-place mode (`gitnexus/src/core/analysis-publication.ts:116–167,262–303`). The current vector selector checks generation matching but lacks an explicit `incrementalInProgress`/collapse gate (`gitnexus/src/storage/vector-generation.ts:33–81`).
- [verified] Optional resource plumbing, native/session drain, sidecar reservations, readiness consumers and progress types are implemented. The total-budget CLI flag, parser-side model drain, producer/IPC phase details and coherent production activation remain unfinished. Existing focused checks passed; the full candidate suite, whole-command benchmark matrix and final review have not run.

## 3. Relevant Architecture

[verified] The existing index lock and native-safe worker lifecycle are the coordination primitives. `runFullAnalysis` already rechecks storage/branch placement after waiting. The auto-sync worker launcher already waits for actual process exit before settlement. Server launch handling checks collapsed graphs before backend publication; that ordering must survive the phase split.

[inferred] Keeping every private graph physically immutable would add an O(database-size) copy to tiny incremental updates on filesystems without copy-on-write. Logical generation receipts plus the existing in-place dirty-recovery contract avoid that added cost. The active embedding job holds the index lock, so its graph stays stable for its lifetime without requiring immutable files forever.

[inferred] A thin supervisor is needed only where a graph worker must exit before the embedding phase. It must remain small, count against the total budget and reuse existing CLI/server process machinery. Graph-only and warm no-op invocations must not gain an unconditional extra fork or load model/vector modules.

[verified] Separate vector artifacts already have bounded native pools and complete per-node receipts. Published artifacts are immutable to writers. A graph-bound scheduling journal and reusable paid vector data have different lifetimes; coupling both to the job identity prevents efficient rebasing after source changes.

## 4. GitNexus Findings

Freshness was established with exact equality between the MCP context's schema-4 runner receipt and local `status --json` index receipt, matching HEAD, `up-to-date`, empty incomplete reasons and current content. Local queries use the already built analyzer and isolated navigation store. No refresh/build was necessary in this Deepen pass. Connected `clusters` and `processes` resource reads failed because that server reads storage version 42 while the local index uses 47; local impact summaries supply bounded process context instead.

| Current local call: `impact(target, upstream, maxDepth:3)` | Result and direct dependents | Treatment |
| --- | --- | --- |
| `runFullAnalysisInner`, file-scoped | LOW; `runFullAnalysis` | Preserve outer lock, shared-store, registry and cache sequencing. The old plan's benchmark `gc` false positives are retired. |
| `runPublishedEmbeddingJob`, file-scoped | UNKNOWN: “No callers resolved” | Source search confirms no production call; controller tests exist. UNKNOWN is not a safety clearance. |
| `decideEmbeddingResume`, file-scoped | CRITICAL; `runFullAnalysisInner`, `embeddingsSyncCommand`, `/api/embed` handler | Migrate all three callers and test identical force/drop/resume decisions. |
| `semanticSearch`, local-backend file | HIGH; `LocalBackend._queryImpl` | Preserve hybrid dispatch, ranking and graph hydration; test readiness gates. |
| `ensureHeap`, CLI analyze file | LOW; `analyzeCommand`, `watchCommandWithRunnerIdentity` | Preserve explicit heap, environment and watch behavior; avoid nested supervisors. |
| `runWorkerAnalysis`, worker-core file | LOW; message handler in `server/analyze-worker.ts` | Add nonterminal phase messages while retaining one terminal slot and exit-only cleanup. |
| `createLaunchAnalysisWorker`, launcher file | LOW; `createServer` | Delay embedding admission until actual exit; keep collapse/branch/cancel behavior. |

[graph] Process summaries reach CLI/watch, API and query flows; they are sampled navigation, not exhaustive dependency proofs. [verified] Dynamic-import legacy embedding callers were checked with text search. Previously CRITICAL native-close/session edits remain high-risk seams; rerun their impacts before any further edit rather than carry old caller counts forward.

## 5. Statement-Level PDG Findings

[graph] A PDG layer exists. File-scoped `controls` probes returned truncated sets. Narrowing `impact(mode:"pdg", target:<exact UID>, line:5498)` to the executable graph-close statement returned `pdg-no-block-at-line`, UNKNOWN. The controller's line-211 slice returned 14 statements, was still truncated, and located `loadMetadata` at line 125 while current source has it at line 127. The initial line-5500 probe was a ternary continuation and was corrected before drawing this conclusion.

These results do **not** establish a complete or correctly aligned handoff slice. No fabricated dependence edges enter the context pack. This is a statement-layer limitation despite current source/build/index provenance; unrelated PDG repair is outside the task.

Source-verified constraints that govern implementation:

1. Checkpoint success is not physical native release. Exit-only graph workers must actually exit before another phase consumes their reserved memory or reopens the graph.
2. Recheck cancellation after waiting for native/session release and before metadata/provider work (`embedding-job.ts:120–127`).
3. In-place mutation invalidates the published graph receipt before the first write; successful verification and durability precede replacement freshness metadata.
4. Graph publication, registry/cache/shared-store finalization and a readable new graph precede embedding admission. Graph-ready is not command completion.
5. Acknowledged units require complete chunk groups and native durability. Model calls cannot be inferred reusable from one row hash.
6. Repeated metadata rewrites, whole-graph copies, job-history scans, repeated HNSW construction and unbounded IPC are performance hazards to exclude and measure.

## 6. Proposed Changes

The following are implementation decisions, not descriptions of already activated behavior.

### A. Logical graph generations with explicit publication modes

Extend `prepareAnalysisPublication`/`publishPreparedAnalysis`, `runFullAnalysisInner`, graph routing and reader gates with explicit **staged** and **in-place** modes.

- Staged full builds retain owned generation files and the existing prepared receipt/metadata recovery. Before publication, the previous graph remains available where the existing staged path provides that guarantee.
- Default private incremental writes retain the existing writable graph file and delta write plan. Before mutation, durably mark the attempt/dirty state and invalidate its old generation readiness. After graph/FTS verification, checkpoint and native release, publish a new logical generation bound to covered content, runner/parser/schema identity and that owned path. Do not copy or hash the entire graph file just to advance a generation.
- An interrupted in-place graph write retains the existing dirty/incomplete status and forced-rebuild recovery; it cannot promise the previous graph survived. Do not advertise graph readiness until verification and publication finish. This corrects the original plan's unconditional pre-publication rollback promise.
- A prepared receipt binds its attempt to the expected prior metadata/slot. Revalidate it under the index lock before completion; a later writer superseding the attempt makes it unusable. Do not trust timestamps alone. Pin prepared artifacts against cleanup until completed or safely superseded.
- Shared commit graphs remain physically immutable. After a private slot adopts the new format, retain its mutable graph under an owned noncanonical filename and reuse that same file across logical generations. Retire the canonical legacy name only after native release, using the existing verified publication/retirement mechanism without a full file copy. The physical filename need not encode every new logical generation ID. Legacy no-job slots stay on their current path. Private paths must not be mistaken for shared pointers or stripped unconditionally. Add dirty/collapse gating before any generation-aware vector query.

The stable-graph guarantee for embedding is the published receipt **plus the held index lock**. After publication, all embedding failures preserve the new graph/FTS and graph freshness. Preserve existing FTS opt-out/degraded reporting, collapse checks, content retention and cache publication rules.

### B. Native process exit as the CLI/server handoff

Add a small proposed `core/analysis-phase-supervisor.ts` and adapt the existing CLI respawn and server/auto-sync worker launch paths. Do not introduce a general scheduler or a borrowed-lock/token protocol.

1. Use a filesystem-only preflight to keep verified no-op/graph-only cases on their current fast path. A compatible pending job takes embedding-only resume without parsing or rewriting the graph. Recheck all decisions after acquiring the existing slot lock.
2. For actual graph work followed by embeddings on exit-only paths, run the graph phase in its own worker process. Preserve `skipNativeCloseOnExit`; checkpoint and prepare the durable publication receipt. Resolve the final repository name under the existing registry collision rules before CLI operations that need it. Complete live-KnowledgeGraph work in that child, including skill generation, with existing `--index-only` and self-commit protections. Any early registry name registration must still point to an old verified graph or an explicitly incomplete/prepared slot; it cannot publish new graph readiness. Transfer only a bounded allowlisted phase/result receipt, never `pipelineResult` or source maps.
3. Treat the graph-prepared message as nonterminal. Wait for actual child exit. Only then may the supervisor reconcile sidecars, reacquire the ordinary index lock, re-resolve the slot and validate the expected receipt/generation before finishing filesystem publication, registry freshness/shared-store/cache bookkeeping and finalization checks. Revalidate the child's registered name as well as slot ownership; a changed registration must not leave generated CLI context naming a different repository. If another writer superseded the attempt, stop with a clear retry reason before any paid request; do not publish stale metadata.
4. Once the graph is verified readable, refresh server graph readers and emit graph-ready while the command/SSE job stays active. Start the embedding continuation under its own admitted allocations. Keep the supervisor and model sidecar inside the same process-family memory budget. Reuse an existing heap-respawn parent where possible; do not stack supervisors.
5. Cooperative cancellation retains artifacts and waits for native-safe exit. A child that sent prepared/complete but has not exited still owns its resources. Never terminate a native-active thread to enforce a budget. Exactly one final event reflects success, failure or cancellation. Defer the CLI success banner and opt-in self-commit until the final outcome, preserving the pre-run edit-safety snapshot through a bounded projection. Graph-ready must not commit context files or print overall success.

For genuinely in-process long-lived callers that already perform safe real close, retain `drainAnalysisNativeResources` and strict physical release accounting. Do not route exit-only callers through that helper as a substitute for process exit. `ensureHeap` sometimes returns without spawning, so ambient heap/opt-out paths need explicit coverage.

### C. Rebase pending paid artifacts without copying the graph

Separate the graph-bound **job identity** (manifest, selection, cursor, source/analyzer/schema) from the ownership identity of its **unpublished vector artifact**. Extend `runPublishedEmbeddingJob`, `VectorStore`, `EmbeddingJobJournal`, job metadata and vector publication together.

An unchanged compatible job resumes its persisted manifest/cursor. A source/graph change creates a fresh graph-bound manifest and journal while adopting the same exclusively owned pending vector artifact through a durable rebase receipt. Validate vector-space and text identities first. For each current node, reuse only a complete matching input/chunk receipt; changed groups are recomputed, deleted/unselected groups are removed before final coverage publication. Do not reinterpret an old journal's completed cursor against a new manifest.

Locate at most one active pending artifact per compatible vector/input space through a directly keyed owned receipt, so returning to a retained space needs no linear job-history scan. Retain at most one previous completed artifact as a read-only fallback while the pending writer accumulates reused/new groups. Repeated source edits reuse that same pending store, so work from the first interrupted attempt survives subsequent rebases without an ever-growing chain of prior jobs or native pools. Published stores are never reopened for writing; the first write after completed publication creates a new pending artifact and performs bounded lookups against the completed source.

Rebase intent/adoption must be recoverable before mutation. A crash between metadata, ownership receipt and journal changes preserves the old paid artifact, proves one active owner and either finishes or rejects the intended rebase. Incompatible model/dimensions/text identity starts separate owned work with a reason; cleanup must not discard retained paid evidence prematurely. Scheduling/resource changes do not change unit or vector identity. Build HNSW once after current selected coverage is complete, checkpoint and close, then publish the pointer.

### D. Preserve existing vectors without claiming fresh complete coverage

Plain `analyze` must still preserve vectors without requesting new/changed-node embeddings. Keep the legacy no-job fast path lazy and free of migration/model/spool initialization.

For a previously completed separate vector artifact after a graph update, keep an explicit **preserved historical coverage** reference. It may retain existing semantic-search behavior by hydrating returned IDs against the newly published graph and omitting deleted IDs. Report its source generation and `coverage: preserved` separately from native index availability; never call it complete for the current selection. Do not rewrite all vectors or invoke a provider merely to change this small reference. This is a compatibility exception for a previously completed artifact, not permission to expose an active/failed writer. While a new job is pending/failed, gate the vector lane before model initialization or vector-table access and continue graph/keyword queries.

Legacy monolithic indexes remain readable. A write-triggered migration uses bounded complete-group validation/spill and retains the source until publication succeeds. Preserve recorded checkpoint/model/input provenance; never fill missing historical fields with the current configuration and claim they were verified. Relocation alone does not justify re-embedding a provably compatible group. When an explicit new-generation request lacks the provenance required to establish compatibility, retain the artifact, explain the exact unknown identity before requests and treat those groups as unverified rather than silently reusable. Plain preserve-only analysis still performs zero provider requests in that case. Include the additional first-generation work in migration/request-count evidence.

Keep explicit force/drop semantics and existing legacy interrupted-checkpoint validation. Do not change graph schema identity solely for vector storage. An older binary must not mistake an obsolete canonical graph for current data; document rebuild/downgrade behavior and preserve rollback artifacts under owned names.

### E. Budget admission and production integration

Expose `--resource-budget <mb>` for the process family; keep `--memory-budget` as the existing main-heap override. Resolve once and pass immutable allocations through CLI, watch, server and sync. Include supervisor RSS, graph/embedding native pools, worker heaps/native allocations, sidecar/model memory, encoded HTTP responses, queues and headroom. Never count thread RSS as separate process RSS.

Wire `drainEmbeddingSidecarForAnalysis` before parser admission on actual graph work, not on a verified no-op. Preserve physical-release accounting after cancellation and failed closes. Automatic defaults are provisional until matched-resource measurements validate useful concurrency and total memory. Keep bounded manifests/chunk expansion, whole-manifest ID validation, File fallback rules and prepared/batched vector writes already implemented.

Activate all three writers together only after the process/publication/rebase/readiness contracts are covered. No production embedding path may retain the corpus-size all-content reader. Update shared-store seeding and cleanup so prepared publications, pending jobs and live readers pin the correct artifacts; siblings cannot mutate or collect them.

### F. Truthful phase progress across every boundary

Carry the existing optional detail fields through actual producers, worker IPC, server jobs, CLI, MCP context, HTTP projection and SSE. Define completed-new + reused + pending + failed = total, with active a subset of pending; unknown totals remain unknown until selection is ready. Advance completion only after durable acknowledgement. Report model download separately. Graph-ready is nonterminal; preserved coverage is not current embedding completion. Public projection copies only enumerated/numeric safe fields, never filesystem paths, ownership tokens or internal identity payloads. Preserve existing response shapes with additive fields and verify all consumers.

## 7. Implementation Sequence

**Already completed at this HEAD — do not repeat:**

| Commit | Completed result |
| --- | --- |
| `f0f3b9abe` | Original approved plan; superseded only by this Deepen revision. |
| `60ddccefa` | Native storage feasibility and baseline microbenchmarks; whole-command harness still missing. |
| `dbf62eab1` | Pure resource resolver and deterministic bounded manifest. |
| `ec9063f65` | Vector store and durable segmented journal. |
| `ba23148ba` | Bounded runner/text streaming and complete-group reuse. |
| `084c52895` | Staged publication and generation-aware readers; in-place mode still needed. |
| `f2fc492cf` | Published-job controller; no production callers yet. |
| `8bdd572fd` | Optional parser/native resource allocation plumbing. |
| `8dec4f273` | Physical sidecar reservations; parser admission not wired. |
| `700d6aca8` | Readiness/progress consumers; producer/IPC wiring incomplete. |
| `2363a1060` | Interrupted native bootstrap and journal recovery. |
| `f953c569e` | Verified explicit native pool release and retry accounting. |
| `8c6b680f3` | Main graph/session drain before in-process phase admission. |

Steps 1–5 of the original plan have helper implementations and microbenchmarks. Original step 6 is partial: its consumers/helpers exist, but the new writer path is not activated. Original steps 7–8 remain open. The original end-to-end `measure.mjs` was never created; move that missing work to the first remaining step.

**Remaining sequence, executable from this HEAD after the revised plan gate:**

1. Create the paired whole-command benchmark harness and record the unchanged pinned baseline/environment. Use the existing microbenchmarks only as diagnostics. Capture no-op/tiny-incremental and process-startup cost early so the supervisor/publication choices are measured before activation.
2. Extend publication to logical in-place generations and implement the bounded native-exit handoff as inert adapters. Cover crash/slot-race/cancellation and CLI live-graph postprocessing. Keep staged and shared immutability where it already applies.
3. Implement pending-artifact rebase and preserved/legacy coverage policy. Test repeated graph changes between crashes and known-identity zero-request migration. Keep published stores immutable and old artifacts until verified adoption/publication.
4. Complete resource admission, shared-store pinning, progress/IPC and reader coverage gates. Validate all public shapes and no-op laziness.
5. Switch analyze, sync and `/api/embed` coherently to the common bounded runner, including embedding-only resume. Remove all unbounded production callers. Run actual CLI/server phase and reader tests, not only injected controller tests.
6. Run the full regression and performance matrix; tune any repeatable regression before shipment. Update RUNBOOK/CLI and benchmark documentation. Regenerate intentional goldens once at the end; do not replace baselines to hide regressions.
7. Run final graph change analysis and `gitnexus-review` on the implementation branch, plus a separate local surface if needed. Report unresolved findings and platform gaps. No push or PR is authorized by this plan.

Each implementation commit requires impact before symbol edits, relevant focused checks and complete `detect_changes` before commit. Partial/truncated change analysis is unresolved. Preserve the existing isolated worktree and unrelated user edits.

## 8. Test Strategy

| Test file | Status and required scenarios |
| --- | --- |
| `gitnexus/test/unit/analysis-publication.test.ts` | **existing** — In-place mutation invalidates generation before writes; no full graph copy/hash on a tiny edit. Staged crash keeps old graph; in-place crash preserves existing dirty-recovery behavior; after publication embedding failures preserve new graph. |
| `gitnexus/test/integration/analyze-phase-publication.test.ts` | **new** — Graph child sends prepared then stays alive: zero provider/open-new-pool calls until exit. Cold/warm MCP and HTTP readers see new graph/FTS while separate vector writer is open. Crash before/after file and metadata publication; competing writer changes slot/generation during handoff: reject stale receipt without paid requests. Registry-name collision/change and --skills/self-commit: context names match final registration; prepared slot never appears graph-ready. |
| `gitnexus/test/unit/analyze-worker-core.test.ts` | **existing** — Graph-prepared is nonterminal; cancellation owns terminal slot; preserve skipNativeCloseOnExit. |
| `gitnexus/test/unit/analyze-worker-ipc.test.ts` | **existing** — Graph getters throw if traversed: bounded phase receipt still serializes; safe counters only. |
| `gitnexus/test/unit/analyze-launch-collapse.test.ts` | **existing** — Collapse rejected before backend publication; no embedding child or model admission. |
| `gitnexus/test/unit/analyze-launch-branch-settle.test.ts` | **existing** — External/shared/branch slot from result is revalidated after child exit. |
| `gitnexus/test/unit/auto-sync-analysis-worker.test.ts` | **existing** — Prepared IPC is not terminal; actual exit gates completion; cancelled native child is not force-killed. |
| `gitnexus/test/integration/embedding-job-controller.test.ts` | **existing** — Unchanged graph skips parsing and complete provider requests; graph changes rebase pending artifact. Two source changes between interruptions retain first-attempt paid groups and previous completed fallback. New model/text/dimensions reject incompatible reuse before requests; smaller resource budget does not invalidate units. |
| `gitnexus/test/integration/embedding-vector-store.test.ts` | **existing** — Current manifest validates complete groups; stale/deleted nodes pruned before publish; published store never mutated. Rebase crash at intent/adoption/checkpoint boundaries preserves owned paid artifact and rejects foreign identity. |
| `gitnexus/test/unit/embedding-job-journal.test.ts` | **existing** — One active unit; corrupted checksum/missing segment preserved and recovered only from complete native groups. |
| `gitnexus/test/integration/embedding-job-restart.test.ts` | **new** — Real child crashes at JS-visible intent/native-write/checkpoint/cursor/HNSW/pointer boundaries; at most active unit replay. ENOSPC, cancellation and repeated interruption keep published graph available and no duplicate/missing chunk rows. |
| `gitnexus/test/integration/embedding-resource-bounds.test.ts` | **new** — Lazy 10k/100k/1m descriptors and oversized Unicode nodes: fixed queue high-water mark, identical text/chunks, no corpus materialization. Smaller real-native case counts parent, graph/embedding child and sidecar peaks without double-counting thread RSS. |
| `gitnexus/test/unit/vector-generation.test.ts` | **existing** — Dirty/collapsed/mismatched graphs gate before native/model access; historical completed artifact is labeled preserved; pending job disables vector lane. |
| `gitnexus/test/unit/local-backend-vector-generation.test.ts` | **existing** — Preserved results hydrate current IDs and reject deleted nodes; active vector writer never opened; query ranking parity. |
| `gitnexus/test/unit/embedding-job-progress.test.ts` | **existing** — Completed+reused+pending+failed=total; active subset of pending; preserved is not current-complete; no false terminal event. |
| `gitnexus/test/unit/server-sse-payload.test.ts` | **existing** — Forward producer/IPC phase details through safe allowlist; graph-ready nonterminal; exactly one final success/failure/cancel event. |
| `gitnexus/test/unit/analyze-memory-budget.test.ts` | **existing** — Heap-only flag retains old meaning, including explicit ambient heap and respawn opt-out. |
| `gitnexus/test/unit/analysis-resource-budget.test.ts` | **existing** — Supervisor+children+native pools+sidecar+queues fit; defaults preserve useful concurrency when feasible. |
| `gitnexus/test/unit/lbug-analysis-resources.test.ts` | **existing** — Failed close remains charged; session drain blocks model/parser; cancellation during drain makes no metadata/provider calls. |
| `gitnexus/test/integration/embedding-native-release.test.ts` | **existing** — Explicit native pools are not reused before verified physical close; failed close retries, result-close failures clear active admission. |
| `gitnexus/test/unit/embedding-sidecar-client.test.ts` | **existing** — Parser phase waits for prior model-child exit; cancellation does not release a physically active request early. |
| `gitnexus/test/integration/analyze-staged-embedding-recovery.test.ts` | **existing** — Keep legacy complete-group reuse, second-crash, changed/deleted nodes, force/drop behavior and known-identity relocation without provider requests. |
| `gitnexus/test/integration/vector-generation-compatibility.test.ts` | **new** — Plain analyze preserves legacy and previously completed vector coverage without automatic requests. Unknown legacy provenance remains unknown; explicit generation logs any unsafe-reuse invalidation; relocation alone never invalidates verified groups. Windows open handles, no VECTOR/FTS, shared sibling and external/branch storage, concurrent writers. |
| `gitnexus/test/integration/shared-store-embedding-reuse.test.ts` | **existing** — Prepared publication/pending vector work pins its artifacts; sibling cannot clean or mutate them. |

The existing tests listed above were located; entries marked **new** are proposed and must be created before naming them in a runnable command. Extend focused commands with those tests once implemented. Existing scripts were verified in `gitnexus/package.json`:

```sh
cd gitnexus && npm run build
cd gitnexus && npx tsc --noEmit
cd gitnexus && npm run typecheck:tests
cd gitnexus && npm test -- test/unit/analysis-publication.test.ts test/unit/vector-generation.test.ts test/unit/analyze-worker-core.test.ts test/unit/analyze-worker-ipc.test.ts test/unit/embedding-job-journal.test.ts test/unit/analysis-resource-budget.test.ts test/unit/lbug-analysis-resources.test.ts test/unit/server-sse-payload.test.ts
cd gitnexus && npm run test:integration -- test/integration/embedding-job-controller.test.ts test/integration/embedding-vector-store.test.ts test/integration/embedding-native-release.test.ts test/integration/analyze-staged-embedding-recovery.test.ts test/integration/shared-store-embedding-reuse.test.ts
cd gitnexus && npm test
cd gitnexus && node --import tsx bench/embedding-inputs/measure.cjs --check
cd gitnexus && node --import tsx bench/embedding-identities/measure.cjs --check
```

Also run ESLint and Prettier checks on changed files and any required package checks. Do not run the candidate performance matrix alongside indexing or the full test suite. Baseline full-suite evidence exists (30,685 passing, 91 skipped, four setup environment failures; the isolated setup rerun passed); it is not a candidate pass. The latest implementation commit has 80 focused passing tests across six suites plus build/type/lint checks. No tests were rerun during this planning-only pass.

**Performance protocol:** use baseline `f641342d1fcbfdcb764c5e478db0f69e6cea899a` and candidate in isolated stores, same corpus/features, Node/native versions, provider/model/request limits and comparable resources. Alternate order, warm up, and collect at least seven paired samples; extend if noisy. Include cold graph-only, warm no-op, tiny incremental edit on non-CoW storage, preserved/all-cached vectors, fresh embeddings, local inference, fast deterministic HTTP, interrupted resume, legacy migration and concurrent warm/cold graph/keyword/vector queries. Include manifest creation, process handoff, native reopen, migration and final HNSW inside the timer.

Measure total/phase time, throughput, query p50/p95, CPU, process-family peak RSS, queue bytes, native reservations, disk I/O and provider request counts. Verify equal text/chunk/output fingerprints and result ranking. Test default allocations separately from a constrained explicit budget, comparing like resources in each case. A cold query unable to read the new graph during embedding is a correctness failure regardless of speed.

**No performance degradation is an acceptance gate, not an assumed result.** No arbitrary allowed slowdown. Existing native/vector/text microbenchmarks are promising diagnostics but do not establish whole-command non-regression. A seven-pair isolated HTTP response microbenchmark had a candidate/baseline geometric ratio around 1.019 and remains inconclusive; investigate it within the full provider path. Report raw samples and uncertainty, including migration/first-generation costs. Any repeatable regression requires tuning/design work before completion; inconclusive or unavailable measurements remain unresolved.

## 9. Risk and Impact Analysis

- **CRITICAL resume policy / HIGH query lane:** all current depth-1 dependents in §4 have explicit wiring and tests. Native close/session helpers were previously CRITICAL and require fresh impact before edits. The original proceed choice covered the original design; this structural revision returns to the LFG gate.
- **Native lifetime:** a terminal IPC message is not physical release. Keep the existing exit-only workaround and actual-exit accounting on every path, including cancellation and ambient-heap/no-respawn invocations.
- **Publication:** staged rollback and in-place dirty recovery are different guarantees. The post-publication embedding-failure guarantee applies to both. Never publish a stale handoff receipt after another writer changes the slot/generation.
- **Durable reuse:** job and artifact identity separation must not create two mutable owners or lose the oldest compatible paid groups after repeated rebases. Treat journal corruption/unknown ownership as uncertainty, not an empty job.
- **Compatibility:** preserved historical vectors may remain available under explicit coverage metadata, but active/failed new jobs cannot be advertised as complete. Unknown legacy provenance is never silently upgraded.
- **Performance:** full-DB copying, eager migration, extra no-op forks, unbounded IPC, repeated history scans, constrained default concurrency and extra HTTP processing can violate the user's request. Tests and paired measurements decide acceptance.
- **Scope:** only required CLI/core/storage/server/tests/bench/docs files. No language-provider changes, dependencies, CI/release/security configuration, production credentials, unrelated worktree changes or publishing actions.

## 10. Files Expected to Change

The following is the remaining implementation map. Existing helper code should be extended where needed, not re-created; only entries explicitly marked NEW are proposed files. Symbol names/ranges are grounded in the current investigation or unchanged verified source. Re-run impact and locate the precise edit range during work.

| File | Remaining responsibility |
| --- | --- |
| `gitnexus/src/core/run-analyze.ts` | Integrate logical graph generations, deferred exit-only finalization and embedding-only resume; preserve existing no-op/in-place paths. |
| `gitnexus/src/core/analysis-publication.ts` | Add explicit staged/in-place publication modes, attempt binding and exit-verified recovery without whole-graph copies. |
| `gitnexus/src/core/analysis-phase-supervisor.ts` | NEW proposed filesystem/IPC phase supervisor; use actual child exit, existing lock acquisition and bounded result projection. |
| `gitnexus/src/cli/analyze.ts` | Compose supervision with heap respawn; keep live pipeline-result work in graph child and avoid extra forks for no-op/graph-only runs. |
| `gitnexus/src/cli/index.ts` | Expose --resource-budget and pass immutable allocations without changing --memory-budget. |
| `gitnexus/src/cli/analyze-watch.ts` | Preserve heap flags and safe lifecycle across repeated analyses. |
| `gitnexus/src/server/analyze-worker-core.ts` | Emit graph-prepared handoff separately from terminal completion; retain exit-only native cleanup. |
| `gitnexus/src/server/analyze-worker-ipc.ts` | Allowlist bounded phase receipts/counters; never serialize pipelineResult. |
| `gitnexus/src/server/analyze-launch.ts` | Wait for graph-worker exit, finish publication, refresh graph backend, then continue embeddings; exactly one terminal event. |
| `gitnexus/src/core/auto-sync/analysis-worker-launch.ts` | Preserve exit-based settlement and cooperative cancellation; carry nonterminal graph readiness. |
| `gitnexus/src/core/embeddings/embedding-job.ts` | Separate job identity from unpublished artifact ownership, reuse pending paid groups across rebases, and admit only after native release. |
| `gitnexus/src/core/embeddings/embedding-job-identity.ts` | Keep graph-bound scheduling identity separate from reusable input/vector-space identities. |
| `gitnexus/src/core/embeddings/embedding-job-runner.ts` | Validate/reuse complete groups in the current manifest, preserve durability-before-acknowledgement and bounded queues. |
| `gitnexus/src/core/lbug/vector-store.ts` | Allow an exclusively owned unpublished artifact to outlive one graph-bound journal; retain complete group proofs and immutable published stores. |
| `gitnexus/src/storage/embedding-job-journal.ts` | Crash-safe rebase receipt and fresh manifest/cursor; no in-memory history chain or loss of acknowledged compatible groups. |
| `gitnexus/src/storage/embedding-job.ts` | Owned filesystem artifacts and durable adoption/rebase records. |
| `gitnexus/src/core/embeddings/vector-publication.ts` | Verify current manifest coverage and close durability before publishing the artifact pointer. |
| `gitnexus/src/storage/repo-meta.ts` | Version optional graph mode, job/artifact references, preserved coverage and recorded legacy provenance without inventing missing identities. |
| `gitnexus/src/storage/vector-generation.ts` | Reject dirty/collapsed graphs; distinguish verified-current, preserved historical, legacy and pending states. |
| `gitnexus/src/storage/index-capabilities.ts` | Expose availability separately from current-generation coverage; preserve existing result shapes with additive fields. |
| `gitnexus/src/storage/embedding-job-progress.ts` | Represent preserved coverage and durable pending progress truthfully. |
| `gitnexus/src/core/embedding-checkpoint.ts` | Retain legacy proof/force/drop policy; share one caller decision for new jobs. |
| `gitnexus/src/cli/embeddings-sync.ts` | Route to the common bounded controller after ownership and graph validation. |
| `gitnexus/src/server/api.ts` | Route /api/embed through the controller and carry safe readiness/progress fields. |
| `gitnexus/src/core/shared-store-analyze.ts` | Publish graph facts independently of checkout-owned vector debt; preserve shared immutable graph ownership. |
| `gitnexus/src/storage/shared-store.ts` | Resolve explicit graph mode and pin artifacts referenced by prepared publication, active job or readers. |
| `gitnexus/src/storage/repo-manager.ts` | Preserve owned generation references across metadata and registry updates. |
| `gitnexus/src/core/analysis-resource-budget.ts` | Include supervisor and child process peaks; tune automatic allocations using matched-resource measurements. |
| `gitnexus/src/core/lbug/lbug-adapter.ts` | Keep strict admission for genuinely in-process callers; never use it to override exit-only graph cleanup. |
| `gitnexus/src/core/embeddings/embedding-sidecar-client.ts` | Wire prior-model drain before parser admission, while keeping no-op analysis lazy. |
| `gitnexus/src/core/analysis-progress.ts` | Carry graph and embedding phase counters from actual durable producer events. |
| `gitnexus/src/core/embeddings/types.ts` | Maintain additive safe progress contracts. |
| `gitnexus/src/mcp/local/local-backend.ts` | Gate vector selection before model/native vector work; preserve BM25 parallelism and matching graph hydration. |
| `gitnexus/src/core/embeddings/vector-generation-search.ts` | Serve a completed preserved artifact with explicit coverage state; never serve the active writer. |
| `gitnexus/src/core/index-freshness.ts` | Keep vector debt separate; dirty in-place graph mutation remains unavailable/unverified. |
| `gitnexus/src/cli/status.ts` | Report graph freshness, embedding phase and preserved/current coverage independently. |
| `gitnexus/src/server/ops-snapshot.ts` | Allowlist public progress; omit paths, tokens and internal identities. |
| `gitnexus/src/server/analyze-job.ts` | Represent nonterminal graph readiness and one terminal outcome. |
| `gitnexus/src/server/repo-projection.ts` | Expose additive coverage/readiness fields. |
| `gitnexus/src/mcp/resources.ts` | Expose the same graph/vector state in repository context. |
| `gitnexus/bench/analyze-resume/measure.mjs` | NEW proposed end-to-end paired harness; existing microbenchmarks do not replace it. |
| `gitnexus/bench/analyze-resume/README.md` | Document raw samples, environment, pair ordering, equal-work checks and limits. |
| `RUNBOOK.md` | Document phase recovery, resource flag, preserved coverage, migration and downgrade behavior. |

Tests from §8 and existing benchmark artifacts are evidence; proposed harness/tests have absent-path provenance. Cleanup integrations may require adjacent owned-storage code already in the original scope, with impact and targeted verification first; unrelated refactors remain excluded.

## 11. Reusable Implementation Context

```json
{
  "implementation_context": {
    "task_summary": "Finish #3598 from completed helper commits: preserve incremental performance, publish verified graph before a bounded durable embedding job, and validate no performance degradation.",
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
      "head_commit": "8c6b680f3071025189804ffebac2fd3bc8bf1232",
      "generated_plan_path": "docs/plans/2026-11-03-gitnexus-plan-resource-bounded-resumable-analyze.md",
      "global_dirty_digest": {
        "algorithm": "sha256",
        "canonicalization": "gitnexus-evidence-provenance-v2 NUL-framed UTF-8 records",
        "value": "0a9c85780067d9afcd0764f307b60891e3cee927ee11eaeb5ec7826d10fd82cd"
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
          "path": "gitnexus/bench/analyze-resume/README.md",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:b37524c4c64d1d0688533f5de0e2f894ddbda877bbc198c8a5407114a7c5c1f9",
          "index_digest": "sha256:b37524c4c64d1d0688533f5de0e2f894ddbda877bbc198c8a5407114a7c5c1f9",
          "worktree_digest": "sha256:b37524c4c64d1d0688533f5de0e2f894ddbda877bbc198c8a5407114a7c5c1f9",
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
          "path": "gitnexus/bench/analyze-resume/native-baseline.json",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:b9960371de24ed894b3ccd98cb156a3ef4f1b0abe6b9ba57bd6cbe1ddd936fd7",
          "index_digest": "sha256:b9960371de24ed894b3ccd98cb156a3ef4f1b0abe6b9ba57bd6cbe1ddd936fd7",
          "worktree_digest": "sha256:b9960371de24ed894b3ccd98cb156a3ef4f1b0abe6b9ba57bd6cbe1ddd936fd7",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/bench/analyze-resume/native-primitives.mjs",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:3b0112c66e15f82c7cc8c4ac311952cbd8873b00ad0a517ece807f43a98b0ceb",
          "index_digest": "sha256:3b0112c66e15f82c7cc8c4ac311952cbd8873b00ad0a517ece807f43a98b0ceb",
          "worktree_digest": "sha256:3b0112c66e15f82c7cc8c4ac311952cbd8873b00ad0a517ece807f43a98b0ceb",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/bench/analyze-resume/text-streaming-baseline.json",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:f037a52275ad6f224a71a3f15bb6e93fd6ececedec5e5fcf62160dbcf7dea20b",
          "index_digest": "sha256:f037a52275ad6f224a71a3f15bb6e93fd6ececedec5e5fcf62160dbcf7dea20b",
          "worktree_digest": "sha256:f037a52275ad6f224a71a3f15bb6e93fd6ececedec5e5fcf62160dbcf7dea20b",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/bench/analyze-resume/text-streaming.mjs",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:2283b338d4a57e88d494d98a8bec5b1d7f0b119830ac80fbba2a309b4c46d5d8",
          "index_digest": "sha256:2283b338d4a57e88d494d98a8bec5b1d7f0b119830ac80fbba2a309b4c46d5d8",
          "worktree_digest": "sha256:2283b338d4a57e88d494d98a8bec5b1d7f0b119830ac80fbba2a309b4c46d5d8",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/bench/analyze-resume/vector-store-baseline.json",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:b967c251fc385dd596af8b6ca529cfc6f58056dd87fd1c03dcf3a33009add8e9",
          "index_digest": "sha256:b967c251fc385dd596af8b6ca529cfc6f58056dd87fd1c03dcf3a33009add8e9",
          "worktree_digest": "sha256:b967c251fc385dd596af8b6ca529cfc6f58056dd87fd1c03dcf3a33009add8e9",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/bench/analyze-resume/vector-store.mjs",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:0c8d292fda4ae28ef5060ff7ff55f82b8aa880f75eacf41dfa630ee72261125b",
          "index_digest": "sha256:0c8d292fda4ae28ef5060ff7ff55f82b8aa880f75eacf41dfa630ee72261125b",
          "worktree_digest": "sha256:0c8d292fda4ae28ef5060ff7ff55f82b8aa880f75eacf41dfa630ee72261125b",
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
          "path": "gitnexus/src/cli/analyze-watch.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:94410e3e832339af291fc232e1b4bd99e5992a5acdfd610cb0528b6dc072ce0d",
          "index_digest": "sha256:94410e3e832339af291fc232e1b4bd99e5992a5acdfd610cb0528b6dc072ce0d",
          "worktree_digest": "sha256:94410e3e832339af291fc232e1b4bd99e5992a5acdfd610cb0528b6dc072ce0d",
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
          "head_digest": "sha256:1d17584ee2d7759f5b06d8d7e76dcc36f2658fd435aafadff935d6e89973bac0",
          "index_digest": "sha256:1d17584ee2d7759f5b06d8d7e76dcc36f2658fd435aafadff935d6e89973bac0",
          "worktree_digest": "sha256:1d17584ee2d7759f5b06d8d7e76dcc36f2658fd435aafadff935d6e89973bac0",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/analysis-phase-supervisor.ts",
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
          "path": "gitnexus/src/core/analysis-progress.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:d4e82adbf50d1c89d4e91b8d78abf510b1a55088fcc5d745c51bccae126b39d5",
          "index_digest": "sha256:d4e82adbf50d1c89d4e91b8d78abf510b1a55088fcc5d745c51bccae126b39d5",
          "worktree_digest": "sha256:d4e82adbf50d1c89d4e91b8d78abf510b1a55088fcc5d745c51bccae126b39d5",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/analysis-publication.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:eb884b1e6513cb54662b84a750a975007f9afd202609ea3a5e742f7353a8a471",
          "index_digest": "sha256:eb884b1e6513cb54662b84a750a975007f9afd202609ea3a5e742f7353a8a471",
          "worktree_digest": "sha256:eb884b1e6513cb54662b84a750a975007f9afd202609ea3a5e742f7353a8a471",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/analysis-resource-budget.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:7dc00edf90721d155eb5e9c961a859f79222dce3013dcb70afcf1ffc62491f3c",
          "index_digest": "sha256:7dc00edf90721d155eb5e9c961a859f79222dce3013dcb70afcf1ffc62491f3c",
          "worktree_digest": "sha256:7dc00edf90721d155eb5e9c961a859f79222dce3013dcb70afcf1ffc62491f3c",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/auto-sync/analysis-worker-launch.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:101a6395ccbc6de1ddbe1fe805ea863388115421dd37b77f0295e425988a2f04",
          "index_digest": "sha256:101a6395ccbc6de1ddbe1fe805ea863388115421dd37b77f0295e425988a2f04",
          "worktree_digest": "sha256:101a6395ccbc6de1ddbe1fe805ea863388115421dd37b77f0295e425988a2f04",
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
          "path": "gitnexus/src/core/embeddings/embedding-job-identity.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:9549ef09c72478186e933f747c6d992f38e7cb0d79bc5438c69a93be1339b415",
          "index_digest": "sha256:9549ef09c72478186e933f747c6d992f38e7cb0d79bc5438c69a93be1339b415",
          "worktree_digest": "sha256:9549ef09c72478186e933f747c6d992f38e7cb0d79bc5438c69a93be1339b415",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/embeddings/embedding-job-runner.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:1929322282068ac7baca7b06f76ab08db17f688005387c0a6bce6d57c5e157f9",
          "index_digest": "sha256:1929322282068ac7baca7b06f76ab08db17f688005387c0a6bce6d57c5e157f9",
          "worktree_digest": "sha256:1929322282068ac7baca7b06f76ab08db17f688005387c0a6bce6d57c5e157f9",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/embeddings/embedding-job.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:abcf32e3b4d4d6af05610b14c0521fbb8b2e613c51391c3fdcf0dd4ff164d1ee",
          "index_digest": "sha256:abcf32e3b4d4d6af05610b14c0521fbb8b2e613c51391c3fdcf0dd4ff164d1ee",
          "worktree_digest": "sha256:abcf32e3b4d4d6af05610b14c0521fbb8b2e613c51391c3fdcf0dd4ff164d1ee",
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
          "head_digest": "sha256:0e6988332df01e3cb7f3302f91d1b43c9e3b42c1f04a2d229be496da6612403d",
          "index_digest": "sha256:0e6988332df01e3cb7f3302f91d1b43c9e3b42c1f04a2d229be496da6612403d",
          "worktree_digest": "sha256:0e6988332df01e3cb7f3302f91d1b43c9e3b42c1f04a2d229be496da6612403d",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/embeddings/embedding-sidecar-client.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:686d195abe5d50c1bd3ab04d5fb03744cad8424656c9a60c17d39e93a23590c7",
          "index_digest": "sha256:686d195abe5d50c1bd3ab04d5fb03744cad8424656c9a60c17d39e93a23590c7",
          "worktree_digest": "sha256:686d195abe5d50c1bd3ab04d5fb03744cad8424656c9a60c17d39e93a23590c7",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/embeddings/embedding-work-manifest.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:624eae51ded3820063890c65b75c56ce8ce705ea2d3364b9347b931e7bfcefc0",
          "index_digest": "sha256:624eae51ded3820063890c65b75c56ce8ce705ea2d3364b9347b931e7bfcefc0",
          "worktree_digest": "sha256:624eae51ded3820063890c65b75c56ce8ce705ea2d3364b9347b931e7bfcefc0",
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
          "head_digest": "sha256:4b41a883e9a5f62b0c6135696bae7880e1c247e8da8cc59f92fe8dfdff75ffb0",
          "index_digest": "sha256:4b41a883e9a5f62b0c6135696bae7880e1c247e8da8cc59f92fe8dfdff75ffb0",
          "worktree_digest": "sha256:4b41a883e9a5f62b0c6135696bae7880e1c247e8da8cc59f92fe8dfdff75ffb0",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/embeddings/vector-generation-search.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:c5efc5d48f40cff2579253a6368b3a6f9519d2fa9729b317c48898ee0a6dab5e",
          "index_digest": "sha256:c5efc5d48f40cff2579253a6368b3a6f9519d2fa9729b317c48898ee0a6dab5e",
          "worktree_digest": "sha256:c5efc5d48f40cff2579253a6368b3a6f9519d2fa9729b317c48898ee0a6dab5e",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/embeddings/vector-publication.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:74857e03e58d2e406604675db5370dac5f9e0d84c9c4e08b374963c2be78c968",
          "index_digest": "sha256:74857e03e58d2e406604675db5370dac5f9e0d84c9c4e08b374963c2be78c968",
          "worktree_digest": "sha256:74857e03e58d2e406604675db5370dac5f9e0d84c9c4e08b374963c2be78c968",
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
          "head_digest": "sha256:395bd98aa5a286b23424930b93bf1d78807316d4810ebe964e19ff4a691f3056",
          "index_digest": "sha256:395bd98aa5a286b23424930b93bf1d78807316d4810ebe964e19ff4a691f3056",
          "worktree_digest": "sha256:395bd98aa5a286b23424930b93bf1d78807316d4810ebe964e19ff4a691f3056",
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
          "head_digest": "sha256:941054f8291fb11f18c01f7e7b1644e15e994c1bd3ac7b03940e782815538d9c",
          "index_digest": "sha256:941054f8291fb11f18c01f7e7b1644e15e994c1bd3ac7b03940e782815538d9c",
          "worktree_digest": "sha256:941054f8291fb11f18c01f7e7b1644e15e994c1bd3ac7b03940e782815538d9c",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/lbug/embedding-source.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:e3aabd03c69aa74fa2a27b530d60654d71ea2e6734504b0ec4acbac0f6468737",
          "index_digest": "sha256:e3aabd03c69aa74fa2a27b530d60654d71ea2e6734504b0ec4acbac0f6468737",
          "worktree_digest": "sha256:e3aabd03c69aa74fa2a27b530d60654d71ea2e6734504b0ec4acbac0f6468737",
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
          "head_digest": "sha256:828a6667a7b2bb832e6a063cf2ac7e7846727433eab46e72a62121975a6c29e5",
          "index_digest": "sha256:828a6667a7b2bb832e6a063cf2ac7e7846727433eab46e72a62121975a6c29e5",
          "worktree_digest": "sha256:828a6667a7b2bb832e6a063cf2ac7e7846727433eab46e72a62121975a6c29e5",
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
          "head_digest": "sha256:83446f01048db52effb674415dfee16ae1a05acd8b0b1e6ce5d220be6fc802c6",
          "index_digest": "sha256:83446f01048db52effb674415dfee16ae1a05acd8b0b1e6ce5d220be6fc802c6",
          "worktree_digest": "sha256:83446f01048db52effb674415dfee16ae1a05acd8b0b1e6ce5d220be6fc802c6",
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
          "head_digest": "sha256:9166d33e94410bc05a28129a0159ef33872d67bf0b2f9ff0695c00bf8b1b6c3a",
          "index_digest": "sha256:9166d33e94410bc05a28129a0159ef33872d67bf0b2f9ff0695c00bf8b1b6c3a",
          "worktree_digest": "sha256:9166d33e94410bc05a28129a0159ef33872d67bf0b2f9ff0695c00bf8b1b6c3a",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/lbug/vector-store.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:eaf1ff71d135e4e384888277181dc3193f5664f94a7fde4daa13179293b68b4a",
          "index_digest": "sha256:eaf1ff71d135e4e384888277181dc3193f5664f94a7fde4daa13179293b68b4a",
          "worktree_digest": "sha256:eaf1ff71d135e4e384888277181dc3193f5664f94a7fde4daa13179293b68b4a",
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
          "head_digest": "sha256:756030431ea263c658a29566877a63a6df40dbe138410e03c9af4713316ba722",
          "index_digest": "sha256:756030431ea263c658a29566877a63a6df40dbe138410e03c9af4713316ba722",
          "worktree_digest": "sha256:756030431ea263c658a29566877a63a6df40dbe138410e03c9af4713316ba722",
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
          "head_digest": "sha256:c1bfc2c305948dd77619c666a9f68420efee9d834c18be12a65a6d9d7f4683fa",
          "index_digest": "sha256:c1bfc2c305948dd77619c666a9f68420efee9d834c18be12a65a6d9d7f4683fa",
          "worktree_digest": "sha256:c1bfc2c305948dd77619c666a9f68420efee9d834c18be12a65a6d9d7f4683fa",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/mcp/resources.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:0689f5ca7b29320a9c919407d06551f80600c90a1596f832f03e25d6a050f7f6",
          "index_digest": "sha256:0689f5ca7b29320a9c919407d06551f80600c90a1596f832f03e25d6a050f7f6",
          "worktree_digest": "sha256:0689f5ca7b29320a9c919407d06551f80600c90a1596f832f03e25d6a050f7f6",
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
          "head_digest": "sha256:013f35454d3f253fc1e1ddf1fd46f9b36f36a8579b17f4b6c9c22b3f342dd010",
          "index_digest": "sha256:013f35454d3f253fc1e1ddf1fd46f9b36f36a8579b17f4b6c9c22b3f342dd010",
          "worktree_digest": "sha256:013f35454d3f253fc1e1ddf1fd46f9b36f36a8579b17f4b6c9c22b3f342dd010",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/server/analyze-launch.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:886da3f19448f6ca01a504eee631aa7027c3c35ff27715e2ccfaa5bc35512b0f",
          "index_digest": "sha256:886da3f19448f6ca01a504eee631aa7027c3c35ff27715e2ccfaa5bc35512b0f",
          "worktree_digest": "sha256:886da3f19448f6ca01a504eee631aa7027c3c35ff27715e2ccfaa5bc35512b0f",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/server/analyze-worker-core.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:ff74b381cd1279f5a95dd6c964e375d03026bc102b102328af059e31ca7930f7",
          "index_digest": "sha256:ff74b381cd1279f5a95dd6c964e375d03026bc102b102328af059e31ca7930f7",
          "worktree_digest": "sha256:ff74b381cd1279f5a95dd6c964e375d03026bc102b102328af059e31ca7930f7",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/server/analyze-worker-ipc.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:80d6bba543ee757fa65ff036b42544aba6ac052d1f536eb407d16b1589470a10",
          "index_digest": "sha256:80d6bba543ee757fa65ff036b42544aba6ac052d1f536eb407d16b1589470a10",
          "worktree_digest": "sha256:80d6bba543ee757fa65ff036b42544aba6ac052d1f536eb407d16b1589470a10",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/server/analyze-worker.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:0cb4fa75441c31eb674102db7f15b95645a81c6cd7cdedac6ce0f6d5d74a389c",
          "index_digest": "sha256:0cb4fa75441c31eb674102db7f15b95645a81c6cd7cdedac6ce0f6d5d74a389c",
          "worktree_digest": "sha256:0cb4fa75441c31eb674102db7f15b95645a81c6cd7cdedac6ce0f6d5d74a389c",
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
          "head_digest": "sha256:724c463aaf317c9b8d7e7b420472d66ba4838dc91d8a978aa4791d01993c4412",
          "index_digest": "sha256:724c463aaf317c9b8d7e7b420472d66ba4838dc91d8a978aa4791d01993c4412",
          "worktree_digest": "sha256:724c463aaf317c9b8d7e7b420472d66ba4838dc91d8a978aa4791d01993c4412",
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
          "head_digest": "sha256:a89c2718afea565aa52fdb7ca577a9e9e81d57960bbe664f478f3a2c405c2365",
          "index_digest": "sha256:a89c2718afea565aa52fdb7ca577a9e9e81d57960bbe664f478f3a2c405c2365",
          "worktree_digest": "sha256:a89c2718afea565aa52fdb7ca577a9e9e81d57960bbe664f478f3a2c405c2365",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/server/repo-projection.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:779fa65dc8b6ff7cd77c449938f3d4a3058ea2497f1a03d70652c59b69a84589",
          "index_digest": "sha256:779fa65dc8b6ff7cd77c449938f3d4a3058ea2497f1a03d70652c59b69a84589",
          "worktree_digest": "sha256:779fa65dc8b6ff7cd77c449938f3d4a3058ea2497f1a03d70652c59b69a84589",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/storage/embedding-job-journal.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:45b2d6d1db96e53a06e22cb13ca3debfb67e200b0eff5e99c3bad69efe643be0",
          "index_digest": "sha256:45b2d6d1db96e53a06e22cb13ca3debfb67e200b0eff5e99c3bad69efe643be0",
          "worktree_digest": "sha256:45b2d6d1db96e53a06e22cb13ca3debfb67e200b0eff5e99c3bad69efe643be0",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/storage/embedding-job-progress.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:e5d19ae5b416c115164e0988bd8b30e43e476fecede524d17126168fb69f9039",
          "index_digest": "sha256:e5d19ae5b416c115164e0988bd8b30e43e476fecede524d17126168fb69f9039",
          "worktree_digest": "sha256:e5d19ae5b416c115164e0988bd8b30e43e476fecede524d17126168fb69f9039",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/storage/embedding-job.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:aa2a245ce1352e89bf1c5d0ac78ef15c9a33b4939269b9757a2574853599bd4a",
          "index_digest": "sha256:aa2a245ce1352e89bf1c5d0ac78ef15c9a33b4939269b9757a2574853599bd4a",
          "worktree_digest": "sha256:aa2a245ce1352e89bf1c5d0ac78ef15c9a33b4939269b9757a2574853599bd4a",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/storage/index-capabilities.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:1106d95598245248a7f093d9701c4ab37c73e175f074d8a6561b1d871970600d",
          "index_digest": "sha256:1106d95598245248a7f093d9701c4ab37c73e175f074d8a6561b1d871970600d",
          "worktree_digest": "sha256:1106d95598245248a7f093d9701c4ab37c73e175f074d8a6561b1d871970600d",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/storage/index-lock.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:2285d73a52f619e1c742865e7d280c9e94bc10e2d7749fa557c6f44491057c90",
          "index_digest": "sha256:2285d73a52f619e1c742865e7d280c9e94bc10e2d7749fa557c6f44491057c90",
          "worktree_digest": "sha256:2285d73a52f619e1c742865e7d280c9e94bc10e2d7749fa557c6f44491057c90",
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
          "head_digest": "sha256:412e87ab75c7db23c323e5d04aaafb03351ee7f2118dc307ccc19cab01e4e120",
          "index_digest": "sha256:412e87ab75c7db23c323e5d04aaafb03351ee7f2118dc307ccc19cab01e4e120",
          "worktree_digest": "sha256:412e87ab75c7db23c323e5d04aaafb03351ee7f2118dc307ccc19cab01e4e120",
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
          "head_digest": "sha256:48163d6460e6403a7837c25e7fff5209c7ca0d7f71e82f71499a87e0bc1c6c92",
          "index_digest": "sha256:48163d6460e6403a7837c25e7fff5209c7ca0d7f71e82f71499a87e0bc1c6c92",
          "worktree_digest": "sha256:48163d6460e6403a7837c25e7fff5209c7ca0d7f71e82f71499a87e0bc1c6c92",
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
          "head_digest": "sha256:be639f0f54680f27abcf1fc1efdfdadfbb2197d1ec4d493cdf03d6b58aebad17",
          "index_digest": "sha256:be639f0f54680f27abcf1fc1efdfdadfbb2197d1ec4d493cdf03d6b58aebad17",
          "worktree_digest": "sha256:be639f0f54680f27abcf1fc1efdfdadfbb2197d1ec4d493cdf03d6b58aebad17",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/storage/vector-generation.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:8e68833a8d0741ded37bd4b4600e2e094eb8d631f7862deb3be039cd23fa3655",
          "index_digest": "sha256:8e68833a8d0741ded37bd4b4600e2e094eb8d631f7862deb3be039cd23fa3655",
          "worktree_digest": "sha256:8e68833a8d0741ded37bd4b4600e2e094eb8d631f7862deb3be039cd23fa3655",
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
          "path": "gitnexus/test/integration/embedding-job-controller.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:052d885d773597196a719cd1184be4d3349c45c74836c992937ad75c10afff84",
          "index_digest": "sha256:052d885d773597196a719cd1184be4d3349c45c74836c992937ad75c10afff84",
          "worktree_digest": "sha256:052d885d773597196a719cd1184be4d3349c45c74836c992937ad75c10afff84",
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
          "path": "gitnexus/test/integration/embedding-native-release.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:43dcc9d5b5dbd61d07bc44bf1191f12c5b12f05aa32e9d384adb7d97effb9819",
          "index_digest": "sha256:43dcc9d5b5dbd61d07bc44bf1191f12c5b12f05aa32e9d384adb7d97effb9819",
          "worktree_digest": "sha256:43dcc9d5b5dbd61d07bc44bf1191f12c5b12f05aa32e9d384adb7d97effb9819",
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
          "path": "gitnexus/test/integration/embedding-vector-store.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:1b9819c2692e6122ba9f958ca07acde122005c53723af7bb17961fb3323b5f2a",
          "index_digest": "sha256:1b9819c2692e6122ba9f958ca07acde122005c53723af7bb17961fb3323b5f2a",
          "worktree_digest": "sha256:1b9819c2692e6122ba9f958ca07acde122005c53723af7bb17961fb3323b5f2a",
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
          "path": "gitnexus/test/unit/analysis-publication.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:e37f3c7a85bc17dbc7a1ccb2303eeb6a70cb3be4b32d4c90a8882945cf8813e0",
          "index_digest": "sha256:e37f3c7a85bc17dbc7a1ccb2303eeb6a70cb3be4b32d4c90a8882945cf8813e0",
          "worktree_digest": "sha256:e37f3c7a85bc17dbc7a1ccb2303eeb6a70cb3be4b32d4c90a8882945cf8813e0",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/unit/analysis-resource-budget.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:24ed33c78bb6f37abde2f6b68ba35c307c3d1c25fc2b14830407f48b6a109acf",
          "index_digest": "sha256:24ed33c78bb6f37abde2f6b68ba35c307c3d1c25fc2b14830407f48b6a109acf",
          "worktree_digest": "sha256:24ed33c78bb6f37abde2f6b68ba35c307c3d1c25fc2b14830407f48b6a109acf",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/unit/analyze-launch-branch-settle.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:9a37459f431b81dc89d2b02e5c05f361b41cd4ff598e02b27371b5fdfe2c0e1b",
          "index_digest": "sha256:9a37459f431b81dc89d2b02e5c05f361b41cd4ff598e02b27371b5fdfe2c0e1b",
          "worktree_digest": "sha256:9a37459f431b81dc89d2b02e5c05f361b41cd4ff598e02b27371b5fdfe2c0e1b",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/unit/analyze-launch-collapse.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:e1fd4983f39929aba6beb5ddd55b02ab31b85e26de4a040dd781658ee88fd652",
          "index_digest": "sha256:e1fd4983f39929aba6beb5ddd55b02ab31b85e26de4a040dd781658ee88fd652",
          "worktree_digest": "sha256:e1fd4983f39929aba6beb5ddd55b02ab31b85e26de4a040dd781658ee88fd652",
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
          "path": "gitnexus/test/unit/analyze-worker-core.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:40a12110cecb3542e218d85d4aed7bd1fde6c168479947ed69b691a57d417bc0",
          "index_digest": "sha256:40a12110cecb3542e218d85d4aed7bd1fde6c168479947ed69b691a57d417bc0",
          "worktree_digest": "sha256:40a12110cecb3542e218d85d4aed7bd1fde6c168479947ed69b691a57d417bc0",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/unit/analyze-worker-ipc.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:f57c5cce114929f78c37fd7b4ed32a4061d87f9bf712d7c2ddef65d061fad68e",
          "index_digest": "sha256:f57c5cce114929f78c37fd7b4ed32a4061d87f9bf712d7c2ddef65d061fad68e",
          "worktree_digest": "sha256:f57c5cce114929f78c37fd7b4ed32a4061d87f9bf712d7c2ddef65d061fad68e",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/unit/auto-sync-analysis-worker.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:e6f69f81057968879092a6df90619de873a8fb9a0d1b192f4450f6ec72058950",
          "index_digest": "sha256:e6f69f81057968879092a6df90619de873a8fb9a0d1b192f4450f6ec72058950",
          "worktree_digest": "sha256:e6f69f81057968879092a6df90619de873a8fb9a0d1b192f4450f6ec72058950",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/unit/embedding-job-journal.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:b77958ad828ec1392f5c53f6317c7a96176a8bbf1f0300e080b86326b570bcf6",
          "index_digest": "sha256:b77958ad828ec1392f5c53f6317c7a96176a8bbf1f0300e080b86326b570bcf6",
          "worktree_digest": "sha256:b77958ad828ec1392f5c53f6317c7a96176a8bbf1f0300e080b86326b570bcf6",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/unit/embedding-job-progress.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:1fee3af2ce6ece7e89c2e87015d3e444ce766b9a5a5b194fd55aca82f9c9de0c",
          "index_digest": "sha256:1fee3af2ce6ece7e89c2e87015d3e444ce766b9a5a5b194fd55aca82f9c9de0c",
          "worktree_digest": "sha256:1fee3af2ce6ece7e89c2e87015d3e444ce766b9a5a5b194fd55aca82f9c9de0c",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/unit/embedding-sidecar-client.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:ad2c7746c20179d797ff1fa2252f4824025a3b600f601146d9af754916159fc8",
          "index_digest": "sha256:ad2c7746c20179d797ff1fa2252f4824025a3b600f601146d9af754916159fc8",
          "worktree_digest": "sha256:ad2c7746c20179d797ff1fa2252f4824025a3b600f601146d9af754916159fc8",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/unit/lbug-analysis-resources.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:a8f81cec6a18f4f8388599b7c16aec643ebe5bbb17c9c7458c5af2e584ad9e05",
          "index_digest": "sha256:a8f81cec6a18f4f8388599b7c16aec643ebe5bbb17c9c7458c5af2e584ad9e05",
          "worktree_digest": "sha256:a8f81cec6a18f4f8388599b7c16aec643ebe5bbb17c9c7458c5af2e584ad9e05",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/unit/local-backend-vector-generation.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:62dfd503c616fa0b9f03737add16f84aa60f7bba6406390de925418a602d50c6",
          "index_digest": "sha256:62dfd503c616fa0b9f03737add16f84aa60f7bba6406390de925418a602d50c6",
          "worktree_digest": "sha256:62dfd503c616fa0b9f03737add16f84aa60f7bba6406390de925418a602d50c6",
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
          "head_digest": "sha256:116cb2e25c2acb6bbbe789506ceecd2761b344a53269c634511240f49f8423a5",
          "index_digest": "sha256:116cb2e25c2acb6bbbe789506ceecd2761b344a53269c634511240f49f8423a5",
          "worktree_digest": "sha256:116cb2e25c2acb6bbbe789506ceecd2761b344a53269c634511240f49f8423a5",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/unit/vector-generation.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:34709e135f248a242ffd3c5ca2607423df94da785bec99a2ec0208d000073be6",
          "index_digest": "sha256:34709e135f248a242ffd3c5ca2607423df94da785bec99a2ec0208d000073be6",
          "worktree_digest": "sha256:34709e135f248a242ffd3c5ca2607423df94da785bec99a2ec0208d000073be6",
          "untracked_digest": "absent"
        }
      ]
    },
    "primary_symbols": [
      {
        "symbol": "runFullAnalysisInner",
        "file": "gitnexus/src/core/run-analyze.ts",
        "lines": "1580,2817-2840,5497-5500,5545-5580",
        "role": "Graph finalization; retain in-place vs staged semantics and defer exit-only publication",
        "source_verified": true
      },
      {
        "symbol": "runPublishedEmbeddingJob",
        "file": "gitnexus/src/core/embeddings/embedding-job.ts",
        "lines": "116-330",
        "role": "Bounded controller, verified graph admission, pending-artifact rebase",
        "source_verified": true
      },
      {
        "symbol": "decideEmbeddingResume",
        "file": "gitnexus/src/core/embedding-checkpoint.ts",
        "lines": "190-290",
        "role": "Existing force/drop/legacy compatibility across three production callers",
        "source_verified": true
      },
      {
        "symbol": "LocalBackend.semanticSearch",
        "file": "gitnexus/src/mcp/local/local-backend.ts",
        "lines": "generation selection and graph hydration; re-locate exact edit range before change",
        "role": "Readiness and preserved coverage gating",
        "source_verified": true
      },
      {
        "symbol": "ensureHeap",
        "file": "gitnexus/src/cli/analyze.ts",
        "lines": "682-764",
        "role": "Existing conditional respawn; supervisor cannot assume a parent already exists",
        "source_verified": true
      }
    ],
    "related_symbols": [
      {
        "symbol": "runFullAnalysis",
        "relationship": "CALLS runFullAnalysisInner",
        "relevance": "Lock, shared-store, cache and registry boundary"
      },
      {
        "symbol": "analyzeCommandImpl",
        "relationship": "CALLS runFullAnalysis",
        "relevance": "CLI postprocessing consumes live graph"
      },
      {
        "symbol": "runWorkerAnalysis",
        "relationship": "CALLS runFullAnalysis",
        "relevance": "skipNativeCloseOnExit plus terminal projection"
      },
      {
        "symbol": "createLaunchAnalysisWorker",
        "relationship": "parent of graph worker",
        "relevance": "Actual exit before continuation and backend publication"
      },
      {
        "symbol": "projectAnalyzeResultForIpc",
        "relationship": "projection",
        "relevance": "Bounded scalar allowlist"
      },
      {
        "symbol": "watchCommandWithRunnerIdentity",
        "relationship": "CALLS ensureHeap/runFullAnalysis",
        "relevance": "Repeated process lifecycle"
      },
      {
        "symbol": "embeddingsSyncCommand",
        "relationship": "CALLS decideEmbeddingResume",
        "relevance": "Production writer parity"
      },
      {
        "symbol": "createServer / POST /api/embed",
        "relationship": "CALLS decideEmbeddingResume",
        "relevance": "Production writer parity"
      },
      {
        "symbol": "LocalBackend._queryImpl",
        "relationship": "CALLS semanticSearch",
        "relevance": "Preserve hybrid search concurrency/ranking"
      },
      {
        "symbol": "prepareAnalysisPublication / publishPreparedAnalysis",
        "relationship": "publication helper",
        "relevance": "Extend staged-only receipt to explicit in-place mode"
      },
      {
        "symbol": "selectVectorGeneration",
        "relationship": "read gate",
        "relevance": "Dirty graph, pending writer and preserved coverage"
      },
      {
        "symbol": "VectorStore",
        "relationship": "native storage",
        "relevance": "Stable unpublished artifact plus complete group receipts"
      },
      {
        "symbol": "EmbeddingJobJournal",
        "relationship": "durability",
        "relevance": "Graph-specific manifest/cursor and crash-safe rebase"
      },
      {
        "symbol": "runEmbeddingJob",
        "relationship": "runner",
        "relevance": "Bounded complete-unit processing"
      },
      {
        "symbol": "drainAnalysisNativeResources",
        "relationship": "resource admission",
        "relevance": "Main singleton and tracked explicit pool release"
      },
      {
        "symbol": "drainEmbeddingSidecarForAnalysis",
        "relationship": "resource admission",
        "relevance": "Release prior runtime before parser phase"
      },
      {
        "symbol": "publishSharedGraph",
        "relationship": "shared storage",
        "relevance": "Immutable shared graph separate from checkout vector work"
      },
      {
        "symbol": "resolveGraphPath",
        "relationship": "routing",
        "relevance": "Owned canonical/generation/shared paths"
      },
      {
        "symbol": "getGraphIncompleteReasons",
        "relationship": "status",
        "relevance": "Graph debt separate from vectors"
      },
      {
        "symbol": "runEmbeddingPipeline",
        "relationship": "legacy production path",
        "relevance": "Three callers remain; must be removed from unbounded production use at activation"
      }
    ],
    "execution_path": [
      "Lock and revalidate target; take existing no-op or embedding-only resume when valid.",
      "If graph work is required, drain prior runtime and run bounded graph phase with its existing in-place/staged choice.",
      "Checkpoint and prepare receipt; finish live-graph CLI work in graph child; on exit-only paths observe actual child exit.",
      "Reacquire existing slot lock, revalidate attempt/slot/metadata, finalize sidecars and publication, registry/shared-store/cache; graph-ready is nonterminal.",
      "Reuse/rebase one owned pending vector artifact; persist graph-specific manifest/journal; admit separate vector writer/model within budget.",
      "Verify current selected coverage, checkpoint/close, publish vector receipt; report exactly one final outcome."
    ],
    "pdg_constraints": [],
    "pdg_availability": "Layer exists. Bounded controls/impact probes are partial and source-offset inconsistent; no trusted complete slice for native handoff. Do not infer edges from source.",
    "source_constraints": [
      "Exit-only CHECKPOINT does not release graph/native handles.",
      "In-place mutation must invalidate the published graph receipt before the first write.",
      "One index lock pins a graph during the active embedding job; a handoff gap requires revalidation.",
      "Only complete per-node chunk receipts qualify for reuse; durability precedes cursor acknowledgement.",
      "No model initialization or vector table access before readiness gate; no-op stays lazy.",
      "Final registry name used by graph-dependent CLI outputs must match post-exit publication; early registration cannot advertise new graph readiness."
    ],
    "architectural_patterns": [
      {
        "pattern": "Owned filesystem receipts and safe publication",
        "example_location": "gitnexus/src/core/analysis-publication.ts",
        "usage_guidance": "Extend explicit publication modes; do not weaken ownership or checksum checks."
      },
      {
        "pattern": "Bounded IPC projection",
        "example_location": "gitnexus/src/server/analyze-worker-ipc.ts:projectAnalyzeResultForIpc",
        "usage_guidance": "Keep KnowledgeGraph in child; allowlist only phase receipt and scalar counters."
      },
      {
        "pattern": "Actual exit before settlement",
        "example_location": "gitnexus/src/core/auto-sync/analysis-worker-launch.ts",
        "usage_guidance": "Reuse exit/cancellation discipline; never force-kill native work."
      },
      {
        "pattern": "Exclusive index lock and target revalidation",
        "example_location": "gitnexus/src/core/run-analyze.ts:runFullAnalysis",
        "usage_guidance": "At handoff reacquire existing lock and reject replaced receipt/slot/generation."
      }
    ],
    "files_to_modify": [
      {
        "file": "gitnexus/src/core/run-analyze.ts",
        "symbols": [
          "runFullAnalysis",
          "runFullAnalysisInner"
        ],
        "intended_change": "Integrate logical graph generations, deferred exit-only finalization and embedding-only resume; preserve existing no-op/in-place paths."
      },
      {
        "file": "gitnexus/src/core/analysis-publication.ts",
        "symbols": [
          "prepareAnalysisPublication",
          "publishPreparedAnalysis"
        ],
        "intended_change": "Add explicit staged/in-place publication modes, attempt binding and exit-verified recovery without whole-graph copies."
      },
      {
        "file": "gitnexus/src/core/analysis-phase-supervisor.ts",
        "symbols": [],
        "intended_change": "NEW proposed filesystem/IPC phase supervisor; use actual child exit, existing lock acquisition and bounded result projection."
      },
      {
        "file": "gitnexus/src/cli/analyze.ts",
        "symbols": [
          "ensureHeap",
          "analyzeCommandImpl"
        ],
        "intended_change": "Compose supervision with heap respawn; keep live pipeline-result work in graph child and avoid extra forks for no-op/graph-only runs."
      },
      {
        "file": "gitnexus/src/cli/index.ts",
        "symbols": [],
        "intended_change": "Expose --resource-budget and pass immutable allocations without changing --memory-budget."
      },
      {
        "file": "gitnexus/src/cli/analyze-watch.ts",
        "symbols": [
          "watchCommandWithRunnerIdentity"
        ],
        "intended_change": "Preserve heap flags and safe lifecycle across repeated analyses."
      },
      {
        "file": "gitnexus/src/server/analyze-worker-core.ts",
        "symbols": [
          "runWorkerAnalysis"
        ],
        "intended_change": "Emit graph-prepared handoff separately from terminal completion; retain exit-only native cleanup."
      },
      {
        "file": "gitnexus/src/server/analyze-worker-ipc.ts",
        "symbols": [
          "projectAnalyzeResultForIpc"
        ],
        "intended_change": "Allowlist bounded phase receipts/counters; never serialize pipelineResult."
      },
      {
        "file": "gitnexus/src/server/analyze-launch.ts",
        "symbols": [
          "createLaunchAnalysisWorker"
        ],
        "intended_change": "Wait for graph-worker exit, finish publication, refresh graph backend, then continue embeddings; exactly one terminal event."
      },
      {
        "file": "gitnexus/src/core/auto-sync/analysis-worker-launch.ts",
        "symbols": [],
        "intended_change": "Preserve exit-based settlement and cooperative cancellation; carry nonterminal graph readiness."
      },
      {
        "file": "gitnexus/src/core/embeddings/embedding-job.ts",
        "symbols": [
          "runPublishedEmbeddingJob"
        ],
        "intended_change": "Separate job identity from unpublished artifact ownership, reuse pending paid groups across rebases, and admit only after native release."
      },
      {
        "file": "gitnexus/src/core/embeddings/embedding-job-identity.ts",
        "symbols": [
          "embeddingJobIdentity"
        ],
        "intended_change": "Keep graph-bound scheduling identity separate from reusable input/vector-space identities."
      },
      {
        "file": "gitnexus/src/core/embeddings/embedding-job-runner.ts",
        "symbols": [
          "runEmbeddingJob"
        ],
        "intended_change": "Validate/reuse complete groups in the current manifest, preserve durability-before-acknowledgement and bounded queues."
      },
      {
        "file": "gitnexus/src/core/lbug/vector-store.ts",
        "symbols": [
          "VectorStore"
        ],
        "intended_change": "Allow an exclusively owned unpublished artifact to outlive one graph-bound journal; retain complete group proofs and immutable published stores."
      },
      {
        "file": "gitnexus/src/storage/embedding-job-journal.ts",
        "symbols": [
          "EmbeddingJobJournal"
        ],
        "intended_change": "Crash-safe rebase receipt and fresh manifest/cursor; no in-memory history chain or loss of acknowledged compatible groups."
      },
      {
        "file": "gitnexus/src/storage/embedding-job.ts",
        "symbols": [],
        "intended_change": "Owned filesystem artifacts and durable adoption/rebase records."
      },
      {
        "file": "gitnexus/src/core/embeddings/vector-publication.ts",
        "symbols": [
          "publishVectorGeneration"
        ],
        "intended_change": "Verify current manifest coverage and close durability before publishing the artifact pointer."
      },
      {
        "file": "gitnexus/src/storage/repo-meta.ts",
        "symbols": [
          "RepoMeta"
        ],
        "intended_change": "Version optional graph mode, job/artifact references, preserved coverage and recorded legacy provenance without inventing missing identities."
      },
      {
        "file": "gitnexus/src/storage/vector-generation.ts",
        "symbols": [
          "selectVectorGeneration",
          "metadataMatchesGraph"
        ],
        "intended_change": "Reject dirty/collapsed graphs; distinguish verified-current, preserved historical, legacy and pending states."
      },
      {
        "file": "gitnexus/src/storage/index-capabilities.ts",
        "symbols": [],
        "intended_change": "Expose availability separately from current-generation coverage; preserve existing result shapes with additive fields."
      },
      {
        "file": "gitnexus/src/storage/embedding-job-progress.ts",
        "symbols": [],
        "intended_change": "Represent preserved coverage and durable pending progress truthfully."
      },
      {
        "file": "gitnexus/src/core/embedding-checkpoint.ts",
        "symbols": [
          "decideEmbeddingResume"
        ],
        "intended_change": "Retain legacy proof/force/drop policy; share one caller decision for new jobs."
      },
      {
        "file": "gitnexus/src/cli/embeddings-sync.ts",
        "symbols": [
          "embeddingsSyncCommand"
        ],
        "intended_change": "Route to the common bounded controller after ownership and graph validation."
      },
      {
        "file": "gitnexus/src/server/api.ts",
        "symbols": [
          "createServer"
        ],
        "intended_change": "Route /api/embed through the controller and carry safe readiness/progress fields."
      },
      {
        "file": "gitnexus/src/core/shared-store-analyze.ts",
        "symbols": [
          "publishSharedGraph"
        ],
        "intended_change": "Publish graph facts independently of checkout-owned vector debt; preserve shared immutable graph ownership."
      },
      {
        "file": "gitnexus/src/storage/shared-store.ts",
        "symbols": [
          "resolveGraphPath"
        ],
        "intended_change": "Resolve explicit graph mode and pin artifacts referenced by prepared publication, active job or readers."
      },
      {
        "file": "gitnexus/src/storage/repo-manager.ts",
        "symbols": [
          "saveMeta"
        ],
        "intended_change": "Preserve owned generation references across metadata and registry updates."
      },
      {
        "file": "gitnexus/src/core/analysis-resource-budget.ts",
        "symbols": [],
        "intended_change": "Include supervisor and child process peaks; tune automatic allocations using matched-resource measurements."
      },
      {
        "file": "gitnexus/src/core/lbug/lbug-adapter.ts",
        "symbols": [
          "drainAnalysisNativeResources"
        ],
        "intended_change": "Keep strict admission for genuinely in-process callers; never use it to override exit-only graph cleanup."
      },
      {
        "file": "gitnexus/src/core/embeddings/embedding-sidecar-client.ts",
        "symbols": [
          "drainEmbeddingSidecarForAnalysis"
        ],
        "intended_change": "Wire prior-model drain before parser admission, while keeping no-op analysis lazy."
      },
      {
        "file": "gitnexus/src/core/analysis-progress.ts",
        "symbols": [],
        "intended_change": "Carry graph and embedding phase counters from actual durable producer events."
      },
      {
        "file": "gitnexus/src/core/embeddings/types.ts",
        "symbols": [
          "EmbeddingProgress"
        ],
        "intended_change": "Maintain additive safe progress contracts."
      },
      {
        "file": "gitnexus/src/mcp/local/local-backend.ts",
        "symbols": [
          "LocalBackend.semanticSearch"
        ],
        "intended_change": "Gate vector selection before model/native vector work; preserve BM25 parallelism and matching graph hydration."
      },
      {
        "file": "gitnexus/src/core/embeddings/vector-generation-search.ts",
        "symbols": [],
        "intended_change": "Serve a completed preserved artifact with explicit coverage state; never serve the active writer."
      },
      {
        "file": "gitnexus/src/core/index-freshness.ts",
        "symbols": [
          "getGraphIncompleteReasons"
        ],
        "intended_change": "Keep vector debt separate; dirty in-place graph mutation remains unavailable/unverified."
      },
      {
        "file": "gitnexus/src/cli/status.ts",
        "symbols": [],
        "intended_change": "Report graph freshness, embedding phase and preserved/current coverage independently."
      },
      {
        "file": "gitnexus/src/server/ops-snapshot.ts",
        "symbols": [],
        "intended_change": "Allowlist public progress; omit paths, tokens and internal identities."
      },
      {
        "file": "gitnexus/src/server/analyze-job.ts",
        "symbols": [],
        "intended_change": "Represent nonterminal graph readiness and one terminal outcome."
      },
      {
        "file": "gitnexus/src/server/repo-projection.ts",
        "symbols": [],
        "intended_change": "Expose additive coverage/readiness fields."
      },
      {
        "file": "gitnexus/src/mcp/resources.ts",
        "symbols": [],
        "intended_change": "Expose the same graph/vector state in repository context."
      },
      {
        "file": "gitnexus/bench/analyze-resume/measure.mjs",
        "symbols": [],
        "intended_change": "NEW proposed end-to-end paired harness; existing microbenchmarks do not replace it."
      },
      {
        "file": "gitnexus/bench/analyze-resume/README.md",
        "symbols": [],
        "intended_change": "Document raw samples, environment, pair ordering, equal-work checks and limits."
      },
      {
        "file": "RUNBOOK.md",
        "symbols": [],
        "intended_change": "Document phase recovery, resource flag, preserved coverage, migration and downgrade behavior."
      }
    ],
    "tests": [
      {
        "file": "gitnexus/test/unit/analysis-publication.test.ts",
        "status": "existing",
        "scenarios": [
          "In-place mutation invalidates generation before writes; no full graph copy/hash on a tiny edit.",
          "Staged crash keeps old graph; in-place crash preserves existing dirty-recovery behavior; after publication embedding failures preserve new graph."
        ]
      },
      {
        "file": "gitnexus/test/integration/analyze-phase-publication.test.ts",
        "status": "new",
        "scenarios": [
          "Graph child sends prepared then stays alive: zero provider/open-new-pool calls until exit.",
          "Cold/warm MCP and HTTP readers see new graph/FTS while separate vector writer is open.",
          "Crash before/after file and metadata publication; competing writer changes slot/generation during handoff: reject stale receipt without paid requests.",
          "Registry-name collision/change and --skills/self-commit: context names match final registration; prepared slot never appears graph-ready."
        ]
      },
      {
        "file": "gitnexus/test/unit/analyze-worker-core.test.ts",
        "status": "existing",
        "scenarios": [
          "Graph-prepared is nonterminal; cancellation owns terminal slot; preserve skipNativeCloseOnExit."
        ]
      },
      {
        "file": "gitnexus/test/unit/analyze-worker-ipc.test.ts",
        "status": "existing",
        "scenarios": [
          "Graph getters throw if traversed: bounded phase receipt still serializes; safe counters only."
        ]
      },
      {
        "file": "gitnexus/test/unit/analyze-launch-collapse.test.ts",
        "status": "existing",
        "scenarios": [
          "Collapse rejected before backend publication; no embedding child or model admission."
        ]
      },
      {
        "file": "gitnexus/test/unit/analyze-launch-branch-settle.test.ts",
        "status": "existing",
        "scenarios": [
          "External/shared/branch slot from result is revalidated after child exit."
        ]
      },
      {
        "file": "gitnexus/test/unit/auto-sync-analysis-worker.test.ts",
        "status": "existing",
        "scenarios": [
          "Prepared IPC is not terminal; actual exit gates completion; cancelled native child is not force-killed."
        ]
      },
      {
        "file": "gitnexus/test/integration/embedding-job-controller.test.ts",
        "status": "existing",
        "scenarios": [
          "Unchanged graph skips parsing and complete provider requests; graph changes rebase pending artifact.",
          "Two source changes between interruptions retain first-attempt paid groups and previous completed fallback.",
          "New model/text/dimensions reject incompatible reuse before requests; smaller resource budget does not invalidate units."
        ]
      },
      {
        "file": "gitnexus/test/integration/embedding-vector-store.test.ts",
        "status": "existing",
        "scenarios": [
          "Current manifest validates complete groups; stale/deleted nodes pruned before publish; published store never mutated.",
          "Rebase crash at intent/adoption/checkpoint boundaries preserves owned paid artifact and rejects foreign identity."
        ]
      },
      {
        "file": "gitnexus/test/unit/embedding-job-journal.test.ts",
        "status": "existing",
        "scenarios": [
          "One active unit; corrupted checksum/missing segment preserved and recovered only from complete native groups."
        ]
      },
      {
        "file": "gitnexus/test/integration/embedding-job-restart.test.ts",
        "status": "new",
        "scenarios": [
          "Real child crashes at JS-visible intent/native-write/checkpoint/cursor/HNSW/pointer boundaries; at most active unit replay.",
          "ENOSPC, cancellation and repeated interruption keep published graph available and no duplicate/missing chunk rows."
        ]
      },
      {
        "file": "gitnexus/test/integration/embedding-resource-bounds.test.ts",
        "status": "new",
        "scenarios": [
          "Lazy 10k/100k/1m descriptors and oversized Unicode nodes: fixed queue high-water mark, identical text/chunks, no corpus materialization.",
          "Smaller real-native case counts parent, graph/embedding child and sidecar peaks without double-counting thread RSS."
        ]
      },
      {
        "file": "gitnexus/test/unit/vector-generation.test.ts",
        "status": "existing",
        "scenarios": [
          "Dirty/collapsed/mismatched graphs gate before native/model access; historical completed artifact is labeled preserved; pending job disables vector lane."
        ]
      },
      {
        "file": "gitnexus/test/unit/local-backend-vector-generation.test.ts",
        "status": "existing",
        "scenarios": [
          "Preserved results hydrate current IDs and reject deleted nodes; active vector writer never opened; query ranking parity."
        ]
      },
      {
        "file": "gitnexus/test/unit/embedding-job-progress.test.ts",
        "status": "existing",
        "scenarios": [
          "Completed+reused+pending+failed=total; active subset of pending; preserved is not current-complete; no false terminal event."
        ]
      },
      {
        "file": "gitnexus/test/unit/server-sse-payload.test.ts",
        "status": "existing",
        "scenarios": [
          "Forward producer/IPC phase details through safe allowlist; graph-ready nonterminal; exactly one final success/failure/cancel event."
        ]
      },
      {
        "file": "gitnexus/test/unit/analyze-memory-budget.test.ts",
        "status": "existing",
        "scenarios": [
          "Heap-only flag retains old meaning, including explicit ambient heap and respawn opt-out."
        ]
      },
      {
        "file": "gitnexus/test/unit/analysis-resource-budget.test.ts",
        "status": "existing",
        "scenarios": [
          "Supervisor+children+native pools+sidecar+queues fit; defaults preserve useful concurrency when feasible."
        ]
      },
      {
        "file": "gitnexus/test/unit/lbug-analysis-resources.test.ts",
        "status": "existing",
        "scenarios": [
          "Failed close remains charged; session drain blocks model/parser; cancellation during drain makes no metadata/provider calls."
        ]
      },
      {
        "file": "gitnexus/test/integration/embedding-native-release.test.ts",
        "status": "existing",
        "scenarios": [
          "Explicit native pools are not reused before verified physical close; failed close retries, result-close failures clear active admission."
        ]
      },
      {
        "file": "gitnexus/test/unit/embedding-sidecar-client.test.ts",
        "status": "existing",
        "scenarios": [
          "Parser phase waits for prior model-child exit; cancellation does not release a physically active request early."
        ]
      },
      {
        "file": "gitnexus/test/integration/analyze-staged-embedding-recovery.test.ts",
        "status": "existing",
        "scenarios": [
          "Keep legacy complete-group reuse, second-crash, changed/deleted nodes, force/drop behavior and known-identity relocation without provider requests."
        ]
      },
      {
        "file": "gitnexus/test/integration/vector-generation-compatibility.test.ts",
        "status": "new",
        "scenarios": [
          "Plain analyze preserves legacy and previously completed vector coverage without automatic requests.",
          "Unknown legacy provenance remains unknown; explicit generation logs any unsafe-reuse invalidation; relocation alone never invalidates verified groups.",
          "Windows open handles, no VECTOR/FTS, shared sibling and external/branch storage, concurrent writers."
        ]
      },
      {
        "file": "gitnexus/test/integration/shared-store-embedding-reuse.test.ts",
        "status": "existing",
        "scenarios": [
          "Prepared publication/pending vector work pins its artifacts; sibling cannot clean or mutate them."
        ]
      }
    ],
    "verification_commands": [
      "cd gitnexus && npm run build",
      "cd gitnexus && npx tsc --noEmit",
      "cd gitnexus && npm run typecheck:tests",
      "cd gitnexus && npm test -- test/unit/analysis-publication.test.ts test/unit/vector-generation.test.ts test/unit/analyze-worker-core.test.ts test/unit/analyze-worker-ipc.test.ts test/unit/embedding-job-journal.test.ts test/unit/analysis-resource-budget.test.ts test/unit/lbug-analysis-resources.test.ts test/unit/server-sse-payload.test.ts",
      "cd gitnexus && npm run test:integration -- test/integration/embedding-job-controller.test.ts test/integration/embedding-vector-store.test.ts test/integration/embedding-native-release.test.ts test/integration/analyze-staged-embedding-recovery.test.ts test/integration/shared-store-embedding-reuse.test.ts",
      "cd gitnexus && npm test",
      "cd gitnexus && node --import tsx bench/embedding-inputs/measure.cjs --check",
      "cd gitnexus && node --import tsx bench/embedding-identities/measure.cjs --check"
    ],
    "risks": [
      "CRITICAL decideEmbeddingResume across analyze/sync/API; HIGH semanticSearch; previously CRITICAL native close/session helpers. Re-run impact before each edit.",
      "Process handoff, publication, historical-coverage semantics, migration and rebase durability must activate coherently.",
      "New process startup, manifest/native reopen, HTTP response parsing or pool sizing may regress latency/throughput; performance gate is unresolved."
    ],
    "assumptions": [
      "Whole-command performance is unmeasured. Verify with at least seven alternating pairs at equal work/resources before activation/shipment; no allowed slowdown threshold.",
      "Automatic resource defaults are provisional. Include supervisor RSS, native pools, child/model runtime, queues and headroom; tune using the full matrix.",
      "Windows and a representative local model have not been validated in this environment. Obtain those executions or report the acceptance gap; never infer a pass from Linux mocks.",
      "PDG exists but current close slice is unavailable and controller output has mismatched source offsets plus truncation. Treat statement-level coverage as unresolved; source constraints remain authoritative.",
      "Legacy model/text provenance may be absent. Preserve legacy read/preserve-only behavior; never invent a verified identity. Explicit new generation may invalidate only groups whose required compatibility cannot be proven, with reason and cost visible."
    ],
    "open_questions": [
      "No user product preference is required beyond the revised architecture gate. Performance defaults are decided by measurements, not an arbitrary regression allowance.",
      "Windows/local-model evidence and PDG coverage limits remain explicit acceptance gaps."
    ],
    "avoid": [
      "Do not redo landed helper commits or repeat full repository discovery.",
      "Do not force physical graph immutability/copying for default private incremental updates.",
      "Do not invoke real native graph close on a CLI/server exit-only path just to begin embeddings; wait for process exit.",
      "Do not serialize KnowledgeGraph/pipelineResult through IPC or add unbounded job-history scans.",
      "Do not create a borrowed-index-lock token protocol; reacquire and revalidate the existing exclusive lock at handoff.",
      "Do not mutate published vector artifacts, expose an active writer to readers, or present preserved historical coverage as current complete.",
      "Do not charge provider work on plain preserve-only analyze, fabricate legacy identities, truncate input, or accept isolated chunk hashes as complete groups.",
      "Do not change --memory-budget semantics or invalidate paid work because of scheduling/resource changes.",
      "Do not terminate a native-active thread/worker; use cooperative safe points and verified exit.",
      "Do not use microbenchmarks as proof of end-to-end non-regression or compare unequal work/resources.",
      "Do not edit unrelated /workspace changes, dependencies, language-resolution behavior, CI/release/security config; no push or PR."
    ],
    "completed_commits": [
      {
        "commit": "f0f3b9abe",
        "result": "Original approved plan; superseded only by this Deepen revision."
      },
      {
        "commit": "60ddccefa",
        "result": "Native storage feasibility and baseline microbenchmarks; whole-command harness still missing."
      },
      {
        "commit": "dbf62eab1",
        "result": "Pure resource resolver and deterministic bounded manifest."
      },
      {
        "commit": "ec9063f65",
        "result": "Vector store and durable segmented journal."
      },
      {
        "commit": "ba23148ba",
        "result": "Bounded runner/text streaming and complete-group reuse."
      },
      {
        "commit": "084c52895",
        "result": "Staged publication and generation-aware readers; in-place mode still needed."
      },
      {
        "commit": "f2fc492cf",
        "result": "Published-job controller; no production callers yet."
      },
      {
        "commit": "8bdd572fd",
        "result": "Optional parser/native resource allocation plumbing."
      },
      {
        "commit": "8dec4f273",
        "result": "Physical sidecar reservations; parser admission not wired."
      },
      {
        "commit": "700d6aca8",
        "result": "Readiness/progress consumers; producer/IPC wiring incomplete."
      },
      {
        "commit": "2363a1060",
        "result": "Interrupted native bootstrap and journal recovery."
      },
      {
        "commit": "f953c569e",
        "result": "Verified explicit native pool release and retry accounting."
      },
      {
        "commit": "8c6b680f3",
        "result": "Main graph/session drain before in-process phase admission."
      }
    ],
    "remaining_steps": [
      "Create full paired harness and re-anchor baseline",
      "Extend graph publication and bounded exit handoff",
      "Rebase pending artifacts and preserve legacy/historical coverage",
      "Wire resource/progress/shared-store surfaces",
      "Activate all three production writers together",
      "Full regression/performance matrix and docs",
      "GitNexus review; no push/PR"
    ],
    "index_refresh": {
      "runner": "node gitnexus/dist/cli/index.js",
      "storage": "isolated local navigation index",
      "head": "8c6b680f3071025189804ffebac2fd3bc8bf1232",
      "schema": 4,
      "status": "up-to-date",
      "runner_identity_status": "current",
      "content_drift": "current",
      "incomplete_reasons": [],
      "receipt_match": "Exact MCP context runnerIdentity equals local status.index.runnerIdentity; local build/source current.",
      "deepen_refreshes": 0,
      "limitations": [
        "Connected MCP native engine uses storage42, local index storage47; use build-current local backend for graph calls.",
        "Clusters/processes resource attempts failed engine mismatch; bounded local impact process summaries used instead.",
        "PDG source offsets/truncation remain unresolved; no unrelated indexer repair included."
      ]
    },
    "validation_status": {
      "feature": "incomplete; bounded controller not yet activated in production",
      "latest_focused": "80 passed across six relevant suites for 8c6b680; build, source/test typecheck and lint passed (pre-existing warnings).",
      "prior_focused": "f953c569: 265 passed, 1 skipped across recorded focused sets; 2363a106 bootstrap/journal regressions passed.",
      "candidate_full_suite": "not run",
      "performance": "microbenchmarks only; no whole-command non-regression acceptance",
      "review": "gitnexus-review not run",
      "platforms": "Linux native exercised; Windows/local-model unverified"
    },
    "reanchor": {
      "old_head": "f641342d1fcbfdcb764c5e478db0f69e6cea899a",
      "new_head": "8c6b680f3071025189804ffebac2fd3bc8bf1232",
      "old_plan_digest": "sha256:c36d6ad14288ca3ff0510c7d18a769d750c72475b5fff0fb476b10709e22d0e9",
      "changed_cited_paths": [
        "gitnexus/src/cli/status.ts",
        "gitnexus/src/core/analysis-publication.ts",
        "gitnexus/src/core/analysis-resource-budget.ts",
        "gitnexus/src/core/embeddings/embedding-job.ts",
        "gitnexus/src/core/embeddings/embedding-pipeline.ts",
        "gitnexus/src/core/embeddings/embedding-work-manifest.ts",
        "gitnexus/src/core/embeddings/types.ts",
        "gitnexus/src/core/index-freshness.ts",
        "gitnexus/src/core/ingestion/workers/worker-pool.ts",
        "gitnexus/src/core/lbug/lbug-adapter.ts",
        "gitnexus/src/core/lbug/lbug-config.ts",
        "gitnexus/src/core/lbug/pool-adapter.ts",
        "gitnexus/src/core/run-analyze.ts",
        "gitnexus/src/mcp/local/local-backend.ts",
        "gitnexus/src/server/analyze-job.ts",
        "gitnexus/src/server/api.ts",
        "gitnexus/src/server/ops-snapshot.ts",
        "gitnexus/src/storage/embedding-job.ts",
        "gitnexus/src/storage/repo-manager.ts",
        "gitnexus/src/storage/repo-meta.ts",
        "gitnexus/src/storage/shared-store.ts",
        "gitnexus/test/unit/analysis-resource-budget.test.ts",
        "gitnexus/test/unit/embedding-work-manifest.test.ts",
        "gitnexus/test/unit/server-sse-payload.test.ts"
      ],
      "policy": "Changed old ranges replaced by current seam evidence or retired; landed helpers reconciled rather than blindly re-pinned."
    }
  }
}
```

## 12. Assumptions and Open Questions

- [assumed] Whole-command performance is unmeasured. Verify with at least seven alternating pairs at equal work/resources before activation/shipment; no allowed slowdown threshold.
- [assumed] Automatic resource defaults are provisional. Include supervisor RSS, native pools, child/model runtime, queues and headroom; tune using the full matrix.
- [assumed] Windows and a representative local model have not been validated in this environment. Obtain those executions or report the acceptance gap; never infer a pass from Linux mocks.
- [assumed] PDG exists but current close slice is unavailable and controller output has mismatched source offsets plus truncation. Treat statement-level coverage as unresolved; source constraints remain authoritative.
- [assumed] Legacy model/text provenance may be absent. Preserve legacy read/preserve-only behavior; never invent a verified identity. Explicit new generation may invalidate only groups whose required compatibility cannot be proven, with reason and cost visible.

No new product preference is needed beyond approval of the concrete architecture revision. Implementation choices above are fixed; allocation tuning follows evidence. The full matrix, Windows/local-model coverage and final review remain completion gates, not reasons to claim a partial feature finished.

The original stale-analyzer/graph-UID limitation has been replaced by a verified current local runner/index and explicit narrower PDG/resource limitations. Changed cited paths were reconciled before moving the evidence pin. Existing shared language-neutral ingestion rules and no-native-termination guardrails remain binding.

Deferred: distributed embedding workers, new database engines, unrelated PDG fixes, graph-ingestion out-of-core redesign, automatic background scheduling and serving vectors from incomplete active jobs. Preserving a previously completed artifact with historical-coverage labeling is explicitly in scope for backward compatibility.

The original `/workspace` user edits are outside this worktree/task. Do not stage them. No automatic push/PR.

## 13. Definition of Done

- [ ] New graph/keyword results are independently durable and readable before embeddings finish; every embedding failure preserves that graph.
- [ ] Staged and in-place crash semantics are tested and documented; tiny private incremental updates do not gain a whole-graph copy/hash.
- [ ] Exit-only graph workers physically exit before embedding admission; no native-active termination, unbounded IPC or double-counted resource reservations.
- [ ] All three production writers use bounded input/chunk/vector queues with identical text/coverage semantics; large-corpus and oversized-node cases pass.
- [ ] Compatible unchanged retries skip graph rebuilding and acknowledged provider requests; repeated source-change interruptions preserve all provably reusable paid groups.
- [ ] Plain analyze preserves existing vectors with zero automatic requests; current/preserved/legacy/pending coverage is truthful across CLI, MCP, HTTP and SSE.
- [ ] Force/drop, legacy recovery, shared/external/branch storage and Windows handle behavior pass their required cases; unmeasured platforms remain explicitly unresolved.
- [ ] Paired full-command evidence demonstrates no repeatable throughput/query-latency regression at comparable resources, including all added work and migration costs.
- [ ] Candidate full checks and final GitNexus review are complete; remaining findings are reported. No unrelated edits or unrequested publication.
