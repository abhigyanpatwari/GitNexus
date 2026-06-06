---
title: Open Issues Batch Triage v2 — 2026-06-03
date: 2026-06-03
last_updated: 2026-06-06
author: arch
status: in-progress
supersedes: open-issues-batch-2026-06-03.md
scope: 86 open issues (80 original + 6 from 2026-06-03 usage audit), repo ngocvo3103/GitNexus
progress: 70/86 closed · 16 open (see "Progress — 2026-06-06")
---

# Triage of 86 Open Issues — v2 (Re-batched by "fixable together")

Supersedes [open-issues-batch-2026-06-03.md](open-issues-batch-2026-06-03.md). The original 80 issues
plus **6 filed 2026-06-03 from a cross-session GitNexus usage audit (#105–#110)**, re-batched on the
axis the user actually asked for: **what can be fixed in one PR together** — i.e. shared file, shared
root cause, or "must co-ship to avoid a known regression."

## What changed vs v1

1. **7 issues were never placed in v1** — now assigned: **#14, #44, #55, #64, #65, #70, #71**.
2. **New Batch A (Verify-and-Close / un-skip)** — derived from git history v1 couldn't see. Recent
   merges (#99, #103, #18/#98, #19/#97) already fixed or test-cover several open issues. Two are
   literally `describe.skip` blocks. This is the highest-ROI, near-zero-code batch — **do it first.**
3. **#102 was mis-grouped** in v1's Spring cluster. It is a **Go** test (`gin` handler→service) →
   moved to Batch A / Go.
4. **#37 pulled out of v1 Cluster 0 into the rename batch (G).** #37 (dup edits on a line) and #63
   (wrong line for duplicates) touch the same rename line-resolution code; splitting them invites a
   regression. Co-ship.
5. **document-endpoint (Batch B)** kept as a single co-shipped PR with ordered sub-commits, per the
   [[route-fix-regression]] rule (scope must stay isolated; the doc-ep fallback must not be touched
   piecemeal across separate PRs).
6. **6 new issues from a cross-session usage audit (#105–#110)** — scanned ~390 Claude Code sessions
   across all local projects for GitNexus usage failures. Placed into existing batches **E** (#107),
   **F** (#105), **I** (#110) and a new **Batch L — Index health & analyze ergonomics** (#106, #108,
   #109). The dominant finding (#105, ~172 occurrences of "Multiple repositories indexed") shares its
   root with #47.

## Live state (verified 2026-06-03)

`gh issue list --state open` → **86 open** (80 from v1 + #105–#110 filed 2026-06-03), **0 closed since
triage date.** Premise of v1 holds: no closing activity, but the merge log shows **active fix work on
adjacent issues** that changes the plan.

---

## Progress — 2026-06-06 (updated)

**70 of 86 triaged issues CLOSED · 16 open.** (Plus 3 newer follow-ups not in this triage: #141, #143, #145.)

Two waves of fix work landed since 2026-06-03:

1. **Prior merges** (`#136–#140` and the `bugfix/NN-*` document-endpoint branches) closed **Batch B** in full and scattered issues (#30, #37, #56, #60, #61, #106, #109).
2. **2026-06-06 merge session** — merged **all 11 open PRs into `main-afk` one-by-one** (union-resolving conflicts; **no existing functionality removed** — HARD RULE), then implemented completion fixes for issues the PRs *over-claimed*. PRs #142, #144, #146–#154 → **51 issues genuinely fixed + closed.** Suite **5,715 pass / 0 fail**, tsc clean, index refreshed.

   Completion work beyond the raw merges (the PRs claimed these but didn't actually deliver end-to-end):
   - **#5/#6/#7/#43/#31/#79/#80** — FastAPI, Gin, and Angular route extractors + Angular CALLS were wired only into the **dormant worker-pool path**; re-wired into the **active sequential path** (FastAPI/Gin/Angular routes ride the decorator-route channel since their receiver is an app/router variable, not a controller class). See `.claude/agent-memory/arch/project-ingestion-dual-path-gotcha.md`.
   - **#150 HARD-RULE** — the merge of #150 silently dropped non-Go `EXTENDS` edges in the worker path; restored during the merge.
   - **#90** (cross-file Spring `@RequestMapping` inheritance) and **#50** (gated cross-repo `CROSS_IMPORTS` edges + external File nodes, in-memory `isExternal` flag) — designed via `/at-planning` (`docs/designs/` + `docs/plans/cross-file-spring-and-cross-repo-imports.md`), then implemented additively/gated.
   - **#81** document-endpoint HTTP-method gate · **#46** cross-repo artifactId prefix-tolerant match · **#77** Go local/anonymous-struct `HAS_PROPERTY` guard · **#102** populated the empty Go fixture + un-skipped the Issue-#19 test.

### Batch status

| Batch | Status | Remaining open |
|---|---|---|
| A Verify/un-skip | ✅ DONE (4/4) | — |
| B document-endpoint | ⚠️ 12/14 | #45, #15 |
| C Spring route | ✅ DONE (5/5) | — *(this session, PR #144 + #81/#90)* |
| D Language extractors | ⚠️ 6/8 | #84, #33 |
| E Angular / TypeScript | ✅ DONE (8/8) | — *(this session, PR #147 + #31)* |
| F Cross-repo | ✅ DONE (7/7) | — *(this session, PR #148 + #46/#50)* |
| G Rename | ✅ DONE (6/6) | — *(62/63/72 PR #149; 37/60/61 prior)* |
| H Typing / pollution | ⚠️ 4/9 | #76, #83, #85, #86, #88 |
| I Cypher surface | ⚠️ 2/7 | #29, #68, #69, #73, #82 |
| J Param plumbing | ✅ DONE (10/10) | — *(this session, PR #152)* |
| K IMPLEMENTS/CALLS | ⚠️ 3/5 | #23, #34 |
| L Index health | ✅ DONE (3/3) | — *(108 PR #154; 106/109 prior)* |

### Remaining 16 — grouped for the next session

- **B / document-endpoint (2):** #45 (ai_context wrong downstream HTTP methods), #15 (downstream APIs show unresolved code expressions). Both depend on the CALLS-based downstream resolver from #93 (now merged) — should now be tractable.
- **D / re-test siblings (2):** #84 (FastAPI DI self-referencing CALLS), #33 (Go service methods zero incoming CALLS). Re-test against the merged #146/#150 first — may already be partially resolved.
- **H / Python & Go typing (5):** #76 (Python methods as Function not Method), #86 (Python parameterCount/returnType not queryable), #83 (Python Interface dup at import sites), #85 (Go IMPLEMENTS not created), #88 (Go interface methods not indexed). #85 likely co-fixes with the merged #20; #83 aligns with the closed #87.
- **I / Cypher engine (5):** #29 (`type()`), #68 (`labels()` empty), #69 (OVERRIDES 0), #73 (cluster `labels()`), #82 (`count{}` parser). Mostly LadybugDB/Kùzu engine limits — triage as document-or-workaround per [[db-is-ladybugdb]].
- **K / traversal (2):** #23 (Spring CALLS resolves to interface not impl), #34 (Spring service context shows only IMPORTS). Corollary of the merged #36/#56 IMPLEMENTS walk.

> Status badges (✅ DONE / ⚠️ PARTIAL) are mirrored on each batch heading below. Original batch plans are retained as the working spec for the remaining 16.

---

## Batch A — Verify-and-Close / Re-enable tests  ✅ DONE (4/4)

These are already fixed by merged PRs, or gated behind a `describe.skip`. Cheapest wins in the backlog.

| # | Title | Evidence | Action |
|---|-------|----------|--------|
| 102 | Go handler→service field chain test returns empty | `go-handler-service.test.ts:13` is `describe.skip(... Issue #19)`; **#19 fix merged** (5a92e58 / #97) | Remove `.skip`, run. Green → close. Red → fix in Batch D-go. |
| 55 | Kotlin annotation test suite skipped | `annotation-extraction.test.ts:211` is `describe.skip('Kotlin')` | Remove `.skip`, run. Fix or close. |
| 21 | impacted_endpoints leaks changes across repos | **#99 merged** (008b7c4); only #101 reverted *project files*, not the fix | Verify guard present, add 1 regression test, close. |
| 51 | detect_changes includes non-code files (CLAUDE.md) | **#103 merged** (ef41fc0 / #24 "non-code files pollute graph"); same root cause | Verify CLAUDE.md no longer surfaces; 1-line filter if it does; close. |

**PR:** `chore/verify-and-close-batch`. **Verify gate:** the two un-skipped suites pass; 2 new
regression tests for #21/#51. Likely closes 3–4 issues for ~half a day of work.

> Re-test note (do **not** schedule blind): **#33, #78, #84** are siblings of just-merged fixes
> (#19 Go CALLS, #18 FastAPI handler self-reference). Re-run their repros against current `main`
> **before** scheduling their batches — they may be partially or fully fixed already. They live in
> Batches D/H below but carry a "re-test first" flag.

---

## Batch B — document-endpoint (single PR, ordered commits)  ⚠️ PARTIAL 12/14 (#45, #15 open)  [HIGH]

All in `src/mcp/local/document-endpoint.ts`. Co-ship; keep the fallback logic isolated per
[[route-fix-regression]]. Sub-groups = commit boundaries.

| Sub | # | Title |
|-----|---|-------|
| B1 error contract | 8 | skeleton response for non-existent paths |
| B1 | 9 | misleading skeleton for FastAPI/Gin repos |
| B1 | 65 | returns **both** error and result body for invalid input *(v1-unplaced)* |
| B1 | 71 | returns **both** error and result for nonexistent path *(v1-unplaced)* |
| B2 HTTP semantics | 22 | wrong HTTP status codes (`confirmed`) |
| B2 | 42 | ignores HTTP method mismatch, returns wrong method |
| B2 | 45 | ai_context resolves wrong downstream HTTP methods |
| B3 schema typing | 39 | `Map<String,Object>` classified as `primitive` (`confirmed`) |
| B3 | 14 | response schema `type:string` for entity endpoints *(v1-unplaced)* |
| B3 | 16 | request body schema `type:object` without fields |
| B3 | 74 | Config Property content = entire remaining file |
| B4 flow/size | 38 | logicFlow duplicate method names (`confirmed`) |
| B4 | 44 | ai_context 157KB+ response *(v1-unplaced)* |
| B4 | 15 | downstream APIs show unresolved code expressions |

**PR:** `bugfix/document-endpoint`. **Dependency:** B2/B5-area overlaps Batch C #93 (downstream
resolution via CALLS graph) — land C #93 first, then B's #45/#15 can reuse the CALLS-based resolver.

---

## Batch C — Spring route extractor (single PR, ordered commits)  ✅ DONE (5/5, PR #144)  [HIGH]

`src/core/ingestion/route-extractors/spring.ts` + `workers/spring-route-extractor.ts`. Must co-ship —
the canonical [[route-fix-regression]] hazard.

| Order | # | Title |
|-------|---|-------|
| 1 | 91 | broken RequestMethod array parsing + missing @PatchMapping |
| 2 | 90 | misses inherited @RequestMapping from non-@RestController base classes |
| 3 | 92 | ignores produces/consumes attributes |
| 4 | 81 | wrong handler for DELETE — DELETE routes not extracted |
| 5 | 93 | downstream APIs use class-name-heuristic instead of CALLS graph |

**PR:** `bugfix/spring-route-extractor`. **Verify gate:** `npx gitnexus analyze` on a Spring fixture;
assert GET/DELETE/PATCH counts match expected. **Unblocks** Batch B #45/#15.

---

## Batch D — New / broken language route extractors  ⚠️ PARTIAL 6/8 (#84, #33 open)  [HIGH]

Independent new files per language → **parallel PRs**. The "endpoints empty" symptoms (#5/#6) are
resolved by the extractor itself.

**D-py** `feature/python-route-extractor` — re-test #78/#84 vs #18 merge first:
| # | Title |
|---|-------|
| 79 | No Python route extractor (FastAPI/Flask) |
| 5 | endpoints empty for FastAPI repos |
| 78 | FastAPI 0 execution flows (sibling of merged #18 — **re-test first**) |
| 84 | FastAPI DI self-referencing CALLS (sibling of merged #18 — **re-test first**) |

**D-go** `feature/go-route-extractor` — re-test #33 vs #19 merge first:
| # | Title |
|---|-------|
| 80 | No Go route extractor (gin.Engine) |
| 6 | endpoints empty for Go/Gin repos |
| 33 | Go service methods zero incoming CALLS (sibling of merged #19 — **re-test first**) |

**D-express** `feature/express-route-extractor` *(v1-unplaced)*:
| # | Title |
|---|-------|
| 70 | No Express/Node.js route extractor (detection exists, extraction missing) |

---

## Batch E — Angular / TypeScript extractor (single PR)  ✅ DONE (8/8, PR #147 + #31)  [HIGH/MED]

| # | Title |
|---|-------|
| 7 | endpoints broken for Angular repos |
| 11 | Route:/app.module typed as Route not Class |
| 31 | Angular CALLS edges invisible in context tool |
| 32 | Angular AppModule no outgoing relationships |
| 43 | Angular endpoints line=-1, missing fields |
| 87 | duplicate Interface nodes at import sites |
| 89 | TypeScript Interface startLine=0 |
| 107 | impact/context: React/TS symbols not indexed (useCallback consts, inner/hook fns, JSX, const/type aliases) *(usage audit)* |

**PR:** `bugfix/angular-ts-extractor`. Note: #87 (TS interface dup) shares logic with #83
(Python interface dup, Batch H) — align the dedup approach across both. #107 is a TS-extractor
indexing gap (symbols absent from the graph) — fold into the same extractor pass.

---

## Batch F — Cross-repo / registry (single PR)  ✅ DONE (7/7, PR #148 + #46/#50)  [HIGH/MED]

| # | Title |
|---|-------|
| 28 | impacted_endpoints inconsistent changed_files format (`confirmed`) — **anchor; land first** |
| 46 | registry artifactId→repoName mismatch |
| 50 | cross-repo resolver 3 stages fail for Maven deps |
| 12 | endpoints tool no `repos` param |
| 47 | CLI query/context crash on multiple repos |
| 49 | impacted_endpoints summary differs single vs multi repo |
| 105 | MCP: auto-resolve repo from cwd → eliminate "Multiple repositories indexed" friction *(usage audit, enhancement)* |

**PR:** `bugfix/cross-repo`. Sequence #28 (format unifier) before #49/#12, which depend on the
unified shape. Builds on the already-merged #21 (Batch A). **#105 and #47 share the multi-repo
resolution root** (~172 occurrences across sessions) — co-fix: a cwd-containment default in
`resolveRepoFromCache` fixes the MCP surface (#105) and the CLI crash (#47) together.

---

## Batch G — Rename accuracy (single PR)  ✅ DONE (6/6, PR #149 + prior #138–140)  [HIGH/MED]

| # | Title |
|---|-------|
| 37 | duplicate edits on same line (`confirmed`) — **anchor** *(moved from v1 Cluster 0)* |
| 63 | wrong line numbers for duplicate occurrences |
| 60 | substring false-positives (getAllBond → getAllBondCategory) |
| 61 | misses definition line + impl for interface method |
| 62 | misses real call sites, finds false positives |
| 72 | class rename misses definition file + most refs |

**PR:** `bugfix/rename-accuracy`. #37+#63 are the same line-resolution code — co-ship. One regression
test per issue (the rename tool already has dedicated coverage to extend).

---

## Batch H — Interface/Class typing & property pollution (single PR)  ⚠️ PARTIAL 4/9 (#76, #83, #85, #86, #88 open)  [MED]

Schema-typing refactor in the Go/Python extractors.

| # | Title |
|---|-------|
| 30 | UserRepository typed as Class not Interface |
| 76 | Python class methods indexed as Function not Method |
| 86 | Python parameterCount/returnType not queryable |
| 83 | Python Interface types duplicated at import sites |
| 20 | Go IMPLEMENTS not tracked struct↔interface |
| 85 | Go IMPLEMENTS not created despite correct types |
| 88 | Go interface methods not indexed |
| 26 | Go struct anonymous fields indexed as own properties |
| 77 | Go anonymous struct fields leak as Properties |

**PR:** `bugfix/interface-typing`. #20/#85 are likely one fix (IMPLEMENTS edge creation);
#26/#77 are one fix (anonymous-field pollution); #83 aligns with #87 (Batch E).

---

## Batch I — Cypher / graph-engine surface  ⚠️ PARTIAL 2/7 (#29, #68, #69, #73, #82 open)  [LOW]

Likely bounded by LadybugDB/Kùzu capability ([[db-is-ladybugdb]]). Triage each as
**"engine can't → document+close"** vs **"client workaround → fix+test."**

| # | Title |
|---|-------|
| 29 | `type()` function not supported |
| 67 | Route node properties inaccessible (only `name`) |
| 68 | `labels()` returns empty strings |
| 69 | OVERRIDES relationship returns 0 |
| 73 | Cluster `resource type:undefined` (labels() on large communities) |
| 82 | `count{}` pattern comprehension parser error |
| 110 | no schema discoverability → agents guess non-existent properties (`fqn`) and misuse `PROPERTIES()` *(usage audit)* |

**PR:** `bugfix/cypher-surface` (whatever is client-fixable) + close-with-doc for engine limits.
#68/#73 share `labels()` root; #67 likely shares it. #110 is distinct — expose the node/relationship
property schema (or a `gitnexus_schema` helper) so agents stop guessing property names.

---

## Batch J — Tool parameter plumbing & quick wins  ✅ DONE (10/10, PR #152)  [LOW/MED]

Scattered small fixes grouped by tool. Several are 1-liners (dead code / validation).

| # | Title | Size |
|---|-------|------|
| 64 | impacted_endpoints `max_depth` ignored *(v1-unplaced)* | small |
| 75 | impact `maxDepth` no effect for Class node | small |
| 66 | impact `minConfidence` accepts out-of-range | 1-line validation |
| 53 | impact ignores `file_path` for overloaded methods | small |
| 10 | impact picks wrong candidate for ambiguous names | med |
| 52 | query `task_context`/`goal` dead code | 1-line / remove |
| 54 | ImportEntry.isExternal/externalRepo dead code | 1-line / remove |
| 57 | query ranks test files above production | small |
| 58 | query `max_symbols` reduces search quality | small |
| 48 | analyze --skip-git on empty dir → 0-node index | small |

**PR:** `bugfix/tool-params`. #64+#75 share the depth-plumbing root — fix together.

---

## Batch K — IMPLEMENTS / CALLS traversal (impact & context)  ⚠️ PARTIAL 3/5 (#23, #34 open)  [MED, architectural]

Shared root: impl classes show no callers because traversal stops at the interface / file-level edge.

| # | Title |
|---|-------|
| 36 | impact empty for impl classes (no IMPLEMENTS walk) |
| 56 | context no incoming callers for impl classes |
| 23 | Spring CALLS resolves to interface not impl |
| 34 | Spring service class context shows only IMPORTS |
| 13 | context incoming refs are file-level IMPORTS not method-level CALLS |

**PR:** `bugfix/implements-calls-traversal`. #36/#56 are one root (IMPLEMENTS walk); #23/#34/#13 are
the CALLS-edge-resolution corollary. One focused architectural PR.

---

## Batch L — Index health & analyze ergonomics (single PR or two)  ✅ DONE (3/3, PR #154 + prior)  [HIGH/MED]

New from the 2026-06-03 cross-session usage audit. Shared theme: the index/analyze lifecycle —
staleness is **silent**, and `analyze` has destructive/noisy side effects.

| # | Title | Sev |
|---|-------|-----|
| 106 | Stale index returns silently wrong/empty results (false-positive CRITICAL, 0 changed symbols) — add freshness diagnostics | high |
| 108 | analyze mutates tracked files (.gitignore/CLAUDE.md/AGENTS.md) and pollutes git staging | med |
| 109 | analyze silently deletes existing embeddings when `--embeddings` omitted (data loss) | med |

**PR:** `bugfix/index-health`. #106 is the high-value one — add a `_diagnostics`/freshness field
(indexed-at commit vs HEAD, schema version, `stale` flag) per [[stale-index-zero-results]], and
distinguish "no match" from "stale" on 0-result responses. #108/#109 are `analyze` CLI fixes
(idempotent/no-op doc writes; preserve embeddings by default) and can co-ship. Keep #108's file-write
changes scoped — do not touch ingestion output ([[route-fix-regression]]).

---

## Recommended sequence

> **As of 2026-06-06:** orders 1–7 are largely DONE. Remaining work is the partials in **B, D, H, I, K** (16 issues — see [Progress — 2026-06-06](#progress--2026-06-06-updated)). Suggested next-session order for the remainder: **D re-test (#84/#33)** → **K (#23/#34)** and **H Go (#85/#88)** (share the IMPLEMENTS/CALLS root) → **B (#45/#15)** (now unblocked by merged #93) → **H Python (#76/#83/#86)** → **I (#29/#68/#69/#73/#82)** (mostly engine-blocked → document-or-workaround).

| Order | Batch | Why |
|-------|-------|-----|
| 1 | **A** Verify/un-skip | Near-zero code; closes 3–4 already-fixed issues; clears noise |
| 2 | **C** Spring route | Biggest payoff, single root; unblocks B |
| 3 | **B** document-endpoint | High user-visible value; depends on C #93 |
| 4 | **G** Rename | Isolated blast radius, existing test harness |
| 5 | **D** / **E** extractors | Parallelizable by language; re-test D-py/D-go vs merges first; E now incl. #107 |
| 6 | **L** Index health | #106 (silent wrong/empty results) is high-value — do early; #108/#109 ergonomics co-ship |
| 7 | **F** Cross-repo · **H** Typing · **K** Traversal | Medium, mostly independent; F now incl. #105 (co-root with #47) |
| 8 | **J** Param plumbing · **I** Cypher | Trivial cleanups or engine-blocked; I now incl. #110 |

**Cadence:** one batch per real working session, **not** a fixed loop tick. 0 closures in 30 days +
a per-PR verify gate ⇒ the bottleneck is review absorption, not fix generation. See
[[project-issue-triage-2026-06-03]].

## Coverage check

All 86 open issues placed exactly once:
A(4) B(14) C(5) D(8) E(8) F(7) G(6) H(9) I(7) J(10) K(5) L(3) = **86**.
(v1's 80 + usage-audit #105→F, #106→L, #107→E, #108→L, #109→L, #110→I.)

**Closure as of 2026-06-06 — 70 closed / 16 open:**
A(4/4) B(12/14) C(5/5) D(6/8) E(8/8) F(7/7) G(6/6) H(4/9) I(2/7) J(10/10) K(3/5) L(3/3) = **70 closed**.
Open 16: **#15, #23, #29, #33, #34, #45, #68, #69, #73, #76, #82, #83, #84, #85, #86, #88.**
(Newer follow-ups outside this triage, also open: #141, #143, #145.)
