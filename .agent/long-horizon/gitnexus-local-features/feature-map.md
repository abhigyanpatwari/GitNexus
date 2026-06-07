# GitNexus Local Features - Comprehensive Feature Map

Created: 2026-06-06

## Purpose

This file maps the whole GitNexus local-features workstream in one place: feature status, dependencies, source surfaces, tests, approval gates, evidence files, and next actions.

It is a navigation and coordination artifact. It does not approve source edits. Source edits remain gated by `MAIN | READY_FOR_IMPLEMENTATION` for one feature and one write set at a time.

## Control Surface

Authoritative long-horizon files:

| File | Role |
| --- | --- |
| `prompt.md` | Durable objective, constraints, branch, and candidate feature list |
| `plans.md` | Live queue, selected-task packets, implementation/readiness plans |
| `implement.md` | Execution discipline, TDD, approval, routing, and documentation rules |
| `documentation.md` | Checkpoint authority and current truth ledger |

Supporting evidence:

| File | Role |
| --- | --- |
| `enterprise-feature-intended-functions-scratchpad.md` | Research evidence and intended-function notes |
| `brainstorming-pr-review-blast-radius.md` | PR Impact / Blast Radius V1 brainstorm and critique incorporation |
| `gitnexus-router-indexing-note.md` | Historical workstation routing/indexing incident note |
| `plan.md` | Legacy/subordinate plan material; not a live control file |

## Operating Map

| Rule | Current Decision |
| --- | --- |
| Branch model | One shared branch: `local/gitnexus-local-features` |
| Work sequencing | One implementation feature at a time |
| Current tranche | Task 1 Auto-Reindexing, Task 2 Auto-Updating Code Wiki, Task 3 Multi-Repo Support Improvements, Task 4 PR Impact / Blast Radius, Task 5 Auto Regression Forensics local V1, Task 6 E2E/API-smoke local V1, and Task 7 OCaml readiness |
| Pause point | Task 6 deterministic generated Playwright spec renderer is implemented for narrow mocked `/api/repos`, `/api/repo`, `/api/graph`, and `/api/file` route paths; `/api/processes` and `/api/health` are implemented through a separate API-smoke lane; Task 7 OCaml Query Depth V2 is implemented; broader generated tests, additional API-smoke routes, wiki mutation, and deeper OCaml semantics require new readiness packets |
| Implementation gate | `MAIN | READY_FOR_IMPLEMENTATION` must name feature, branch/worktree, write set, and constraints |
| Standing authorization | MAIN authorizes implementation after each feature's readiness/research map is complete, but only for the exact documented slice and write set |
| Development method | TDD for behavior changes: red, green, refactor, verify |
| Hooks | Not used as the implementation route |
| GitNexus host route | `gitnexus` = host/npm CLI |
| GitNexus Podman route | `gitnexus-podman` = Podman/container runtime/indexes |
| Removed route | `gitnexus-host` is quarantined/removed and should not be used in new workflow |
| Embeddings route | Podman-managed repos use internal `gitnexus-embed:8080`; host embedding parity is opt-in only |

## Feature Inventory

| Order | Feature | Research Depth | Disposition | Implementation Status | Gate |
| --- | --- | --- | --- | --- | --- |
| 1 | Auto-Reindexing | Decision-grade completed for first slice | `local V1 complete` | Approved first slice implemented, verified, and snapshotted | Do not broaden without a new Goal |
| 2 | Auto-Updating Code Wiki | Medium plus source analysis completed for first slices | `local V1 complete` | Core status/dry-run-first planner/runner implemented and snapshotted; read-only server status endpoint plus provider-readiness status implemented and verified | Do not add event wiring or mutation without a new Goal |
| 3 | Multi-Repo Support Improvements | Readiness completed for first docs slice | `local docs slice complete` | README tool-surface reconciliation implemented, verified, and snapshotted | No unified graph expansion without new approval |
| 4 | PR Impact / Blast Radius | Medium readiness refreshed | `local V1 complete` | Report core and thin local CLI wrapper implemented, verified, and committed | MCP/GitHub automation deferred |
| 5 | Auto Regression Forensics | Light scoping completed for first slice | `local V1 complete` | Report core and thin local CLI wrapper implemented, verified, and committed | CI/artifact/bisect automation deferred |
| 6 | End-to-End Test Generation | Light scoping completed plus executable-output/API-smoke policy readiness | `local V1 complete` | Proposal/report core, thin local CLI wrapper, deterministic `/api/repos`, `/api/repo`, `/api/graph`, and `/api/file` generated-spec renderer, `/api/processes` and `/api/health` API-smoke renderers, and explicit write modes implemented locally | Broader generated tests/browser/CI remain deferred |
| 7 | OCaml Support | Light scoping completed plus approval packet | `local V1 complete` | Experimental `.ml` / `.mli` support and Query Depth V2 module type/include/functor-reference captures implemented locally | Deeper OCaml semantics beyond syntax-level module type/include/functor references require a new Goal |

## Dependency Map

| Dependency | Meaning |
| --- | --- |
| Auto-Reindexing -> Code Wiki | Wiki auto-refresh must trust graph freshness before deciding whether a wiki is stale or safe to refresh. |
| Auto-Reindexing -> PR Impact | PR impact reports should warn or block when graph/index evidence is stale or ambiguous. |
| Code Wiki -> Multi-Repo | Wiki refresh status and graph freshness decisions should not be confused with group/multi-repo behavior; Task 3 should reconcile those surfaces after Task 2 is bounded. |
| Multi-Repo -> PR Impact | PR impact may later need explicit repo identity and group/context awareness, but V1 should remain local report-first unless MAIN expands scope. |
| PR Impact -> Auto Regression Forensics | Regression forensics needs a stable impact/risk/evidence report shape before it can explain failures defensibly. |
| PR Impact -> End-to-End Test Generation | Test generation needs changed-surface/risk/test-gap signals before proposing or creating tests. |
| OCaml Support -> Indexing/Impact/Wiki | OCaml would affect ingestion, symbol extraction, graph queries, impact, and wiki docs, so it is a separate language-onboarding project. |

High-level flow:

```text
Task 1 Auto-Reindexing
  -> Task 2 Auto-Updating Code Wiki
  -> Task 3 Multi-Repo Support Improvements
  -> MAIN pause/review
  -> Task 4 PR Impact / Blast Radius
       -> Task 5 Auto Regression Forensics
       -> Task 6 End-to-End Test Generation

Task 7 OCaml Support remains parallel/deferred and should not be mixed into Tasks 1-6.
```

## Feature Detail Map

### Task 1 - Auto-Reindexing

Current status:

- Approved by MAIN on 2026-06-05.
- Implemented locally with TDD.
- Focused tests and build passed.
- Snapshotted in the shared branch as part of the local-features checkpoint history.

Intended local capability:

- Prevent registered repository indexes from silently becoming stale.
- Use opt-in server-side freshness sweeps, commit-staleness checks, existing reindex queue semantics, dry-run safety, coalescing, and operation visibility.
- Avoid hooks and avoid native file watching as the correctness mechanism.

Implemented source surfaces:

| Surface | Status |
| --- | --- |
| `gitnexus/src/server/reindex-auto-sweep.ts` | New planner/runner for stale repo sweep |
| `gitnexus/src/server/reindex-operations.ts` | Adds `auto-reindex` operation support |
| `gitnexus/src/server/api.ts` | Wires opt-in sweep from watcher config |
| `gitnexus/test/unit/reindex-auto-sweep.test.ts` | New focused tests |
| `gitnexus/test/unit/reindex-api-wiring.test.ts` | Updated wiring tests |
| `gitnexus/test/unit/reindex-operations.test.ts` | Updated operation tests |

Verification recorded:

| Check | Result |
| --- | --- |
| Focused reindex/freshness suite | Passed, 7 files, 62 tests |
| `npm run build` | Passed |
| `git diff --check` | Passed after local docs/source WIP at the time |

Open risks:

- Next agents must not mix more feature source edits into this slice without a new Goal.
- Runtime/Podman behavior still requires later operational validation if MAIN asks for promoted runtime use.

Next gate:

- Do not broaden Task 1 without a new Goal and explicit write set.

### Task 2 - Auto-Updating Code Wiki

Current status:

- User approved implementation on 2026-06-06 for the status/dry-run-first slice.
- Core planner/runner implemented locally.
- Read-only server status endpoint implemented locally on 2026-06-07.
- Core focused wiki tests, focused reindex/freshness tests, build, and whitespace check passed for the original core slice.
- Endpoint verification passed under the active Goal.
- No generated wiki output mutation, no unattended LLM generation.

Intended local capability:

- Reuse the existing manual Code Wiki generator.
- Add conservative auto-refresh orchestration that decides whether a refresh would be safe and useful after confirmed graph freshness.
- Default to status/dry-run behavior.
- Avoid creating or overwriting wiki output unless explicit mutation and provider policy are approved.

Implemented source surfaces:

| Surface | Status |
| --- | --- |
| `gitnexus/src/core/wiki/auto-refresh.ts` | New planner/runner and meta reader |
| `gitnexus/src/core/wiki/provider-readiness.ts` | Non-secret provider-readiness policy for server status |
| `gitnexus/test/unit/wiki-auto-refresh.test.ts` | New focused tests |
| `gitnexus/src/server/api.ts` | Read-only `GET /api/wiki/auto-refresh` status endpoint |
| `gitnexus/test/unit/wiki-auto-refresh-api-wiring.test.ts` | Source-wiring test proving planner/provider-status use and no generator invocation |
| `gitnexus/test/unit/wiki-provider-readiness.test.ts` | Provider-readiness and no-secret status tests |

Existing generator surfaces inspected:

| Surface | Finding |
| --- | --- |
| `gitnexus/src/cli/wiki.ts` | Interactive/config-mutating CLI path; automation should not call it directly |
| `gitnexus/src/core/wiki/generator.ts` | Functional generator; mutates output; wiki freshness is not graph freshness |
| `gitnexus/src/core/wiki/llm-client.ts` | Provider readiness and LLM policy must remain explicit |
| `gitnexus/src/core/wiki/graph-queries.ts` | Wiki content comes from existing graph, so graph freshness gating is required |

Verification recorded:

| Check | Result |
| --- | --- |
| `npm test -- test/unit/wiki-auto-refresh.test.ts` | Passed, 1 file, 8 tests |
| `npm test -- test/unit/wiki-auto-refresh-api-wiring.test.ts` | Passed, 1 file, 1 test after red/green |
| `npm test -- test/unit/wiki-auto-refresh.test.ts test/unit/wiki-auto-refresh-api-wiring.test.ts` | Passed, 2 files, 9 tests |
| `npm test -- test/unit/reindex-freshness-wiring.test.ts test/unit/reindex-api-wiring.test.ts` | Passed, 2 files, 23 tests |
| Focused wiki suite | Passed, 5 files, 127 tests |
| Focused reindex/freshness suite | Passed, 7 files, 62 tests |
| `npm run build` | Passed |
| `git diff --check` | Passed |

Open decisions:

- Whether the next Task 2 slice should wire status-only planning into successful reindex/freshness events.
- Whether any future mutation should require an explicit config key, CLI flag, operation request, or all three.
- Provider/cost/publication policy remains required before unattended generation.

Next gate:

- Complete current endpoint verification, then decide the next Task 2 boundary through a new Goal if MAIN wants event wiring or mutation behavior.

### Task 3 - Multi-Repo Support Improvements

Current status:

- First docs slice complete.
- Docs-only README tool-surface reconciliation implemented, verified, and snapshotted.
- Current readiness says the first useful slice is README MCP tool-surface reconciliation, not unified cross-repo graph expansion.

Intended local capability:

- Make multi-repo/group behavior clearer and safer by reconciling docs, resources, CLI surfaces, and actual source behavior.
- Improve current group/status/contracts/tool-surface ergonomics only if source evidence supports a small, useful slice.

Known current-source framing:

| Surface | Current Understanding |
| --- | --- |
| CLI `gitnexus group ...` commands | `create`, `add`, `remove`, `list`, `status`, `sync`, `impact`, `query`, and `contracts` are present |
| MCP group-specific tools | `group_list` and `group_sync` are present; `group_sync` is mutating |
| Group-aware MCP `query`, `context`, `impact` | These route through `repo: "@<groupName>"` or `repo: "@<groupName>/<memberPath>"` |
| Group status/contracts MCP resources | `gitnexus://group/{name}/contracts` and `gitnexus://group/{name}/status` are present |
| Removed MCP `group_query`, `group_contracts`, `group_status` | Legacy tool names only; LocalBackend throws migration guidance |
| Unified cross-repo graph | Out of scope unless MAIN expands scope |

Likely evidence to inspect next:

| Area | Candidate Files/Commands |
| --- | --- |
| Architecture | `ARCHITECTURE.md`, group docs, MCP resource docs |
| Source | group registry, group sync/contracts/status implementation, MCP server wiring |
| Tests | group unit/integration tests, MCP resource tests |
| Runtime | `gitnexus group list`, `gitnexus group status`, group resources if available |

Open risks:

- Stale docs can make agents plan features that already changed or no longer exist.
- Multi-repo may tempt a broad unified-graph rewrite; current plan forbids that without MAIN.

Next gate:

- If MAIN wants actual unified cross-repo graph behavior later, create a new decision-grade architecture plan first.

### Task 4 - PR Impact / Blast Radius

Current status:

- Local V1 complete.
- Report core and thin local `gitnexus pr-impact` CLI wrapper implemented, verified, and committed.
- Brainstorm note now frames V1 as deterministic `diff ranges -> symbols -> impact -> report`.
- Recommended command name is `pr-impact`, not `pr-review`, to avoid confusion with review/swarms.

Intended local capability:

- Produce a local Markdown/JSON PR impact report.
- Use deterministic diff-to-graph mapping and bounded impact traversal.
- Keep GitHub comments, checks, token-bearing workflows, Codex remediation, and generated tests for later phases.

V1 core concept:

| Stage | Meaning |
| --- | --- |
| Diff ranges | Identify changed file/range evidence from git diff or supplied diff |
| Symbols | Map changed ranges to graph symbols when possible |
| Impact | Traverse direct/transitive callers/process/routes within bounded hops |
| Report | Emit deterministic Markdown/JSON with verdict, schema version, evidence, caveats, and optional sections only when backed by graph evidence |

Draft V1 rules from brainstorm:

| Topic | Current Draft |
| --- | --- |
| JSON schema | Experimental but includes `schema_version` from day one |
| Hop cap | Default 5 with cycle guard |
| Coverage signal | `has_test_reference` only when graph has test file `CALLS` or `IMPORTS` path; otherwise `unknown_or_unreferenced` |
| Deleted symbols | Resolve against base graph where possible; surface inbound callers loudly |
| Unmatched ranges | Report as unmatched range/file-level impact candidate |
| New symbols | Report as new/unmapped without inbound-caller claims |
| Verdicts | `BLOCK`, `NEEDS_DISCUSSION`, `PROCEED`, `UNKNOWN` |
| Acceptance | Checked-in fixture diff plus golden Markdown/JSON reports |

Current source ownership map:

| Surface | Current Files/Tests | V1 Use |
| --- | --- | --- |
| CLI command registration | `gitnexus/src/cli/index.ts`, `gitnexus/src/cli/tool.ts`, `gitnexus/test/unit/tool-direct-cli.test.ts`, `gitnexus/test/unit/cli-index-help.test.ts` | Add `pr-impact` only after report core is tested |
| Diff parsing | `gitnexus/src/storage/git.ts`, `gitnexus/test/unit/parse-diff-hunks.test.ts` | Reuse/extend for richer new-side, old-side, deletion, and unmatched range records |
| Range-to-symbol mapping | `gitnexus/src/mcp/local/local-backend.ts::detectChanges`, `gitnexus/test/unit/detect-changes-worktree.test.ts`, `gitnexus/test/unit/calltool-dispatch.test.ts` | Extract or wrap a focused helper; do not bury report logic inside `detectChanges()` |
| Impact traversal | `gitnexus/src/mcp/local/local-backend.ts::impact/_runImpactBFS`, `gitnexus/test/unit/impact-confidence.test.ts`, `gitnexus/test/unit/impact-pagination.test.ts` | Reuse bounded BFS, depth output, cycle guard, risk, process/module enrichment |
| API/route evidence | `route_map`, `shape_check`, `api_impact`, `gitnexus/test/integration/api-impact-e2e.test.ts`, `gitnexus/test/fixtures/api-impact-seed.ts` | Render optional API section only when graph evidence exists |
| MCP tool schema | `gitnexus/src/mcp/tools.ts`, `gitnexus/test/unit/tools.test.ts` | Keep MCP `pr-impact` out of V1 unless MAIN later expands scope |
| PR review methods | `pr-swarm-review/`, `C:\Users\steve\.agents\skills\gitnexus-pr-review\SKILL.md` | Read-only methodology/reference material, not automation source |

Current expected-vs-actual findings:

| V1 expectation | Current local behavior | Gap |
| --- | --- | --- |
| Local diff input | `detect_changes` supports unstaged/staged/all/compare | Good base |
| Changed range parsing | `parseDiffHunks()` returns new-side line ranges | Needs richer range model |
| Deleted symbols | Pure-deletion hunks are skipped today | Needs old-side/base-graph deletion handling |
| Unmatched ranges | Unmatched changed ranges are not surfaced | Needs explicit unmatched evidence |
| New symbols | New unmapped symbols are not separately classified | Needs explicit new/unmapped status |
| Impact traversal | `impact` provides bounded BFS, cycle guard, per-depth output, risk | Reuse; V1 default depth should be 5 |
| API impact | `api_impact`/`route_map`/`shape_check` exist | Optional report sections only |
| Report schema | No `pr-impact` report schema exists | Add experimental `schema_version` and golden tests |
| GitHub automation | Not present | Defer; out of V1 |

Smallest safe implementation candidate:

- Add deterministic report core with fixture-backed JSON/Markdown golden tests.
- Add diff-mapping support for unmatched ranges, deleted symbols, and new/unmapped symbols.
- Add verdict rules and conservative test-reference approximation.
- Add a thin `gitnexus pr-impact` CLI wrapper only after report core passes.
- Do not add MCP exposure, GitHub PR comments/checks, PR URL ingestion, Codex remediation, generated tests, or UI in V1.

Implemented V1 source surfaces:

| File | Purpose |
| --- | --- |
| `gitnexus/src/core/pr-impact/report.ts` | JSON/Markdown report, schema, verdicts, optional sections |
| `gitnexus/src/core/pr-impact/diff-mapping.ts` | Range model and range-to-symbol helper if needed |
| `gitnexus/src/cli/pr-impact.ts` | Thin CLI orchestration |
| `gitnexus/src/cli/index.ts` | Register command |
| `gitnexus/src/cli/help-i18n.ts` and locale files | Help text only if CLI command is registered |
| `gitnexus/test/unit/pr-impact-report.test.ts` | Golden report and verdict tests |
| `gitnexus/test/unit/pr-impact-diff-mapping.test.ts` | Range/deletion/new/unmatched tests |
| `gitnexus/test/fixtures/pr-impact/*` | Fixture diffs and golden outputs |

Open risks:

- GitHub automation is security-sensitive and out of V1.
- Stale/ambiguous graph identity must produce `UNKNOWN`, not overconfident output.
- Large hubs require summary-first/pagination behavior.
- Deleted-symbol support may require old-side/base-graph lookup; stop if it expands into a broad base-index architecture.

Next gate:

- Do not add MCP exposure, GitHub PR comments/checks, PR URL ingestion, Codex remediation, generated tests, or UI without a new Goal and approval boundary.

### Task 5 - Auto Regression Forensics

Current status:

- Deterministic report core implemented and committed with TDD.
- Thin local `gitnexus regression-forensics` CLI wrapper implemented with TDD.
- No MCP/GitHub/CI automation implemented.
- PR Impact V1 report/CLI now exists and can provide the first graph/risk dependency.

Intended local capability:

- Explain regressions by combining known-good/known-bad refs, failing tests/CI evidence, changed graph surfaces, and impact context.
- V1 should report candidate causes and confidence/caveats; it must not claim true root cause from incomplete evidence.

Dependencies:

| Dependency | Why |
| --- | --- |
| PR Impact schema | Regression forensics needs stable impact/risk evidence to reason from; `pr-impact.v1alpha1` now exists locally |
| CI/test failure contract | Needs concrete failure evidence, not just code change evidence |
| Git history/bisect model | Needs known-good/known-bad or equivalent |
| Graph freshness | Stale graph would invalidate causal claims |

Implemented local V1 surfaces:

| Surface | Status |
| --- | --- |
| `gitnexus/src/core/regression-forensics/report.ts` | Deterministic report core with experimental `regression-forensics.v1alpha1` schema |
| `gitnexus/src/cli/regression-forensics.ts` | Thin local CLI wrapper over local JSON files |
| `gitnexus/test/unit/regression-forensics-report.test.ts` | Report schema/Markdown/confidence tests |
| `gitnexus/test/unit/regression-forensics-cli.test.ts` | CLI local JSON Markdown/JSON tests |
| `gitnexus/test/fixtures/regression-forensics/golden-basic-report.md` | Golden Markdown fixture |

Verification recorded:

| Check | Result |
| --- | --- |
| Report-core focused tests | Passed, 1 file, 3 tests |
| Report-core adjacent PR Impact tests | Passed, 3 files, 10 tests |
| CLI focused tests | Passed, 1 file, 2 tests |
| Combined CLI/report/help tests | Passed, 5 files, 24 tests |
| `git diff --check` | Passed |
| `npm run build` | Passed |

Next gate:

- Commit the CLI wrapper slice and complete the active Goal.
- Create the next sequential Goal for Task 6 End-to-End Test Generation readiness.
- Keep richer Task 5 parsing, MCP exposure, GitHub comments/checks, live CI/test execution, automatic bisect, and remediation deferred.

### Task 6 - End-to-End Test Generation

Current status:

- Readiness completed for a first local slice.
- Target app/framework/runtime contract now exists for the first track: `gitnexus-web` with existing Playwright Chromium E2E infrastructure.
- Deterministic proposal/report core implemented locally with TDD.
- Thin local `gitnexus e2e-test-plan` CLI wrapper implemented locally with TDD.

Intended local capability:

- Generate or propose E2E tests from changed routes, execution flows, impact reports, and an approved app/test framework.
- V1 should propose tests only; executable test-file generation is later.

Dependencies:

| Dependency | Why |
| --- | --- |
| Target app launch surface | Tests must know what to run and where |
| Test framework | Playwright/Cypress/etc. must be explicit |
| Fixture/data policy | Generated tests need stable safe data |
| PR Impact/test-gap signal | Helps choose which tests are worth generating |
| Secrets/sandbox policy | E2E generation can touch auth, URLs, and credentials |

Readiness decisions:

| Field | Decision |
| --- | --- |
| First target app | `gitnexus-web` |
| First framework | Existing Playwright (`@playwright/test`) |
| Browser | Chromium first, matching CI |
| Backend/frontend | `gitnexus serve` on `4747`, Vite on `5173` |
| Data | Existing CI mini fixture repo indexing pattern |
| First output | Deterministic Markdown/JSON proposal report |
| First schema | Proposed `e2e-test-plan.v1alpha1` |
| First mutation boundary | No generated executable test files |

Candidate first source surfaces:

| Surface | Purpose |
| --- | --- |
| `gitnexus/src/core/e2e-test-generation/report.ts` | Implemented deterministic proposal schema, ranking, caveats, Markdown/JSON rendering |
| `gitnexus/test/unit/e2e-test-generation-report.test.ts` | Implemented golden schema/Markdown/ranking/no-executable-code tests |
| `gitnexus/test/fixtures/e2e-test-generation/golden-basic-report.md` | Implemented checked-in expected Markdown |
| `gitnexus/src/cli/e2e-test-plan.ts` | Implemented local JSON-in/Markdown-or-JSON-out wrapper |
| `gitnexus/test/unit/e2e-test-plan-cli.test.ts` | Implemented CLI Markdown/JSON tests |

Verification recorded:

| Check | Result |
| --- | --- |
| Focused E2E test-plan report tests | Passed, 1 file, 3 tests |
| Adjacent E2E/Regression/PR report tests | Passed, 4 files, 13 tests |
| Focused E2E test-plan CLI tests | Passed, 1 file, 2 tests |
| Combined CLI/report/help tests | Passed, 6 files, 27 tests |
| `git diff --check` | Passed |
| `npm run build` | Passed |

Next gate:

- Move to Task 7 OCaml Support readiness.
- Keep generated Playwright file writing, browser execution, CLI/MCP exposure, GitHub/CI automation, and `gitnexus-web/e2e` changes deferred.

### Task 7 - OCaml Support

Current status:

- Experimental V1 implemented locally.
- Separate language-provider/parser onboarding project.
- Deeper source work requires a new Goal and write set.

Intended local capability:

- Add OCaml indexing support only if parser/provider/dependency/test burden is accepted.

Readiness result:

- Feasible in principle through `tree-sitter-ocaml`.
- Not a minor parser toggle; it touches shared language identity, extension detection, parser loading, parse-worker dispatch, provider registration, queries/captures, import/module semantics, type/call extraction, fixtures, and tests.
- `.ml` and `.mli` must both be in V1 scope because the official grammar exposes separate implementation and interface grammars.

Known local gaps:

| Gap | Meaning |
| --- | --- |
| Language enum/registry | `gitnexus-shared/src/languages.ts` and provider registry do not include OCaml |
| Extension mapping | `.ml` and `.mli` are not mapped in `gitnexus-shared/src/language-detection.ts` |
| Parser/provider | `tree-sitter-ocaml` route must be selected and approved before dependency/source edits |
| Grammar selection | `.ml` and `.mli` need file-path-aware grammar selection similar in spirit to TS/TSX |
| Queries/resolvers | Symbol/call/import extraction requires language-specific query and provider work |
| Fixtures/parity tests | Need representative OCaml fixtures and graph expectations before broadening |

External evidence:

| Source | What it contributes |
| --- | --- |
| https://github.com/tree-sitter/tree-sitter-ocaml | Official OCaml grammar exists; README documents implementation/interface/type grammars; MIT license |
| `npm view tree-sitter-ocaml ...` | npm latest is `0.24.2`, MIT, peer `tree-sitter` `^0.22.4` |
| https://raw.githubusercontent.com/tree-sitter/tree-sitter-ocaml/master/package.json | Repository master metadata is `0.25.0`, MIT, ESM package, peer `tree-sitter` `^0.25.0` |
| https://github.com/abhigyanpatwari/GitNexus/pull/305 | Language support analogue showing CLI/web parity, grammar provenance, type extraction, resolver, syntax, and coverage expectations |
| https://github.com/abhigyanpatwari/GitNexus/pull/317 | Language support caution showing parser/registry wiring is insufficient without type/import/member CALLS correctness |

Recommended first approved slice:

- Experimental OCaml support for `.ml` and `.mli`.
- Dependency route: npm `tree-sitter-ocaml@0.22.0`, because it peers on `tree-sitter: 0.21` and GitNexus currently pins `tree-sitter@0.21.1`.
- Minimal graph correctness for modules, values/functions, types, direct calls, open/import-like module references, and interface declarations.
- Parser ABI smoke, query compilation, focused fixtures, and build verification.

Implemented V1 notes:

- The actual `tree-sitter-ocaml@0.22.0` package exports `ocaml` and `interface`; implementation uses `interface` for `.mli`.
- OCaml is classified as `experimental`.
- Focused OCaml tests and existing language safety tests pass.

Deferred:

- Dune project model.
- PPX expansion.
- Full functor/module alias semantics.
- Generated-code handling.
- Production classification.

Next gate:

- Do not broaden OCaml beyond the experimental V1 without a new Goal.

## Current WIP Boundary

Current uncommitted source WIP includes:

- None at this checkpoint.

Current uncommitted documentation WIP includes:

- None at this checkpoint.

Boundary rule:

- Before broadening Task 6 into inventory extraction, browser execution, or generated test files, create a new output-policy Goal.
- Before broadening Task 7 beyond experimental `.ml` / `.mli` support, create a new Goal for the exact OCaml semantics, dependency, and test boundary.

## Source Surface Map By Area

| Area | Known/Expected Surfaces | Feature Use |
| --- | --- | --- |
| Reindex/freshness | `gitnexus/src/server/reindex-auto-sweep.ts`, `reindex-operations.ts`, `api.ts`, freshness/staleness tests | Task 1, supports Tasks 2 and 4 |
| Wiki | `gitnexus/src/core/wiki/*`, `gitnexus/src/cli/wiki.ts`, wiki tests | Task 2 |
| Groups/multi-repo | group registry/sync/status/contracts source, MCP resources, architecture docs, group tests | Task 3 |
| Diff/impact/API impact | `detect_changes`, `impact`, `api_impact`, CLI/MCP wiring, graph traversal tests | Task 4 |
| Regression/evals | `eval/`, test/CI surfaces, regression forensics report/CLI source, possible report/evidence fixtures | Task 5 |
| E2E generation | existing E2E tests, route maps, browser/test framework docs | Task 6 |
| Language support | language registry, ingestion provider patterns, parser queries, fixture tests | Task 7 |

## Evidence Map

| Evidence Class | Where Recorded | Features Affected |
| --- | --- | --- |
| Long-horizon operating model | `prompt.md`, `implement.md`, `plans.md`, `documentation.md` | All |
| Feature research matrix | `enterprise-feature-agent-handoff.md` legacy material, `plans.md`, `documentation.md` | All |
| Auto-Reindexing source/readiness | `plans.md`, `documentation.md`, source/tests | Task 1 |
| Wiki generator analysis | `documentation.md`, `plans.md`, source/tests | Task 2 |
| PR Impact brainstorm | `brainstorming-pr-review-blast-radius.md`, `enterprise-feature-intended-functions-scratchpad.md` | Task 4, later Tasks 5-6 |
| Routing/indexing incident | `gitnexus-router-indexing-note.md`, AGENTS/workstation guidance | All local GitNexus operations |
| Embeddings/Podman route | `documentation.md`, routing notes | GitNexus indexing environment |

## What Is Not Fully Mapped Yet

| Gap | Required Work |
| --- | --- |
| Task 3 source ownership | Completed for first docs slice; no further source mapping needed unless MAIN expands scope |
| Task 3 smallest useful slice | Decide whether improvement is docs reconciliation, CLI ergonomics, status output, tests, or MCP/resource alignment |
| Task 4 source implementation | First local report/CLI slice completed; future MCP/GitHub automation requires a new plan |
| Task 4 fixture design | Completed for first local report slice; future live diff/GitHub fixtures remain later |
| Task 5 evidence contract | First local fixture-shaped failure/PR Impact input contract exists; richer CI artifact parsing remains later |
| Task 6 runtime contract | First local contract selected for `gitnexus-web` + Playwright; proposal/report core, CLI wrapper, executable-output policy readiness, narrow `/api/repos`, `/api/repo`, `/api/graph`, `/api/file` generated-spec renderer, and `/api/processes` plus `/api/health` generated API-smoke renderer completed; broader generated tests remain deferred |
| Task 6 `/api/processes` generated UI fixture | Rejected for the browser UI lane: frontend Process panel derives rows from `/api/graph` Process nodes and does not call `fetchProcesses()` / `/api/processes`; `/api/processes` is now covered by a separate generated API-smoke lane |
| Task 7 parser/provider plan | Experimental V1 and Query Depth V2 implemented; Dune, PPX, interface/implementation matching, production classification, and full module-system resolution remain deferred |

## Next Actions

Immediate:

1. Treat the seven local V1 slices plus Task 6 `/api/processes` and `/api/health` API-smoke lane and `/api/file` UI fixture as the completed base tranche.
2. Continue with exactly one next selected task from the map below.
3. Start source edits only after the selected task's exact slice and write set are named.

## Next Task Map

| Rank | Candidate next task | Goal type | Why now | First concrete outcome | Current gate |
| --- | --- | --- | --- | --- | --- |
| 1 | Post-Tranche Consolidation | Readiness / docs Goal | Recent Task 6 and Task 7 slices are now implemented; the queue needs a refreshed next-slice recommendation before more source edits. | Reconcile completed slices, remaining deferred scopes, and recommend the next exact task. | Stop if the next task needs MAIN product/policy choice rather than technical readiness. |

Recommended default:

- Start with post-tranche consolidation and next-slice map refresh.
- Do not add more generated API-smoke routes until the backend route contract is decision-complete.
- Keep browser execution, Playwright config changes, CI mutation, live-backend generated specs, GitHub automation, MCP expansion, and deeper OCaml semantics deferred until the selected task opens that scope.
