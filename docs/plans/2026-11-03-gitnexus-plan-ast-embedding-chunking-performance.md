# GitNexus Engineering Plan

> Task: Complete [issue #702](https://github.com/abhigyanpatwari/GitNexus/issues/702), AST-aware embedding chunking, without performance degradation.
> Deepen cycle: 1, after the real storage/search test disproved the chunker-only source assumption. Depth deep; full form; impact depth3.
> Evidence pin: 802e6f292aa9faf24ac38c5d395eff0f2d71d93a, branch feat/issue-702-ast-embedding-chunking, **plus the exact uncommitted working tree** in §11. This is not a clean-HEAD source claim.
> Provenance schema2; global dirty digest eb1d7761939caba494c72af78ef00913af4b74fcfe45f76aa5c6958c457b7e77; 41 cited paths.
> Index current at 2026-11-03T10:03:45.557Z; indexed/current runner schema4 identities match, content drift current, incomplete reasons empty. Matching local backend used because connected MCP graph storage engine is incompatible. PDG nodes-flow slice is complete; controls slice is partial.
> Status: revised implementation proposal awaiting the LFG structural-replan gate. Existing WIP is preserved. **No implementation commit, passing lifecycle, final performance verdict or completed review.**
> Prior plan receipt: sha256:40b37b8bf04c8fb8d32d0a753e8556510ae731b63b25fc56617932ffb032c6d3; canonical path retained unchanged for guarded replacement.

## 1. Objective

Finish the issue on the existing embedding pipeline: split long callable source at useful AST boundaries, omit duplicate method bodies from Class inputs, expose validated chunk settings, persist accurate ranges, and preserve cache/recovery/search behavior. Retain the current 1,200-character size and120 overlap defaults; 500/50 remains configurable. File embedding policy, vector-space identity and database schema stay unchanged.

The no-performance-degradation constraint remains a blocking release requirement. A partial implementation or reduced Class vector count does not establish it.

## 2. Current Behaviour

- [verified, current WIP] Config validation and ast/fixed dispatch exist; short callable inputs bypass parsing. Class input is projected before the short fast path, method implementations are excluded, and one parsed Class tree is shared with structural extraction. See config.ts:74, chunker.ts:46, structural-extractor.ts:31 and embedding-pipeline.ts:833.
- [verified, current WIP] Hashing is synchronous and parse-free; scoped Class/nested/policy tags preserve unaffected short v7 fingerprints. It still hashes **persisted graph content**, not a source fingerprint/range: embedding-pipeline.ts:98-146.
- [verified, current source + failing lifecycle] CSV normalizes CR/LF/tab runs to spaces and caps symbol snippets at5,000 characters before persistence: gitnexus/src/core/lbug/csv-generator.ts:281-351. This supports FTS tokenization and must not be undone. A93-line function reached embedding with no newlines; all five stored chunks had range0/0. Long-tail completeness and Python indentation cannot be established from this representation.
- [verified] Analyze already computes raw file SHA256 values at run-analyze.ts:3152, but final metadata stores them only for git repositories at5392. Incremental eligibility independently requires repoHasGit at3184-3195. The status drift scan independently excludes non-git folders at status.ts:335-343.
- [verified] Analyze, embeddings sync and POST /api/embed are the three production pipeline callers. Sync has repoPath and loaded meta; server has entry.path and embeddingMeta. Server storagePath is the index directory, not the source root.
- [verified by execution] Latest focused tests:194 across7 files passed. The real lifecycle test fails on ranges; its temporary diagnostic assertion must also be corrected to zero-based expected source lines. Full suite and performance acceptance are incomplete.

The previous plan's direct chunker behavior remains useful WIP. Its assumption that stored content is complete, line-preserving source is **rejected**, not re-pinned as verified.

## 3. Relevant Architecture

The current flow is ingestion → CSV FTS-normalized symbol content → queryEmbeddableNodes → hash freshness filter → per-node structural/AST preparation → per-batch replacement → CodeEmbedding → best-chunk search. The source representation is lost before chunking.

Add one private, embedding-only source context at the pipeline boundary. Analyze supplies its existing source root/current hash map; sync/server supply the registered checkout root and indexed metadata. The reader supplies verified original spans only for nodes whose source/layout needs it. Keep persisted text and source preparation as separate values so a hydrated snippet cannot accidentally change the cache key mid-run.

Existing seams: run-analyze.ts:4977; embeddings-sync.ts:197; api.ts:2278. Existing ordering: embedding-pipeline.ts:693 freshness filter,811 checkpoint,821 batch preparation,920 stale deletion. Existing source conventions: raw SHA256 in storage/file-hash.ts:29; zero-based inclusive symbol ranges and notebook reconstruction in lbug/csv-generator.ts:330-351.

Scope is CLI/core embedding code, these three callers, narrowly required tests and RUNBOOK. Preserve unrelated original-workspace edits. AGENTS.md/GUARDRAILS rules apply: impact before symbol edits, warn on HIGH/CRITICAL, UNKNOWN requires source confirmation, detect_changes and npm test before commits, preserve embeddings and native worker safety. No language-specific behavior is added to shared ingestion code.

## 4. GitNexus Findings

Fresh graph results, maxDepth3, includeTests:true, limit1000, no partial/truncated impact verdicts:

| Target | Risk | Direct dependents | Production accounting |
| --- | --- | ---: | --- |
| runEmbeddingPipeline | CRITICAL |54| analyze, sync, server callback; remaining51 are tests |
| runFullAnalysisInner | CRITICAL |1| runFullAnalysis; CLI/watch and tests appear downstream |
| resolveEmbeddingConfig | HIGH |13| doctorCommand, resolveEmbeddingIdentity, initLocalEmbedder, runEmbeddingPipeline;9 tests |
| chunkNode | HIGH |28| runEmbeddingPipeline;27 tests |
| contentHashForNode | HIGH |21| runEmbeddingPipeline;20 tests |
| embeddingsSyncCommand | LOW |1| resolved direct caller is its unit-test run helper; dynamic CLI dispatch is not an absence guarantee |
| server callback fn_2104_4 | UNKNOWN |0| source confirms app.post('/api/embed',...) at api.ts:2100; graph records the route |

Pipeline impact covers analyze/watch, sync and server embedding processes. Modules include Embeddings, Lbug, Storage, CLI and tests. Cluster/process overviews were read through the matching local backend after connected resources failed with engine version47vs42.

The original HIGH-risk authorization covered the prior plan. The concrete revised gate now also exposes the newly proposed analyzer/caller/source boundary. No new source edit has been made during this Deepen pass.

## 5. Statement-Level PDG Findings

[verified graph slice] The current index contains PDG data. A file-anchored flows query for variable nodes returns all10 REACHING_DEF edges in runEmbeddingPipeline (functionLine613), without truncation: fetched nodes at634 reach filter693; filtered nodes at693 reach checkpoint811 and batch821. This supports placing source reads only in the post-filter batch path.

The controls query was50/861 edges and is explicitly partial. It cannot prove missing control edges or whole-function safety. The following constraint is source-verified instead: allTexts/allUpdates are prepared before stale-row deletion at920. Source verification must fail before that batch's deletion, retaining existing checkpoint/retry behavior.

The earlier plan's “PDG unavailable” claim is superseded by this bounded complete data slice and partial control evidence. No whole-file PDG safety claim is made.

## 6. Proposed Changes

These are implementation decisions. Existing WIP is retained where the tests support it; the source seam below is new and unimplemented.

### A. Retain the validated layout behavior

Keep environment → explicit config → default precedence for GITNEXUS_EMBEDDING_CHUNK_SIZE, GITNEXUS_EMBEDDING_CHUNK_OVERLAP and GITNEXUS_EMBEDDING_CHUNK_STRATEGY. Blank means unset; size is a safe integer≥2, overlap is0≤overlap<size, strategy ast/fixed. Defaults remain1200/120/ast. Resolve once per run. Fixed callable mode does not parse; Class structural exclusion applies to both strategies.

Keep Class header/field projection, compact names, no raw method/constructor/body fallback, and one transient parsed tree per changed Class. An unavailable/ambiguous parser yields metadata-only Class input. Preserve Interface/Struct behavior. Keep nested compound refinement, complete text coverage, bounded overlap and atomic character fallback. The latest overlap reservation reduces the measured nested fixture from6 inputs to5, but its CPU cost still needs final assessment.

### B. Add a private verified original-source reader

Proposed new source-reader.ts owns one bounded per-run reader; no dependency or schema change. Pipeline options carry repository root, indexed file fingerprints and retention. Source eligibility is Class plus potentially split/truncated non-short nodes: compare persisted content with the effective/default layout thresholds, and recognize the existing truncation marker regardless of an explicitly larger chunk budget. A normalized complete short callable retains existing text/hash behavior. Class and long callable defaults are the primary acceptance surface.

Do not instantiate/read the source cache on embeddings-disabled analyze. Compute cache keys from already-supplied metadata and filter fresh nodes first. Only stale/new eligible nodes read source. Cache both positive and failed lookup results within explicit entry and byte bounds; bypass oversized entries instead of retaining an entire large repository. Keep AST lifetime per node. The cache must be measured on many-symbol same-file and very-large-file cases, not justified by a count-only bound.

Validate repo-relative paths and resolved containment, reject escaping symlinks, read a buffer once, and verify its raw SHA256 against the indexed map before decoding it. Do not accept path text or modification time as proof of source identity. Use exact zero-based inclusive symbol lines; preserve indentation, Unicode and CRLF semantics. No extra full-repository scan or new whole-repository hash pass.

For full retention, eligible nodes with missing indexed fingerprints, missing files, out-of-range spans or fingerprint mismatch must stop that embedding batch with an actionable analyze/reindex error **before its stale rows are deleted**. Do not silently substitute current checkout text or flattened content and report full fidelity. Existing indexes without fingerprints upgrade through analyze. Low-level direct callers without a source context remain compatible and can operate on already-original snippets as tests do.

For symbol/none retention, never hydrate checkout content. Preserve the existing retained-content/metadata behavior, with conservative parent ranges where precise subchunk positions cannot be proved; document the reduced-source limitation rather than claiming complete tails. Full-source availability is part of the scoped policy identity so a later full-retention run cannot reuse degraded affected chunks. None retention must not become a path for source disclosure.

For notebooks, reuse notebookPythonSnippet rather than embedding JSON syntax. Its Python output lines are not linear JSON line offsets: either map through existing extraction segments or retain the original enclosing JSON symbol range. Do not invent precise JSON subranges by adding Python line offsets. This is a compatibility guard, not a new notebook provider.

Line-only graph spans can contain sibling declarations. Select the matching declaration where identity can be proved from AST name/range; do not blindly project the first sibling. If Class selection is ambiguous, use metadata-only fallback. Preserve bounded callable fallback and honest enclosing ranges. Do not add a column schema migration.

### C. Bind source identity without destroying the fresh fast path

Extend the scoped layout hash for source-eligible nodes with a source-layout revision, indexed file fingerprint, original start/end range and source mode/retention. Keep it synchronous and read/parse-free. This catches tail edits beyond5000, source relocation and source-mode transitions before the fresh filter. Include effective chunk policy even when restored source is long but the stored snippet fits an explicitly larger budget. Preserve baseline v7 hashes for unaffected unsplit short nodes.

Compute and retain the authoritative hash from persisted node identity plus indexed metadata **before hydration**; use that same hash for every inserted chunk. Hydrated content and structural names are transient rendering inputs, never a second hash definition. New and stale nodes must follow the same convention. Test default→fixed→default and grow→shrink transitions so no old high chunkIndex survives.

The file-level fingerprint conservatively invalidates affected Class/long siblings after any file edit. This avoids source reads on fresh nodes but may add changed-file inference work. Measure it. A regression is a blocker; do not widen invalidation to every short symbol or claim a cache win merely because the comparison is cheap.

### D. Wire all production callers and non-git metadata

Analyze passes repoPath, the already-computed newFileHashes and effective retention. Persist that existing map for non-git repositories as well so later sync/server runs can validate the same source snapshot. Retain the separate repoHasGit incremental-write gate and existing status git gate. Do not introduce another hash map field or duplicate source content in metadata. Verify metadata size/time under the disabled-embeddings cohort.

Sync passes repoPath and loaded meta.fileHashes/retention. Server passes **entry.path**, never storagePath/job.repoPath, and embeddingMeta fingerprints/retention. Preserve index locks, private shared-store graph handling, cancellation, checkpoint windows, whole-node inference failure cleanup, WAL flushing and final outcome publication. Existing source preparation occurs before per-batch stale deletion; keep that ordering.

### E. Keep full-text search and query behavior stable

Leave CSV whitespace normalization, CJK segmentation, its5000-character cap, graph schema and vector identity untouched. Correct the text/ranges at embedding preparation/write time. Keep the existing best-chunk selection and unique-parent search contract. Add an FTS smoke assertion alongside source-aware semantic search to prove the fix did not move the original bug into keyword search.

## 7. Implementation Sequence

1. **Completed setup; retain WIP.** Original plan is committed as802e6f292. Dependencies and current analyzer build/index are usable. Config, class projection, nested refinement, scoped layout hashes and194 focused tests exist as uncommitted changes. No implementation step is landed at HEAD; do not redo or discard this work. Read/re-anchor this revised plan before resuming.
2. **Lock source regressions first.** Clean the failing lifecycle diagnostic and fix its zero-based expectation. Add a tail beyond5000, Python indentation, relocation/tail-only edit, unchanged rerun and alternate storage root. Keep a real failing proof against the current WIP; fake-parser tests are insufficient.
3. **Implement source context, scoped hashing and callers as one coherent behavior.** Add the bounded reader and three caller integrations together, including non-git metadata, retention and validation failure behavior. Run impact before edits to existing symbols; keep source reads below freshness and before batch deletion. Add targeted reader/caller/pipeline tests.
4. **Finish AST/source edge cases.** Validate class fields after excluded methods, same-line declaration selection, CRLF/Unicode, notebooks, giant atoms and overlap. Preserve one Class parse and no parse for short/fixed callables. Resolve failures without expanding language-specific shared ingestion logic.
5. **Prove lifecycle and performance before implementation commits.** Run native persistence/search and restart/recovery checks, final paired benchmarks, typechecks, lint/format, test-dupe check and full npm test. Use the working /tmp native environment only with an explicit candidate byte manifest. A regression or unexplained failure remains open, not a passing result.
6. **Commit verified units, document and review.** Split staged changes into coherent atomic commits only after required checks and matching-backend detect_changes. The source seam, policy invalidation and caller support must not be committed in mutually broken intermediate states. Update RUNBOOK with actual final behavior and measured refresh cost. Refresh final graph and invoke gitnexus-review on the final branch, with local separately if any work remains. No push/PR is implied by LFG.

## 8. Test Strategy

### Required functional scenarios

- **gitnexus/test/unit/embedding-config.test.ts** — Unset/blank → 1200/120/ast; env overrides partial config; 500/50/fixed works; invalid effective integers, overlap or strategy fail before work.
- **gitnexus/test/integration/ast-embedding-chunking.test.ts** — Real TypeScript/Python/Java/Objective-C class projection retains header and fields, excludes method/constructor/lambda bodies, preserves separate Method text. Short and fixed callables perform no parse; changed Class uses one shared parse. Nested compounds preserve fitting statements, branch syntax and full tail with bounded overlap; irreducible atoms use bounded character fallback. CRLF, Unicode, nested classes, declarations sharing a line, field accessors and parser failure have explicit safe behavior.
- **gitnexus/test/unit/embedding-source-reader.test.ts** — Matching SHA256 and contained path → exact original zero-based inclusive symbol lines; missing/mismatching/escaping input → explicit unavailable/error, never unverified source. One file read per resident cache entry; byte and entry bounds, large-file bypass and cleanup; no unbounded source/AST cache. No source I/O under retention none/symbol; notebook extraction uses its established mapping and conservative original JSON ranges.
- **gitnexus/test/unit/embedding-pipeline.test.ts** — Unchanged source-aware hash → zero reader, parser and inference calls; unchanged short default hash remains baseline v7. Tail-only edit beyond 5000, relocation, mode/size/overlap changes, grow/shrink and source capability changes invalidate affected rows. Class preparation uses one tree; hashing remains synchronous and parse/read-free. Source validation failure happens before that batch stale-row DELETE and keeps resumable checkpoint state; existing inference/cancellation/partial-node behavior remains intact.
- **gitnexus/test/integration/embedding-chunking-lifecycle.test.ts** — Fresh analyze → persist searchable tail beyond 5000 and correct nonzero winning range; FTS still finds normal tokens. Python indentation survives; Class fields after a long method survive while body sentinel exists only in Method inputs. Unchanged rerun → no reader/parser/inference; fixed→ast round trip, relocate, tail-only edit, shrink/delete, close/reopen all match clean rebuild. Git and non-git repositories; alternate storage path differs from checkout; old metadata/missing checkout has explicit limited/error behavior.
- **gitnexus/test/unit/embeddings-sync-command.test.ts** — Sync forwards indexed fingerprint/root/retention and preserves locks/checkpoint/outcome behavior.
- **gitnexus/test/unit/server-embed.test.ts** — Use existing server embed harness if present; POST /api/embed supplies entry.path rather than storagePath, respects retention and reports validation failure without successful completion.
- **gitnexus/test/unit/semantic-chunk-search.test.ts** — Unique parent pagination and winning chunk source range survive both vector-index and exact-scan search.
- **gitnexus/test/integration/embedding-identity-integrity.test.ts** — Chunk/source layout does not change model/dimension/provider identity or lose preserved compatible vectors.
- **gitnexus/test/integration/embedding-chunking-benchmark.test.ts** — Paired short, flat, nested, class-heavy, very-large and mixed cohorts; fresh/no-change/changed/disabled runs and equal-vector query benchmark; local real model plus orchestration/native DB measurements.

Use real installed TypeScript/JavaScript/Python parsers and the existing Java/Objective-C fixtures; add Rust/constructor coverage if the shared traversal affects it. Optional grammar absence is unverified coverage, not a pass. No provider parse/resolution change is proposed; consult the Objective-C provider guide before any such expansion.

### Performance gate (unchanged)

Identical runtime/dependencies, corpus, model/provider, hardware, ordering and default config; warmups then at least15 paired serial samples, alternating baseline/candidate. Report median andp95 wall time, peak RSS/heap, parser/source-reader calls, input characters/vectors and inference/API requests. Separate cold start, first affected-vector refresh, steady-state and changed-file runs. Include short, flat-long, nested, method-heavy Class, very-large and mixed repositories; embeddings-disabled analyze, unchanged reruns and equal-vector-count semantic queries.

Require **no reproducible default-mode slowdown in any required cohort**, no unexplained memory growth, no parsing or source I/O for unchanged nodes, no new short-callable parse, one Class parse, and no added source preparation on disabled embeddings. Unaffected short vectors/requests remain identical; method-heavy Class vectors cannot increase. Do not average a regression away with Class gains or grant an arbitrary percentage allowance. Explicit smaller user-selected chunk sizes are a separately reported workload.

Full source beyond the old5000-character cap adds useful coverage absent from baseline; it may also add vectors. Report both coverage and work honestly. An equal-coverage algorithm benchmark helps diagnose overhead but does not replace the requested baseline end-to-end comparison. If complete coverage cannot meet the no-regression gate, report that conflict and return to the user; this plan does not authorize weakening either requirement.

Use a deterministic local HTTP fixture for orchestration/DB behavior and the installed Snowflake/snowflake-arctic-embed-xs model for CPU inference. No paid service or credential use is needed. Promote the reproducible benchmark into the existing opt-in runner; raw artifacts stay outside source.

### Evidence already obtained

- Latest focused command: **7 files /194 tests passed**,14.32s. Baseline config tests showed17 new failures before implementation. Production/test typechecks passed before the final overlap-only edit; final checks remain required.
- Native lifecycle: actual range failure on flattened persisted content. Workspace worker readiness timeouts are separate; the same candidate replica in /tmp runs the lifecycle in about16s and reaches that assertion. No full-suite passing receipt.
- Exploratory real-model benchmark,16 paired samples, CPU2 threads, candidate current build: short inference median12.41→12.22ms; flat823.04→830.72ms (p95866.26→962.81ms); nested1683.51→1380.32ms,6→5 inputs,6045→5705 chars; Class1319.49→38.93ms,5→1 inputs; query4.85→4.79ms. These are four-node inference samples and an exact-scan query fixture, **not full-analyze results**. Nested preparation median140.57→154.83ms per200 preparations remains a concern. RSS observations are not peak-memory proof. Hydration is not yet implemented.

### Commands

- `cd gitnexus && npm test -- test/unit/chunker.test.ts test/unit/embedding-chunking.test.ts test/unit/text-generator.test.ts test/unit/embedding-config.test.ts test/unit/embedding-pipeline.test.ts test/unit/semantic-chunk-search.test.ts test/integration/ast-embedding-chunking.test.ts`
- `cd gitnexus && npm run test:integration -- test/integration/embedding-chunking-lifecycle.test.ts test/integration/embedding-identity-integrity.test.ts`
- `cd gitnexus && npm run test:benchmarks`
- `cd gitnexus && npx tsc --noEmit`
- `cd gitnexus && npm run typecheck:tests`
- `cd gitnexus && npm run test:dupes`
- `cd gitnexus && npm test`
- `Changed-file ESLint and Prettier checks using existing configuration; targeted new reader/caller test files after creation.`
- `Before each commit use matching local backend detect_changes scope all; rerun incomplete/truncated results. Complete npm test before commit per repository instructions.`

Scripts are verified in gitnexus/package.json; integration carries a pre-build hook. Work owns those builds. Do not overlap a build/index refresh with native lifecycle analysis because runner provenance correctly rejects a changing runtime.

## 9. Risk and Impact Analysis

- CRITICAL pipeline/analyzer changes affect analyze/watch, sync, server embedding and recovery; do not broaden storage mutation semantics.
- Source data is flattened/capped before the current embedding path; direct chunker tests alone cannot prove complete source or line fidelity.
- File fingerprint invalidation is conservative for affected long/Class siblings in an edited file; measure changed-file work and optimize only with evidence.
- Full tails beyond the legacy 5000-character cap may require more inference work than the incomplete baseline. Do not hide this behind class savings or claim parity without end-to-end evidence.
- Latest flat inference p95 is slower and nested preparation CPU is higher; end-to-end improvements do not waive per-cohort investigation.
- Existing graph stores line spans, not exact columns. Same-line declarations and notebook coordinate mapping need explicit selection/conservative-range tests.
- The HTTP callback has UNKNOWN upstream graph risk; its POST /api/embed registration is source-confirmed.
- Native tests time out under the workspace filesystem; /tmp validation replica runs them. Final evidence must prove identical candidate bytes and report environmental failures separately.

Read-only/source-preparation failures must not become vector loss. Keep old rows until the prepared batch is ready; preserve pending-node recovery. The HTTP boundary must use registered source root and containment, not a path taken directly from graph text. No schema migration, new external service or dependency is proposed.

## 10. Files Expected to Change

- `gitnexus/src/core/embeddings/config.ts` — Retain existing WIP effective-value validation and defaults.
- `gitnexus/src/core/embeddings/types.ts` — Retain WIP strategy/projection types; add only minimal source preparation types if needed.
- `gitnexus/src/core/embeddings/chunker.ts` — Retain WIP class projection and nested refinement; finish original-source/name/range coverage and overlap invariants.
- `gitnexus/src/core/embeddings/structural-extractor.ts` — Retain one-tree class reuse; align declaration selection when a line contains siblings.
- `gitnexus/src/core/embeddings/text-generator.ts` — Retain trusted class projection and no raw-body/context fallback.
- `gitnexus/src/core/embeddings/embedding-pipeline.ts` — Bind source-aware hash before hydration, then lazily prepare stale/new nodes from original source; preserve checkpoint/deletion/inference ordering.
- `gitnexus/src/core/embeddings/source-reader.ts` — NEW proposed private bounded reader: containment, fingerprint verification, original symbol spans and explicit unavailable/mismatch handling.
- `gitnexus/src/core/run-analyze.ts` — Pass repo root, current file hashes and retention to embedding pipeline; persist already-computed file hashes for non-git repositories without enabling incremental DB mode.
- `gitnexus/src/cli/embeddings-sync.ts` — Pass repoPath plus loaded indexed source fingerprints and retention through the common options.
- `gitnexus/src/server/api.ts` — Pass entry.path, embeddingMeta.fileHashes and retention; keep source root distinct from storagePath and preserve locks/outcome handling.
- `gitnexus/test/unit/embedding-config.test.ts` — Keep validated policy regression scenarios.
- `gitnexus/test/unit/chunker.test.ts` — Finish boundary, class projection, overlap, source span and fallback scenarios.
- `gitnexus/test/unit/embedding-chunking.test.ts` — Keep final text no-body/no-context-leak coverage.
- `gitnexus/test/unit/text-generator.test.ts` — Keep projection trust marker, unchanged non-Class and short input behavior.
- `gitnexus/test/unit/embedding-pipeline.test.ts` — Extend source identity/fresh skip/tail edit/relocation/retention/recovery tests.
- `gitnexus/test/unit/embedding-source-reader.test.ts` — NEW proposed reader tests for verified source, missing hashes/files, mismatch, path containment, bounded cache and line handling.
- `gitnexus/test/integration/ast-embedding-chunking.test.ts` — Keep real grammar cases; add only discriminating missing language/range cases.
- `gitnexus/test/integration/embedding-chunking-lifecycle.test.ts` — Complete actual analyze/storage/search lifecycle; fix diagnostic test to use zero-based source lines.
- `gitnexus/test/unit/embeddings-sync-command.test.ts` — Verify indexed metadata/root forwarded; missing source does not overwrite valid vectors.
- `gitnexus/test/unit/server-embed.test.ts` — Proposed file if no existing endpoint harness covers this: root/retention/fingerprint forwarding and error preservation. Prefer the existing endpoint test file when found.
- `gitnexus/test/integration/embedding-chunking-benchmark.test.ts` — NEW proposed opt-in serial paired benchmark under existing benchmark runner.
- `RUNBOOK.md` — Document env configuration, unchanged defaults, scoped refresh cost and explicit source-unavailable behavior.

Read-only evidence/reuse: csv-generator.ts, file-hash.ts, repo-meta.ts, index-content-drift.ts, status.ts, ipynb-extractor.ts, ast-utils.ts and schema.ts. Editing a reused helper still requires fresh impact and a justified minimal diff. New test filenames above are proposals; use existing equivalent harnesses when present.

## 11. Reusable Implementation Context

The manifest pins the **worktree** bytes as well as HEAD/index layers.22 of the original33 cited paths are byte-identical to the old receipt;11 changed implementation/test paths were re-anchored to current WIP evidence and old current-behavior line claims were replaced. Eight newly cited paths capture the source seam and actual lifecycle tests. The prior plan remains recoverable through the guarded writer's durable backup receipt.

```json
{
  "implementation_context": {
    "task_summary": "Complete issue #702 on the existing chunk pipeline; no measured default-mode performance degradation. Deepen 1 adds an embedding-only original-source seam after an actual storage/search test disproved the original chunker-only assumption.",
    "acceptance_criteria": [
      "Validated chunk-size, overlap, and ast/fixed env configuration; retain 1200/120 defaults.",
      "Preserve long callable tails and fitting statement boundaries; explicitly bound oversized-atom fallback.",
      "Class inputs contain declaration/fields and compact names, without method bodies; Method inputs retain body searchability.",
      "Correct source ranges and unique-parent best-chunk search remain intact.",
      "Config changes and content shrink clean stale chunks; unchanged nodes skip AST and inference work.",
      "Preserve unaffected short-node text and baseline v7 hashes.",
      "Passing functional/type/integration checks and paired runtime/RSS/query benchmarks are required before completion.",
      "Default full-retention embedding runs use fingerprint-verified original source for Class and split/truncated nodes, preserving indentation and tails beyond the FTS snippet cap.",
      "Analyze, embeddings sync, and POST /api/embed use the same source, hashing, retention and failure contract; no source reads on unchanged nodes or embeddings-disabled runs.",
      "FTS normalization, database schema, vector-space identity and search query structure remain unchanged."
    ],
    "evidence_provenance": {
      "schema_version": 2,
      "head_commit": "802e6f292aa9faf24ac38c5d395eff0f2d71d93a",
      "generated_plan_path": "docs/plans/2026-11-03-gitnexus-plan-ast-embedding-chunking-performance.md",
      "global_dirty_digest": {
        "algorithm": "sha256",
        "canonicalization": "gitnexus-evidence-provenance-v2 NUL-framed UTF-8 records",
        "value": "eb1d7761939caba494c72af78ef00913af4b74fcfe45f76aa5c6958c457b7e77"
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
          "path": "TESTING.md",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:24f21e043e83552c5a88ff7d6bfdafcad2cc2cd0d10cfb0e0edab2d04d76d6ea",
          "index_digest": "sha256:24f21e043e83552c5a88ff7d6bfdafcad2cc2cd0d10cfb0e0edab2d04d76d6ea",
          "worktree_digest": "sha256:24f21e043e83552c5a88ff7d6bfdafcad2cc2cd0d10cfb0e0edab2d04d76d6ea",
          "untracked_digest": "absent"
        },
        {
          "path": "docs/languages/objective-c-provider.md",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:a441af807004f2dd2922e1daef0fbb7c76b5223d5dcce6d237a92d2f49eed2c9",
          "index_digest": "sha256:a441af807004f2dd2922e1daef0fbb7c76b5223d5dcce6d237a92d2f49eed2c9",
          "worktree_digest": "sha256:a441af807004f2dd2922e1daef0fbb7c76b5223d5dcce6d237a92d2f49eed2c9",
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
          "path": "gitnexus/scripts/run-benchmarks.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:ff30312600bad21e28c8c530f7f0c79367c6f4c7157404bc144a1607178a9c04",
          "index_digest": "sha256:ff30312600bad21e28c8c530f7f0c79367c6f4c7157404bc144a1607178a9c04",
          "worktree_digest": "sha256:ff30312600bad21e28c8c530f7f0c79367c6f4c7157404bc144a1607178a9c04",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/cli/doctor.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:fe2714f44a25bbaff7f8ca1f9a7449d03064f6408da4940c4a903af0fc158c9a",
          "index_digest": "sha256:fe2714f44a25bbaff7f8ca1f9a7449d03064f6408da4940c4a903af0fc158c9a",
          "worktree_digest": "sha256:fe2714f44a25bbaff7f8ca1f9a7449d03064f6408da4940c4a903af0fc158c9a",
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
          "path": "gitnexus/src/core/embeddings/ast-utils.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:72b7e3b40299262ba072051ab2c2563bb4c48e05f66f16dcdece86c85fbfc6c0",
          "index_digest": "sha256:72b7e3b40299262ba072051ab2c2563bb4c48e05f66f16dcdece86c85fbfc6c0",
          "worktree_digest": "sha256:72b7e3b40299262ba072051ab2c2563bb4c48e05f66f16dcdece86c85fbfc6c0",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/embeddings/character-chunk.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:00b3112296ff1a649c0beceaba0b8bc837167b68842cae233287197ba2d0b799",
          "index_digest": "sha256:00b3112296ff1a649c0beceaba0b8bc837167b68842cae233287197ba2d0b799",
          "worktree_digest": "sha256:00b3112296ff1a649c0beceaba0b8bc837167b68842cae233287197ba2d0b799",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/embeddings/chunker.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "unstaged",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:9c4d44fb03c89a1bc4fdea60b4196463aca225b979fe6c21730fdc267047d0a1",
          "index_digest": "sha256:9c4d44fb03c89a1bc4fdea60b4196463aca225b979fe6c21730fdc267047d0a1",
          "worktree_digest": "sha256:1afdb44e23c52841be665a5447ee5d8d39bd4e44d6f16d74dd36abab5eb13652",
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
          "state": "unstaged",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:7ba8ae915a989c161ca262dc3d3501dc0d33b3c6085159a829a08db572256de3",
          "index_digest": "sha256:7ba8ae915a989c161ca262dc3d3501dc0d33b3c6085159a829a08db572256de3",
          "worktree_digest": "sha256:0dd2de80fd988249e4291dfec8eebac8b2f9291a059984879af48ddfccb6aabe",
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
          "path": "gitnexus/src/core/embeddings/embedding-local-init.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:3c432f6e1ea9781744f31798f81d253331f3d1e693549b45490823fee65eda27",
          "index_digest": "sha256:3c432f6e1ea9781744f31798f81d253331f3d1e693549b45490823fee65eda27",
          "worktree_digest": "sha256:3c432f6e1ea9781744f31798f81d253331f3d1e693549b45490823fee65eda27",
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
          "state": "unstaged",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:a680386f29e36826df87f09ddcd34042841e24059e7737806f5b31c944b3706c",
          "index_digest": "sha256:a680386f29e36826df87f09ddcd34042841e24059e7737806f5b31c944b3706c",
          "worktree_digest": "sha256:345174b559c0f8a245684bc36181e71e13428633e084e3387a8203740853c23e",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/embeddings/line-index.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:e0470c50761f5825c578876525ca9fcc1e824056317b35900088d159e7578d8f",
          "index_digest": "sha256:e0470c50761f5825c578876525ca9fcc1e824056317b35900088d159e7578d8f",
          "worktree_digest": "sha256:e0470c50761f5825c578876525ca9fcc1e824056317b35900088d159e7578d8f",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/embeddings/structural-extractor.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "unstaged",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:c97cd2e5e16b4dc6714b02a7a76044c5ca69c47a73b4ae24959acb295c0b52ba",
          "index_digest": "sha256:c97cd2e5e16b4dc6714b02a7a76044c5ca69c47a73b4ae24959acb295c0b52ba",
          "worktree_digest": "sha256:31f22d4df2bfa6cd217efc0f2108865aa5f2f0301070d4525fe66b2dc78c468a",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/embeddings/text-generator.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "unstaged",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:ea2b0fedb80e447a27ea0362a2b81fa1e6a96198f01737f9c68a5ff34fea1ea0",
          "index_digest": "sha256:ea2b0fedb80e447a27ea0362a2b81fa1e6a96198f01737f9c68a5ff34fea1ea0",
          "worktree_digest": "sha256:1f197ffaf647548863f22fe3e3807ebbbe7c4ac5e5f63d8bc797e6a73a26ba95",
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
          "state": "unstaged",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:fd2269f5aa16cf736e1f0d0a3d458f1585a1aeaf226a9a5ec236ef4bc2064381",
          "index_digest": "sha256:fd2269f5aa16cf736e1f0d0a3d458f1585a1aeaf226a9a5ec236ef4bc2064381",
          "worktree_digest": "sha256:9af6c191cfbfe6659916dfa1551ac592597608575bef069c68a97744f024fb1a",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/index-content-drift.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:8c1897ef5aaa79c81b121edc9d0863efba4b2d57a207b12a12012f0ddaa121cd",
          "index_digest": "sha256:8c1897ef5aaa79c81b121edc9d0863efba4b2d57a207b12a12012f0ddaa121cd",
          "worktree_digest": "sha256:8c1897ef5aaa79c81b121edc9d0863efba4b2d57a207b12a12012f0ddaa121cd",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/ingestion/ipynb-extractor.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:e96683cfa4786fa1b612c208398dca3f39fc5d07a24094c4e5a49f1347d72a8a",
          "index_digest": "sha256:e96683cfa4786fa1b612c208398dca3f39fc5d07a24094c4e5a49f1347d72a8a",
          "worktree_digest": "sha256:e96683cfa4786fa1b612c208398dca3f39fc5d07a24094c4e5a49f1347d72a8a",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/ingestion/method-types.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:be35ac1c4c93e1854511301ffe37e0848190c3cd918c1f145dbd3b705a229aa1",
          "index_digest": "sha256:be35ac1c4c93e1854511301ffe37e0848190c3cd918c1f145dbd3b705a229aa1",
          "worktree_digest": "sha256:be35ac1c4c93e1854511301ffe37e0848190c3cd918c1f145dbd3b705a229aa1",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/lbug/csv-generator.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:3a8405f63ae7f91e0cb4188aa72d1a135b4c73d4947e42a88dc0abf30e9a506c",
          "index_digest": "sha256:3a8405f63ae7f91e0cb4188aa72d1a135b4c73d4947e42a88dc0abf30e9a506c",
          "worktree_digest": "sha256:3a8405f63ae7f91e0cb4188aa72d1a135b4c73d4947e42a88dc0abf30e9a506c",
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
          "path": "gitnexus/src/storage/file-hash.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:f4d55be1b172f37116673dd6ded0cb0dc47c6820033f47a7e9b1a0c34c994565",
          "index_digest": "sha256:f4d55be1b172f37116673dd6ded0cb0dc47c6820033f47a7e9b1a0c34c994565",
          "worktree_digest": "sha256:f4d55be1b172f37116673dd6ded0cb0dc47c6820033f47a7e9b1a0c34c994565",
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
          "path": "gitnexus/test/integration/ast-embedding-chunking.test.ts",
          "object_kind": {
            "head": "absent",
            "index": "absent",
            "worktree": "absent",
            "untracked": "regular"
          },
          "state": "untracked",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "absent",
          "index_digest": "absent",
          "worktree_digest": "absent",
          "untracked_digest": "sha256:68887f61ff4d48d20f3f40d01d7f0b65b94ab844e1071344616338639f1c37e1"
        },
        {
          "path": "gitnexus/test/integration/embedding-chunking-lifecycle.test.ts",
          "object_kind": {
            "head": "absent",
            "index": "absent",
            "worktree": "absent",
            "untracked": "regular"
          },
          "state": "untracked",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "absent",
          "index_digest": "absent",
          "worktree_digest": "absent",
          "untracked_digest": "sha256:72b1e4dab2b4933dbe9bdccfe1131c206721d9be67036248fbc7bdbd6d3145c0"
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
          "path": "gitnexus/test/unit/chunker.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "unstaged",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:6da377bc78dbc9635339cac86c87f32d354ded9335e9d4fb8500c12b5dfcbdec",
          "index_digest": "sha256:6da377bc78dbc9635339cac86c87f32d354ded9335e9d4fb8500c12b5dfcbdec",
          "worktree_digest": "sha256:71167806be55f852f39684b3ffe1542c64bcdbad977863948dbbe35d2f1b7d2d",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/unit/embedding-chunking.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "unstaged",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:e3c7baa49817b29f541b727fa9d4953e95e8f0ddc577f83621f4ce9ea4904733",
          "index_digest": "sha256:e3c7baa49817b29f541b727fa9d4953e95e8f0ddc577f83621f4ce9ea4904733",
          "worktree_digest": "sha256:0a87d0fa2d8fad908da01b8a6e973f064796e3a52763bc20f70d871934e9a947",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/unit/embedding-config.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "unstaged",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:a0151cd57d6a816720e6de4495ac3ba766f81334afc8d6043f24f663446c9814",
          "index_digest": "sha256:a0151cd57d6a816720e6de4495ac3ba766f81334afc8d6043f24f663446c9814",
          "worktree_digest": "sha256:0a286c5b4cb1a28e439454fc12cfd455be0a5cbf02286f12200bc2983ddd3be8",
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
          "state": "unstaged",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:eb8cd73dffebecbcb68033ed1b7b884ec0fa077f8023ca83066a50d83a053955",
          "index_digest": "sha256:eb8cd73dffebecbcb68033ed1b7b884ec0fa077f8023ca83066a50d83a053955",
          "worktree_digest": "sha256:883c88c218fbe8fcf7882ce66f504c004e41397299c4bb98b6df03b2124e3d6f",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/unit/semantic-chunk-search.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:b2d4ff910f23ee6cd5276785f3a97b34c7bdb136b3dc3b51c4e4c8c0483a8dad",
          "index_digest": "sha256:b2d4ff910f23ee6cd5276785f3a97b34c7bdb136b3dc3b51c4e4c8c0483a8dad",
          "worktree_digest": "sha256:b2d4ff910f23ee6cd5276785f3a97b34c7bdb136b3dc3b51c4e4c8c0483a8dad",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/unit/text-generator.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "unstaged",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:07bcc19b275c744d36f126d9d244bab242eb6ea3d4afca877eeeac8a789957c4",
          "index_digest": "sha256:07bcc19b275c744d36f126d9d244bab242eb6ea3d4afca877eeeac8a789957c4",
          "worktree_digest": "sha256:29b729c1e2bc936107dbcb3c1b084462624386e1fc21656dc77b5558a0d3e078",
          "untracked_digest": "absent"
        }
      ]
    },
    "primary_symbols": [
      {
        "symbol": "chunkNode",
        "file": "gitnexus/src/core/embeddings/chunker.ts",
        "lines": "46-122;228-306;583-733",
        "role": "Current WIP dispatch, nested refinement, projected source mapping"
      },
      {
        "symbol": "resolveEmbeddingConfig",
        "file": "gitnexus/src/core/embeddings/config.ts",
        "lines": "74-133",
        "role": "Current validated strategy and chunk budgets"
      },
      {
        "symbol": "contentHashForNode",
        "file": "gitnexus/src/core/embeddings/embedding-pipeline.ts",
        "lines": "98-146",
        "role": "Parse-free layout/source freshness key; preserve unaffected v7 hashes"
      },
      {
        "symbol": "runEmbeddingPipeline",
        "file": "gitnexus/src/core/embeddings/embedding-pipeline.ts",
        "lines": "613-925",
        "role": "Source preparation after freshness and before batch deletion; one Class parse"
      },
      {
        "symbol": "runFullAnalysisInner",
        "file": "gitnexus/src/core/run-analyze.ts",
        "lines": "3152-3195;4977-5010;5392",
        "role": "Supply already-computed source fingerprints and persist non-git map"
      }
    ],
    "related_symbols": [
      {
        "symbol": "embeddingsSyncCommand",
        "relationship": "CALLS runEmbeddingPipeline",
        "relevance": "Source repoPath and indexed meta available; options at line211"
      },
      {
        "symbol": "createServer POST /api/embed callback",
        "relationship": "CALLS runEmbeddingPipeline",
        "relevance": "UNKNOWN upstream but public route verified; root entry.path and storagePath differ"
      },
      {
        "symbol": "extractContent / normalizeFtsText",
        "relationship": "source preparation before graph persistence",
        "relevance": "FTS flattening and 5000-character cap must remain unchanged"
      },
      {
        "symbol": "extractStructuralNames",
        "relationship": "CALLS ensureAndParse only without supplied tree",
        "relevance": "Retain class parse reuse and matching declaration selection"
      },
      {
        "symbol": "generateStructuralTypeText",
        "relationship": "called by generateEmbeddingText",
        "relevance": "Only trusted projected Class input; no body/prevTail fallback"
      },
      {
        "symbol": "ensureAndParse / findDeclarationNode / findFunctionNode",
        "relationship": "AST utilities",
        "relevance": "Current first-declaration selection needs same-line target verification; impact before any utility edit"
      },
      {
        "symbol": "notebookPythonSnippet",
        "relationship": "called by CSV extractContent",
        "relevance": "Reconstructs Python from JSON line envelope; output subchunk coordinates are not linear JSON offsets"
      },
      {
        "symbol": "computeFileHashes / computeFileHash",
        "relationship": "called by analyze",
        "relevance": "Existing raw-buffer SHA256 convention; do not add a second all-files hashing pass"
      },
      {
        "symbol": "detectIndexContentDrift / statusCommand",
        "relationship": "READS meta.fileHashes",
        "relevance": "Non-git metadata change must retain existing explicit git gates"
      },
      {
        "symbol": "collectBestChunks / semanticSearch",
        "relationship": "reads CodeEmbedding range and identity",
        "relevance": "Do not rewrite search; correct rows at write time"
      },
      {
        "symbol": "resolveEmbeddingIdentity / initLocalEmbedder / doctorCommand",
        "relationship": "CALLS resolveEmbeddingConfig",
        "relevance": "Direct config consumers retain valid defaults and deterministic errors"
      }
    ],
    "execution_path": [
      "Analyze computes source hashes already; sync/server load indexed hashes. Supply root/retention/fingerprints through one optional internal pipeline source context.",
      "Read graph nodes and compute source-aware layout hashes synchronously from persisted content, indexed fingerprint and range; filter unchanged nodes before any source reads or parsing.",
      "For stale/new eligible nodes, read one fingerprint-verified source buffer per bounded resident cache entry; derive original symbol text while retaining persisted identity/hash separately.",
      "Parse changed Class once and share tree for names/projection; AST split long callables or fixed/atomic fallback; preserve zero-based original range envelopes.",
      "Prepare complete batch, then retain existing stale DELETE, bounded inference, insert, failure cleanup and checkpoint ordering.",
      "Search returns winning persisted chunk range through existing vector/exact paths."
    ],
    "pdg_constraints": [
      {
        "description": "Complete nodes REACHING_DEF slice has 10 edges in runEmbeddingPipeline: fetched nodes at634 flow to filter693 and batch821; filtered nodes at693 flow to checkpoint811 and batch821.",
        "affected_statements": [
          "gitnexus/src/core/embeddings/embedding-pipeline.ts:634",
          "gitnexus/src/core/embeddings/embedding-pipeline.ts:693",
          "gitnexus/src/core/embeddings/embedding-pipeline.ts:811",
          "gitnexus/src/core/embeddings/embedding-pipeline.ts:821"
        ],
        "implementation_consequence": "Hydrate inside the filtered batch path; do not move file reads into queryEmbeddableNodes or the synchronous freshness filter."
      },
      {
        "description": "Source-verified batch preparation precedes deleteStaleEmbeddingRows at920; existing checkpoint window begins at811.",
        "affected_statements": [
          "gitnexus/src/core/embeddings/embedding-pipeline.ts:811",
          "gitnexus/src/core/embeddings/embedding-pipeline.ts:833",
          "gitnexus/src/core/embeddings/embedding-pipeline.ts:920"
        ],
        "implementation_consequence": "Source validation errors must occur before deletion of that batch and leave existing checkpoint/retry semantics intact. This ordering is source-derived, not asserted as a complete CDG proof."
      }
    ],
    "pdg_status": "Layer now present. Complete variable=nodes flow slice total10; file-level controls result total861 was truncated50 and is only partial supporting evidence. No absent-edge conclusions.",
    "architectural_patterns": [
      {
        "pattern": "Original source separate from FTS text",
        "example_location": "gitnexus/src/core/lbug/csv-generator.ts:281-351",
        "usage_guidance": "Keep normalized persisted text untouched; introduce a private embedding reader rather than a schema/FTS change."
      },
      {
        "pattern": "Use indexed SHA256 identity",
        "example_location": "gitnexus/src/storage/file-hash.ts:29-35",
        "usage_guidance": "Verify raw buffer before decoding; reuse analyze map and loaded metadata instead of a new repository scan."
      },
      {
        "pattern": "Prepare then mutate per batch",
        "example_location": "gitnexus/src/core/embeddings/embedding-pipeline.ts:821-925",
        "usage_guidance": "Integrate source preparation without reordering checkpoint/delete/insert invariants."
      }
    ],
    "files_to_modify": [
      {
        "file": "gitnexus/src/core/embeddings/config.ts",
        "symbols": [
          "resolveEmbeddingConfig"
        ],
        "intended_change": "Retain existing WIP effective-value validation and defaults."
      },
      {
        "file": "gitnexus/src/core/embeddings/types.ts",
        "symbols": [
          "EmbeddingConfig",
          "EmbeddableNode"
        ],
        "intended_change": "Retain WIP strategy/projection types; add only minimal source preparation types if needed."
      },
      {
        "file": "gitnexus/src/core/embeddings/chunker.ts",
        "symbols": [
          "chunkNode",
          "refineOversizedStatement",
          "projectClassChunks"
        ],
        "intended_change": "Retain WIP class projection and nested refinement; finish original-source/name/range coverage and overlap invariants."
      },
      {
        "file": "gitnexus/src/core/embeddings/structural-extractor.ts",
        "symbols": [
          "extractStructuralNames"
        ],
        "intended_change": "Retain one-tree class reuse; align declaration selection when a line contains siblings."
      },
      {
        "file": "gitnexus/src/core/embeddings/text-generator.ts",
        "symbols": [
          "generateStructuralTypeText"
        ],
        "intended_change": "Retain trusted class projection and no raw-body/context fallback."
      },
      {
        "file": "gitnexus/src/core/embeddings/embedding-pipeline.ts",
        "symbols": [
          "contentHashForNode",
          "runEmbeddingPipeline",
          "EmbeddingPipelineOptions"
        ],
        "intended_change": "Bind source-aware hash before hydration, then lazily prepare stale/new nodes from original source; preserve checkpoint/deletion/inference ordering."
      },
      {
        "file": "gitnexus/src/core/embeddings/source-reader.ts",
        "symbols": [],
        "intended_change": "NEW proposed private bounded reader: containment, fingerprint verification, original symbol spans and explicit unavailable/mismatch handling."
      },
      {
        "file": "gitnexus/src/core/run-analyze.ts",
        "symbols": [
          "runFullAnalysisInner"
        ],
        "intended_change": "Pass repo root, current file hashes and retention to embedding pipeline; persist already-computed file hashes for non-git repositories without enabling incremental DB mode."
      },
      {
        "file": "gitnexus/src/cli/embeddings-sync.ts",
        "symbols": [
          "embeddingsSyncCommand"
        ],
        "intended_change": "Pass repoPath plus loaded indexed source fingerprints and retention through the common options."
      },
      {
        "file": "gitnexus/src/server/api.ts",
        "symbols": [
          "createServer POST /api/embed callback"
        ],
        "intended_change": "Pass entry.path, embeddingMeta.fileHashes and retention; keep source root distinct from storagePath and preserve locks/outcome handling."
      },
      {
        "file": "gitnexus/test/unit/embedding-config.test.ts",
        "symbols": [],
        "intended_change": "Keep validated policy regression scenarios."
      },
      {
        "file": "gitnexus/test/unit/chunker.test.ts",
        "symbols": [],
        "intended_change": "Finish boundary, class projection, overlap, source span and fallback scenarios."
      },
      {
        "file": "gitnexus/test/unit/embedding-chunking.test.ts",
        "symbols": [],
        "intended_change": "Keep final text no-body/no-context-leak coverage."
      },
      {
        "file": "gitnexus/test/unit/text-generator.test.ts",
        "symbols": [],
        "intended_change": "Keep projection trust marker, unchanged non-Class and short input behavior."
      },
      {
        "file": "gitnexus/test/unit/embedding-pipeline.test.ts",
        "symbols": [],
        "intended_change": "Extend source identity/fresh skip/tail edit/relocation/retention/recovery tests."
      },
      {
        "file": "gitnexus/test/unit/embedding-source-reader.test.ts",
        "symbols": [],
        "intended_change": "NEW proposed reader tests for verified source, missing hashes/files, mismatch, path containment, bounded cache and line handling."
      },
      {
        "file": "gitnexus/test/integration/ast-embedding-chunking.test.ts",
        "symbols": [],
        "intended_change": "Keep real grammar cases; add only discriminating missing language/range cases."
      },
      {
        "file": "gitnexus/test/integration/embedding-chunking-lifecycle.test.ts",
        "symbols": [],
        "intended_change": "Complete actual analyze/storage/search lifecycle; fix diagnostic test to use zero-based source lines."
      },
      {
        "file": "gitnexus/test/unit/embeddings-sync-command.test.ts",
        "symbols": [],
        "intended_change": "Verify indexed metadata/root forwarded; missing source does not overwrite valid vectors."
      },
      {
        "file": "gitnexus/test/unit/server-embed.test.ts",
        "symbols": [],
        "intended_change": "Proposed file if no existing endpoint harness covers this: root/retention/fingerprint forwarding and error preservation. Prefer the existing endpoint test file when found."
      },
      {
        "file": "gitnexus/test/integration/embedding-chunking-benchmark.test.ts",
        "symbols": [],
        "intended_change": "NEW proposed opt-in serial paired benchmark under existing benchmark runner."
      },
      {
        "file": "RUNBOOK.md",
        "symbols": [],
        "intended_change": "Document env configuration, unchanged defaults, scoped refresh cost and explicit source-unavailable behavior."
      }
    ],
    "tests": [
      {
        "file": "gitnexus/test/unit/embedding-config.test.ts",
        "scenarios": [
          "Unset/blank → 1200/120/ast; env overrides partial config; 500/50/fixed works; invalid effective integers, overlap or strategy fail before work."
        ]
      },
      {
        "file": "gitnexus/test/integration/ast-embedding-chunking.test.ts",
        "scenarios": [
          "Real TypeScript/Python/Java/Objective-C class projection retains header and fields, excludes method/constructor/lambda bodies, preserves separate Method text.",
          "Short and fixed callables perform no parse; changed Class uses one shared parse.",
          "Nested compounds preserve fitting statements, branch syntax and full tail with bounded overlap; irreducible atoms use bounded character fallback.",
          "CRLF, Unicode, nested classes, declarations sharing a line, field accessors and parser failure have explicit safe behavior."
        ]
      },
      {
        "file": "gitnexus/test/unit/embedding-source-reader.test.ts",
        "scenarios": [
          "Matching SHA256 and contained path → exact original zero-based inclusive symbol lines; missing/mismatching/escaping input → explicit unavailable/error, never unverified source.",
          "One file read per resident cache entry; byte and entry bounds, large-file bypass and cleanup; no unbounded source/AST cache.",
          "No source I/O under retention none/symbol; notebook extraction uses its established mapping and conservative original JSON ranges."
        ]
      },
      {
        "file": "gitnexus/test/unit/embedding-pipeline.test.ts",
        "scenarios": [
          "Unchanged source-aware hash → zero reader, parser and inference calls; unchanged short default hash remains baseline v7.",
          "Tail-only edit beyond 5000, relocation, mode/size/overlap changes, grow/shrink and source capability changes invalidate affected rows.",
          "Class preparation uses one tree; hashing remains synchronous and parse/read-free.",
          "Source validation failure happens before that batch stale-row DELETE and keeps resumable checkpoint state; existing inference/cancellation/partial-node behavior remains intact."
        ]
      },
      {
        "file": "gitnexus/test/integration/embedding-chunking-lifecycle.test.ts",
        "scenarios": [
          "Fresh analyze → persist searchable tail beyond 5000 and correct nonzero winning range; FTS still finds normal tokens.",
          "Python indentation survives; Class fields after a long method survive while body sentinel exists only in Method inputs.",
          "Unchanged rerun → no reader/parser/inference; fixed→ast round trip, relocate, tail-only edit, shrink/delete, close/reopen all match clean rebuild.",
          "Git and non-git repositories; alternate storage path differs from checkout; old metadata/missing checkout has explicit limited/error behavior."
        ]
      },
      {
        "file": "gitnexus/test/unit/embeddings-sync-command.test.ts",
        "scenarios": [
          "Sync forwards indexed fingerprint/root/retention and preserves locks/checkpoint/outcome behavior."
        ]
      },
      {
        "file": "gitnexus/test/unit/server-embed.test.ts",
        "scenarios": [
          "Use existing server embed harness if present; POST /api/embed supplies entry.path rather than storagePath, respects retention and reports validation failure without successful completion."
        ]
      },
      {
        "file": "gitnexus/test/unit/semantic-chunk-search.test.ts",
        "scenarios": [
          "Unique parent pagination and winning chunk source range survive both vector-index and exact-scan search."
        ]
      },
      {
        "file": "gitnexus/test/integration/embedding-identity-integrity.test.ts",
        "scenarios": [
          "Chunk/source layout does not change model/dimension/provider identity or lose preserved compatible vectors."
        ]
      },
      {
        "file": "gitnexus/test/integration/embedding-chunking-benchmark.test.ts",
        "scenarios": [
          "Paired short, flat, nested, class-heavy, very-large and mixed cohorts; fresh/no-change/changed/disabled runs and equal-vector query benchmark; local real model plus orchestration/native DB measurements."
        ]
      }
    ],
    "verification_commands": [
      "cd gitnexus && npm test -- test/unit/chunker.test.ts test/unit/embedding-chunking.test.ts test/unit/text-generator.test.ts test/unit/embedding-config.test.ts test/unit/embedding-pipeline.test.ts test/unit/semantic-chunk-search.test.ts test/integration/ast-embedding-chunking.test.ts",
      "cd gitnexus && npm run test:integration -- test/integration/embedding-chunking-lifecycle.test.ts test/integration/embedding-identity-integrity.test.ts",
      "cd gitnexus && npm run test:benchmarks",
      "cd gitnexus && npx tsc --noEmit",
      "cd gitnexus && npm run typecheck:tests",
      "cd gitnexus && npm run test:dupes",
      "cd gitnexus && npm test",
      "Changed-file ESLint and Prettier checks using existing configuration; targeted new reader/caller test files after creation.",
      "Before each commit use matching local backend detect_changes scope all; rerun incomplete/truncated results. Complete npm test before commit per repository instructions."
    ],
    "validation_status": {
      "focused_tests": "Latest actual worktree: 7 files,194 tests passed; /tmp/gitnexus-702-deepen-focused.log (14.32s).",
      "types": "Production and test typechecks passed before the final overlap-only fix; rerun at final implementation.",
      "lifecycle": "Failing range assertion: graph source is flattened; all long-function chunk ranges0/0. Existing diagnostic also needs zero-based expected line correction.",
      "performance": "Current WIP real-model paired exploratory benchmark completed exit0; nested inference improves, flat p95 and preparation remain concerns; source hydration not implemented/measured.",
      "full_suite": "No passing full-suite receipt; workspace native worker readiness timeouts. /tmp replica runs lifecycle in about16s but still exposes the actual source bug.",
      "implementation_commits": 0,
      "plan_commit": "802e6f292aa9faf24ac38c5d395eff0f2d71d93a",
      "deepen_cycles": 1
    },
    "risks": [
      "CRITICAL pipeline/analyzer changes affect analyze/watch, sync, server embedding and recovery; do not broaden storage mutation semantics.",
      "Source data is flattened/capped before the current embedding path; direct chunker tests alone cannot prove complete source or line fidelity.",
      "File fingerprint invalidation is conservative for affected long/Class siblings in an edited file; measure changed-file work and optimize only with evidence.",
      "Full tails beyond the legacy 5000-character cap may require more inference work than the incomplete baseline. Do not hide this behind class savings or claim parity without end-to-end evidence.",
      "Latest flat inference p95 is slower and nested preparation CPU is higher; end-to-end improvements do not waive per-cohort investigation.",
      "Existing graph stores line spans, not exact columns. Same-line declarations and notebook coordinate mapping need explicit selection/conservative-range tests.",
      "The HTTP callback has UNKNOWN upstream graph risk; its POST /api/embed registration is source-confirmed.",
      "Native tests time out under the workspace filesystem; /tmp validation replica runs them. Final evidence must prove identical candidate bytes and report environmental failures separately."
    ],
    "assumptions": [
      "Retain 1200/120 defaults and offer 500/50 explicitly; no baseline workload change from new defaults.",
      "Character fallback is permitted for irreducible atoms or unsupported parsers; Class fallback remains metadata-only, never raw method bodies.",
      "Stored content is sufficient to identify unchanged unsplit nodes; raw hydration applies to Class and potentially split/truncated nodes. Verify explicit >5000 chunk sizes and normalized-short cases.",
      "Indexed file hashes identify the intended source snapshot. Compare SHA256 of every hydrated buffer; missing/mismatched source must not be accepted as indexed text.",
      "A scoped source/layout hash can preserve unaffected short v7 hashes while detecting tail changes, relocation, retention/source-mode transitions and policy changes. Prove this before committing.",
      "Retaining fileHashes for non-git metadata does not enable incremental DB mode: the separate repoHasGit condition remains mandatory; test the metadata change.",
      "No production source or test edits occurred during this Deepen pass; current WIP remains uncommitted and must be integrated, not reimplemented from scratch."
    ],
    "open_questions": [
      "Can the final complete-source implementation meet the unchanged no-regression requirement on every required cohort? Open until paired end-to-end measurement; no tolerance budget is authorized.",
      "How much changed-file sibling invalidation does the conservative file fingerprint add on the representative corpus? Measure before deciding whether a narrower cache identity is needed.",
      "Are unsupported/ambiguous declaration shapes safely bounded without weakening field/body separation? Add concrete failing fixtures where current projection cannot prove the target.",
      "Native full-suite environment failures remain unresolved; obtain a full same-bytes run in the working native environment or report the specific remaining failures without a passing claim."
    ],
    "avoid": [
      "Do not repeat full repository discovery; reverify only drifted or unresolved evidence.",
      "Do not modify unrelated dirty files or include them in commits.",
      "Do not introduce a schema migration, checkpoint redesign, new dependency, or query-pagination rewrite.",
      "Do not add work on embeddings-disabled paths or AST work to freshness hashing.",
      "Do not change default chunk size to 500 or globally invalidate unaffected short vectors.",
      "Do not reparse every Class chunk or keep a global tree cache.",
      "Do not claim all statements can remain unsplit under a hard limit smaller than an indivisible expression.",
      "Do not claim measured performance parity, passed tests, or PDG evidence from planning.",
      "Do not proceed beyond LFG gate without explicit choice and HIGH-risk sign-off for the specified config change.",
      "Do not change CSV normalization or the 5000-character FTS snippet cap to obtain original embedding source.",
      "Do not read arbitrary graph file paths, ignore retention, or embed a checkout buffer whose fingerprint differs from the indexed map.",
      "Do not move source reads/parsing before the fresh-node filter or into embeddings-disabled analyze.",
      "Do not treat lower inference input counts as proof of full repository performance parity.",
      "Do not rebuild source/code during planning; work owns implementation/build/test/commit/review completion."
    ],
    "execution_state": {
      "branch": "feat/issue-702-ast-embedding-chunking",
      "worktree": "/workspace/.worktrees/issue-702",
      "baseline": "f641342d1fcbfdcb764c5e478db0f69e6cea899a",
      "landed_steps": [
        "Original plan commit only"
      ],
      "uncommitted_completed_parts": [
        "Config validation",
        "Scoped layout hashing",
        "Class projection and shared tree",
        "Nested refinement and overlap reservation",
        "194 focused regression tests"
      ],
      "remaining": [
        "Verified original-source seam/caller wiring",
        "Complete persisted lifecycle",
        "Performance no-regression proof",
        "Full checks, implementation commits, final graph refresh and review"
      ]
    },
    "analyzer_provenance": {
      "status": "current",
      "index_commit": "802e6f292aa9faf24ac38c5d395eff0f2d71d93a",
      "indexed_at": "2026-11-03T10:03:45.557Z",
      "runner_identity": {
        "schemaVersion": 4,
        "runtime": {
          "executablePath": "/usr/local/bin/node",
          "version": "v22.23.3",
          "platform": "linux",
          "architecture": "x64",
          "modulesAbi": "127",
          "libc": "glibc:2.41"
        },
        "cliVersion": "1.6.12",
        "invokedArtifact": {
          "path": "/workspace/.worktrees/issue-702/gitnexus/dist/cli/index.js",
          "digest": "sha256:0636e9162eab7d08fcf7138a48791c509f79a645821e5b6201e349b1ce294b4b"
        },
        "build": {
          "kind": "distribution",
          "rootPath": "/workspace/.worktrees/issue-702/gitnexus/dist",
          "canonicalization": "gitnexus-analyzer-build-v2",
          "digest": "sha256:9c07082109f67661bb57b72321d31163fa97d66728c782dc29e59ff205e0e5d0"
        },
        "dependencyRuntime": {
          "manifestPath": "/workspace/.worktrees/issue-702/gitnexus/package.json",
          "lockfilePath": "/workspace/.worktrees/issue-702/gitnexus/package-lock.json",
          "canonicalization": "gitnexus-analyzer-dependency-runtime-v4",
          "packageCount": 237,
          "artifactCount": 10504,
          "digest": "sha256:fbcd9a76a4a78d35550750ebd4cf1eaf7c49943e1a698d0869d3199bacda49da"
        }
      },
      "incomplete_reasons": [],
      "content_drift": {
        "status": "current",
        "coveredFiles": 3307
      },
      "transport": "Matching local compiled backend; connected MCP graph engine incompatible47vs42; context metadata remains readable"
    },
    "evidence_artifacts": [
      "/tmp/gitnexus-702-deepen-read.json",
      "/tmp/gitnexus-702-deepen-status.json",
      "/tmp/gitnexus-702-deepen-impacts.jsonl",
      "/tmp/gitnexus-702-deepen-layout-impacts.jsonl",
      "/tmp/gitnexus-702-deepen-pdg-nodes.json",
      "/tmp/gitnexus-702-lifecycle-content.log",
      "/tmp/gitnexus-702-deepen-focused.log",
      "/tmp/gitnexus-702-benchmark-current.json"
    ]
  }
}
```

## 12. Assumptions and Open Questions

- [assumed; execution must verify] Retain 1200/120 defaults and offer 500/50 explicitly; no baseline workload change from new defaults.
- [assumed; execution must verify] Character fallback is permitted for irreducible atoms or unsupported parsers; Class fallback remains metadata-only, never raw method bodies.
- [assumed; execution must verify] Stored content is sufficient to identify unchanged unsplit nodes; raw hydration applies to Class and potentially split/truncated nodes. Verify explicit >5000 chunk sizes and normalized-short cases.
- [assumed; execution must verify] Indexed file hashes identify the intended source snapshot. Compare SHA256 of every hydrated buffer; missing/mismatched source must not be accepted as indexed text.
- [assumed; execution must verify] A scoped source/layout hash can preserve unaffected short v7 hashes while detecting tail changes, relocation, retention/source-mode transitions and policy changes. Prove this before committing.
- [assumed; execution must verify] Retaining fileHashes for non-git metadata does not enable incremental DB mode: the separate repoHasGit condition remains mandatory; test the metadata change.
- [assumed; execution must verify] No production source or test edits occurred during this Deepen pass; current WIP remains uncommitted and must be integrated, not reimplemented from scratch.

- Open: Can the final complete-source implementation meet the unchanged no-regression requirement on every required cohort? Open until paired end-to-end measurement; no tolerance budget is authorized.
- Open: How much changed-file sibling invalidation does the conservative file fingerprint add on the representative corpus? Measure before deciding whether a narrower cache identity is needed.
- Open: Are unsupported/ambiguous declaration shapes safely bounded without weakening field/body separation? Add concrete failing fixtures where current projection cannot prove the target.
- Open: Native full-suite environment failures remain unresolved; obtain a full same-bytes run in the working native environment or report the specific remaining failures without a passing claim.

Resolved from the original plan: dependencies and real local model work; analyzer/index identities now match; a complete nodes PDG data slice is available. Rejected: persisted symbol content is suitable original AST source. Still limited: controls slice partial, HTTP callback caller graph UNKNOWN, native workspace full-suite reliability and final per-cohort performance.

Deferred: model-specific token budgets, changed File policy, multiple hits per parent, global AST caches, schema/column additions, generalized source-reader frameworks and unrelated ingestion/search optimizations.

## 13. Definition of Done

- Validated chunk-size, overlap, and ast/fixed env configuration; retain 1200/120 defaults.
- Preserve long callable tails and fitting statement boundaries; explicitly bound oversized-atom fallback.
- Class inputs contain declaration/fields and compact names, without method bodies; Method inputs retain body searchability.
- Correct source ranges and unique-parent best-chunk search remain intact.
- Config changes and content shrink clean stale chunks; unchanged nodes skip AST and inference work.
- Preserve unaffected short-node text and baseline v7 hashes.
- Passing functional/type/integration checks and paired runtime/RSS/query benchmarks are required before completion.
- Default full-retention embedding runs use fingerprint-verified original source for Class and split/truncated nodes, preserving indentation and tails beyond the FTS snippet cap.
- Analyze, embeddings sync, and POST /api/embed use the same source, hashing, retention and failure contract; no source reads on unchanged nodes or embeddings-disabled runs.
- FTS normalization, database schema, vector-space identity and search query structure remain unchanged.
- Native lifecycle verifies actual persisted rows and late-tail search, including long→short cleanup, deletion, relocation, tail-only changes and reopen/resume.
- All required checks pass; environment failures and incomplete graph evidence are reported rather than counted as clean.
- Paired benchmarks satisfy the unchanged per-cohort no-regression gate, with full-source coverage and one-time refresh cost disclosed.
- Verified atomic implementation commits exist, each preceded by required checks/change analysis; final current-graph LFG review is completed and unresolved findings are surfaced.

**Current delivery:** Deepen1 revises this plan only. One original plan commit, zero implementation commits. Existing13-file WIP is retained; source hydration, lifecycle success, performance acceptance, full verification and review remain unfinished. The next step is the explicit LFG proceed/stop gate for this concrete revised scope.
