# GitNexus Engineering Plan

> Task: Fix #2508 — `context()`/`impact()` drop Function callers because LadybugDB misevaluates relationship-property `IN` predicates on ≥0.18.1-written indexes; rewrite all `r.type IN` sites to OR-of-scalar predicates and add a real-LadybugDB regression test asserting exact caller IDs.
> Evidence verified at commit 4d7a0a69 (full SHA in §11); GitNexus index fresh — built this session via `node /workspace/.gitnexus/run.cjs analyze --index-only --pdg` (runner: installed gitnexus 1.6.9, @ladybugdb/core 0.18.0).
> Evidence provenance schema 1; global dirty digest e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 (clean tree, zero dirty paths); cited-path manifest 10 sorted entries; generated plan excluded.

## 1. Objective

`context()` and `impact(upstream)` must never drop a resolved caller whose `CALLS` edge exists in the graph. Replace every Cypher predicate of the form `r.type IN [...]` / `r.type IN $param` on `CodeRelation` relationship properties with OR-of-scalar-equality predicates, guard the pattern against reintroduction, and regression-test exact caller identity against a real LadybugDB.

## 2. Current Behaviour

`[verified]` 13 Cypher sites filter `CodeRelation.type` with a list `IN` predicate. On an index **written** by `@ladybugdb/core` ≥ 0.18.1 through the analyze pipeline's bulk CSV `COPY` path, LadybugDB evaluates those predicates incorrectly: for the issue's repro target it returns the `File`-caller row twice and omits the `Function`-caller row entirely, while scalar `r.type = '...'` (and OR-chains of scalars) return the correct row set. This was proven empirically this session (see §4, "Root-cause matrix").

Consequences at the tool surface `[verified against source, consistent with issue repro]`:
- `context()` (`_contextImpl`, `gitnexus/src/mcp/local/local-backend.ts:3088-3097`) builds incoming refs with an 11-type `IN` list (line 3092) → production callers can vanish, duplicates appear.
- `impact(upstream)` (`_runImpactBFS`, lines 5677-5687) filters its per-depth BFS query with `r.type IN $relTypes` → dropped edges collapse the blast radius to `impactedCount: 0, risk: LOW` — a false-safe answer.
- `trace` (`_traceImpl`, line 4705), the epistemic-boundary probe (`computeEpistemicBoundary`, lines 5439/5467), the PDG layer probe and BFS (`pdg-impact.ts:1171/1324`), and the wiki exports query (`core/wiki/graph-queries.ts:84`) use the same pattern.

`[verified]` Failure is silent in several paths: `_contextImpl`'s class-like expansion catches and only logs query errors (lines 3210-3212), `computeEpistemicBoundary` uses `.catch(() => [])` (5443, 5470). Broken queries degrade results without any error surfacing.

## 3. Relevant Architecture

`[verified]` All graph edges live in a single `CodeRelation` rel table declared over ~60 `FROM X TO Y` label pairs (`gitnexus/src/core/lbug/schema.ts:251+`), with a `type` STRING property discriminating edge kinds. The issue's two droppable callers arrive via *different* sub-table pairs (`Function→Function` and `File→Function`) — the misevaluation is tied to scans across this multi-pair storage.

`[verified]` Query execution funnels through `executeParameterized` (`gitnexus/src/core/lbug/pool-adapter.ts:887`); `executeQuery` (line 880) delegates to it with empty params. Param validation (`gitnexus/src/core/lbug/query-params.ts`) documents scalar-only binding expectations (`isBindableScalar`).

`[verified]` Module-level constants feed the param-bound sites: `EPISTEMIC_HERITAGE_RELATION_TYPES` / `EPISTEMIC_CONSUMER_RELATION_TYPES` (local-backend.ts:302-307, with a doc comment at 295-301 explicitly describing the `r.type IN $heritage` binding — must be updated), `TRAVERSAL_EDGE_TYPES` (trace), and the impact `relationTypes` allowlist-filtered user parameter.

## 4. GitNexus Findings

Primary symbols (all `source_verified`): `_contextImpl`, `_runImpactBFS`, `_traceImpl`, `computeEpistemicBoundary` (local-backend.ts); `pdgLayerStatus`, `bfsReachableBlocks` (pdg-impact.ts); `getFilesWithExports` (wiki/graph-queries.ts).

- `impact {target: "_contextImpl", direction: "upstream", maxDepth: 3, summaryOnly: true}` → `risk: HIGH, impactedCount: 14, d1=1` — key output: `"risk": "HIGH"`. ⚠ HIGH-risk edit per AGENTS.md.
- `impact {target: "_runImpactBFS", ...}` → `risk: LOW, impactedCount: 6, d1=2`.
- `cypher` (scalar predicates, deliberately avoiding `IN` given this bug) enumerated every direct (d=1) caller: `context → _contextImpl`; `_impactImpl` and `impactByUid` → `_runImpactBFS`; `trace → _traceImpl`; `_contextImpl` and `_runImpactBFS` → `computeEpistemicBoundary`; `_impactImpl` + unit test `gitnexus/test/unit/pdg-impact-engine.test.ts` → `pdgLayerStatus`; `interproceduralDescent`, `runImpactPDG` → `bfsReachableBlocks`; `fullGeneration` (wiki generator) → `getFilesWithExports`.
- Related tests located `[verified]`: `gitnexus/test/integration/local-backend.test.ts` (real-DB harness `withTestLbugDB` + `LOCAL_BACKEND_SEED_DATA`), `local-backend-calltool.test.ts` (invokes tools through the backend), `impact-epistemic-lower-bound.test.ts`, `impact-pdg-*.test.ts`, `context-typed-property.test.ts`.

**Root-cause matrix** `[verified — session experiments, scratchpad `lbug-repro`]`, all probing `MATCH (c)-[r:CodeRelation]->(t) WHERE t.id = '<classifyOutcome uid>' AND r.type IN ['CALLS']` vs scalar `=`:

| DB produced by | IN result | Scalar result |
|---|---|---|
| analyze pipeline (COPY), lbug **0.18.0** | ✅ correct (readers 0.18.0/0.18.1) | ✅ |
| analyze pipeline (COPY), lbug **0.18.1** @ issue commit 226ec6cf | ❌ File caller ×2, Function caller dropped — **identical wrong rows under readers 0.18.0, 0.18.1, 0.18.2**; param-bound `IN $relTypes` equally wrong | ✅ correct on the same DB |
| analyze pipeline (COPY), lbug **0.18.2** | ❌ same wrong rows | ✅ |
| synthetic small/large CREATE- or COPY-loaded DBs (≤200k rels, 2 pairs), lbug 0.18.1 | ✅ (trigger needs the full pipeline's layout; not minimizable cheaply) | ✅ |

Node-property `IN` (`n.id IN [...]`, `$frontierIds`, BasicBlock `$frontier`, Contract `symbolUid IN $uids`) was probed on the affected DB and is **correct** — those sites are explicitly out of scope.

Conclusions: (a) the workaround must live in GitNexus's queries — no dependency pin can heal already-written user indexes, and the newest patch (0.18.2) still writes the affected layout; (b) OR-of-scalars is proven correct on both healthy and affected DBs; (c) this also explains why in-session MCP results here were trustworthy: the local index was written by 0.18.0.

## 5. Statement-Level PDG Findings

`pdg_query {mode: "controls", target: "_contextImpl"}` (fresh `--pdg` layer):
- The three class-like expansion queries (two of them `IN` sites, lines 3141/3153/3167) execute only under the `isClassLike` T-branch (controller line 3130); their failures are control-routed to `logQueryError` (line 3211) — **silent degradation**: a syntactically broken rewrite would pass every "did not throw" test. Implementation consequence: tests must assert returned caller content, not absence of errors.
- Guard at 3053 (`name`/`uid` required) is the only early return before the incoming-refs query — no other control dependency gates line 3092; the rewrite cannot change behavior for non-class symbols beyond the predicate itself.
- `pdg_query {mode: "flows", target: "_runImpactBFS", variable: "relTypes"}` → empty (destructured param not tracked); data flow source-verified instead: `relationTypes` array is bound as a single list param at line 5685; `confidenceFilter` is a pre-built string appended to the query (5679-5680) — the rewrite must compose with it textually.

## 6. Proposed Changes

1. **New helper** — file `gitnexus/src/core/lbug/query-params.ts`; symbol `relTypeEquals(alias: string, types: readonly string[], paramPrefix?: string)` → `{ clause: string; params: Record<string, string> }`. Emits `(alias.type = $p0 OR alias.type = $p1 …)`; empty `types` → `{ clause: 'FALSE', params: {} }` preserving the current match-nothing semantics of `IN []` (verify LadybugDB accepts a bare `FALSE` literal — fallback `(1 = 0)`; covered by unit test). Responsibility: single construction point for rel-type filters; scalar params satisfy `isBindableScalar`. No `any` types (repo rule).
2. **local-backend.ts rewrite** — symbols `_contextImpl` (4 `IN` sites: 3092, 3141, 3153, 3167, 3220 — 5 queries), `_traceImpl` (4705), `computeEpistemicBoundary` (5439, 5467), `_runImpactBFS` (5679/5680): replace each `r.type IN …` with the helper's clause and spread `…params` into the existing `executeParameterized` param objects. Update the stale doc comment at 295-301 that documents the `IN $heritage`/`IN $types` binding. Constraint: keep the `confidenceFilter` string append and `LIMIT` interpolation exactly as-is.
3. **pdg-impact.ts rewrite** — `pdgLayerStatus` (1171), `bfsReachableBlocks` (1324): same treatment (static two-type list `CDG`/`REACHING_DEF`).
4. **wiki/graph-queries.ts rewrite** — `getFilesWithExports` (84): inline literal `(mr.type = 'HAS_METHOD' OR mr.type = 'HAS_PROPERTY')` (this path uses param-less `executeQuery`; two static literals do not justify param plumbing).
5. **Tripwire test** — new `gitnexus/test/unit/lbug/rel-type-predicate.test.ts`: (a) helper unit tests (clause shape, empty list, custom prefix, param values); (b) source scan asserting no `.type IN` (`[` or `$`) predicate reappears in `gitnexus/src/**/*.ts` Cypher (regex over file contents; zero matches expected after this change; failure message points to `relTypeEquals`).
6. **Regression integration test** — new `gitnexus/test/integration/caller-identity-regression.test.ts` using `withTestLbugDB` + a dedicated seed modeled on `LOCAL_BACKEND_SEED_DATA`: a target `Function` with a `Function→Function` CALLS edge (production caller) **and** a `File→Function` CALLS edge (test-file caller, path under `test/`) — the exact cross-pair shape from #2508 — asserting **exact caller IDs** (not counts) through the real backend tool paths (pattern: `local-backend-calltool.test.ts`): `context` lists both callers once each; `impact` upstream with `includeTests: false` returns the production caller (count ≥ 1); with `includeTests: true` additionally the test caller.

Out of scope (→ §12): fixing LadybugDB upstream; touching node-property `IN` sites; CHANGELOG (release-time, repo rule).

## 7. Implementation Sequence

1. Add `relTypeEquals` + its unit tests (change 1 + helper half of 5). Independently landable.
2. Rewrite the 10 `local-backend.ts` sites + comment 295-301 (change 2); run `npx vitest run test/integration/local-backend.test.ts test/integration/local-backend-calltool.test.ts test/integration/impact-epistemic-lower-bound.test.ts` in `gitnexus/`.
3. Rewrite `pdg-impact.ts` + wiki sites (changes 3-4); run `npx vitest run test/unit/pdg-impact-engine.test.ts test/integration/impact-pdg-e2e.test.ts`.
4. Add the source-scan tripwire assertions (second half of change 5) — must go after steps 2-3 or it fails on the not-yet-rewritten sites.
5. Add the caller-identity regression test (change 6); full `npm test` in `gitnexus/`.
6. End-to-end proof against the session's preserved broken-layout index (see §8 verification recipe) — optional but decisive; no repo artifact changes.

## 8. Test Strategy

- **New**: helper unit tests (empty list → `FALSE`, 1-type, 11-type, prefix collision avoidance); source-scan tripwire; caller-identity integration test with scenarios: seeded cross-pair callers → `context` → both exact IDs, no duplicates; → `impact` upstream ±`includeTests` → exact production-caller ID, non-zero count.
- **Update**: none expected — existing integration suites must stay green unchanged (they run the same query paths on a healthy-layout test DB where `IN` and OR agree).
- **Edge cases**: empty `relationTypes` user param (impact) keeps match-nothing semantics; 11-term OR in the context queries; `confidenceFilter` composition in BFS; `.catch(() => [])` paths still degrade to `[]` on genuine DB errors.
- **Failure paths**: the silent-degradation catches (§5) are why every new assertion checks row content/IDs.
- **Verification commands** (verified to exist): `npm test`, `npm run test:unit`, `npm run test:integration`, `npm run build` — all in `gitnexus/`; targeted `npx vitest run <file>` as in §7.
- **End-to-end recipe** (proves the actual #2508 symptom dies): the session preserved a broken-layout index at `/tmp/claude-1000/-workspace/6d0f369e-3595-41fa-aa9a-f7dab7e46007/scratchpad/gn-0181-idx` (written by lbug 0.18.1 at issue commit 226ec6cf) plus probe scripts in `…/scratchpad/lbug-repro/`. After the rewrite, running the rewritten context/impact query shapes against that index must return both `classifyOutcome` callers; the raw `IN` probe stays broken (it's the DB's bug, not ours).

## 9. Risk and Impact Analysis

- `_contextImpl` is **HIGH-risk** (14 upstream, d=1: `context` tool method — the primary MCP/CLI surface). Mitigation: predicate-only rewrites, no shape changes to returned rows; content-asserting tests in step 2's command list before commit.
- `_runImpactBFS` d=1: `_impactImpl`, `impactByUid` — both flow through the same query constant; BFS output shape untouched. `computeEpistemicBoundary` callers are inside the change set. `pdgLayerStatus` has a unit test caller (`pdg-impact-engine.test.ts`) that may assert on query text — check when running step 3. `getFilesWithExports` d=1 `fullGeneration`: wiki output ordering unchanged (`ORDER BY` intact). `bfsReachableBlocks` d=1 (`interproceduralDescent`, `runImpactPDG`): predicate-only change.
- **Compatibility**: pure read-path change; no schema, no index, no persisted-format impact; users on healthy 0.18.0 indexes see identical results (proven: IN ≡ OR there), users on ≥0.18.1 indexes see *more correct* results — impact counts may grow; that is the fix, worth one line in the PR body.
- **Performance**: ≤11-term OR chains replace list `IN` in per-depth BFS queries; no measured claim made — if LadybugDB's planner degrades, the BFS row caps (`LIMIT`, `PER_NODE_FANOUT_CAP`) bound the damage. No new round-trips.
- **Concurrency/migration/observability**: none / none / silent-catch paths unchanged (deliberate — error-handling redesign is out of scope).

## 10. Files Expected to Change

| File | Symbols | Reason |
|---|---|---|
| gitnexus/src/core/lbug/query-params.ts | `relTypeEquals` (new) | Single construction point for rel-type OR predicates |
| gitnexus/src/mcp/local/local-backend.ts | `_contextImpl`, `_traceImpl`, `computeEpistemicBoundary`, `_runImpactBFS` + module comment 295-301 | Rewrite 10 `IN` sites |
| gitnexus/src/mcp/local/pdg-impact.ts | `pdgLayerStatus`, `bfsReachableBlocks` | Rewrite 2 `IN` sites |
| gitnexus/src/core/wiki/graph-queries.ts | `getFilesWithExports` | Inline literal OR (2 types) |
| gitnexus/test/unit/lbug/rel-type-predicate.test.ts | new | Helper units + reintroduction tripwire |
| gitnexus/test/integration/caller-identity-regression.test.ts | new | Exact-caller-ID regression (#2508 shape) |

## 11. Reusable Implementation Context

```yaml
implementation_context:
  task_summary: >
    Fix #2508: rewrite all 13 CodeRelation.type IN-list Cypher predicates to
    OR-of-scalar equality (helper relTypeEquals), because LadybugDB >=0.18.1
    COPY-written indexes misevaluate rel-property IN (dup+drop rows) under every
    reader version; add exact-caller-ID regression test + tripwire.
  acceptance_criteria:
    - No `.type IN [` or `.type IN $` predicate remains under gitnexus/src
    - context() and impact(upstream) return exact expected caller IDs on the seeded cross-pair fixture
    - Existing unit+integration suites green; npm run build green
    - Tripwire test fails if the pattern is reintroduced

  evidence_provenance:
    schema_version: 1
    head_commit: 4d7a0a69e365736344cedeea4ab3053671378d1e
    generated_plan_path: docs/plans/2026-07-18-gitnexus-plan-rel-in-predicate-rewrite.md
    global_dirty_digest:
      algorithm: sha256
      canonicalization: sorted NUL-delimited dirty-path records (zero dirty paths)
      value: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    cited_path_manifest:  # all clean; head=index=worktree digest; untracked absent
      - { path: gitnexus/package.json, state: clean, object_kind: {head: regular, index: regular, worktree: regular, untracked: absent}, head_digest: "sha256:f1bb29a07a77bb500a461b31a9020587475c7eece3d4d094d8824893333a04f4", index_digest: same, worktree_digest: same, untracked_digest: absent }
      - { path: gitnexus/src/core/lbug/pool-adapter.ts, state: clean, object_kind: {head: regular, index: regular, worktree: regular, untracked: absent}, head_digest: "sha256:18a51622b7e04ef5998a6eab77074d375f41de70483bf77c934b670d928ae693", index_digest: same, worktree_digest: same, untracked_digest: absent }
      - { path: gitnexus/src/core/lbug/query-params.ts, state: clean, object_kind: {head: regular, index: regular, worktree: regular, untracked: absent}, head_digest: "sha256:a08f1448fcc806f6250428549a0b004a6e242e7bba611e6cb7539a1b4bbc93c0", index_digest: same, worktree_digest: same, untracked_digest: absent }
      - { path: gitnexus/src/core/lbug/schema.ts, state: clean, object_kind: {head: regular, index: regular, worktree: regular, untracked: absent}, head_digest: "sha256:b856662a5bfaf105cfe0559f50a2fab483a168932b2d9ac1d2dbce3236fd3610", index_digest: same, worktree_digest: same, untracked_digest: absent }
      - { path: gitnexus/src/core/wiki/graph-queries.ts, state: clean, object_kind: {head: regular, index: regular, worktree: regular, untracked: absent}, head_digest: "sha256:b5d02d3584085db0b01174c6d6c7d3c5ec9d0d5a43b38f54b79684d7272873f8", index_digest: same, worktree_digest: same, untracked_digest: absent }
      - { path: gitnexus/src/mcp/local/local-backend.ts, state: clean, object_kind: {head: regular, index: regular, worktree: regular, untracked: absent}, head_digest: "sha256:ef2cf8398c7ff9390e55ca3c440c217f75c10197e0fbded54b5ac0f25a986d2b", index_digest: same, worktree_digest: same, untracked_digest: absent }
      - { path: gitnexus/src/mcp/local/pdg-impact.ts, state: clean, object_kind: {head: regular, index: regular, worktree: regular, untracked: absent}, head_digest: "sha256:0aa61c7fbfa505c54181688bc62f8f3308e02bd02802fc319139aa965a6c776a", index_digest: same, worktree_digest: same, untracked_digest: absent }
      - { path: gitnexus/test/fixtures/local-backend-seed.ts, state: clean, object_kind: {head: regular, index: regular, worktree: regular, untracked: absent}, head_digest: "sha256:631087404fedb39e835863732c6c8cc8b886d93970e3a5149e632e9505a91448", index_digest: same, worktree_digest: same, untracked_digest: absent }
      - { path: gitnexus/test/integration/local-backend-calltool.test.ts, state: clean, object_kind: {head: regular, index: regular, worktree: regular, untracked: absent}, head_digest: "sha256:84ac6e673fb4458be0a02e9e23c50b00a9b18bdced779ddc46f11239811f94a1", index_digest: same, worktree_digest: same, untracked_digest: absent }
      - { path: gitnexus/test/integration/local-backend.test.ts, state: clean, object_kind: {head: regular, index: regular, worktree: regular, untracked: absent}, head_digest: "sha256:5bc5e57d8eef3c5eebaf2636bb59493e974617ceabc6f37ff5fb4d898c8fd55d", index_digest: same, worktree_digest: same, untracked_digest: absent }

  primary_symbols:
    - { symbol: LocalBackend._contextImpl, file: gitnexus/src/mcp/local/local-backend.ts, lines: "3039-3358", role: "context() impl; IN sites 3092, 3141, 3153, 3167, 3220; silent catch 3210-3212" }
    - { symbol: LocalBackend._runImpactBFS, file: gitnexus/src/mcp/local/local-backend.ts, lines: "5519-6195", role: "impact BFS; IN site 5679/5680 (direction variants); relTypes bound 5685; confidenceFilter appended" }
    - { symbol: LocalBackend._traceImpl, file: gitnexus/src/mcp/local/local-backend.ts, lines: "4551-…", role: "trace BFS; IN site 4705 ($edgeTypes = TRAVERSAL_EDGE_TYPES)" }
    - { symbol: LocalBackend.computeEpistemicBoundary, file: gitnexus/src/mcp/local/local-backend.ts, lines: "5421-5510", role: "IN sites 5439 ($heritage), 5467 ($types); .catch(()=>[]); constants at 302-307; stale comment 295-301" }
    - { symbol: pdgLayerStatus, file: gitnexus/src/mcp/local/pdg-impact.ts, lines: "1115-…", role: "IN site 1171 (probe, literal CDG/REACHING_DEF)" }
    - { symbol: bfsReachableBlocks, file: gitnexus/src/mcp/local/pdg-impact.ts, lines: "1289-…", role: "IN site 1324 (literal + node-prop $frontier which stays)" }
    - { symbol: getFilesWithExports, file: gitnexus/src/core/wiki/graph-queries.ts, lines: "74-92", role: "IN site 84 (literal, param-less executeQuery path)" }

  related_symbols:
    - { symbol: executeParameterized, relationship: CALLS(all sites), relevance: "pool-adapter.ts:887; spread helper params into existing param objects" }
    - { symbol: context/_impactImpl/impactByUid/trace, relationship: d=1 callers, relevance: "public surface; no signature changes" }
    - { symbol: EPISTEMIC_HERITAGE_RELATION_TYPES/EPISTEMIC_CONSUMER_RELATION_TYPES/TRAVERSAL_EDGE_TYPES, relationship: data-source, relevance: "static type lists feeding param sites" }
    - { symbol: withTestLbugDB/LOCAL_BACKEND_SEED_DATA, relationship: test-harness, relevance: "real-DB fixture pattern for the regression test" }

  execution_path:
    - "MCP/CLI tool call → LocalBackend.context/impact/trace → _contextImpl/_runImpactBFS/_traceImpl → executeParameterized(lbugPath, cypher, params) → LadybugDB"
    - "Rewrite changes only the WHERE predicate text + param map at each site"

  pdg_constraints:
    - description: "Class-like expansion queries run only under isClassLike (T @ 3130) and errors route to logQueryError (3211) — silent degradation"
      affected_statements: ["gitnexus/src/mcp/local/local-backend.ts:3130", "gitnexus/src/mcp/local/local-backend.ts:3211"]
      implementation_consequence: "Tests must assert returned caller IDs, never just 'no error'"

  architectural_patterns:
    - { pattern: "param binding via executeParameterized, no string interpolation of values", example_location: "gitnexus/src/mcp/local/local-backend.ts:5676 comment", usage_guidance: "helper returns {clause, params}; only derived integers (LIMIT caps) are interpolated" }
    - { pattern: "real-DB integration harness", example_location: "gitnexus/test/integration/local-backend.test.ts + test/fixtures/local-backend-seed.ts", usage_guidance: "withTestLbugDB('<name>', suite, seed) pattern; follow local-backend-calltool.test.ts to invoke tools" }

  files_to_modify:
    - { file: gitnexus/src/core/lbug/query-params.ts, symbols: [relTypeEquals], intended_change: "add helper" }
    - { file: gitnexus/src/mcp/local/local-backend.ts, symbols: [_contextImpl, _traceImpl, computeEpistemicBoundary, _runImpactBFS], intended_change: "rewrite 10 IN sites + comment 295-301" }
    - { file: gitnexus/src/mcp/local/pdg-impact.ts, symbols: [pdgLayerStatus, bfsReachableBlocks], intended_change: "rewrite 2 IN sites" }
    - { file: gitnexus/src/core/wiki/graph-queries.ts, symbols: [getFilesWithExports], intended_change: "inline literal OR" }

  tests:
    - file: gitnexus/test/unit/lbug/rel-type-predicate.test.ts
      scenarios:
        - "relTypeEquals('r', ['CALLS']) → clause `(r.type = $relType0)`, params {relType0: 'CALLS'}"
        - "empty list → clause FALSE (or (1 = 0) if FALSE unsupported), params {}"
        - "11-type list → 11 OR terms, 11 params, stable ordering"
        - "source scan: no /\\.type\\s+IN\\s*(\\[|\\$)/ match under gitnexus/src/**/*.ts"
    - file: gitnexus/test/integration/caller-identity-regression.test.ts
      scenarios:
        - "seed target Function + Function-caller (CALLS) + File-caller under test/ path (CALLS) → context → exactly both caller IDs, once each"
        - "impact upstream includeTests:false → production caller ID present, impactedCount >= 1"
        - "impact upstream includeTests:true → both callers present"

  verification_commands:
    - "cd gitnexus && npm test"
    - "cd gitnexus && npm run test:unit"
    - "cd gitnexus && npm run test:integration"
    - "cd gitnexus && npm run build"
    - "cd gitnexus && npx vitest run test/integration/local-backend.test.ts test/integration/local-backend-calltool.test.ts test/integration/impact-epistemic-lower-bound.test.ts"

  risks:
    - "_contextImpl is HIGH impact (14 upstream, primary MCP surface) — predicate-only edits, content-asserting tests before commit"
    - "pdg-impact-engine.test.ts may assert on pdgLayerStatus query text — check during step 3"
    - "OR-chain planner behavior vs IN unmeasured — bounded by existing LIMIT caps"

  assumptions:
    - "LadybugDB accepts bare FALSE literal in WHERE — verify in helper unit test; fallback (1 = 0)"
    - "local-backend-calltool.test.ts harness can drive context/impact tools against a seeded DB — re-verify by reading that file before writing the regression test"
    - "Line numbers cited pin to 4d7a0a69 — re-anchor if HEAD moved"

  open_questions:
    - "Should the MCP cypher tool description warn users that their OWN r.type IN queries lie on >=0.18.1-written indexes? (user-facing footgun GitNexus cannot fix server-side) — small docs-string addition, decide at execution"
    - "File an upstream LadybugDB bug with the session's repro matrix (follow-up outside this repo)"

  avoid:
    - "Do not repeat full repository discovery"
    - "Do not touch node-property IN sites (n.id IN $frontierIds etc.) — proven unaffected"
    - "Do not pin/bump @ladybugdb/core as the fix — cannot heal existing user indexes"
    - "Do not edit CHANGELOG (release-time artifact)"
    - "Do not rewrite queries via string find-and-replace across files — each site's param object differs"
    - "No `any`/`as any` in code or tests; no if-branching in vitest tests"
```

## 12. Assumptions and Open Questions

Assumptions (each re-verifiable cheaply): `FALSE` literal support in LadybugDB WHERE (else `(1 = 0)`); calltool harness suitability for the regression test; cited line numbers pin to 4d7a0a69. Confirmed facts stand in §4's matrix — notably the bug is **not** version-gated on the reader and **not** healable by pinning.

Open questions / explicitly deferred follow-ups: cypher-tool docstring warning about user-authored `IN` queries; upstream LadybugDB bug report (repro assets preserved in session scratchpad: broken index `gn-0181-idx`, probe scripts `lbug-repro/probe.mjs`, version matrix); whether other GitNexus consumers (gitnexus-web, group/bridge queries) ever compose rel-prop `IN` dynamically at runtime — audit grep says no today; the tripwire test guards `gitnexus/src` going forward.

## 13. Definition of Done

- Zero `.type IN [`/`.type IN $` predicates under `gitnexus/src` (tripwire green).
- New helper unit tests + caller-identity integration test green; **exact caller IDs** asserted, not counts.
- `npm test` and `npm run build` green in `gitnexus/`.
- Existing integration suites pass unchanged.
- Optional but recommended: rewritten query shapes verified against the preserved 0.18.1-written index returning both #2508 callers.
- No CHANGELOG edits; commits detect_changes-gated (gitnexus-work).
