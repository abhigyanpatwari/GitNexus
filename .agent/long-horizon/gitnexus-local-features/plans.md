# GitNexus Local Features - Plans

Created: 2026-06-05

## Operating Notes

- This is a long-horizon Codex task using the four-file control surface in this directory.
- The source repo bundle is canonical. Old planning files in `C:\Users\steve\podman\gitnexus` are legacy source material only.
- Use branch `local/gitnexus-local-features` for all approved feature work.
- Implement one feature at a time on the shared branch.
- Run the work through one active feature Goal at a time; each feature's Goal Contract is below.
- Goal lifecycle is sequential: finish the current readiness or implementation Goal, mark it complete, then create the next Goal only after the next feature/slice boundary is known. Do not pre-create a backlog of active Goals.
- Each Goal Contract below uses the strong six-part form: outcome, verification surface, constraints, boundaries, iteration policy, and blocked stop condition.
- Non-interactive `codex exec` worker runs must repeat the active Goal Contract and point to this four-file bundle before acting.
- Comprehensive feature map: `feature-map.md` is the single-place map for feature status, dependencies, source surfaces, tests, gates, evidence files, and next actions.
- Treat the shared branch as a small-batch lane, not a dumping ground: keep WIP to one implementation feature, verify each slice, and checkpoint before moving to the next feature.
- Implementation is blocked until `MAIN | READY_FOR_IMPLEMENTATION` names the accepted write scope.
- MAIN has granted standing conditional authorization to implement each feature Goal after its readiness/research map is complete, but only for the exact documented slice and write set. If readiness changes the slice, broadens the write set, or exposes a higher-risk architecture path, stop and document the new approval boundary before editing.
- Once implementation is approved, follow TDD for behavior changes: write one focused failing test, verify the red failure, implement the smallest code to pass, verify green, then refactor while tests stay green.
- Research is feature-wide across all seven candidates. Auto-Reindexing currently receives decision-grade depth because it is the likely first implementation slice, but branch/lane strategy, dependency shape, and sequencing must be derived from the whole feature map.
- Research method is coordinated across methodology, public feature intent, GitHub PR/issue evidence, Context7/official docs, and local source/graph evidence. Do not promote a feature to implementation from one source class alone.
- Interim router cleanup is complete: bare `gitnexus` no longer routes secretly through the Podman helper. Use `gitnexus-podman` explicitly for Podman-backed GitNexus checks.
- `plan.md`, `gitnexus-router-indexing-note.md`, and the scratchpad are subordinate evidence only. They are not live control files and must not override this queue or `documentation.md`.
- Current multi-repo planning must separate CLI, MCP tools, and MCP resources: CLI still has `gitnexus group query/contracts/status`; MCP uses group-mode `query`, `context`, and `impact` plus `group_list`/`group_sync`; group contracts/status are MCP resources. Do not plan from stale tables that present `group_query`, `group_contracts`, or `group_status` as current MCP tools.
- PR Review / Blast Radius should be report-first. Existing PR review and PR swarm materials are read-only methods, not an automated GitHub PR-review product; GitHub posting/check automation is security-sensitive and later.
- Current execution tranche: Task 1 Auto-Reindexing, Task 2 Auto-Updating Code Wiki, and Task 3 Multi-Repo Support Improvements have completed their first local slices. Task 4 PR Impact / Blast Radius readiness is complete; Task 4 source work waits for a snapshot/no-snapshot boundary and the exact implementation Goal.
- WIP boundary resolved: checkpoint commit `568e24de` (`checkpoint local features through task 4 readiness`) was created on 2026-06-06T12:17+01:00. Task 4 report-core implementation is now complete locally; the next sequential Goal should be a thin `gitnexus pr-impact` CLI wrapper if MAIN wants CLI exposure.

## Feature Queue

| Order | Feature | Research depth | Disposition | Current implementation status |
| --- | --- | --- | --- | --- |
| 1 | Auto-Reindexing | `decision-grade now` | `now` | Approved slice implemented locally; verification passed; unsnapshotted |
| 2 | Auto-Updating Code Wiki | `medium now` | `now` | Core status/dry-run-first planner/runner implemented locally; no server/API wiring yet |
| 3 | Multi-Repo Support Improvements | `light scoping only` | `next tranche` | Scope to current group/status/contracts/docs/tool-surface reconciliation; no unified graph expansion |
| 4 | PR Impact / Blast Radius | `medium now` | `now - readiness active` | Tight V1 brainstorm exists; readiness refresh maps exact source/test/report boundary before source work |
| 5 | Auto Regression Forensics | `light scoping only` | `defer` | Research-only; waits for PR impact/risk schema or MAIN reprioritization |
| 6 | End-to-End Test Generation | `light scoping only` | `defer` | Research-only; waits for PR impact/test-gap model and app/runtime contract |
| 7 | OCaml Support | `light scoping only` | `defer` | Research-only |

## Feature Goal Contracts

The Feature Queue above is the authoritative execution order. Goal contracts below may retain previously drafted readiness material, but their heading numbers and the queue control the order of work.

### Goal 1 - Auto-Reindexing

Outcome:

- Produce an opt-in, non-hook Auto-Reindexing slice that prevents registered repository indexes from silently going stale by using validated repo registry data, commit-staleness checks, existing reindex queue semantics, dry-run safety, and operation visibility.

Verification surface:

- Focused tests for stale repo selection, fresh repo skip, dry-run no-op, coalescing, invalid registry handling, explicit auto/freshness operation trigger, and watcher failure not blocking sweep recovery.

Constraints:

- No Git hooks as the implementation route.
- No new dependency without MAIN approval.
- Native file watching may accelerate later, but sweep/staleness must be the correctness mechanism.

Boundaries:

- Use branch `local/gitnexus-local-features`.
- Read from the four-file bundle, `enterprise-feature-intended-functions-scratchpad.md`, local source/tests, official docs, GitHub issues/PRs, Context7, and GitNexus graph queries.
- Likely source ownership is limited to server reindex/freshness surfaces unless MAIN expands the write set.
- Use bare `gitnexus` for host graph/source checks and `gitnexus-podman` only for Podman-backed runtime/index checks.

Iteration policy:

- First reconcile expected behavior, current local behavior, dependency shape, and test surface.
- Draft a decision-complete implementation plan before source edits.
- After MAIN approval, proceed TDD one behavior at a time: red test, minimal green implementation, focused verification, then refactor.
- After each checkpoint, record commands, evidence, files changed, verification, blockers, and next step in `documentation.md`.

Blocked stop condition:

- Stop if the implementation would require hooks, a new dependency, native watcher correctness, public API changes outside the approved scope, or source edits before `MAIN | READY_FOR_IMPLEMENTATION`.
- Report attempted paths, evidence gathered, blocker, and exact MAIN input needed to continue.

### Goal 4 - PR Impact / Blast Radius

Outcome:

- Produce a local report-first PR impact/blast-radius workflow using deterministic diff-to-graph primitives before any GitHub posting, check automation, Codex remediation, or generated tests.

Verification surface:

- Focused tests around `detect_changes`, `impact`, `api_impact`, report formatting, and read-only PR-swarm review references.

Constraints:

- Do not create GitHub comments, checks, or privileged workflow automation until the security and permission model is approved.
- Treat existing PR swarm materials as read-only methodology references.

Boundaries:

- Use existing GitNexus diff/impact primitives, `pr-swarm-review/`, global `gitnexus-pr-review` skill guidance, local tests, GitHub Actions/security docs, and public PR/issue evidence.
- Keep the first implementation candidate local Markdown/JSON report-only unless MAIN later approves GitHub integration.

Iteration policy:

- Reconcile current primitives with desired PR-review behavior, then define report schema, source ownership, and security boundary.
- Do not move to GitHub posting until local report behavior is verified and permission risks are documented.
- After each checkpoint, document evidence and whether the feature remains paused behind Tasks 1-3.

Blocked stop condition:

- Stop if the feature needs fresh graph behavior that Task 1 has not provided, privileged GitHub automation, or an unapproved security model.
- Report missing freshness, schema, permission, or test evidence needed to continue.

### Task 4 Readiness Refresh - PR Impact / Blast Radius

Timestamp: 2026-06-06T11:10+01:00

Readiness outcome:

- V1 should be a local deterministic `pr-impact` report, not a GitHub PR bot.
- Core pipeline remains `diff ranges -> symbols -> impact -> report`.
- Existing GitNexus primitives cover much of the pipeline, but deletion handling, unmatched ranges, report schema, and fixture/golden acceptance need explicit first-class code.
- Source implementation should not start until the current Task 1/Task 2 source WIP has a deliberate snapshot/commit boundary or MAIN records an explicit no-snapshot decision.

Expected vs actual:

| V1 expectation | Current local behavior | Readiness conclusion |
| --- | --- | --- |
| Parse local compare/staged/unstaged diff into file/range evidence | `parseDiffHunks()` parses `git diff -U0` new-side ranges for `detect_changes` | Reuse/extend, but V1 needs richer range records than current new-side-only hunk shape |
| Map changed ranges to graph symbols | `detectChanges()` overlaps parsed hunks with indexed `startLine`/`endLine` and returns `changed_symbols` | Existing logic is useful, but it is private and drops unmatched ranges from the visible result |
| Surface changed ranges with no symbol match | Current `detect_changes` reports only matched symbols and affected processes | V1 must keep unmatched file/range evidence and treat it as `UNKNOWN` or `NEEDS_DISCUSSION` input |
| Handle deleted symbols | `parseDiffHunks()` skips pure-deletion hunks because new-side count is 0 | V1 needs old-side deletion range support and base-graph lookup before it can claim deleted-symbol impact |
| Traverse symbol impact with depth and cycle guard | `impact` uses BFS, visited-set cycle guard, `maxDepth`, per-depth output, summary, pagination, risk, process/module enrichment | Reuse `impact` semantics; V1 report default should request depth 5 and visibly distinguish direct vs transitive callers |
| Add API/route risk where graph evidence exists | `api_impact`, `route_map`, and `shape_check` exist and are tested | V1 should render API sections only when changed symbols/files map to route/API evidence |
| Emit deterministic Markdown/JSON | No `pr-impact` report command or report schema exists | First source slice should add a report builder with experimental `schema_version` and golden tests |
| Approximate test signal conservatively | `impact` can include/exclude test files; no PR test-reference field exists | V1 should add graph-derived `has_test_reference` / `unknown_or_unreferenced`, not true coverage claims |
| Post PR comments/checks | No current V1 support, and this is security-sensitive | Defer to later GitHub automation phase |

Source ownership map:

| Area | Current source/test surface | V1 use |
| --- | --- | --- |
| CLI command registration | `gitnexus/src/cli/index.ts`, `gitnexus/src/cli/tool.ts`, `gitnexus/test/unit/tool-direct-cli.test.ts`, `gitnexus/test/unit/cli-index-help.test.ts` | Add `pr-impact` command only after report core is tested |
| Diff parsing | `gitnexus/src/storage/git.ts`, `gitnexus/test/unit/parse-diff-hunks.test.ts` | Extend or wrap diff parsing for new/old side ranges, deletions, and unmatched range retention |
| Range-to-symbol mapping | `gitnexus/src/mcp/local/local-backend.ts::detectChanges`, `gitnexus/test/unit/detect-changes-worktree.test.ts`, `gitnexus/test/unit/calltool-dispatch.test.ts` | Extract or mirror a focused helper rather than embedding report logic inside `detectChanges()` |
| Impact traversal | `gitnexus/src/mcp/local/local-backend.ts::impact/_runImpactBFS`, `gitnexus/test/unit/impact-confidence.test.ts`, `gitnexus/test/unit/impact-pagination.test.ts` | Reuse through `LocalBackend.callTool('impact')` or a small internal adapter |
| API/route evidence | `route_map`, `shape_check`, `api_impact` in `local-backend.ts`, `gitnexus/test/integration/api-impact-e2e.test.ts`, `gitnexus/test/fixtures/api-impact-seed.ts` | Optional report sections only when graph evidence exists |
| MCP tool schema | `gitnexus/src/mcp/tools.ts`, `gitnexus/test/unit/tools.test.ts` | Keep MCP `pr-impact` out of V1 unless CLI proves useful and MAIN expands scope |
| PR review methods | `pr-swarm-review/`, `C:\Users\steve\.agents\skills\gitnexus-pr-review\SKILL.md` | Read-only methodology/reference material, not automation source |

Smallest safe first implementation slice:

- Add an internal PR Impact report core that accepts deterministic fixture inputs and returns JSON plus Markdown.
- Preserve the V1 fields: `schema_version`, input diff metadata, mapped symbols, unmatched ranges, new/unmapped symbols, deleted symbols, impact summaries, optional API evidence, test-reference approximation, verdict, caveats, and source freshness/status.
- Add a CLI wrapper `gitnexus pr-impact` only after report-core golden tests pass.
- Keep MCP exposure, GitHub PR URL ingestion, GitHub comments/checks, Codex remediation, generated tests, and web UI out of the first slice.

Suggested first write set after snapshot/no-snapshot gate:

| File | Purpose |
| --- | --- |
| `gitnexus/src/core/pr-impact/report.ts` | Deterministic schema, verdict, Markdown/JSON formatting, optional-section rendering |
| `gitnexus/src/core/pr-impact/diff-mapping.ts` | Reusable diff range model and range-to-symbol mapping helper if extraction proves cleaner than expanding `detectChanges()` |
| `gitnexus/src/cli/pr-impact.ts` | Thin CLI orchestration over existing backend tools and report core |
| `gitnexus/src/cli/index.ts` | Register `pr-impact` command |
| `gitnexus/src/cli/help-i18n.ts` and locale files | CLI help text, only if command is registered |
| `gitnexus/test/unit/pr-impact-report.test.ts` | Golden JSON/Markdown, verdict rules, optional sections |
| `gitnexus/test/unit/pr-impact-diff-mapping.test.ts` | Deleted symbols, unmatched ranges, new symbols, range overlap |
| `gitnexus/test/fixtures/pr-impact/*` | Checked-in fixture diffs and golden reports |

Implementation checkpoint:

- 2026-06-06T12:23+01:00: Report core and diff-mapping helper implemented with TDD.
- Implemented files:
  - `gitnexus/src/core/pr-impact/report.ts`
  - `gitnexus/src/core/pr-impact/diff-mapping.ts`
  - `gitnexus/test/unit/pr-impact-report.test.ts`
  - `gitnexus/test/unit/pr-impact-diff-mapping.test.ts`
  - `gitnexus/test/fixtures/pr-impact/golden-basic-report.md`
- Verification passed:
  - focused PR Impact tests: 2 files, 7 tests
  - nearby diff/impact/API baseline: 7 files, 91 tests
  - `git diff --check`
  - `npm run build`
- CLI wrapper not implemented yet.

Focused test plan:

1. Red test for report JSON schema including `schema_version`.
2. Red test for deterministic Markdown golden output.
3. Red test for unmatched changed ranges being retained.
4. Red test for pure deletion hunks resolving against base graph evidence or yielding explicit `UNKNOWN`.
5. Red test for new symbols being reported without inbound-caller claims.
6. Red test for optional sections rendering only when evidence exists.
7. Red test for verdict rules: `BLOCK`, `NEEDS_DISCUSSION`, `PROCEED`, `UNKNOWN`.
8. Red test for traversal depth reporting and hop cap behavior.
9. CLI smoke tests only after report core passes.

Risks and stop rules:

- Stop if deletion handling requires a new base-index architecture rather than a small old-side range lookup.
- Stop if the first slice would require GitHub tokens, Actions, comments, checks, PR URL ingestion, or hosted UI.
- Stop if `detect_changes` must be rewritten broadly instead of extracting a narrow helper.
- Stop if source work would begin before the Task 1/Task 2/Task 3 WIP snapshot/no-snapshot boundary is resolved.
- Stop if the report cannot distinguish graph evidence from inference.

Implementation approval boundary to use after readiness:

```text
MAIN | READY_FOR_IMPLEMENTATION
Feature: PR Impact / Blast Radius
Branch/worktree: C:\Users\steve\projects\gitnexus\source-rc109-integration on local/gitnexus-local-features
Approved slice: local deterministic PR Impact V1 report core plus optional thin `gitnexus pr-impact` CLI wrapper after report-core tests pass. The slice may reuse existing `detect_changes`, `impact`, `api_impact`, `route_map`, and `shape_check` behavior, add fixture/golden Markdown and JSON tests, and add internal helpers for diff range mapping, unmatched ranges, deleted symbols, new/unmapped symbols, test-reference approximation, optional sections, and deterministic verdicts.
Approved write set:
- gitnexus/src/core/pr-impact/report.ts
- gitnexus/src/core/pr-impact/diff-mapping.ts if needed
- gitnexus/src/cli/pr-impact.ts
- gitnexus/src/cli/index.ts
- gitnexus/src/cli/help-i18n.ts and locale files only if CLI help is registered
- gitnexus/test/unit/pr-impact-report.test.ts
- gitnexus/test/unit/pr-impact-diff-mapping.test.ts
- gitnexus/test/fixtures/pr-impact/*
Constraints: no GitHub PR comments/checks, no GitHub token automation, no MCP tool exposure in V1, no web UI, no generated tests/remediation, no new dependency without approval, no broad rewrite of `detect_changes`, and TDD required.
Prerequisite: resolve the current WIP snapshot/no-snapshot boundary before source edits.
```

### Goal 2 - Auto-Updating Code Wiki

Outcome:

- Produce a decision-complete Task 2 Auto-Updating Code Wiki readiness plan, then later implement a refresh workflow around the existing Code Wiki generator only after graph freshness, LLM/provider policy, and MAIN approval are explicit.

Verification surface:

- A documented expected-vs-actual table, source ownership map, dependency map from Task 1 freshness, provider/cost/publication policy questions, smallest safe implementation slice, focused TDD plan, risks/stop rules, and refreshed focused wiki baseline tests where useful.
- Existing focused wiki tests for flags, grouping, Mermaid sanitization, LLM client behavior, and any future refresh orchestration tests remain the implementation verification surface once MAIN opens source work.

Constraints:

- Do not rebuild the wiki generator from scratch.
- Do not run unattended LLM generation without explicit provider, cost, and publication policy.
- Do not edit source during the readiness Goal.
- Do not publish, overwrite, or regenerate user-facing wiki artifacts during readiness unless MAIN explicitly asks.

Boundaries:

- Use existing wiki generator/source, wiki tests, provider/LLM config surfaces, freshness/reindex evidence, and documentation output behavior.
- Keep first work to refresh orchestration and status visibility after graph freshness exists.
- Use the four-file bundle, `enterprise-feature-intended-functions-scratchpad.md`, local wiki source/tests, GitNexus graph queries, public GitNexus README/issues/PRs, and official/Codex docs when relevant.

Iteration policy:

- Confirm generator capability, then define trigger policy, skip behavior, provider readiness checks, and output/operation visibility.
- Re-check dependency on Auto-Reindexing before any implementation plan.
- After each checkpoint, record provider/cost/publication assumptions and unresolved approvals.
- First complete safe precursor tasks: review current WIP boundary, inspect wiki source/tests, refresh the evidence table, and draft the Task 2 approval boundary.
- If evidence shows the feature cannot be safely sequenced after Task 1, record the blocker and do not force implementation.

Blocked stop condition:

- Stop if freshness is not available, LLM/provider policy is missing, publication/cost behavior is ambiguous, user-facing output mutation would be required for research, or MAIN has not approved source writes.
- Report the exact policy or dependency needed to continue.

### Goal 5 - Auto Regression Forensics

Outcome:

- Scope a future regression-forensics workflow that can explain failures from known-good, known-bad, test/CI evidence, and GitNexus graph context.

Verification surface:

- Evidence notes from local `eval/` infrastructure, Git history/bisect analogues, CI failure surfaces, and graph/report dependencies.

Constraints:

- Research-only for now.
- Do not implement until PR Impact / Blast Radius has a stable report schema or MAIN expands scope.

Boundaries:

- Use local `eval/`, test/CI artifacts, Git history/bisect references, graph impact evidence, and public regression-forensics analogues.
- Keep this goal to scoping and evidence contracts.

Iteration policy:

- Identify required failure evidence first, then map dependencies on PR reports, CI data, and graph freshness.
- Produce a defer/next verdict with missing prerequisites rather than designing implementation from thin evidence.

Blocked stop condition:

- Stop if no failing-test/known-good/known-bad evidence contract can be defined or if implementation would start before dependent report/schema work exists.
- Report the missing evidence model or dependency that would unlock progress.

### Goal 6 - End-to-End Test Generation

Outcome:

- Scope a future E2E test-generation workflow that can propose or create tests from routes, execution flows, changed surfaces, and an explicit test framework/runtime contract.

Verification surface:

- Evidence from existing E2E tests, route/tool maps, browser/test-framework docs, and PR/regression report dependencies.

Constraints:

- Research-only for now.
- Do not generate tests without an approved target app, framework, and execution environment.

Boundaries:

- Use existing E2E tests, route maps, execution-flow evidence, browser/test-framework docs, and safety constraints around secrets, preview URLs, and generated tests.
- Keep this goal to scoping until MAIN names a target app and test framework.

Iteration policy:

- First identify the launch surface and target framework, then define fixture, sandbox, and verification requirements.
- Map dependencies on PR/blast-radius reports and regression-forensics evidence before proposing implementation.

Blocked stop condition:

- Stop if there is no approved app launch surface, target framework, runtime, fixture policy, or secrets/sandbox policy.
- Report the exact runtime/test contract needed before generation is defensible.

### Goal 3 - Multi-Repo Support Improvements

Outcome:

- Reconcile current multi-repo/group support with stale docs/tool tables and identify the smallest useful improvement to group/status/contract ergonomics.

Verification surface:

- Local source, `ARCHITECTURE.md`, group tests, group resources, and graph queries using `--repo gitnexus-local-features` when needed.

Constraints:

- Do not assume a new unified cross-repo graph project unless MAIN expands scope.
- Do not plan from stale `group_query`, `group_contracts`, or `group_status` tool tables.

Boundaries:

- Use current group source/tests, `ARCHITECTURE.md`, MCP resources, CLI group commands, host graph queries, and stale docs/tool tables as reconciliation evidence.
- Keep likely work to docs/API-surface reconciliation or group/status ergonomics unless MAIN expands scope.

Iteration policy:

- Separate current source truth from stale public/internal tables, then identify the smallest concrete improvement.
- Prefer correcting guidance and ergonomics before proposing large architecture changes.

Blocked stop condition:

- Stop if the desired improvement requires a unified cross-repo graph, broad API redesign, or source behavior change not approved by MAIN.
- Report the specific stale surface, current source truth, and approval needed.

### Goal 7 - OCaml Support

Outcome:

- Scope OCaml as a language-provider/parser onboarding project rather than a minor config toggle.

Verification surface:

- Local language registry/source, parser availability evidence, provider patterns, fixture expectations, and migration/parity tests.

Constraints:

- Research-only for now.
- Do not add parser dependencies or language-provider source without MAIN approval.

Boundaries:

- Use local language registry/source, existing language-provider patterns, parser availability evidence, fixture/test expectations, and dependency policy.
- Keep this goal separate from Auto-Reindexing, PR Review, and Wiki implementation work.

Iteration policy:

- Map parser/provider/source gaps first, then estimate fixture, query, resolver, and parity-test burden.
- Produce a defer/next verdict and implementation prerequisites rather than adding dependencies or source code.

Blocked stop condition:

- Stop if parser dependency, provider scope, fixture burden, or parity requirements are unclear or unapproved.
- Report the dependency and language-onboarding approvals needed to continue.

## Interim Task - Disable Hidden Bare-GitNexus Router

Status: completed on 2026-06-05

Objective:

- Remove workstation ambiguity before feature implementation by quarantining the hidden bare-`gitnexus` router.

Result:

- `C:\Users\steve\.local\bin\gitnexus.cmd` and `C:\Users\steve\.local\bin\gitnexus.py` were renamed to date-stamped disabled files.
- `gitnexus-podman` remains the explicit rc.109 Podman route.
- Bare `gitnexus` now exposes the host/npm CLI at `1.6.6-rc.109`; the redundant `gitnexus-host` helper is quarantined.
- Normal runtime health on `127.0.0.1:4747` remained OK.
- Evidence is preserved in `plan.md` and `gitnexus-router-indexing-note.md`. Those files are historical evidence only, not additional control files.

## Task 0 - Version The Planning Bundle

Status: complete locally, pending snapshot/commit

Objective:

- Move the canonical long-horizon control surface into the source repo so planning and implementation cannot drift apart.

Acceptance criteria:

- `prompt.md`, `plans.md`, `implement.md`, and `documentation.md` exist under `.agent/long-horizon/gitnexus-local-features/`.
- Files name `local/gitnexus-local-features` as the shared branch.
- Files state no Git hooks and no source implementation before `MAIN | READY_FOR_IMPLEMENTATION`.
- Git status shows only intended planning-file additions.

Validation:

- `git status --short --branch`
- `rg -n "local/gitnexus-local-features|READY_FOR_IMPLEMENTATION|Git hooks|podman" .agent/long-horizon/gitnexus-local-features`

Remaining snapshot requirement:

- The four-file bundle is not fully done until the intended planning artifacts are committed or otherwise explicitly snapshotted.
- Current unsnapshotted docs/planning artifacts must be reviewed before any source implementation starts.

## Task 0.5 - Snapshot The Planning Bundle And Current Feature WIP

Status: pending

Objective:

- Create an explicit snapshot boundary for the current docs/planning artifacts plus implemented Auto-Reindexing and Auto-Updating Code Wiki slices before starting further feature source implementation.

Acceptance criteria:

- The chosen planning and source artifacts are committed, or the user records a deliberate no-commit decision.
- Auto-Reindexing and Auto-Updating Code Wiki source/test additions are no longer ambiguous WIP before the next source feature starts.
- `git status --short --branch` no longer leaves the inter-feature boundary ambiguous.

## Task 1 - Auto-Reindexing

Status: approved slice implemented locally on 2026-06-05T17:13+01:00; focused tests and build passed

Objective:

- Add opt-in, non-hook, server-side freshness orchestration so registered repository indexes do not silently go stale.

Expanded research checkpoint:

- 2026-06-05: Decision-grade readiness research increased using Superpowers/research discipline, local source inspection, Context7/official Node docs, GitHub PR/issue evidence, and focused test-surface review.
- 2026-06-05T10:39+01:00: Coordinated feature-wide research tranche continued with objective timestamps, local file/graph checks, GitHub PR/issue evidence, official Node/GitHub Actions docs, DORA methodology sources, and OpenAI Codex planning guidance. Scratchpad records the detailed source matrix.
- 2026-06-05T10:49+01:00: Coordinated continuation reinforced the operating model: one shared branch is acceptable only with WIP limit one, small verified slices, and documented checkpoints; Auto-Reindexing remains the first candidate because it has concrete local primitives and the highest staleness impact.
- 2026-06-05T10:55+01:00: GitHub PR/issue evidence sharpened the intended function: OSS PostToolUse behavior is notification-only and intentionally distinct from Enterprise Auto-reindexing; our local feature must not revive hidden hook-triggered analyze as the implementation path.

Expected behavior:

- Detect stale registered repos through existing Git commit/index metadata.
- Reuse existing reindex API/queue semantics instead of creating a parallel reindex path.
- Default disabled or dry-run until explicitly enabled.
- Provide enough observable state for verification.
- Treat native filesystem watching as optional acceleration only, not the correctness mechanism.
- Context7 `/nodejs/node` corroborates the Node filesystem watcher caveat: `fs.watch` can be inconsistent or unavailable, and polling fallbacks are slower/less reliable. Auto-Reindexing correctness must be sweep/staleness based.

Recommended first implementation slice:

- Wire an opt-in server-side freshness orchestrator around existing registered repos, staleness checks, scheduler, queue, and operation ledger.
- Run periodic sweep/staleness detection first; do not depend on native file events for correctness.
- Use `listRegisteredRepos({ validate: true })` for validated registry loading before selecting targets.
- Use `checkStalenessAsync(entry.path, entry.lastCommit)` as the freshness primitive to select stale repos.
- Dispatch reindex work through the existing `ReindexQueue` and `startReindexJob` pathway by first defining an explicit server-local helper boundary in the decision-complete implementation plan.
- Do not call the HTTP API from inside the server process.
- Extend `ReindexTrigger` with an explicit auto/freshness trigger name chosen in the decision-complete implementation plan.
- Keep dry-run default true and enabled default false unless MAIN explicitly changes the rollout policy.

Required pre-implementation plan:

- Draft a decision-complete Auto-Reindexing implementation plan before source edits. Status: complete locally on 2026-06-05T16:31+01:00.
- The plan must name the exact write set, helper boundary, trigger name, test files, expected API/operation visibility, dry-run behavior, failure handling, and acceptance criteria.
- The plan must order the first implementation slice as a TDD sequence: baseline focused tests, first failing test, red verification, smallest green implementation, focused green verification, refactor, then the next failing test.
- No agent should start Auto-Reindexing source edits from this Task 1 text alone.

### Auto-Reindexing Decision-Complete Implementation Plan

Readiness verdict:

- MAIN approval granted by the human operator on 2026-06-05T17:05+01:00.
- Approved source mutation was completed for the Auto-Reindexing slice on 2026-06-05T17:13+01:00.

Expected vs actual behavior:

| Area | Expected first-slice behavior | Pre-implementation local behavior | Plan/implementation response |
| --- | --- | --- | --- |
| Stale repo detection | Registered repos that are behind `HEAD` are found proactively. | `checkStalenessAsync(entry.path, entry.lastCommit)` exists, but server does not run a proactive registered-repo sweep. | Add an opt-in server sweep that loads validated registry entries and checks commit staleness. |
| Fresh repo handling | Fresh repos are skipped without scheduling reindex. | Staleness primitive returns `isStale: false`; no scheduler uses it for registered repos. | Pure sweep helper must return skipped/fresh counts and not call queue/start on fresh entries. |
| Registry safety | Invalid/stale registry entries do not schedule jobs. | `listRegisteredRepos({ validate: true })` prunes entries whose `meta.json` is missing. | Auto sweep must use `validate: true`; do not read raw registry directly. |
| Reindex execution | Reuse existing API/queue semantics; do not create a parallel worker path. | `api.ts` has route-local `startReindexJob`, `ReindexQueue`, `ReindexOperationRegistry`, operation logs, and backend refresh. | Keep execution in server-local helper boundary around `startReindexJob`; do not call `/api/reindex` over HTTP from inside the server. |
| Dry-run safety | Disabled or dry-run by default. | `readReindexWatcherConfigFromEnv` defaults to `enabled: false` and `dryRun: true`. | Preserve those defaults; dry-run logs/records intent but starts no job. |
| Observability | Auto work is distinguishable from direct user reindex and pending rerun. | `ReindexTrigger` is currently `direct` or `pending-rerun`. | Add trigger `auto-reindex`; expose it through existing operation records, GET filters, and logs. |
| Queue/coalescing | Same-repo duplicate requests coalesce; different repo concurrency remains bounded. | `ReindexQueue` already coalesces same repo and rejects different repo when one is active. | Auto sweep must go through `ReindexQueue.request(repoKey)` before `startReindexJob`. |
| Watcher correctness | Native watch events may accelerate later but cannot be correctness-critical. | `ReindexWatcherScheduler` can record dirty repos, but no reliable native watcher integration is required. | First slice is periodic commit-staleness sweep only; no hooks and no new watcher dependency. |

Proposed first implementation slice:

- Add an opt-in server-side auto-reindex sweep that periodically inspects validated registered repos and starts reindex jobs only for stale entries.
- Use existing env names and defaults from `readReindexWatcherConfigFromEnv`:
  - `GITNEXUS_REINDEX_WATCHER=false` by default.
  - `GITNEXUS_REINDEX_WATCHER_DRY_RUN=true` by default.
  - `GITNEXUS_REINDEX_WATCHER_SWEEP_MS=60000` by default.
  - `GITNEXUS_REINDEX_WATCHER_EMBEDDINGS=true` by default.
- Treat the env name as legacy/internal naming for the existing watcher config. Do not introduce a new dependency or hooks.

Proposed write set if MAIN approves:

- `gitnexus/src/server/reindex-auto-sweep.ts` - new pure/helper module for validated-entry sweep planning, stale/fresh/invalid result shaping, and small testable orchestration helpers.
- `gitnexus/src/server/reindex-operations.ts` - extend `REINDEX_OPERATION_TRIGGERS` with `auto-reindex`.
- `gitnexus/src/server/api.ts` - wire the opt-in sweep into server startup after `startReindexJob` exists; use `listRegisteredRepos({ validate: true })`, `checkStalenessAsync`, `ReindexQueue`, and `startReindexJob(..., { trigger: 'auto-reindex' })`.
- `gitnexus/test/unit/reindex-auto-sweep.test.ts` - new focused unit tests for stale selection, fresh skip, dry-run behavior, and invalid/staleness-error handling.
- `gitnexus/test/unit/reindex-api-wiring.test.ts` - add source-wiring assertions for validated registry load, no internal HTTP self-call, auto trigger, and dry-run default.
- `gitnexus/test/unit/reindex-operations.test.ts` - add trigger validation/list-filter coverage for `auto-reindex`.
- `gitnexus/test/unit/reindex-watcher.test.ts` - extend only if the implementation reuses scheduler behavior directly; otherwise leave this file as baseline coverage.

Files explicitly out of scope for the first slice:

- Git hooks, `hooks/`, generated editor setup, and generated AGENTS/CLAUDE text.
- Docker/Podman compose files and embedding sidecar configuration.
- Web UI changes.
- PR Review / Blast Radius and Code Wiki refresh orchestration.
- New dependencies such as Chokidar.

Helper boundary:

- Keep `startReindexJob` private to server startup for now, but introduce a small server-local auto-sweep helper that receives callbacks instead of importing Express or making HTTP calls.
- The helper should accept:
  - validated repo loader
  - async staleness checker
  - queue request/status functions
  - `startReindex` callback
  - logger or event callback
  - config with `enabled`, `dryRun`, `sweepMs`, and `embeddings`
- If this proves too awkward because `startReindexJob` is route-local inside `api.ts`, the first implementation step should be extracting only the minimum callback-friendly helper, not moving the full worker implementation wholesale.

TDD sequence:

1. Baseline: run `npm test -- test/unit/reindex-watcher.test.ts test/unit/reindex-control.test.ts test/unit/reindex-operations.test.ts test/unit/reindex-api-wiring.test.ts test/unit/reindex-freshness-wiring.test.ts test/unit/staleness.test.ts`.
2. Red 1: add `reindex-auto-sweep.test.ts` proving a stale validated repo is selected and fresh repo is skipped.
3. Green 1: implement pure stale-selection helper using injected `checkStalenessAsync`-compatible callback.
4. Red 2: add dry-run no-op test proving no `startReindex` callback fires while the intended action is reported/logged.
5. Green 2: wire dry-run branch.
6. Red 3: add queue behavior tests for same-repo coalescing and different-repo active rejection through injected queue callback results.
7. Green 3: route sweep starts through queue decision handling, not direct worker start.
8. Red 4: add operation trigger tests for `auto-reindex`.
9. Green 4: extend `REINDEX_OPERATION_TRIGGERS` and route/filter handling.
10. Red 5: add `api.ts` wiring assertion for `listRegisteredRepos({ validate: true })`, `checkStalenessAsync`, `startReindexJob(... trigger: 'auto-reindex')`, no `fetch('/api/reindex')`, disabled default, and interval cleanup.
11. Green 5: wire startup interval and cleanup in `api.ts`.
12. Refactor only after all focused tests are green.

Acceptance criteria for the approved slice:

- Default process behavior remains unchanged when `GITNEXUS_REINDEX_WATCHER` is unset. Status: covered by source wiring using `readReindexWatcherConfigFromEnv` and conditional interval.
- With auto-reindex enabled and dry-run true, stale repos are detected and reported/logged, but no reindex job starts. Status: covered by `reindex-auto-sweep.test.ts`.
- With auto-reindex enabled and dry-run false, stale validated repos start through existing queue and `startReindexJob` semantics. Status: covered by `reindex-auto-sweep.test.ts` and `reindex-api-wiring.test.ts`.
- Fresh repos do not start jobs. Status: covered by `reindex-auto-sweep.test.ts`.
- Invalid registry entries are pruned or skipped by `listRegisteredRepos({ validate: true })`. Status: covered by `reindex-api-wiring.test.ts`.
- Same-repo duplicate auto sweeps coalesce through the existing queue; different-repo concurrency remains bounded by current queue behavior. Status: covered by `reindex-auto-sweep.test.ts` and existing `ReindexQueue` tests.
- Operation records and logs can show `trigger: 'auto-reindex'`. Status: covered by `reindex-operations.test.ts` and API wiring.
- Native file watching, Git hooks, new dependencies, and runtime/Podman config changes are absent. Status: verified by scoped diff/status review.
- Focused reindex/staleness tests pass. Status: 7 files, 62 tests passed.

Recorded MAIN approval text:

```text
MAIN | READY_FOR_IMPLEMENTATION
Feature: Auto-Reindexing
Branch/worktree: C:\Users\steve\projects\gitnexus\source-rc109-integration on local/gitnexus-local-features
Approved slice: opt-in, dry-run-default, server-side commit-staleness sweep over validated registered repos, using existing reindex queue/job/operation semantics and trigger auto-reindex.
Approved write set:
- gitnexus/src/server/reindex-auto-sweep.ts
- gitnexus/src/server/reindex-operations.ts
- gitnexus/src/server/api.ts
- gitnexus/test/unit/reindex-auto-sweep.test.ts
- gitnexus/test/unit/reindex-api-wiring.test.ts
- gitnexus/test/unit/reindex-operations.test.ts
- gitnexus/test/unit/reindex-watcher.test.ts only if scheduler behavior is directly reused
Constraints: no hooks, no new dependencies, no Docker/Podman runtime changes, no PR Review/Wiki work, TDD required.
```

Known local source surfaces:

- `gitnexus/src/server/reindex-watcher.ts`
- `gitnexus/src/server/reindex-control.ts`
- `gitnexus/src/server/reindex-operations.ts`
- `gitnexus/src/server/api.ts`
- `gitnexus/src/core/git-staleness.ts`
- `gitnexus/src/storage/repo-manager.ts`
- `gitnexus/src/mcp/local/local-backend.ts`

Initial verification shape:

- Existing focused test set passed during research:
  `npm test -- test/unit/reindex-watcher.test.ts test/unit/reindex-control.test.ts test/unit/reindex-operations.test.ts test/unit/reindex-api-wiring.test.ts test/unit/reindex-freshness-wiring.test.ts`
- Result: 5 files passed, 47 tests passed.

Required new or confirmed tests before completion:

- stale registered repo is selected for reindex
- fresh registered repo is skipped
- dry-run does not start reindex work
- repeated same-repo freshness events coalesce
- different-repo concurrency remains bounded by existing queue semantics
- generated/index/dependency paths remain ignored
- operation records expose the auto-reindex trigger distinctly from direct user requests
- registry validation skips or prunes invalid repo entries before scheduling
- native watcher failures do not block sweep-based freshness recovery

Stop rules:

- Stop if the design requires Git hooks.
- Stop if the design needs a new dependency before MAIN approves it.
- Stop if Windows/Podman file-watching reliability is required for correctness.
- Stop if reindex can race graph reads outside existing guarded semantics.

## Task 4 - PR Impact / Blast Radius

Status: readiness refreshed after Tasks 1-3 first slices; source work remains blocked until the WIP snapshot/no-snapshot boundary is resolved and the exact implementation Goal is created

Objective:

- Produce local Markdown/JSON change-risk reports over deterministic diff-to-graph primitives.

Expected first slice:

- Orchestrate existing `detect_changes`, `impact`, and `api_impact` outputs.
- Prefer local branch/diff reporting before GitHub comment or review automation.
- Defer GitHub Actions and PR posting until report schema and permission model are stable.
- Use `pr-swarm-review/` and `gitnexus-pr-review` as report-shape and review-discipline references, while preserving their read-only/manual nature.

Research verification already run:

- `npm test -- test/unit/tools.test.ts test/unit/tool-direct-cli.test.ts test/unit/detect-changes-worktree.test.ts test/integration/api-impact-e2e.test.ts`
- Result: 4 files passed, 71 tests passed.

Dependency:

- Requires fresh enough graph state from Task 1.
- Requires completion or explicit reprioritization of Tasks 1-3 before PR Impact / Blast Radius source edits begin.
- Requires a clean inter-feature snapshot boundary before PR Impact / Blast Radius source edits begin.

Preimplementation steps:

- Re-read existing `detect_changes`, `impact`, and `api_impact` source/tests. Status: complete for readiness planning.
- Reconcile local report-first behavior against `pr-swarm-review/`, global `gitnexus-pr-review` skill guidance, GitHub PR/issue evidence, and GitHub Actions security docs. Status: complete for first-slice planning.
- Draft the decision-complete implementation plan with expected vs actual behavior, report schema, source ownership, test plan, and security boundary. Status: complete locally below.
- Create or refresh a feature Goal before any PR Impact / Blast Radius implementation work. Status: readiness Goal active/refreshed; implementation Goal must wait for the WIP boundary.
- Stop before source edits until the write set is approved and the inter-feature snapshot boundary is resolved.

### PR Impact / Blast Radius Decision-Complete Readiness Plan

Readiness verdict:

- Ready for MAIN review of the proposed first implementation slice.
- Standing conditional implementation authorization exists, but source work is not ready to start until the prerequisite gates below are satisfied.
- Source edits remain blocked until:
  - Tasks 1-3 first slices remain complete/verified and the current WIP boundary is resolved.
  - Current WIP is committed, or MAIN records a deliberate no-commit/snapshot decision.
  - MAIN records `MAIN | READY_FOR_IMPLEMENTATION` for PR Impact / Blast Radius with an accepted write set.

Expected vs actual behavior:

| Area | Expected first-slice behavior | Current local behavior | Plan response |
| --- | --- | --- | --- |
| PR/diff understanding | A local reviewer can see changed symbols, affected execution flows, and risk in one report. | `detect_changes` maps git diffs to indexed symbols and affected processes, but the CLI prints only a compact detect-changes summary. | Add a local report orchestrator that calls `detect_changes` and formats a fuller Markdown/JSON report. |
| Blast radius | Non-trivial changed symbols include upstream impact evidence without overwhelming output. | `impact` supports upstream/downstream, disambiguation, pagination, and `summaryOnly`; issue #414 shows hub symbols need summary-first handling. | Use `impact(..., direction: "upstream", summaryOnly: true, limit: <small>)` first; expand only by explicit later option. |
| API route changes | API route handler changes include consumer, response-shape, middleware, mismatch, and risk evidence. | `api_impact` already combines route map, shape check, mismatch detection, middleware, consumers, flows, and risk. | For changed files that are plausible route handlers, call `api_impact({ file })` and include successful results; report skipped/no-route cases as non-blocking. |
| Review discipline | Output should follow a review structure with findings, missing coverage, and recommendation. | Global `gitnexus-pr-review` skill and `pr-swarm-review/` define read-only review methods and output shapes, but they are agent prompts, not a product CLI feature. | Treat these as report-shape references only; do not copy the swarm into an automated GitHub actor. |
| GitHub automation | GitHub comments/checks must not run before a permission model exists. | No local GitHub-posting feature exists for PR Review. GitHub docs make PR workflow permissions and `pull_request_target` sensitive, especially with forks. | First slice is local report-only. GitHub comments, PR reviews, checks, Actions workflows, and token use are explicitly out of scope. |
| Worktree/local branch support | Local branch reports should work from normal checkouts and linked worktrees. | `detect_changes` has worktree support and compare scope; CLI does not pass `worktree`, relying on auto-detection. | First slice uses current `detect_changes` behavior and documents `--base-ref`; explicit `--worktree` can be a later option if needed. |
| Freshness | Report should warn if graph evidence may be stale, not silently overclaim. | Host graph status is commit-based and does not include uncommitted source until re-analysis; Auto-Reindexing improves future freshness but current WIP is unsnapshotted. | Include a report limitation/caveat section and keep source implementation behind the Auto-Reindexing snapshot boundary. |

Evidence inspected:

- Local source:
  - `gitnexus/src/mcp/tools.ts`
  - `gitnexus/src/mcp/local/local-backend.ts`
  - `gitnexus/src/cli/tool.ts`
  - `gitnexus/src/cli/detect-changes-format.ts`
  - `gitnexus/src/cli/index.ts`
  - `gitnexus/src/cli/help-i18n.ts`
- Local tests:
  - `gitnexus/test/unit/detect-changes-worktree.test.ts`
  - `gitnexus/test/unit/tool-direct-cli.test.ts`
  - `gitnexus/test/unit/tools.test.ts`
  - `gitnexus/test/integration/api-impact-e2e.test.ts`
  - `gitnexus/test/unit/calltool-dispatch.test.ts`
  - `gitnexus/test/unit/impact-pagination.test.ts`
- Local review references:
  - `C:\Users\steve\.agents\skills\gitnexus-pr-review\SKILL.md`
  - `pr-swarm-review/README.md`
  - `pr-swarm-review/orchestration.md`
  - `pr-swarm-review/personas/*.md`
- Host graph query:
  - `gitnexus query --repo gitnexus-local-features "detect_changes impact api_impact PR review blast radius report formatter worktree" --limit 8`
- Public/reference evidence:
  - GitNexus public `AGENTS.md` records `pr-swarm-review/orchestration.md` as the cross-CLI production-readiness review spec and says the review is read-only: https://github.com/abhigyanpatwari/GitNexus/blob/main/AGENTS.md
  - GitNexus public `GUARDRAILS.md` requires impact analysis before shared-symbol edits and `detect_changes` before commit: https://github.com/abhigyanpatwari/GitNexus/blob/main/GUARDRAILS.md
  - GitNexus public `ARCHITECTURE.md` lists `impact`, `detect_changes`, `api_impact`, `route_map`, and `shape_check` as current MCP/tool primitives: https://github.com/abhigyanpatwari/GitNexus/blob/main/ARCHITECTURE.md
  - GitNexus issue #415 explains why `detect_changes` risk can be misleading when added and modified symbols are not distinguished: https://github.com/abhigyanpatwari/GitNexus/issues/415
  - GitNexus PR #416 documents an intended direction for better `detect_changes` change-type/risk scoring, but it is not local rc.109 behavior: https://github.com/abhigyanpatwari/GitNexus/pull/416
  - GitNexus issue #414 documents output explosion risk for highly connected symbols and supports summary-first `impact` use: https://github.com/abhigyanpatwari/GitNexus/issues/414
  - GitHub Actions token docs recommend least privilege for `GITHUB_TOKEN`: https://docs.github.com/en/actions/tutorials/authenticate-with-github_token
  - GitHub workflow syntax docs define `pull-requests: write`, `checks`, `statuses`, fork permission downgrades, and read-only fork behavior: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
  - GitHub events docs warn that `pull_request_target` runs in base context and untrusted code/security implications must be handled carefully: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
  - GitHub secure-use docs warn against privileged triggers with untrusted checkout and recommend avoiding `pull_request_target` when not necessary: https://docs.github.com/en/enterprise-server@3.16/actions/reference/security/secure-use

Proposed first implementation slice if MAIN approves:

- Add a local report-only PR Review / Blast Radius command that composes existing graph primitives and emits Markdown or JSON.
- Command shape to consider:
  - `gitnexus pr-review --base-ref <ref> --repo <name> --format markdown`
  - `gitnexus pr-review --scope compare --base-ref main --repo gitnexus-local-features --format json`
- Default behavior:
  - read-only
  - local checkout/diff based
  - no GitHub posting
  - no Actions workflow
  - no token use
  - no network requirement
  - no new dependency

Report schema:

- `metadata`
  - repo
  - scope
  - baseRef
  - generatedAt
  - command route
  - limitations
- `summary`
  - changedFiles
  - changedSymbols
  - affectedProcesses
  - riskLevel
  - recommendation
- `changedSymbols`
  - name
  - type
  - filePath
  - changeType when available
- `affectedProcesses`
  - name
  - processType
  - stepCount
  - changedSteps
- `symbolImpacts`
  - target
  - uid or disambiguation status
  - risk
  - impactedCount
  - direct/depth counts when available
  - affected modules/processes when available
  - partial/truncated flag
- `apiImpacts`
  - route
  - handler
  - consumers
  - responseShape
  - middleware
  - mismatches
  - impactSummary
- `findings`
  - severity
  - risk
  - evidence
  - recommended fix
  - blocksMerge
- `missingCoverage`
  - affected flows without visible test impact
  - callers outside changed files when detectable
- `securityAndAutomationBoundary`
  - report-only
  - no posting/checks
  - token/permission model deferred
- `recommendation`
  - `APPROVE`, `REQUEST_CHANGES`, or `NEEDS_DISCUSSION`

Proposed write set if MAIN approves:

- `gitnexus/src/cli/pr-review-report.ts` - pure report builder and Markdown/JSON formatting.
- `gitnexus/src/cli/pr-review.ts` - command handler that calls `LocalBackend.callTool` for `detect_changes`, `impact`, and `api_impact`.
- `gitnexus/src/cli/index.ts` - register `pr-review`.
- `gitnexus/src/cli/help-i18n.ts` - localized help routing for the new command/options.
- `gitnexus/src/cli/i18n/en.ts` - English help strings.
- `gitnexus/src/cli/i18n/zh-CN.ts` - Chinese help strings, following existing CLI convention.
- `gitnexus/test/unit/pr-review-report.test.ts` - pure formatter/orchestrator tests.
- `gitnexus/test/unit/pr-review-cli.test.ts` or `gitnexus/test/unit/tool-direct-cli.test.ts` - CLI dispatch tests with mocked backend.
- `gitnexus/test/unit/cli-index-help.test.ts` - command/help registration if required by existing coverage.

Files explicitly out of scope for the first slice:

- `.github/workflows/*`
- GitHub Apps, PAT handling, secrets, checks, statuses, or PR comment posting
- MCP tool schema changes
- graph ingestion, resolver, `impact`, `detect_changes`, or `api_impact` internals
- `pr-swarm-review/` canonical prompt logic, except documentation references
- Auto-Updating Code Wiki, regression forensics, E2E generation, multi-repo, and OCaml work
- new dependencies

TDD sequence:

1. Baseline: run `npm test -- test/unit/tools.test.ts test/unit/tool-direct-cli.test.ts test/unit/detect-changes-worktree.test.ts test/integration/api-impact-e2e.test.ts test/unit/impact-pagination.test.ts`.
2. Red 1: add a pure report-builder test proving a `detect_changes` result becomes a Markdown report with summary, changed symbols, affected processes, and report-only automation boundary.
3. Green 1: implement the pure Markdown formatter.
4. Red 2: add a JSON schema/shape test proving metadata, summary, changedSymbols, affectedProcesses, symbolImpacts, apiImpacts, findings, and recommendation are stable.
5. Green 2: add JSON report shaping.
6. Red 3: add orchestrator test with mocked backend proving it calls `detect_changes` once, calls `impact` summary-first for changed symbols, calls `api_impact` for plausible API route handler files, and tolerates no-route errors.
7. Green 3: implement orchestrator with bounded per-symbol analysis and non-blocking API-impact misses.
8. Red 4: add CLI dispatch test for `gitnexus pr-review --base-ref main --repo gitnexus-local-features --format markdown`.
9. Green 4: wire CLI command and help/i18n strings.
10. Refactor only after focused tests are green.

Acceptance criteria for the proposed slice:

- The command is read-only and local-only.
- Markdown and JSON output are deterministic from fixture inputs.
- `detect_changes` compare/all/staged/unstaged scope can be passed through.
- `impact` calls are bounded/summary-first to avoid hub-symbol output explosion.
- `api_impact` enriches route-handler changes when available and does not fail the whole report when no route is found.
- The report includes a security/automation boundary stating no GitHub posting/check automation occurred.
- No GitHub token, Actions workflow, or network dependency is introduced.
- No source internals for graph traversal or indexing are changed.

Stop rules:

- Stop if the feature requires GitHub comments, checks, statuses, or workflow automation before MAIN approves a security model.
- Stop if a new dependency is required.
- Stop if source implementation would begin before Auto-Reindexing WIP is snapshotted or explicitly accepted as unsnapshotted.
- Stop if the implementation must change `detect_changes`, `impact`, or `api_impact` internals rather than composing them.
- Stop if local graph freshness is too stale to validate meaningful examples and no reindex/snapshot route is approved.

## Task 2 - Auto-Updating Code Wiki

Status: MAIN approved status/dry-run-first implementation slice on 2026-06-06

Objective:

- Refresh existing Code Wiki output after graph freshness is available.

Expected first slice:

- Reuse the existing wiki generator.
- Run only after successful reindex or freshness sweep.
- Skip when no wiki exists unless explicitly configured to create one.
- Check provider readiness before unattended LLM work.
- Record status, skipped reason, duration, and generated page count.

Research verification already run:

- `npm test -- test/unit/wiki-flags.test.ts test/unit/wiki-grouping-batch.test.ts test/unit/wiki-mermaid-sanitizer.test.ts test/unit/wiki-llm-client.test.ts`
- Result: 4 files passed, 119 tests passed.

Precursor tasks before asking MAIN for implementation:

- Re-read current wiki source, CLI/help wiring, provider/LLM config, and focused wiki tests.
- Reconcile expected public behavior against actual local rc.109 behavior.
- Decide whether the first slice is reindex-success-triggered refresh, manual refresh orchestration, or status-only refresh readiness.
- Define skip behavior when no wiki exists, provider readiness behavior, dry-run/report mode, output mutation policy, and operation visibility.
- Draft the exact proposed write set and TDD sequence.
- Record risks, stop rules, and the approval text MAIN would need to provide.

Dependency:

- Requires Task 1 freshness behavior and explicit LLM execution policy.

### Task 2 Readiness Checkpoint - 2026-06-05T18:16+01:00

Readiness verdict:

- Active Goal is readiness/planning only.
- Not approved for source implementation.
- Current evidence supports a narrow first slice around refresh orchestration/status after confirmed graph freshness, not rebuilding wiki generation.

Expected vs actual behavior:

| Area | Expected Task 2 behavior | Current local behavior | Planning response |
| --- | --- | --- | --- |
| Product promise | Auto-updating Code Wiki implies docs stay fresh after code/index changes. | OSS CLI already has `gitnexus wiki`; it is manually invoked. README says wiki reads the indexed graph, groups files into modules, generates per-module pages, and creates an overview. | Build orchestration around the existing command/generator; do not rebuild generation. |
| Graph dependency | Auto-refresh should document the fresh graph, not stale graph state. | `WikiGenerator` reads LadybugDB via `graph-queries.ts` and tracks `wiki/meta.json.fromCommit` against `git rev-parse HEAD`; it does not itself prove the graph index is fresh for that commit. | Gate refresh behind successful Task 1 freshness/reindex evidence before running wiki work. |
| Incremental behavior | Refresh should avoid full regeneration when possible. | `WikiGenerator.incrementalUpdate` diffs `existingMeta.fromCommit..HEAD`, regenerates affected modules, handles small new-file sets, and falls back to full generation on branch divergence or significant new files. | Reuse incremental behavior; first slice should trigger or report it rather than replace it. |
| Provider/cost policy | Unattended refresh must not unexpectedly spend tokens or require interactive setup. | `wikiCommand` can prompt interactively when no saved config exists; non-interactive mode errors without API key/local provider. It supports OpenAI/OpenRouter/Azure/custom/Cursor/Claude/Codex providers. | First slice needs explicit provider readiness checks, dry-run/status behavior, and MAIN policy for unattended LLM use. |
| Output mutation | Auto-refresh can overwrite wiki markdown/HTML artifacts. | Generator writes `wiki/*.md`, `wiki/index.html`, `wiki/module_tree.json`, `wiki/first_module_tree.json`, and `wiki/meta.json` under GitNexus storage, not necessarily repo docs. | First slice must state where output mutates, when to skip, and how to report pages generated/skipped/failed. |
| Existing wiki absence | "Auto-updating" should not silently create a new wiki if the user only wanted existing docs kept fresh. | Invoking `gitnexus wiki` without existing meta performs full generation. | First slice should likely skip when no existing wiki meta exists unless explicitly configured to create. |
| Existing verification | Feature should be testable before source changes. | Focused wiki tests already cover flags, grouping batches, Mermaid sanitizer, LLM client, provider routing, timeout/retry, language/cache behavior, and review mode. | Use those as baseline; add refresh-orchestration tests only after MAIN opens the Task 2 write set. |

Evidence inspected:

- Local source:
  - `gitnexus/src/cli/wiki.ts`
  - `gitnexus/src/cli/index.ts`
  - `gitnexus/src/cli/help-i18n.ts`
  - `gitnexus/src/cli/i18n/en.ts`
  - `gitnexus/src/cli/i18n/zh-CN.ts`
  - `gitnexus/src/core/wiki/generator.ts`
  - `gitnexus/src/core/wiki/graph-queries.ts`
  - `gitnexus/src/core/wiki/llm-client.ts`
  - `gitnexus/src/core/wiki/local-cli-client.ts`
  - `gitnexus/src/core/wiki/cursor-client.ts`
  - `gitnexus/src/core/wiki/html-viewer.ts`
  - `gitnexus/src/core/wiki/mermaid-sanitizer.ts`
- Local tests:
  - `gitnexus/test/unit/wiki-flags.test.ts`
  - `gitnexus/test/unit/wiki-grouping-batch.test.ts`
  - `gitnexus/test/unit/wiki-mermaid-sanitizer.test.ts`
  - `gitnexus/test/unit/wiki-llm-client.test.ts`
- Public/reference evidence:
  - GitNexus README wiki section: https://github.com/abhigyanpatwari/GitNexus/blob/main/README.md#wiki-generation
  - GitNexus architecture map: https://github.com/abhigyanpatwari/GitNexus/blob/main/ARCHITECTURE.md
  - GitNexus issue #302: https://github.com/abhigyanpatwari/GitNexus/issues/302
  - GitNexus triage issue #422 references wiki-related history: issue #265 language support, PR #252 large-repo grouping, issue #166 context overflow, issue #156 Ollama hang, issue #95 language setup.

Commands run:

```powershell
rg -n "wiki|Code Wiki|generateWiki|WikiGenerator|wiki-flags|wiki-grouping|wiki-llm|mermaid|provider|llm" gitnexus/src gitnexus/test ARCHITECTURE.md README.md
rg --files gitnexus/src/core/wiki gitnexus/src/cli gitnexus/test/unit | rg "wiki|help-i18n|i18n"
rg -n "class WikiGenerator|generate\(|generateWiki|wiki\)|command.*wiki|case 'wiki'|--force|--timeout|--retries|provider|base-url|model|lang" gitnexus/src/cli gitnexus/src/core/wiki gitnexus/src/server
rg -n "describe\(|it\(" gitnexus/test/unit/wiki-flags.test.ts gitnexus/test/unit/wiki-grouping-batch.test.ts gitnexus/test/unit/wiki-llm-client.test.ts gitnexus/test/unit/wiki-mermaid-sanitizer.test.ts
gitnexus query --repo gitnexus-local-features "WikiGenerator wikiCommand incrementalUpdate generateOverview llm-client graph-queries" --limit 8
npm test -- test/unit/wiki-flags.test.ts test/unit/wiki-grouping-batch.test.ts test/unit/wiki-mermaid-sanitizer.test.ts test/unit/wiki-llm-client.test.ts
```

Verification result:

- Focused wiki baseline passed: 4 files, 119 tests.
- Host graph query found `wikiCommand`, `WikiGenerator`, `llm-client.ts`, and related local source surfaces.
- Graph query also logged Windows VECTOR-unavailable exact-scan fallback; this does not affect the wiki tests.

Likely first implementation slice to take to MAIN:

- Add a small core/server orchestration layer that can decide whether wiki refresh should run after a successful freshness/reindex event.
- Default to dry-run/status-first behavior unless an explicit config enables output mutation.
- Skip when no existing wiki meta exists unless an explicit create-on-refresh option is approved.
- Check provider readiness before invoking LLM generation; never enter interactive setup in an unattended path.
- Record status: skipped reason, provider readiness, graph freshness source, mode (`up-to-date`, `incremental`, `full`), pages generated, failed modules, duration.

Open policy questions before implementation approval:

- Should Task 2 mutate stored wiki output automatically, or first expose a status/dry-run report only?
- Which provider route is allowed for unattended refresh: OpenAI-compatible env/config, Cursor/Claude/Codex local CLI, or none by default?
- Is token/cost budget required before background refresh can run?
- Should auto-refresh run only for repos with existing `wiki/meta.json`, or create a new wiki when none exists?
- Should wiki refresh be attached to the Task 1 auto-reindex sweep, a manual command, a server operation endpoint, or both?

Proposed TDD shape if MAIN later approves:

1. Red: refresh planner skips when graph is stale or Task 1 did not report successful freshness.
2. Green: implement pure planner with no filesystem/output mutation.
3. Red: planner skips when no existing wiki meta exists and create-on-refresh is disabled.
4. Green: add wiki-meta detection through injected storage probes.
5. Red: planner reports provider-not-ready without interactive prompts.
6. Green: add provider readiness abstraction around existing config/env/local provider detection.
7. Red: orchestration result records mode/pages/skipped reason/duration from a mocked `WikiGenerator`.
8. Green: wire orchestration to existing generator only after all gates pass.

Proposed write set if MAIN approves the status/dry-run first slice:

- `gitnexus/src/core/wiki/auto-refresh.ts` - pure planner plus injectable runner for refresh decisions and status result shaping.
- `gitnexus/src/server/wiki-refresh-operations.ts` - optional server-side operation/status wrapper if the slice records wiki refresh attempts alongside server reindex operations.
- `gitnexus/src/server/api.ts` - only for narrow wiring from successful reindex/freshness events into the dry-run/status planner; no unconditional LLM invocation.
- `gitnexus/test/unit/wiki-auto-refresh.test.ts` - planner/runner tests for graph freshness, existing wiki meta, provider readiness, dry-run/status, and result shaping.
- `gitnexus/test/unit/wiki-refresh-api-wiring.test.ts` - only if `api.ts` is touched for event wiring.

Files explicitly out of scope for the first slice:

- `.github/workflows/*`
- `gitnexus/src/core/wiki/generator.ts` except for a tiny exported helper if the approved implementation cannot avoid it.
- `gitnexus/src/core/wiki/prompts.ts`, unless MAIN explicitly asks to change generated content.
- User-facing generated wiki output or stored wiki artifacts.
- Provider credentials, secrets, billing setup, or default model changes.
- PR Impact / Blast Radius, Multi-Repo Support Improvements, regression forensics, E2E generation, or OCaml work.

Suggested MAIN approval text if this plan is accepted:

```text
MAIN | READY_FOR_IMPLEMENTATION
Feature: Auto-Updating Code Wiki
Branch/worktree: C:\Users\steve\projects\gitnexus\source-rc109-integration on local/gitnexus-local-features
Approved slice: status/dry-run-first wiki auto-refresh orchestration after confirmed graph freshness/reindex success. The slice may plan and report whether wiki refresh would run, verify existing wiki meta and provider readiness, skip safely when prerequisites are missing, and shape operation/status results. It must not mutate wiki output by default and must not run unattended LLM generation unless an explicit opt-in config is added in the approved scope.
Approved write set:
- gitnexus/src/core/wiki/auto-refresh.ts
- gitnexus/src/server/wiki-refresh-operations.ts only if operation/status wrapping is needed
- gitnexus/src/server/api.ts only for narrow dry-run/status wiring from successful reindex/freshness events
- gitnexus/test/unit/wiki-auto-refresh.test.ts
- gitnexus/test/unit/wiki-refresh-api-wiring.test.ts only if api.ts is touched
Constraints: no hooks, no new dependencies, no provider credential changes, no generated wiki output mutation by default, no GitHub/PR work, no Multi-Repo source work, TDD required.
```

Approval recorded:

- 2026-06-06T10:16+01:00: User approved implementation. Treat this as `MAIN | READY_FOR_IMPLEMENTATION` for the status/dry-run-first Task 2 slice above.

### Task 2 Wiki Generator Analysis - 2026-06-06T10:24+01:00

Purpose:

- Analyse the existing wiki generator properly before treating "auto-updating Code Wiki" as an implementation problem.
- Separate what GitNexus already has from what is missing for safe unattended refresh.

Current generator capabilities:

- CLI entrypoint exists: `gitnexus wiki [path]`.
- Source ownership:
  - `gitnexus/src/cli/wiki.ts` resolves repo/index/provider config and drives the command.
  - `gitnexus/src/core/wiki/generator.ts` orchestrates generation.
  - `gitnexus/src/core/wiki/graph-queries.ts` reads graph structure from LadybugDB.
  - `gitnexus/src/core/wiki/llm-client.ts`, `cursor-client.ts`, and `local-cli-client.ts` handle provider calls.
  - `gitnexus/src/core/wiki/html-viewer.ts` bundles the HTML viewer.
  - `gitnexus/src/core/wiki/mermaid-sanitizer.ts` cleans generated Mermaid output.
- Generator phases:
  - prerequisite/meta check
  - graph connection and graph file/symbol/process queries
  - LLM grouping into modules
  - module page generation
  - overview page generation
  - metadata and HTML viewer output
- Existing incremental behavior:
  - `wiki/meta.json.fromCommit` is compared to `git rev-parse HEAD`.
  - same commit plus same language returns `up-to-date`.
  - changed files are mapped back to existing module ownership.
  - affected modules are regenerated.
  - branch divergence or more than five new files can trigger fuller regeneration.
- Existing safety and resilience:
  - CLI checks for an existing GitNexus index before generation.
  - provider config supports OpenAI-compatible APIs, Azure, Cursor, Claude, and Codex.
  - timeout/retry options exist.
  - LLM base URL validation rejects non-HTTP schemes and remote plain HTTP.
  - focused tests already cover flags, local providers, timeout/retry, grouping batches, language/cache behavior, Mermaid sanitization, and LLM client behavior.

Deficiencies for unattended auto-update:

| Deficiency | Evidence | Risk for auto-update | Required planning response |
| --- | --- | --- | --- |
| Wiki freshness is not graph freshness | `WikiGenerator.run()` compares wiki meta commit to repo `HEAD`; graph reads come from existing LadybugDB. | Auto-refresh could document stale graph state if run after a code change but before successful reindex. | Gate auto-refresh behind confirmed graph freshness/reindex success from Task 1. |
| CLI is interactive and config-mutating | `wikiCommand` can prompt for provider setup and save `~/.gitnexus/config.json`. | Background refresh could hang, prompt, or persist config unexpectedly. | Auto-refresh must not call `wikiCommand`; use injectable/core runner and explicit provider readiness. |
| Generator mutates output as part of normal run | `run()` creates wiki dir, may regenerate HTML viewer even when up-to-date, and `--force` deletes markdown/snapshot files. | A status check could accidentally modify stored wiki output. | First slice must be dry-run/status-first and must not call `WikiGenerator.run()` unless output mutation is explicitly enabled. |
| Missing and corrupt wiki meta are collapsed in the generator | `loadWikiMeta()` catches all errors and returns `null`. | Automation could treat corrupt meta like "no wiki" and full-generate or skip unclearly. | Auto-refresh planner should distinguish missing/corrupt meta in its own preflight status. |
| Incremental heuristics are coarse | Small unknown files are assigned to `Other`; more than five new files forces fuller generation; deleted/renamed files depend on module meta behavior. | Auto-refresh may over-refresh or produce partial/outdated module ownership. | First slice should report mode/risks and avoid promising perfect incremental correctness. |
| Failed modules do not fail the whole manual command | Failed modules are collected and printed, while CLI still reports generation summary. | Automation needs machine-readable partial-failure status, not just console text. | Auto-refresh result must shape `failedModules`, `pagesGenerated`, mode, and status clearly. |
| No existing generated wiki was found locally | No `wiki/meta.json` was found under `C:\Users\steve\.gitnexus` for this repo during the check. | Auto-update cannot safely refresh a wiki that does not exist unless creation is explicitly approved. | Default should skip `missing-wiki-meta`; creation must be separate opt-in policy. |
| No saved LLM config was found locally | Sanitized config check found no `~/.gitnexus/config.json` and no visible API env vars. | Unattended generation is not provider-ready by default. | Provider readiness must be explicit; local CLI providers may be considered only if approved. |

Current local readiness facts:

- `gitnexus status` reports the host index for this repo is up to date at commit `b5ce5ab`.
- `gitnexus wiki --help` confirms the wiki CLI is available.
- `codex --version` and `claude --version` show local CLI providers are installed, but local provider use is still a policy choice.
- `npm test -- test/unit/wiki-auto-refresh.test.ts` now passes after adding the first status/dry-run planner/runner WIP tests: 1 file, 5 tests.

Planning conclusion:

- Treat the current wiki generator as a manual generation engine.
- Treat Task 2 as an automation preflight/orchestration layer in front of that engine.
- Do not modify generator prompts, graph queries, grouping, or HTML rendering in the first slice.
- Do not wire auto-refresh directly to user-facing output mutation yet.
- First implementation slice remains valid but should be understood as "make the automation decision safe and observable", not "generate/refresh the wiki automatically".

Refined first-slice requirements:

- Pure planner:
  - require confirmed graph freshness
  - require existing wiki metadata by default
  - distinguish missing/corrupt wiki metadata
  - require provider readiness
  - default to dry-run/status
- Runner:
  - never call the generator unless `dryRun: false` and `mutateOutput: true`
  - shape `mode`, `pagesGenerated`, `failedModules`, `durationMs`, `status`, and `reason`
  - return skipped/dry-run statuses without output mutation or LLM invocation
- Later implementation, not first slice:
  - actual server/API/event wiring
  - provider policy UI/config
  - creation of new wiki artifacts when none exist
  - generated output publication
  - tuning incremental-generation heuristics

### Task 2 Implementation Checkpoint - 2026-06-06T10:26+01:00

Status:

- Core status/dry-run-first planner/runner implemented locally.
- No server/API wiring was needed for the first slice.
- No generated wiki output was created or mutated.

Files changed in this slice:

- `gitnexus/src/core/wiki/auto-refresh.ts`
- `gitnexus/test/unit/wiki-auto-refresh.test.ts`

Implemented behavior:

- `planWikiAutoRefresh` requires confirmed graph freshness.
- Missing wiki metadata skips by default instead of creating a new wiki.
- Corrupt wiki metadata is distinguished from missing metadata.
- Provider-not-ready status skips instead of prompting or running generation.
- Dry-run/status is the default even when all prerequisites are ready.
- `runWikiAutoRefresh` invokes an injected generator only when `dryRun: false` and `mutateOutput: true`.
- Runner result shapes `status`, `reason`, `durationMs`, `mode`, `pagesGenerated`, and `failedModules`.
- `readWikiAutoRefreshMeta` reads `storagePath/wiki/meta.json` and returns missing/corrupt/valid status without throwing.

Verification:

```powershell
npm test -- test/unit/wiki-auto-refresh.test.ts
npm test -- test/unit/wiki-auto-refresh.test.ts test/unit/wiki-flags.test.ts test/unit/wiki-grouping-batch.test.ts test/unit/wiki-mermaid-sanitizer.test.ts test/unit/wiki-llm-client.test.ts
npm test -- test/unit/reindex-auto-sweep.test.ts test/unit/reindex-watcher.test.ts test/unit/reindex-control.test.ts test/unit/reindex-operations.test.ts test/unit/reindex-api-wiring.test.ts test/unit/reindex-freshness-wiring.test.ts test/unit/staleness.test.ts
npm run build
git diff --check
```

Results:

- `wiki-auto-refresh`: 1 file, 8 tests passed.
- Focused wiki suite: 5 files, 127 tests passed.
- Focused reindex/freshness suite: 7 files, 62 tests passed.
- Build passed.
- Diff whitespace check passed.

Residual risks and next boundaries:

- Local provider detection logs warn that Codex/Claude CLI version checks failed inside test paths, even though local `codex --version` and `claude --version` worked in shell checks. Treat unattended provider readiness as explicit policy, not assumed.
- Existing manual generator incremental heuristics remain unchanged.
- Server/API wiring remains a later boundary; do not add event wiring until MAIN approves whether auto-refresh should remain status-only, expose a manual endpoint, or attach to successful reindex events.

## Task 3 - Multi-Repo Support Improvements

Status: next tranche after Auto-Updating Code Wiki; implementation not approved

Objective:

- Reconcile current multi-repo/group support with stale docs/tool tables and identify the smallest useful improvement to group/status/contract ergonomics.

Expected first slice:

- Verify the current source truth for group-aware `query`, `context`, and `impact`.
- Verify how group status/contracts are exposed through current resources and CLI commands.
- Correct stale guidance or choose one small ergonomics improvement; do not expand to a unified cross-repo graph unless MAIN approves that scope.

Research verification to run or refresh:

- Inspect `gitnexus/src/core/group/`, `gitnexus/src/mcp/`, current CLI group commands, `ARCHITECTURE.md`, and relevant group tests.
- Run host graph checks with `gitnexus query --repo gitnexus-local-features` where useful.
- Run the narrowest current group/tool tests once the candidate slice is selected.

Dependency:

- Readiness mapping may proceed before a snapshot because it is evidence gathering and documentation only.
- Task 3 source implementation requires a Task 1/Task 2 snapshot or an explicit MAIN no-snapshot decision.
- Must not depend on stale tables that still present `group_query`, `group_contracts`, or `group_status` as current MCP tools.

### Task 3 Readiness Evidence Checkpoint - 2026-06-06T10:50+01:00

Goal:

- Begin the active Task 3 readiness Goal by mapping actual multi-repo/group surfaces before proposing any implementation slice.

Current expected-vs-actual correction:

| Surface | Current source truth | Planning consequence |
| --- | --- | --- |
| CLI group commands | `gitnexus group create/add/remove/list/status/sync/impact/query/contracts` are present in `gitnexus/src/cli/group.ts`. | Do not call CLI `group query/contracts/status` stale; they remain real user-facing commands. |
| MCP group tools | `group_list` and `group_sync` are registered. `group_sync` is marked mutating/destructive. | MCP tool improvement scope should not invent old `group_query/group_contracts/group_status` tools. |
| MCP group-mode analysis | `query`, `context`, and `impact` route to `GroupService` when `repo` starts with `@<groupName>` or `@<groupName>/<memberPath>`. | Agent-facing guidance should teach `repo: "@group"` routing for analysis. |
| MCP group resources | `gitnexus://group/{name}/contracts` and `gitnexus://group/{name}/status` are resource templates. | Contracts/status inspection should prefer resources in MCP workflows. |
| Removed MCP tools | `group_query`, `group_contracts`, and `group_status` throw a migration message from `LocalBackend`. | Stale tables should be corrected where they imply these are current MCP tools. |
| Local runtime groups | `gitnexus group list` currently reports no configured groups on this workstation. | Runtime smoke can verify empty-state behavior, but realistic group behavior needs fixtures or a deliberate local test group. |

Source ownership found:

| Area | Source/Test Surfaces |
| --- | --- |
| CLI | `gitnexus/src/cli/group.ts` |
| Core service | `gitnexus/src/core/group/service.ts`, `sync.ts`, `cross-impact.ts`, `storage.ts`, `types.ts`, `config-parser.ts`, `group-path-utils.ts` |
| Bridge/contracts | `bridge-db.ts`, `bridge-schema.ts`, `contract-extractor.ts`, extractors under `gitnexus/src/core/group/extractors/` |
| MCP tools/resources | `gitnexus/src/mcp/tools.ts`, `gitnexus/src/mcp/resources.ts`, `gitnexus/src/mcp/local/local-backend.ts` |
| Tests | `test/unit/group/*`, `test/unit/mcp/group-repo-routing.test.ts`, `test/unit/resources.test.ts`, `test/integration/group/*` |

Commands run:

```powershell
gitnexus status
gitnexus group --help
gitnexus group list
rg --files gitnexus/src gitnexus/test ARCHITECTURE.md README.md | rg "group|contract|mcp|multi|bridge|workspace|resource|routing|query|impact|context"
rg -n "group|multi-repo|multi repo|contracts|group_query|group_contracts|group_status|group-aware|bridge|cross-repo|cross repo|context\(|impact\(|query\(" ARCHITECTURE.md README.md gitnexus/src gitnexus/test
gitnexus query --repo gitnexus-local-features "GroupService groupQuery groupContext groupImpact group contracts status resources MCP group mode" --limit 8
gitnexus query --repo gitnexus-local-features "group CLI create add remove list status sync impact query contracts" --limit 8
npm test -- test/unit/group/group-tools.test.ts test/unit/mcp/group-repo-routing.test.ts test/unit/resources.test.ts
```

Verification:

- `gitnexus status` reported this repo up to date at commit `b5ce5ab`.
- `gitnexus group --help` listed all current CLI group subcommands.
- `gitnexus group list` reported no groups configured.
- GitNexus graph queries found `registerGroupCommands`, `GroupService`, `getResourceTemplates`, `handleGroupTool`, and group-related tests.
- Focused MCP/group surface tests passed: 3 files, 52 tests.

Initial conclusion:

- The likely Task 3 improvement is not "add multi-repo support." It is current-surface reconciliation and maybe ergonomics around group status/contracts/routing guidance.
- The next readiness step is to inspect group service behavior and integration fixtures to decide whether the smallest useful slice is documentation correction, resource/status output hardening, CLI/MCP terminology alignment, or a small test-backed ergonomics improvement.

### Task 3 Decision-Complete Readiness Map - 2026-06-06T10:53+01:00

Readiness verdict:

- Task 3 is ready to take to MAIN as a documentation/tool-surface reconciliation slice.
- Do not implement a unified cross-repo graph in this tranche.
- Do not change group service behavior, MCP tool schemas, CLI commands, or bridge storage unless MAIN rejects the docs-only slice and names a behavior gap.

Expected vs actual:

| Source | Expected / stated behavior | Actual local/source behavior | Conclusion |
| --- | --- | --- | --- |
| Enterprise README wording | "Multi-repo support - unified graph across repositories." | Source implements repository groups, contract extraction, bridge graph, group-aware query/context/impact, and group resources. | Enterprise phrase is broader than the current OSS/local mechanism; local Task 3 should not promise a new unified graph without MAIN scope expansion. |
| README "What Your AI Agent Gets" table | Says **16 tools** and lists `group_contracts`, `group_query`, `group_status` as MCP tools. | `gitnexus/test/unit/tools.test.ts` asserts 13 MCP tools: 11 per-repo plus `group_list` and `group_sync`. | README MCP tool table is stale. |
| ARCHITECTURE.md | Lists 13 MCP tools, group-mode `query/context/impact`, and group contracts/status resources. | Matches `tools.ts`, `resources.ts`, `LocalBackend`, and focused tests. | Architecture is the current source-aligned reference. |
| CLI commands | README CLI command list includes `gitnexus group query/contracts/status`. | `gitnexus group --help` and `gitnexus/src/cli/group.ts` confirm these CLI commands exist. | CLI docs should keep these commands; only MCP tool table needs correction. |
| MCP removed tools | Some stale material still implies `group_query/group_contracts/group_status` are tools. | `LocalBackend.callTool` rejects those names with migration guidance. | Use resources or `repo: "@group"` routing in MCP workflows. |
| Runtime group state | Multi-repo commands should handle empty local config. | `gitnexus group list` returns "No groups configured." | Empty-state behavior is healthy; fixture tests cover real group behavior. |

Primary source evidence:

- Local `ARCHITECTURE.md` already states the intended current MCP architecture.
- Public upstream `ARCHITECTURE.md` on GitHub says the same: MCP tools are 13, `query/context/impact` are group-aware, and group contracts/status are resources.
- Public upstream `AGENTS.md` changelog records removal of `group_query/group_contracts/group_status` MCP tools and addition of group contracts/status resources.

Source ownership map:

| Concern | Owner |
| --- | --- |
| Current README drift | `README.md`, section "What Your AI Agent Gets" |
| Correct architecture reference | `ARCHITECTURE.md`, "MCP tools" and cross-repo groups sections |
| MCP tool definitions | `gitnexus/src/mcp/tools.ts` |
| MCP group resources | `gitnexus/src/mcp/resources.ts` |
| MCP group-mode routing | `gitnexus/src/mcp/local/local-backend.ts` |
| CLI group commands | `gitnexus/src/cli/group.ts` |
| Shared group service | `gitnexus/src/core/group/service.ts` |
| Contract sync / bridge / cross impact | `sync.ts`, `bridge-db.ts`, `bridge-schema.ts`, `cross-impact.ts`, extractors under `gitnexus/src/core/group/extractors/` |
| Surface tests | `gitnexus/test/unit/tools.test.ts`, `test/unit/group/group-tools.test.ts`, `test/unit/mcp/group-repo-routing.test.ts`, `test/unit/resources.test.ts`, `test/integration/group/*` |

Smallest safe implementation slice:

- Update `README.md` "What Your AI Agent Gets" so it matches source truth:
  - change "16 tools (11 per-repo + 5 group)" to "13 MCP tools (11 per-repo + 2 group-specific)".
  - add missing current per-repo tools: `api_impact`, `route_map`, `tool_map`, and `shape_check`.
  - remove `group_contracts`, `group_query`, and `group_status` from the MCP tools table.
  - add a short note that group analysis is performed through `query`, `context`, and `impact` using `repo: "@<groupName>"` or `repo: "@<groupName>/<memberPath>"`.
  - keep `gitnexus group query/contracts/status` in the CLI command list because those are real CLI commands.
  - ensure resources list includes `gitnexus://group/{name}/contracts` and `gitnexus://group/{name}/status`.

Proposed write set:

- `README.md`

No source-code write set is recommended for the first Task 3 slice.

Focused verification for the docs-only slice:

```powershell
rg -n "16 tools|group_contracts|group_query|group_status|13 MCP tools|repo: \"@<groupName>\"|gitnexus://group/{name}/contracts|gitnexus://group/{name}/status" README.md ARCHITECTURE.md
npm test -- test/unit/tools.test.ts test/unit/group/group-tools.test.ts test/unit/mcp/group-repo-routing.test.ts test/unit/resources.test.ts
npm test -- test/integration/group
git diff --check -- README.md
```

Risks:

- If MAIN wants "unified graph across repositories" literally, README reconciliation is not enough and the task becomes a large architecture project.
- If docs are changed without making the CLI/MCP distinction explicit, future agents will again confuse CLI group commands with MCP group tools.
- If `README.md` remains stale, agent-facing public docs will continue telling agents to call removed MCP tools.

Stop rules:

- Stop if implementation pressure moves beyond `README.md`.
- Stop if MAIN requests actual unified cross-repo graph behavior; that requires a new decision-grade architecture plan.
- Stop if verification shows `tools.ts` or `ARCHITECTURE.md` have changed underneath this plan.

Suggested MAIN approval text:

```text
MAIN | READY_FOR_IMPLEMENTATION
Feature: Multi-Repo Support Improvements
Branch/worktree: C:\Users\steve\projects\gitnexus\source-rc109-integration on local/gitnexus-local-features
Approved slice: documentation/tool-surface reconciliation only. Update README.md so the MCP tool table matches current source truth: 13 MCP tools, 11 per-repo plus group_list/group_sync; group analysis through query/context/impact with repo "@<groupName>" or "@<groupName>/<memberPath>"; group contracts/status via resources; keep CLI group query/contracts/status documented as CLI commands.
Approved write set:
- README.md
Constraints: no GitNexus source-code changes, no MCP schema changes, no CLI behavior changes, no unified cross-repo graph work, no hooks, no new dependencies. Verify with focused MCP/group surface tests and git diff --check.
```

Approval recorded:

- 2026-06-06T10:55+01:00: User clarified standing conditional implementation authorization for all goals after readiness/research is complete. This authorizes the Task 3 docs-only `README.md` slice above because its readiness map is complete and the write set is exact.

Implementation status:

- 2026-06-06T10:57+01:00: Task 3 docs-only `README.md` slice implemented and verified. No source-code, MCP schema, CLI behavior, dependency, hook, or unified graph changes were made.

## Deferred Tasks

- Auto Regression Forensics: wait for PR Impact report schema and CI/failure evidence model.
- End-to-End Test Generation: wait for PR Impact risk model and explicit test-framework target.
- Regression Forensics requires a failing-test/known-good/known-bad evidence contract; E2E generation requires an app launch/browser/test-framework contract. Do not plan implementation for either from the current `eval/` harness alone.
- OCaml Support: separate language-support project with parser/provider/test burden; do not mix into the first feature sequence.

## Research Methodology For Remaining Work

Use this order for each feature before implementation:

1. Expected behavior: public README/enterprise wording, relevant GitHub PRs/issues, and external analogues.
2. Actual behavior: local source, tests, `ARCHITECTURE.md`, and `gitnexus query --repo gitnexus-local-features` graph checks.
3. Dependency shape: what the feature needs from previous features and which surfaces it would touch.
4. Smallest safe slice: the minimum useful behavior that can be tested independently.
5. Approval boundary: exact write set, tests, risks, and `MAIN | READY_FOR_IMPLEMENTATION` gate.

Do not implement from research notes alone. Auto-Reindexing, Auto-Updating Code Wiki, and Multi-Repo Support Improvements have approved local slices implemented and verified. The next allowed work is Task 4 readiness completion and then, only after the WIP boundary is resolved, a sequential Task 4 implementation Goal for the exact documented `pr-impact` report slice.

## TDD Execution Rule

When MAIN opens a feature write scope, implementation should proceed one behavior at a time:

1. Run the relevant focused baseline tests and record the result.
2. Write one minimal test for the next intended behavior.
3. Run that test and confirm it fails for the expected product reason, not a typo or harness error.
4. Implement only enough code to make that test pass.
5. Re-run the focused test and any nearby affected tests.
6. Refactor only after green, keeping the same tests green.
7. Repeat for the next behavior until the approved slice's acceptance criteria are covered.

For Auto-Reindexing, the first TDD candidates are stale repo selected, fresh repo skipped, dry-run no-op, same-repo coalescing, invalid registry entry handling, explicit auto/freshness operation trigger, and watcher failure not blocking sweep recovery.
