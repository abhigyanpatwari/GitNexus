---
title: Open Issues Batch Triage — 2026-06-03
date: 2026-06-03
author: claude
status: superseded
superseded_by: open-issues-batch-2026-06-03-v2.md
scope: 80 open issues, repo ngocvo3103/GitNexus
---

> **Superseded by [open-issues-batch-2026-06-03-v2.md](open-issues-batch-2026-06-03-v2.md).**
> v2 re-batches by "fixable together", places 7 issues missing here (#14 #44 #55 #64 #65 #70 #71),
> and adds a Verify-and-Close batch (#21 #51 #55 #102) derived from the merge log. Use v2.

# Triage of 80 Open Issues

Snapshot: 80 open, 0 closed since 2026-05-04 (~30-day drift, no closing activity).

## Recommended Sequence (Per the User's Workflow Spec)

Honest constraint: the spec's per-issue lifecycle (branch → `/at-planning` → `/wf-implement` + `/verify` → PR + merge) requires 15-45 min per issue for this codebase, with a verify gate that cannot be shortcut. **Fixing all 80 in batch is not feasible in any reasonable loop interval.** This triage groups the 80 into 7 clusters that can be attacked in coherent PRs, with the **confirmed + ready-to-fix cluster first**.

## Cluster 0 — Confirmed & Ready-to-Fix (do FIRST)

All have `confirmed` label, evidence in issue body, and a narrow blast radius. No research required.

| # | Title | Cluster | Notes |
|---|-------|---------|-------|
| 8 | document-endpoint returns skeleton response for non-existent paths | doc-ep | error path: when path not found, return error not skeleton |
| 9 | document-endpoint returns misleading skeleton for FastAPI/Gin repos | doc-ep | FastAPI/Gin → return 422-like stub with explicit `unsupported` flag |
| 22 | document-endpoint wrong HTTP status codes for REST endpoints | doc-ep | 200/201/204 mapping from `@ResponseStatus` / return type |
| 28 | impacted_endpoints inconsistent response format for changed_files | impacted-ep | unify changed_files shape between single/multi repo |
| 21 | impacted_endpoints leaks changes across repos when using repo parameter | impacted-ep | already merged in PR #99 per commit log; verify and close |
| 39 | document-endpoint classifies Map<String,Object> response body as source 'primitive' | doc-ep | source enum: add `map` source |
| 38 | document-endpoint logicFlow contains duplicate method names in call chain | doc-ep | dedupe by (name, file) in logicFlow path |
| 37 | rename tool produces duplicate edits on same line for implementation class | rename | dedupe edit set by line before emit |

**Action:** One PR, label `cluster-0-confirmed`, closes #8 #9 #22 #28 #21 #39 #38 #37.
**Branch:** `bugfix/cluster-0-confirmed`.
**Verify gate:** add 1 regression test per issue before merge.

## Cluster 1 — Spring Route Extractor (HIGH)

All 4 issues touch `src/core/ingestion/route-extractors/spring.ts` and `workers/spring-route-extractor.ts`. They MUST be fixed together to avoid the "route-fix regression" risk flagged in [[route-fix-regression]].

| # | Title | Priority |
|---|-------|----------|
| 91 | Standalone spring.ts has broken RequestMethod array parsing + missing @PatchMapping | high |
| 90 | Spring route extractor misses inherited @RequestMapping from non-@RestController base classes | high |
| 81 | document-endpoint wrong handler for DELETE — DELETE routes not extracted | high |
| 92 | Spring route extractor ignores produces/consumes attributes | medium |
| 93 | document-endpoint downstream APIs use class-name-heuristic instead of CALLS graph | medium |
| 102 | Go handler→service field chain resolution integration test returns empty results | (unlabeled) |

**Action:** One PR per fix is unsafe (regressions). Single PR `bugfix/spring-route-extractor` with ordered commits:
1. `#91` PatchMapping + array parsing
2. `#90` superclass extends walk
3. `#92` produces/consumes
4. `#81` DELETE method coverage
5. `#93` CALLS-graph-based downstream resolution (the *real* root cause for #93)
6. `#102` Go field-chain test (verify added test still empty → fix)

**Verify gate:** run `npx gitnexus analyze` on `tcbs-bond-trading`, assert DELETE/GET counts match expected.

## Cluster 2 — Python/Go Extractor Gaps (HIGH)

| # | Title |
|---|-------|
| 5  | endpoints tool returns empty for FastAPI repos |
| 6  | endpoints tool returns empty for Go/Gin repos |
| 78 | FastAPI repos have 0 execution flows |
| 79 | No Python route extractor (FastAPI/Flask) |
| 80 | No Go route extractor (gin.Engine) |
| 84 | FastAPI DI calls resolve to same-name local function |

**Action:** Two PRs: `feature/python-extractors` (#5/#78/#79/#84), `feature/go-extractor` (#6/#80). The Python one is larger (4 issues) and the Go one is smaller.

## Cluster 3 — Angular Extractor Gaps (HIGH/MEDIUM)

| # | Title |
|---|-------|
| 7  | endpoints tool returns broken data for Angular repos |
| 11 | Angular Route:/app.module incorrectly typed as Route |
| 31 | Angular CALLS edges invisible in context tool |
| 32 | Angular AppModule has no outgoing relationships |
| 43 | Angular endpoints have line=-1 and missing fields |
| 87 | Angular duplicate Interface nodes at import sites |
| 89 | TypeScript Interface startLine=0 |

**Action:** One PR `bugfix/angular-extractor` (likely 4-6 commits).

## Cluster 4 — Cross-Repo / Registry (HIGH/MEDIUM)

| # | Title |
|---|-------|
| 46 | Cross-repo registry artifactId-to-repoName mismatch |
| 50 | Cross-repo resolver 3 stages fail for Maven deps |
| 12 | endpoints tool does not support `repos` param |
| 47 | CLI query/context crash on multiple repos |
| 49 | impacted_endpoints summary format differs single vs multi repo |

**Action:** Single PR `bugfix/cross-repo` after #21/#28 fix the response format.

## Cluster 5 — Rename Tool (HIGH/MEDIUM)

| # | Title |
|---|-------|
| 60 | rename: substring false-positive matches (getAllBond) |
| 61 | rename: misses definition line + impl for interface method |
| 62 | rename: misses call sites, finds false positives |
| 63 | rename: wrong line numbers for duplicates |
| 72 | rename: class rename misses definition file + refs |

**Action:** One PR `bugfix/rename-accuracy`. Add regression test for each.

## Cluster 6 — Graph Schema / Cypher (LOW)

| # | Title |
|---|-------|
| 29 | Cypher `type()` not supported |
| 67 | Cypher Route node properties inaccessible |
| 68 | Cypher `labels()` returns empty |
| 69 | OVERRIDES relationship type returns 0 |
| 73 | Cluster `resource type:undefined` |
| 75 | impact maxDepth no effect for Class |
| 82 | Cypher `count{}` pattern comprehension |
| 66 | impact minConfidence accepts out-of-range |

**Action:** Most likely blocked on `lbug`/LadybugDB limitations. Triage → check engine docs (Cypher reference) → group as either "engine doesn't support, document + close" or "workaround in client, fix + test".

## Cluster 7 — Impact Tool & General (MEDIUM/LOW)

| # | Title |
|---|-------|
| 10 | impact tool picks wrong candidate for ambiguous names |
| 13 | context incoming refs are file-level IMPORTS not method-level CALLS |
| 15 | doc-ep downstream APIs show unresolved code expressions |
| 16 | doc-ep request body schema is `type:object` without fields |
| 23 | Spring CALLS resolves to interface not impl |
| 34 | Spring service class context shows only IMPORTS |
| 36 | impact returns empty for impl classes (no IMPLEMENTS walk) |
| 42 | doc-ep ignores HTTP method mismatch |
| 45 | doc-ep ai_context resolves wrong HTTP methods |
| 51 | detect_changes includes non-code files |
| 52 | query task_context and goal are dead code |
| 53 | impact ignores file_path for overloaded methods |
| 54 | ImportEntry.isExternal/externalRepo dead code |
| 56 | context no incoming callers for impl classes |
| 57 | query ranks test files above production |
| 58 | query max_symbols reduces search quality |
| 74 | Config Property content field = entire remaining file |
| 48 | analyze --skip-git on empty dir creates 0-node index |

**Action:** Mixed bag — some are 1-line fixes (#51, #54, #57), some are architectural (#13/#56 IMPLEMENTS traversal, #15 code expr resolution). Group by file/module, not by cluster.

## Cluster 8 — Interface/Class Typing & Property Pollution (LOW/MEDIUM)

| # | Title |
|---|-------|
| 20 | Go IMPLEMENTS not tracked between structs and interfaces |
| 26 | Go struct anonymous fields indexed as own properties |
| 30 | UserRepository typed as Class instead of Interface |
| 33 | Go service methods zero incoming CALLS |
| 76 | Python class methods indexed as Function not Method |
| 77 | Go anonymous struct fields leak as Properties |
| 83 | Python Interface types duplicated at import sites |
| 85 | Go IMPLEMENTS not created despite correct types |
| 86 | Python parameterCount/returnType not queryable |
| 88 | Go interface methods not indexed |

**Action:** Extractors group — many need schema-typing refactor. Single PR `bugfix/interface-typing`.

---

## Recommended Iteration Plan (Post-Triage)

1. **Now (manual, no loop):** open PR for **Cluster 0** — 8 confirmed-and-ready fixes. Highest ROI, lowest risk.
2. **Next:** Cluster 1 (Spring route extractor) — biggest payoff, single root cause.
3. **Then:** Cluster 5 (rename) — has dedicated tests, isolated blast radius.
4. **Then:** Clusters 2/3/4/8 in parallel by language/area.
5. **Last:** Clusters 6/7 — usually either trivial or blocked on engine.

**Do not loop.** Run 1 cluster per real session, not per 30-min tick. The cadence the user proposed assumes a code review rate the maintainer hasn't shown evidence of being able to absorb.

## Memory Updates

- Add `project/issue-triage-2026-06-03.md` referencing this doc (cluster table, recommended sequence).
- Update `feedback/route-fix-regression.md` to confirm this triage is the canonical reference for why Spring route fixes must stay co-shipped.
