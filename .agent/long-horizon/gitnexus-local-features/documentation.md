# GitNexus Local Features - Documentation

Created: 2026-06-05
Last updated: 2026-06-07

## Current Status

This task is tracked as a long-horizon Codex task through the four-file bundle in `.agent/long-horizon/gitnexus-local-features/`. This `documentation.md` file is the checkpoint authority.

Current state:

- Branch: `local/gitnexus-local-features`
- Baseline: `local/enterprise-handoff/rc109-fix5-dirty-baseline`
- Mode: Task 6 generated E2E route support broadened to deterministic mocked `/api/graph` specs
- Canonical docs: this source repo bundle
- Comprehensive map: `feature-map.md`
- Legacy docs: `C:\Users\steve\podman\gitnexus`
- Implementation gate: Auto-Reindexing, Auto-Updating Code Wiki planner/runner, Auto-Updating Code Wiki read-only server status endpoint, Multi-Repo Support Improvements, PR Impact / Blast Radius, Auto Regression Forensics, the Task 6 E2E proposal/report core, Task 6 deterministic generated Playwright spec renderer for `/api/repos`, `/api/repo`, and `/api/graph`, and Task 7 OCaml experimental language support V1 are implemented locally. Broader generated tests, browser execution, CI mutation, mutating wiki generation, MCP exposure, and GitHub automation remain deferred.
- Goal workflow: one active feature Goal at a time; complete or block the current Goal before creating the next; after every completed or blocked Goal, the supervisor must create the next Goal with the Goal tool or record `NO_NEXT_GOAL_CREATED` with the blocker; non-interactive `codex exec` worker runs must repeat the active Goal Contract and point to this bundle.
- CLI routing: hidden bare-`gitnexus` router quarantined on 2026-06-05; use `gitnexus-podman` explicitly for the Podman rc.109 route. Bare `gitnexus` is the host/npm route, aligned to `1.6.6-rc.109`.
- Embedding route: Podman-managed repos use container-side indexing and the internal llama.cpp sidecar at `gitnexus-embed:8080`; host/npm `gitnexus` embedding parity is opt-in only and must not be assumed.

## Decisions

- 2026-06-04: MAIN decided to use one shared branch for all planned local features.
- 2026-06-05: User chose `local/gitnexus-local-features` as the shared branch name.
- 2026-06-05: User chose to move the canonical planning bundle inside the source repo.
- 2026-06-05: User asked to review/fix interim-plan deficiencies and begin autonomous work. This was treated as approval to execute the documented interim router cleanup and continue non-source preparation, not as a source-feature write-set approval.
- 2026-06-05: Hidden bare-`gitnexus` router was quarantined. `gitnexus-podman` is the explicit Podman route and bare `gitnexus` is the host/npm route.
- 2026-06-05: Host/npm GitNexus CLI was updated from `1.6.6-rc.53` to the pinned local runtime version `1.6.6-rc.109`. npm also reported the package dist-tags as `latest: 1.6.5` and `rc: 1.6.6-rc.148`; this task did not retarget the runtime or source branch to rc.148.
- Git hooks are not the implementation route.
- One shared branch is the chosen route, but the operating rule is small-batch work with WIP limited to one implementation feature at a time.
- Current completed tranche is Task 1 Auto-Reindexing, Task 2 Auto-Updating Code Wiki, Task 3 Multi-Repo Support Improvements, Task 4 PR Impact / Blast Radius, then Task 5 Auto Regression Forensics local V1.
- Task 7 OCaml Support readiness is complete.
- End-to-End Test Generation has completed proposal/report, thin CLI local V1, and deterministic generated Playwright output for mocked `/api/repos`, `/api/repo`, and `/api/graph` route proposals. Broader generated tests remain implementation-blocked until an exact route/scenario Goal is opened. OCaml Support has completed experimental `.ml` / `.mli` local V1; deeper semantics remain deferred.
- 2026-06-05T10:39+01:00 coordinated research tranche initially preferred freshness first, PR report second, wiki refresh third, multi-repo surface reconciliation later, and regression/E2E/OCaml deferred; the later user decision below supersedes this sequence.
- 2026-06-05T10:49+01:00 coordinated continuation added methodology evidence, Context7 Node watcher corroboration, and a tighter rule: implementation planning must reconcile public intent, GitHub PR/issue evidence, official docs, and local source/graph evidence before MAIN approval.
- 2026-06-05T10:55+01:00 GitHub PR/issue deepening confirmed that OSS PostToolUse staleness behavior is notification-only and intentionally distinct from Enterprise Auto-reindexing.
- 2026-06-05T14:01+01:00 TDD discipline was recorded: once implementation is approved, behavior changes should proceed red-green-refactor with one focused failing test before production code.
- 2026-06-05: User chose a Codex Goal-backed non-interactive workflow: each feature has a Goal Contract, work proceeds through `codex exec` worker runs, and the supervisor thread keeps one active feature Goal at a time.
- 2026-06-05: Goal Contracts were reviewed against OpenAI Codex Goal guidance and tightened to include outcome, verification surface, constraints, boundaries, iteration policy, and blocked stop condition.
- 2026-06-05: Upstream Docker README/compose guidance and embedding PR evidence were reconciled with Steve's local Podman profile. Decision: default to Podman/container-side indexing for Podman-managed repos; do not configure Windows/User PowerShell `GITNEXUS_EMBEDDING_*` variables unless host CLI parity is explicitly requested.
- 2026-06-05: Redundant `gitnexus-host` compatibility helper was quarantined. New workflow uses only bare `gitnexus` for the host/npm CLI and `gitnexus-podman` for the Podman/container runtime.
- 2026-06-05T16:31+01:00: Auto-Reindexing now has a decision-complete implementation plan in `plans.md`, including expected vs actual behavior, proposed write set, helper boundary, TDD order, acceptance criteria, and required MAIN approval text. Source implementation remains blocked.
- 2026-06-05T17:05+01:00: Human operator approved the drafted Auto-Reindexing scope as `MAIN | READY_FOR_IMPLEMENTATION`. Source implementation may proceed only within that approved write set and must follow TDD.
- 2026-06-05T17:13+01:00: Approved Auto-Reindexing slice implemented locally with TDD. Focused reindex/staleness tests passed and `npm run build` passed.
- 2026-06-05T17:17+01:00: User clarified that Codex should work autonomously feature-by-feature. Decision: perform necessary preimplementation steps for each feature, create a particularized Goal for one feature at a time, and avoid starting the next feature's source implementation until the previous feature WIP boundary is unambiguous.
- 2026-06-05: User set the next execution order as Tasks 1, 2, and 3, then pause before Task 4. The task order is Auto-Reindexing, Auto-Updating Code Wiki, Multi-Repo Support Improvements, then PR Impact / Blast Radius only after MAIN review.
- 2026-06-05T18:12+01:00: Precursor review found no active Codex Goal. Task 2 Auto-Updating Code Wiki is now the active readiness Goal target; source implementation remains closed until a decision-complete plan and `MAIN | READY_FOR_IMPLEMENTATION` exist.
- 2026-06-06T10:16+01:00: User approved Task 2 implementation. Treat as `MAIN | READY_FOR_IMPLEMENTATION` for the status/dry-run-first wiki auto-refresh slice in `plans.md`.
- 2026-06-06T10:45+01:00: Comprehensive feature map created in `feature-map.md` to connect feature status, dependencies, source surfaces, tests, gates, evidence files, and next actions.
- 2026-06-06T10:47+01:00: Control docs reviewed before the next Goal. Stale Task 2 readiness wording was corrected; Task 3 readiness may begin, but Task 3 source implementation remains blocked.
- 2026-06-06T10:50+01:00: Active Task 3 readiness Goal created. First evidence checkpoint recorded: CLI group commands remain real, MCP group analysis uses `repo: "@group"` routing, MCP group contracts/status are resources, and removed `group_query/group_contracts/group_status` are legacy MCP tool names only.
- 2026-06-06T10:53+01:00: Task 3 readiness map completed for the first candidate slice. Evidence points to README MCP tool-table drift as the smallest safe improvement; proposed write set is `README.md` only.
- 2026-06-06T10:55+01:00: User clarified standing conditional implementation authorization for all feature Goals after readiness/research is complete. Treat this as authorization to implement exact documented slices after readiness, not as permission to skip readiness or broaden write sets.
- 2026-06-06T10:57+01:00: Task 3 docs-only README tool-surface reconciliation implemented and verified.
- 2026-06-06T11:04+01:00: Sequential Goal lifecycle rule recorded: complete or block the current Goal before creating the next; do not pre-create a backlog of active Goals.
- 2026-06-06T11:10+01:00: Active Task 4 PR Impact / Blast Radius readiness Goal started. Source edits remain blocked during readiness.
- 2026-06-06T11:15+01:00: Task 4 PR Impact / Blast Radius readiness refresh completed and verified. Source implementation remains blocked until the WIP snapshot/no-snapshot boundary is resolved and the next implementation Goal is created.
- 2026-06-06T12:12+01:00: WIP boundary review started as the next sequential Goal. Dirty tree buckets were identified; recommendation is to create a checkpoint/snapshot before Task 4 PR Impact source work.
- 2026-06-06T12:17+01:00: Checkpoint snapshot created at commit `568e24de` (`checkpoint local features through task 4 readiness`). The tree was clean immediately after the commit.
- 2026-06-06T12:23+01:00: Task 4 PR Impact report-core slice implemented with TDD. CLI wrapper is not added yet; that should be the next sequential Goal if desired.
- 2026-06-06T12:29+01:00: Task 4 thin `gitnexus pr-impact` CLI wrapper implemented with TDD. MCP and GitHub automation remain deferred.
- 2026-06-06T12:38+01:00: Task 4 CLI wrapper committed as `39d77845` (`feat: add pr impact cli command`). Goal baton rule strengthened: future completed/blocked Goals must be followed by an actual Goal tool call for the next Goal, or a documented `NO_NEXT_GOAL_CREATED` blocker.
- 2026-06-06T12:49+01:00: Active Task 5 Auto Regression Forensics readiness Goal created with the Goal tool. First readiness pass recommends a pure deterministic report-core slice over failure evidence plus PR Impact V1 data.
- 2026-06-06T13:02+01:00: Task 5 Auto Regression Forensics report-core slice implemented with TDD. CLI/MCP/GitHub/CI automation remain deferred.
- 2026-06-06T13:05+01:00: Task 5 report-core committed as `dcc5fd24` (`feat: add regression forensics report core`). Active post-core boundary Goal recommends a thin local `gitnexus regression-forensics` CLI wrapper next, with local JSON inputs only.
- 2026-06-06T13:08+01:00: Task 5 thin local `gitnexus regression-forensics` CLI wrapper implemented with TDD. It reads local `--failure-json` and `--pr-impact-json` files and emits Markdown or JSON. MCP, GitHub/CI automation, automatic bisect, live test execution, and remediation remain deferred.
- 2026-06-06T13:28+01:00: Task 6 End-to-End Test Generation readiness completed. Recommendation: first source slice should be a deterministic proposal/report core over PR Impact, optional Regression Forensics, route/API evidence, existing E2E inventory, and the `gitnexus-web` Playwright contract. Do not generate executable test files in V1.
- 2026-06-06T13:31+01:00: Task 6 E2E test proposal/report core implemented with TDD. It emits `e2e-test-plan.v1alpha1` JSON/Markdown proposals only; no executable Playwright files, browser execution, CLI/MCP exposure, CI mutation, or GitHub automation.
- 2026-06-06T13:34+01:00: Task 6 post-core boundary review completed. Recommendation: implement a thin local `gitnexus e2e-test-plan` CLI wrapper over local JSON inputs next. Defer richer existing-spec inventory extraction and all executable test-file generation.
- 2026-06-06T13:37+01:00: Task 6 thin local `gitnexus e2e-test-plan` CLI wrapper implemented with TDD. It reads local target, PR Impact, existing-scenarios, route-evidence, and optional Regression Forensics JSON and emits Markdown or JSON. Generated Playwright files, browser execution, automatic spec parsing, MCP, CI, and GitHub automation remain deferred.
- 2026-06-06T13:40+01:00: Task 6 post-CLI boundary review completed. Decision: Task 6 local V1 is complete enough to pause before executable generated-test policy. Next baton target is Task 7 OCaml Support readiness.
- 2026-06-06T13:41+01:00: Task 7 OCaml Support readiness completed. Decision: OCaml is feasible in principle through `tree-sitter-ocaml`, but source implementation requires MAIN approval for native dependency strategy, exact write set, `experimental` classification, and `.ml`/`.mli` V1 scope.
- 2026-06-06T13:48+01:00: Task 7 OCaml implementation approval packet prepared. Recommendation: use npm `tree-sitter-ocaml@0.22.0` for the first experimental local slice because it peers on `tree-sitter: 0.21`, matching GitNexus's current `tree-sitter@0.21.1` runtime family. Do not upgrade core `tree-sitter` in this slice.
- 2026-06-06T19:26+01:00: Task 7 OCaml experimental language support V1 implemented with TDD. `tree-sitter-ocaml@0.22.0` installed without upgrading core `tree-sitter@0.21.1`; package smoke showed actual exports `ocaml` and `interface` rather than README's `ocaml_interface`, so implementation uses the actual `interface` export for `.mli`.
- 2026-06-06T19:31+01:00: Task 7 OCaml implementation committed as `5f543c17` (`feat: add experimental ocaml language support`) and the active Goal was marked complete. The next defensible Goal is post-tranche consolidation and next-slice recommendation; do not start deeper feature work until a new exact slice and write set are named.
- 2026-06-06T19:35+01:00: Post-tranche consolidation recommends the next Goal as Task 6 executable generated-test output policy readiness. This is not implementation approval; it should define whether and how `e2e-test-plan.v1alpha1` proposals may become executable Playwright files.
- 2026-06-06T19:35+01:00: Task 6 executable-output policy readiness recorded in `plans.md`. Recommendation: future implementation should start with a pure deterministic Playwright spec renderer for `gitnexus-web` mocked-backend route proposals, with optional explicit CLI write mode only after renderer tests pass.
- 2026-06-06T19:38+01:00: Task 6 executable-output policy readiness committed as `4f3fec63` (`docs: define e2e executable output policy`).
- 2026-06-06T19:45+01:00: Task 6 deterministic generated Playwright spec renderer and explicit `gitnexus e2e-test-plan --write-specs` mode implemented with TDD. The implementation is limited to deterministic mocked `/api/repos` route specs and policy-block diagnostics; browser execution, CI mutation, MCP/API, GitHub automation, and live-backend generation remain deferred.
- 2026-06-06T19:47+01:00: Task 6 generated-spec renderer committed as `ac1b43a5` (`feat: add e2e generated spec renderer`).
- 2026-06-06T19:48+01:00: `NO_NEXT_GOAL_CREATED`. Blocker: after Task 6 renderer V1, the remaining candidate Goals are priority-dependent rather than sequentially forced. Candidate next Goals are broader generated E2E scenario support, Task 2 wiki wiring/mutation policy, Task 4 PR Impact MCP/GitHub-readiness, or deeper Task 7 OCaml semantics.
- 2026-06-07T13:25+01:00: Active Goal created for Task 2 Wiki Auto-Refresh Status Endpoint V1. A focused GitHub/source pass supports a conservative read-only server status route over automatic wiki generation. TDD red/green completed; focused tests, adjacent reindex wiring tests, build, and diff checks passed.
- 2026-06-07T13:31+01:00: Task 2 post-endpoint readiness recommends treating Task 2 local V1 as complete at read-only status. Mutation/manual refresh/provider readiness requires a separate MAIN policy approval before source implementation.
- 2026-06-07T13:33+01:00: `NO_NEXT_GOAL_CREATED`. Blocker: Task 2 mutation/manual refresh/provider readiness requires a MAIN product/policy decision before source implementation, and the remaining non-Task-2 candidates are priority-dependent. Candidate next Goals are provider/output mutation policy readiness, Task 4 PR Impact MCP/GitHub-readiness, broader E2E scenario support, or deeper OCaml semantics.
- 2026-06-07T13:51+01:00: Active Task 6 Goal broadened deterministic generated-spec support from mocked `/api/repos` route proposals to mocked `/api/repo` route proposals. TDD red/green completed; focused E2E renderer/CLI/report tests, build, and diff checks passed. Browser execution, live-backend generated specs, CI mutation, Playwright config changes, MCP/API exposure, GitHub automation, and broader route/scenario generation remain deferred.
- 2026-06-07T14:00+01:00: Active Task 6 follow-on Goal selected `/api/graph` as the next deterministic route fixture after source evidence showed footer graph stats are stable web-first assertions. During readiness, a `/api/repo` generated-spec mismatch was found and fixed: graph stats now come from a non-empty mocked `/api/graph` payload rather than stale `/api/repo.stats` assumptions. TDD red/green completed; focused renderer/CLI/report tests, build, and diff checks passed.

### 2026-06-07T14:00+01:00 - Task 6 `/api/graph` Generated Spec Support

Goal:

- Determine and, if evidence supports it, implement exactly one additional deterministic generated route fixture after `/api/repos` and `/api/repo`.

Evidence:

- `gitnexus-web/src/services/backend-client.ts` fetches `/api/graph` during server/repo connection.
- `gitnexus-web/src/components/StatusBar.tsx` renders stable footer graph stats from `graph.nodes.length` and `graph.relationships.length`.
- Existing Playwright tests use `contentinfo`, `status-ready`, and `graph-stats` as stable web-first assertion surfaces.

Implemented:

- Repaired the previous `/api/repo` generated fixture so its graph-stat assertions align with mocked `/api/graph` data.
- Added a regression test proving `/api/repo` generated specs do not assert graph stats from an empty graph payload.
- Added deterministic `/api/graph` generated-spec support.
- Added a golden `/api/graph` generated Playwright fixture.
- Expanded the route policy diagnostic to name `/api/repos`, `/api/repo`, and `/api/graph` as the current deterministic V1 generated fixtures.

TDD checkpoint:

- Red test 1: `/api/repo` generated spec still mocked an empty graph while asserting footer graph stats.
- Green fix 1: `/api/repo` generated spec now mocks a two-node, one-edge graph and asserts `2 nodes` / `1 edge`.
- Red test 2: `/api/graph` proposal was blocked by the supported-route guard.
- Green fix 2: `/api/graph` proposals now render deterministic mocked-backend Playwright text.

Verification:

```powershell
npm test -- test/unit/e2e-test-generation-spec-renderer.test.ts
npm test -- test/unit/e2e-test-generation-spec-renderer.test.ts test/unit/e2e-test-plan-cli.test.ts test/unit/e2e-test-generation-report.test.ts
npm run build
git diff --check
```

Results:

- Focused renderer: 1 file, 7 tests passed.
- Focused Task 6 suite passed: 3 files, 13 tests.
- Build passed with existing Vite chunk-size and ineffective dynamic-import warnings.
- Diff whitespace check passed.

Still out of scope:

- Browser execution.
- Playwright config changes.
- CI mutation.
- MCP/API exposure.
- GitHub automation.
- Live-backend generated specs.
- Generated specs beyond explicitly approved deterministic mocked route fixtures.

### 2026-06-07T13:51+01:00 - Task 6 `/api/repo` Generated Spec Support

Goal:

- Broaden the deterministic Task 6 generated-spec renderer to support mocked `/api/repo` route proposals without opening browser execution, live-backend specs, CI mutation, or general route generation.

Implemented:

- Added a golden generated Playwright fixture for `/api/repo` route proposals.
- Added renderer support for deterministic `/api/repo` specs using mocked `/api/repos`, `/api/repo`, `/api/graph**`, and `/api/heartbeat` backend responses.
- Preserved the existing `/api/repos` generated-spec behavior.
- Kept unsupported routes blocked with policy diagnostics instead of generating brittle specs.

TDD checkpoint:

- Red test: `/api/repo` proposal was blocked because V1 only supported `/api/repos`.
- Green implementation: `renderE2EGeneratedSpecs()` now supports `/api/repos` and `/api/repo` deterministic mocked route fixtures.

Verification:

```powershell
npm test -- test/unit/e2e-test-generation-spec-renderer.test.ts
npm test -- test/unit/e2e-test-generation-spec-renderer.test.ts test/unit/e2e-test-plan-cli.test.ts test/unit/e2e-test-generation-report.test.ts
npm run build
git diff --check
```

Results:

- Focused renderer red/green completed.
- Focused Task 6 suite passed: 3 files, 11 tests.
- Build passed with existing Vite chunk-size and ineffective dynamic-import warnings.
- Diff whitespace check passed.

Still out of scope:

- Browser execution.
- Playwright config changes.
- CI mutation.
- MCP/API exposure.
- GitHub automation.
- Live-backend generated specs.
- Generated specs beyond explicitly approved deterministic mocked route fixtures.

### 2026-06-07T13:25+01:00 - Task 2 Wiki Status Endpoint V1

Goal:

- Complete a focused GitHub issue/PR/source evidence pass for the wiki/Code Wiki area, then add a read-only server status endpoint for wiki auto-refresh planning if the evidence still supports that scope.

Evidence summary:

- Upstream README positions `gitnexus wiki` as LLM-powered documentation from the indexed knowledge graph, not a passive metadata endpoint.
- Architecture maps wiki ownership to `src/core/wiki/`.
- Issue #302 shows external generated docs-site adoption is a product/docs ownership concern rather than an implementation ticket with an attached PR.
- Triage issue #422 records wiki-related risk history: large-repo context overflow, Ollama hangs, language support, and grouping fixes.
- Windows registry/freshness issue #1400 reinforces that downstream automation should surface explicit index/freshness status before mutating docs.

Implemented:

- Added `GET /api/wiki/auto-refresh` in `gitnexus/src/server/api.ts`.
- The endpoint resolves an optional repo parameter with the existing `requestedRepo(req)` / `resolveRepo(...)` path.
- It checks graph freshness with `checkStalenessAsync(entry.path, entry.lastCommit)`.
- It reads existing wiki metadata with `readWikiAutoRefreshMeta(entry.storagePath)`.
- It calls `planWikiAutoRefresh(...)` with `dryRun: true`, `mutateOutput: false`, and provider readiness set to `false` with reason `provider-not-wired-through-server`.
- The response includes repo identity plus the planner result shape.

Not implemented:

- No `runWikiAutoRefresh` call.
- No `WikiGenerator` call.
- No LLM execution.
- No generated wiki output mutation.
- No reindex-completion event wiring.
- No hooks, dependencies, credentials, or provider config changes.

TDD checkpoint:

```powershell
npm test -- test/unit/wiki-auto-refresh-api-wiring.test.ts
```

Results:

- Red: failed because `api.ts` lacked `planWikiAutoRefresh`, confirming the endpoint was absent.
- Green: passed after adding the route and import, 1 file, 1 test.

Verification:

- `npm test -- test/unit/wiki-auto-refresh.test.ts test/unit/wiki-auto-refresh-api-wiring.test.ts` passed: 2 files, 9 tests.
- `npm test -- test/unit/reindex-freshness-wiring.test.ts test/unit/reindex-api-wiring.test.ts` passed: 2 files, 23 tests.
- `npm run build` passed.
- `git diff --check` passed.
- `git status --short --branch` showed only intended docs/source/test files changed.

### 2026-06-07T13:31+01:00 - Task 2 Post-Endpoint Boundary

Goal:

- Determine whether the next Task 2 step should be event wiring, manual refresh/mutation, provider readiness, or deferral.

Finding:

- Reindex-completion status wiring is technically possible but not yet justified by a named consumer.
- Manual refresh/mutation is not ready because it would run `WikiGenerator`, mutate stored wiki files, and potentially call LLM providers.
- Provider readiness is a separate policy problem because server-side unattended generation must not prompt, write credentials, spend tokens unexpectedly, or assume local CLI behavior.

Recommendation:

- Treat Task 2 local V1 as complete at read-only status.
- Do not implement wiki mutation, automatic generation, or reindex-completion wiki actions without a new MAIN approval naming provider policy, output mutation policy, rollback/reporting behavior, tests, and exact write set.
- If continuing Task 2 later, start with provider/output mutation policy readiness before any source implementation.

### 2026-06-06T19:26+01:00 - Task 7 OCaml Experimental V1 Implemented

Goal:

- Implement the approved experimental OCaml language-support slice for `.ml` and `.mli`.

Implemented:

- Added `SupportedLanguages.OCaml`.
- Added `.ml` and `.mli` detection and OCaml syntax mapping.
- Classified OCaml as `experimental`.
- Added `tree-sitter-ocaml@0.22.0` without upgrading core `tree-sitter@0.21.1`.
- Added parser-loader and parse-worker grammar dispatch:
  - `.ml` -> `tree-sitter-ocaml`.`ocaml`
  - `.mli` -> `tree-sitter-ocaml`.`interface`
- Added an experimental OCaml provider and minimal query support for:
  - modules,
  - type declarations,
  - value/function bindings,
  - `open` module references,
  - direct calls,
  - interface value specifications.
- Added focused `.ml` and `.mli` fixtures and tests.

Not implemented:

- Dune/project model.
- PPX expansion.
- Full module alias/functor semantics.
- Generated-code handling.
- Production classification.
- Web UI/WASM parity beyond successful build.
- MCP/API exposure.

Important implementation note:

- `tree-sitter-ocaml@0.22.0` README text describes `ocaml_interface`, but the actual package export is `interface`. The implementation uses the verified export.

Verification:

- Red test confirmed before implementation:
  - `npm test -- test/unit/ocaml-language-support.test.ts` failed because `.ml` / `.mli` returned `null` and parser-loader reported unsupported OCaml.
- Green tests:
  - `npm test -- test/unit/ocaml-language-support.test.ts`
  - `npm test -- test/unit/ocaml-language-support.test.ts test/unit/parser-loader-abi.test.ts test/unit/tree-sitter-queries.test.ts test/integration/tree-sitter-languages.test.ts`
    - Passed: 4 files, 153 tests.
  - `npm run build`
    - Passed with existing Vite chunk-size and ineffective dynamic-import warnings.
  - `git diff --check`
    - Passed.

Follow-up boundary:

- Future OCaml work should use a new Goal for import/module resolution depth, functor semantics, Dune awareness, or production classification.

### 2026-06-06T13:48+01:00 - Task 7 OCaml Approval Packet

Goal:

- Particularize the next implementation Goal enough for MAIN to approve or reject it without ambiguity.

Additional evidence:

- `gitnexus/package.json` pins `tree-sitter` to `0.21.1`.
- `npm view tree-sitter-ocaml version versions license peerDependencies dependencies dist-tags --json` shows npm latest `0.24.2`, MIT, peer `tree-sitter` `^0.22.4`.
- `npm view tree-sitter-ocaml@0.22.0 ... --json` shows version `0.22.0`, MIT, peer `tree-sitter: 0.21`, `main: bindings/node`, `types: bindings/node`, and documented `ocaml` / `ocaml_interface` grammar exports.

Recommendation:

- Request approval for npm `tree-sitter-ocaml@0.22.0` rather than latest.
- Keep `tree-sitter@0.21.1` unchanged.
- Add experimental OCaml support for `.ml` and `.mli` only.
- Use file-path-aware grammar selection for implementation vs interface files.
- Stop if compatibility requires a core `tree-sitter` runtime upgrade.

Approval phrase drafted in `plans.md`:

- `MAIN | READY_FOR_IMPLEMENTATION: Task 7 OCaml experimental language support V1 is approved on branch local/gitnexus-local-features...`

Supersession:

- This approval packet is historical. MAIN approved the boundary, Task 7 implementation completed, and commit `5f543c17` contains the experimental OCaml V1 source slice.

Verification:

- `git diff --check` must pass after this documentation update.

Next Goal:

- If MAIN gives the approval phrase in `plans.md`, create the Task 7 OCaml implementation Goal.
- If MAIN does not approve it, record `NO_NEXT_GOAL_CREATED` and leave OCaml deferred.

### 2026-06-06T13:41+01:00 - Task 7 OCaml Support Readiness

Goal:

- Determine whether OCaml support is ready for source implementation and what the safe first slice would be.

Evidence gathered:

- Local source:
  - `gitnexus-shared/src/languages.ts`
  - `gitnexus-shared/src/language-detection.ts`
  - `gitnexus-shared/src/scope-resolution/language-classification.ts`
  - `gitnexus/src/core/ingestion/languages/index.ts`
  - `gitnexus/src/core/ingestion/language-provider.ts`
  - `gitnexus/src/core/tree-sitter/parser-loader.ts`
  - `gitnexus/src/core/ingestion/workers/parse-worker.ts`
  - `gitnexus/src/core/ingestion/tree-sitter-queries.ts`
  - parser/query/language tests under `gitnexus/test`.
- External sources:
  - https://github.com/tree-sitter/tree-sitter-ocaml
  - https://raw.githubusercontent.com/tree-sitter/tree-sitter-ocaml/master/package.json
  - https://raw.githubusercontent.com/tree-sitter/tree-sitter-ocaml/master/tree-sitter.json
  - https://pypi.org/project/tree-sitter-ocaml/0.24.1/
  - https://github.com/abhigyanpatwari/GitNexus/pull/305
  - https://github.com/abhigyanpatwari/GitNexus/pull/317
- Local registry command:
  - `npm view tree-sitter-ocaml version license peerDependencies dependencies dist-tags --json`

Findings:

| Area | Finding |
| --- | --- |
| Feasibility | `tree-sitter-ocaml` exists, is MIT licensed, and exposes separate grammars for `.ml`, `.mli`, and type syntax. |
| Local support | No OCaml enum, extension mapping, syntax map, provider, parser-loader row, parse-worker grammar, query set, fixture, or tests exist locally. |
| Dependency risk | npm latest is `0.24.2` with peer `tree-sitter` `^0.22.4`; repository master metadata is `0.25.0` with peer `tree-sitter` `^0.25.0`. GitNexus must test native ABI/runtime compatibility before adopting it. |
| Implementation shape | A safe V1 is a full language-onboarding slice, not just adding a package. |
| Acceptance bar | Parser smoke, `.ml`/`.mli` grammar selection, minimal captures, import/module behavior, type/member/call extraction, and fixture/golden tests are required. |

Decision:

- Historical decision before implementation: keep OCaml source implementation blocked until MAIN approves:
  - dependency route: npm `tree-sitter-ocaml`, vendored grammar, or another named parser path,
  - write set covering shared language files, parser loader, parse worker, provider/query files, fixtures, and focused tests,
  - initial classification as `experimental`,
  - `.ml` and `.mli` as required V1 surfaces.

Recommended first approved implementation slice:

- Experimental OCaml support for `.ml` and `.mli` with:
  - shared enum/extension/syntax mapping,
  - grammar selection for implementation vs interface files,
  - provider registration,
  - minimal captures for modules, values/functions, types, direct calls, and open/import-like module references,
  - parser ABI smoke and focused query/fixture tests.

Deferred:

- Dune/project model inference.
- PPX expansion.
- Full module alias and functor-aware resolution.
- Generated-code handling.
- Production classification.

Verification:

- `git diff --check` must pass after this documentation update.

Next Goal:

- Do not create an OCaml implementation Goal unless MAIN approves the dependency/write-set boundary above. If approval is not granted, record `NO_NEXT_GOAL_CREATED` and leave OCaml deferred.

### 2026-06-06T13:40+01:00 - Task 6 Post-CLI Boundary

Goal:

- Decide whether to continue Task 6 immediately or move to Task 7 readiness.

Decision:

- Pause Task 6 source work after local V1:
  - `e2e-test-plan.v1alpha1` report core,
  - thin local `gitnexus e2e-test-plan` CLI wrapper.
- Move next to Task 7 OCaml Support readiness.

Rationale:

- Task 6 now has a bounded local report/CLI surface matching the established PR Impact and Regression Forensics pattern.
- The next Task 6 steps would require new policy decisions:
  - generated executable Playwright file ownership,
  - review rules,
  - flake strategy,
  - browser execution policy,
  - CI/GitHub integration boundaries,
  - whether automatic existing-spec parsing is acceptable.
- Task 7 is the final candidate feature and should receive readiness mapping before returning to deeper Task 6 output-policy work.

Deferred Task 6 work:

- Generated Playwright files.
- Browser execution.
- Automatic existing-spec inventory parsing.
- MCP/API exposure.
- GitHub comments/checks.
- CI workflow mutation.
- `gitnexus-web/e2e` changes.

Next Goal:

- Task 7 OCaml Support readiness/research only.

### 2026-06-06T13:37+01:00 - Task 6 E2E Test Plan CLI Wrapper Implemented

Goal:

- Implement the thin local `gitnexus e2e-test-plan` CLI wrapper over the committed report core.

Files changed:

- `gitnexus/src/cli/e2e-test-plan.ts`
- `gitnexus/src/cli/index.ts`
- `gitnexus/src/cli/help-i18n.ts`
- `gitnexus/src/cli/i18n/en.ts`
- `gitnexus/src/cli/i18n/zh-CN.ts`
- `gitnexus/test/unit/e2e-test-plan-cli.test.ts`

Implemented behavior:

- New local command: `gitnexus e2e-test-plan`.
- Required local inputs:
  - `--target-json <path>`
  - `--pr-impact-json <path>`
  - `--existing-scenarios-json <path>`
  - `--route-evidence-json <path>`
- Optional local input:
  - `--regression-forensics-json <path>`
- Output format:
  - `--format markdown`
  - `--format json`
  - default is Markdown.

Not implemented:

- No generated executable Playwright files.
- No browser execution.
- No automatic existing-spec parsing.
- No MCP tool.
- No GitHub PR comments/checks.
- No token-bearing automation.
- No CI workflow mutation.
- No new dependency.
- No `gitnexus-web/e2e` changes.

TDD / verification:

```powershell
npm test -- test/unit/e2e-test-plan-cli.test.ts
npm test -- test/unit/e2e-test-plan-cli.test.ts test/unit/e2e-test-generation-report.test.ts test/unit/regression-forensics-report.test.ts test/unit/pr-impact-report.test.ts test/unit/pr-impact-diff-mapping.test.ts test/unit/cli-index-help.test.ts
git diff --check
npm run build
```

Results:

- Initial red test failed because `src/cli/e2e-test-plan.js` did not exist.
- Focused E2E test-plan CLI tests passed: 1 file, 2 tests.
- Combined CLI/report/help tests passed: 6 files, 27 tests.
- Diff whitespace check passed.
- Build passed.

Next boundary:

- Commit the CLI wrapper implementation.
- Mark the active Goal complete with the Goal tool.
- Post-CLI boundary completed below; next baton target is Task 7 OCaml Support readiness.

### 2026-06-06T13:34+01:00 - Task 6 Post-Core Boundary

Goal:

- Decide the next exact Goal after the E2E test-plan report core.

Candidates considered:

| Candidate | Verdict | Rationale |
| --- | --- | --- |
| Thin local CLI wrapper | `next` | Matches the prior PR Impact and Regression Forensics pattern, keeps input local/deterministic, and makes the report core usable without adding browser or CI behavior. |
| Existing-spec inventory extraction | `later` | Useful, but needs source parsing heuristics for Playwright specs and should follow a stable local JSON report surface. |
| Generated executable Playwright files | `defer` | Requires output policy, review/ownership rules, flake strategy, browser execution policy, and likely separate approval. |

Recommended next Goal:

- Implement `gitnexus e2e-test-plan` as a local JSON-in / Markdown-or-JSON-out CLI wrapper.

Recommended CLI surface:

- `gitnexus e2e-test-plan --target-json <path> --pr-impact-json <path> --existing-scenarios-json <path> --route-evidence-json <path> --format markdown`
- Optional: `--regression-forensics-json <path>`.
- `--format <format>` supports `markdown` or `json`, defaulting to `markdown`.

Approved next write set to use if implementing:

- `gitnexus/src/cli/e2e-test-plan.ts`
- `gitnexus/src/cli/index.ts`
- `gitnexus/src/cli/help-i18n.ts`
- `gitnexus/src/cli/i18n/en.ts`
- `gitnexus/src/cli/i18n/zh-CN.ts`
- `gitnexus/test/unit/e2e-test-plan-cli.test.ts`
- long-horizon documentation updates for checkpointing

Constraints:

- No generated executable test files.
- No browser execution.
- No MCP tool.
- No GitHub PR comments/checks.
- No token-bearing automation.
- No CI workflow mutation.
- No new dependency.
- No `gitnexus-web/e2e` changes.
- No automatic existing-spec parsing in this slice.

### 2026-06-06T13:31+01:00 - Task 6 E2E Test Plan Report Core Implemented

Goal:

- Implement the first Task 6 source slice: pure deterministic E2E test proposal/report core only.

Files changed:

- `gitnexus/src/core/e2e-test-generation/report.ts`
- `gitnexus/test/unit/e2e-test-generation-report.test.ts`
- `gitnexus/test/fixtures/e2e-test-generation/golden-basic-report.md`

Implemented behavior:

- Experimental schema version: `e2e-test-plan.v1alpha1`.
- Deterministic JSON report with:
  - target contract metadata,
  - PR Impact linkage,
  - optional Regression Forensics linkage,
  - proposed scenarios,
  - existing-spec coverage status,
  - priority,
  - evidence,
  - caveats.
- Deterministic Markdown rendering with golden fixture coverage.
- Prioritizes high-risk route/API impacts before medium-risk changed surfaces.
- Marks existing E2E coverage as `covered_by_existing_spec` instead of proposing duplicate work.
- Caps confidence to `LOW` when PR Impact graph evidence is stale.
- Explicitly states that V1 proposes scenarios only and does not generate executable test files.

Not implemented:

- No generated Playwright spec files.
- No browser execution.
- No CLI command.
- No MCP tool.
- No GitHub PR comments/checks.
- No token-bearing automation.
- No CI workflow mutation.
- No new dependency.
- No `gitnexus-web/e2e` changes.

TDD / verification:

```powershell
npm test -- test/unit/e2e-test-generation-report.test.ts
npm test -- test/unit/e2e-test-generation-report.test.ts test/unit/regression-forensics-report.test.ts test/unit/pr-impact-report.test.ts test/unit/pr-impact-diff-mapping.test.ts
git diff --check
npm run build
```

Results:

- Initial red test failed because `src/core/e2e-test-generation/report.js` did not exist.
- Focused E2E test-plan report tests passed: 1 file, 3 tests.
- Adjacent E2E/Regression/PR report tests passed: 4 files, 13 tests.
- Diff whitespace check passed.
- Build passed.

Next boundary:

- Commit the report-core implementation.
- Mark the active Goal complete with the Goal tool.
- Post-core boundary completed below; next Task 6 slice is the thin local CLI wrapper.

### 2026-06-06T13:28+01:00 - Task 6 End-to-End Test Generation Readiness

Goal:

- Decide whether Task 6 can move from light scoping to a bounded local first slice.

Evidence inspected:

- `README.md` enterprise/upcoming list.
- `gitnexus-web/package.json`.
- `gitnexus-web/playwright.config.ts`.
- `gitnexus-web/e2e/server-connect.spec.ts`.
- `gitnexus-web/e2e/multi-repo-scoping.spec.ts`.
- `gitnexus-web/e2e/tree-view.spec.ts`.
- `gitnexus-web/e2e/manual-record.spec.ts`.
- `.github/workflows/ci-e2e.yml`.
- `gitnexus/src/core/pr-impact/report.ts`.
- `gitnexus/src/core/regression-forensics/report.ts`.
- `gitnexus/src/mcp/tools.ts` / `gitnexus/src/mcp/local/local-backend.ts` route/API/impact surfaces.
- Context7 Playwright docs from `/microsoft/playwright.dev` for codegen, locators, config, web server, trace, and report behavior.

Decision:

- Do not start by writing generated executable Playwright specs.
- Use existing `gitnexus-web` Playwright E2E infrastructure as the first target contract:
  - backend `gitnexus serve` on `4747`,
  - frontend Vite on `5173`,
  - Chromium,
  - existing mini fixture repo indexing pattern,
  - retained traces/screenshots/videos on failure.
- First source slice should be a pure report core that proposes E2E scenarios and explains evidence/caveats.

Recommended next Goal:

- Implement `e2e-test-plan.v1alpha1` report core only.

Approved-style boundary drafted in `plans.md`:

- `gitnexus/src/core/e2e-test-generation/report.ts`
- `gitnexus/test/unit/e2e-test-generation-report.test.ts`
- `gitnexus/test/fixtures/e2e-test-generation/golden-basic-report.md`
- long-horizon documentation updates for checkpointing

Constraints:

- No generated executable test files.
- No browser execution.
- No CLI/MCP exposure in the first source slice.
- No GitHub PR comments/checks.
- No token automation.
- No CI workflow mutation.
- No new dependency.
- No changes to `gitnexus-web/e2e`.
- TDD required.

Verification:

- Readiness is documentation-only.
- Verify with `git diff --check`.

### 2026-06-06T13:08+01:00 - Task 5 Regression Forensics CLI Wrapper Implemented

Goal:

- Implement the thin local `gitnexus regression-forensics` CLI wrapper over the committed report core.

Files changed:

- `gitnexus/src/cli/regression-forensics.ts`
- `gitnexus/src/cli/index.ts`
- `gitnexus/src/cli/help-i18n.ts`
- `gitnexus/src/cli/i18n/en.ts`
- `gitnexus/src/cli/i18n/zh-CN.ts`
- `gitnexus/test/unit/regression-forensics-cli.test.ts`

Implemented behavior:

- New local command: `gitnexus regression-forensics`.
- Required local inputs:
  - `--failure-json <path>`
  - `--pr-impact-json <path>`
- Output format:
  - `--format markdown`
  - `--format json`
  - default is Markdown.
- Failure JSON may include optional `knownGoodRef` / `knownBadRef`, which are passed into the report core as ref metadata.

Not implemented:

- No MCP tool.
- No GitHub PR comments/checks.
- No token-bearing automation.
- No CI workflow mutation.
- No automatic bisect.
- No live test execution.
- No generated fixes/remediation.
- No new dependency.

TDD / verification:

```powershell
npm test -- test/unit/regression-forensics-cli.test.ts
npm test -- test/unit/regression-forensics-cli.test.ts test/unit/regression-forensics-report.test.ts test/unit/pr-impact-report.test.ts test/unit/pr-impact-diff-mapping.test.ts test/unit/cli-index-help.test.ts
git diff --check
npm run build
```

Results:

- Initial red test failed because `src/cli/regression-forensics.js` did not exist.
- Focused Regression Forensics CLI tests passed: 1 file, 2 tests.
- Combined CLI/report/help tests passed: 5 files, 24 tests.
- Diff whitespace check passed.
- Build passed.

Next boundary:

- Commit the CLI wrapper implementation.
- Mark the active Goal complete with the Goal tool.
- Create the next sequential Goal with the Goal tool: Task 6 End-to-End Test Generation readiness.

### 2026-06-06T13:05+01:00 - Task 5 Post-Core Boundary

Goal:

- Decide the next exact Goal after the Regression Forensics report core.

Decision:

- Next recommended Goal: thin local `gitnexus regression-forensics` CLI wrapper.

Why:

- The report core is implemented and verified, but currently only available to tests/importers.
- A CLI wrapper is bounded and useful if it reads local JSON files only.
- Richer CI artifact parsing, GitHub integration, automatic bisect, live test execution, MCP exposure, and remediation can remain deferred.

Recommended CLI surface:

- `gitnexus regression-forensics --failure-json <path> --pr-impact-json <path> --format markdown`
- `--failure-json <path>` reads local failure evidence JSON.
- `--pr-impact-json <path>` reads local PR Impact V1 JSON.
- `--format <format>` supports `markdown` or `json`, defaulting to `markdown`.

Approved next write set to use if implementing:

- `gitnexus/src/cli/regression-forensics.ts`
- `gitnexus/src/cli/index.ts`
- `gitnexus/src/cli/help-i18n.ts`
- `gitnexus/src/cli/i18n/en.ts`
- `gitnexus/src/cli/i18n/zh-CN.ts`
- `gitnexus/test/unit/regression-forensics-cli.test.ts`
- long-horizon documentation updates for checkpointing

Constraints:

- No MCP tool.
- No GitHub PR comments/checks.
- No token-bearing automation.
- No CI workflow mutation.
- No automatic bisect.
- No live test execution.
- No generated fixes/remediation.
- No new dependency.

### 2026-06-06T13:02+01:00 - Task 5 Regression Forensics Report Core Implemented

Goal:

- Implement the first Task 5 source slice: pure deterministic report core only.

Files changed:

- `gitnexus/src/core/regression-forensics/report.ts`
- `gitnexus/test/unit/regression-forensics-report.test.ts`
- `gitnexus/test/fixtures/regression-forensics/golden-basic-report.md`

Implemented behavior:

- Experimental schema version: `regression-forensics.v1alpha1`.
- Deterministic JSON report with:
  - failure command,
  - exit code,
  - failing tests,
  - failure excerpt,
  - environment,
  - known-good/known-bad refs,
  - linked PR Impact summary,
  - candidate causes,
  - confidence,
  - caveats,
  - recommendation.
- Deterministic Markdown rendering with golden fixture coverage.
- Confidence is capped when known-good or failing-test evidence is missing.
- Stale PR Impact graph evidence lowers confidence.
- Report text explicitly treats findings as candidate causes, not proven root cause.

Not implemented:

- No CLI command.
- No MCP tool.
- No GitHub PR comments/checks.
- No token-bearing automation.
- No CI workflow mutation.
- No automatic bisect.
- No live test execution.
- No generated fixes/remediation.

TDD / verification:

```powershell
npm test -- test/unit/regression-forensics-report.test.ts
npm test -- test/unit/regression-forensics-report.test.ts test/unit/pr-impact-report.test.ts test/unit/pr-impact-diff-mapping.test.ts
git diff --check
npm run build
```

Results:

- Initial red test failed because `src/core/regression-forensics/report.js` did not exist.
- Focused Regression Forensics tests passed: 1 file, 3 tests.
- Adjacent Regression Forensics + PR Impact report tests passed: 3 files, 10 tests.
- Diff whitespace check passed.
- Build passed.

Next boundary:

- Commit the report-core implementation.
- Apply the Goal Baton rule after Goal completion.
- Next possible Goal should be chosen from:
  - thin local `gitnexus regression-forensics` CLI wrapper,
  - richer input parsing for CI/eval artifacts,
  - Task 6 End-to-End Test Generation readiness.

### 2026-06-06T12:49+01:00 - Task 5 Auto Regression Forensics Readiness Started

Goal:

- Define the first defensible Auto Regression Forensics slice now that PR Impact V1 exists.

Evidence inspected:

- Current control docs:
  - `AGENTS.md`
  - `.agent/long-horizon/gitnexus-local-features/plans.md`
  - `.agent/long-horizon/gitnexus-local-features/implement.md`
  - `.agent/long-horizon/gitnexus-local-features/documentation.md`
  - `.agent/long-horizon/gitnexus-local-features/feature-map.md`
- PR Impact V1:
  - `gitnexus/src/core/pr-impact/report.ts`
  - `gitnexus/src/cli/pr-impact.ts`
- Eval infrastructure:
  - `eval/README.md`
  - `eval/run_eval.py`
  - `eval/agents/gitnexus_agent.py`
  - `eval/analysis/analyze_results.py`
- CI/test artifact surfaces:
  - `.github/workflows/ci.yml`
  - `.github/workflows/ci-tests.yml`
  - `.github/workflows/ci-report.yml`
  - `.github/workflows/pr-autofix.yml`
  - `.github/workflows/pr-autofix-apply.yml`
- Public/reference evidence:
  - OpenAI Codex noninteractive/Goal guidance for agent workflow boundaries.
  - NASA Software Test Plan handbook page for regression-test evidence/reporting concepts.
  - Web searches for GitNexus-specific "auto regression forensics"; no authoritative GitNexus product implementation source was found.

Local observations:

- `gitnexus status` reports the host index is stale: indexed commit `b5ce5ab`, current commit `7fb4412`. Do not rely on host graph output for the just-added PR Impact files until re-analyzed.
- PR Impact V1 now provides an experimental schema (`pr-impact.v1alpha1`), verdict, mapped symbols, impacts, API impacts, test signal, and caveats.
- The eval harness is a SWE-bench evaluation system for comparing GitNexus-assisted agents against baselines; it is useful evidence infrastructure but not the Auto Regression Forensics product surface.
- CI workflows already produce test reports, coverage artifacts, PR metadata, and trusted/untrusted autofix separation. Task 5 V1 must not disturb or reuse those as privileged automation.
- The repository has many regression, golden, parity, and benchmark tests, but no dedicated regression-forensics report core, CLI, MCP tool, or GitHub workflow.

Readiness conclusion:

- V1 should be a local deterministic report core:
  - input: fixture-shaped failure evidence plus PR Impact V1 report data,
  - output: experimental JSON/Markdown with candidate causes, confidence, caveats, and recommendation.
- V1 should not run tests, download CI artifacts, post PR comments/checks, run bisect, generate fixes, or mutate workflows.
- The first implementation slice should be TDD and fixture-backed:
  - `gitnexus/src/core/regression-forensics/report.ts`
  - `gitnexus/test/unit/regression-forensics-report.test.ts`
  - `gitnexus/test/fixtures/regression-forensics/golden-basic-report.md`

Commands run:

```powershell
git status --short --branch
get_goal
rg -n "Goal baton|NO_NEXT_GOAL_CREATED|39d77845|Task 5 Auto Regression Forensics readiness|Goal tool|local V1 complete" AGENTS.md .agent\long-horizon\gitnexus-local-features\implement.md .agent\long-horizon\gitnexus-local-features\plans.md .agent\long-horizon\gitnexus-local-features\documentation.md
gitnexus list
gitnexus status
rg -n "regression|forensic|forensics|bisect|failure|failing|CI|eval|benchmark|flake|test generation|known-good|known bad|golden" gitnexus eval .github README.md .agent\long-horizon\gitnexus-local-features
rg --files gitnexus\src gitnexus\test eval .github | rg "(eval|regression|ci|workflow|test|fixture|benchmark|pr-impact|detect-changes|impact)"
```

Next boundary:

- Verify the readiness documentation with `git diff --check`.
- Commit the readiness documentation when complete.
- Then apply the Goal Baton rule: complete this readiness Goal and create the next Goal with the Goal tool. If the readiness plan remains unchanged, the next Goal should be the Task 5 report-core implementation slice.

### 2026-06-06T12:29+01:00 - Task 4 PR Impact CLI Wrapper Implemented

Goal:

- Expose the committed PR Impact report core through a thin local CLI command.

Files changed:

- `gitnexus/src/cli/pr-impact.ts`
- `gitnexus/src/cli/index.ts`
- `gitnexus/src/cli/help-i18n.ts`
- `gitnexus/src/cli/i18n/en.ts`
- `gitnexus/src/cli/i18n/zh-CN.ts`
- `gitnexus/test/unit/pr-impact-cli.test.ts`

Implemented behavior:

- New local command: `gitnexus pr-impact`.
- Options:
  - `--scope <scope>` for `unstaged`, `staged`, `all`, or `compare`.
  - `--base-ref <ref>` for compare mode.
  - `--repo <name>` for explicit repo targeting.
  - `--format <format>` for `markdown` or `json`.
- The command calls existing backend tools:
  - `detect_changes` for changed symbols,
  - `impact` with upstream depth 5 and tests included for each changed symbol,
  - `api_impact` for API/route-like changed files.
- The command uses the report core from `gitnexus/src/core/pr-impact/report.ts`.
- Help/i18n wiring was added for English and Simplified Chinese.

Not implemented:

- No MCP tool.
- No GitHub PR URL ingestion.
- No PR comments/checks.
- No token-bearing automation.
- No web UI.
- No generated remediation/tests.

TDD / verification:

```powershell
npm test -- test/unit/pr-impact-cli.test.ts
npm test -- test/unit/pr-impact-cli.test.ts test/unit/pr-impact-report.test.ts test/unit/pr-impact-diff-mapping.test.ts test/unit/tool-direct-cli.test.ts test/unit/cli-index-help.test.ts
npm test -- test/unit/pr-impact-cli.test.ts test/unit/pr-impact-report.test.ts test/unit/pr-impact-diff-mapping.test.ts test/unit/parse-diff-hunks.test.ts test/unit/detect-changes-worktree.test.ts test/unit/impact-confidence.test.ts test/unit/impact-pagination.test.ts test/unit/tool-direct-cli.test.ts test/unit/cli-index-help.test.ts test/integration/api-impact-e2e.test.ts
git diff --check
npm run build
```

Results:

- Initial red test failed because `src/cli/pr-impact.js` did not exist.
- CLI test passed: 1 file, 2 tests.
- Focused CLI/report/help tests passed: 5 files, 27 tests.
- Broader PR Impact/CLI baseline passed: 10 files, 111 tests.
- Diff whitespace check passed.
- Build passed.

Next boundary:

- Commit the CLI wrapper slice.
- After commit, Task 4 V1 local CLI/report slice is complete.
- Any next PR Impact work should be a new Goal: richer deletion/base-graph integration, public MCP exposure, GitHub ingestion, GitHub automation, or Codex remediation.

### 2026-06-06T12:23+01:00 - Task 4 PR Impact Report Core Implemented

Goal:

- Implement the first Task 4 source slice: deterministic report core and diff-mapping helper only.

Files changed:

- `gitnexus/src/core/pr-impact/report.ts`
- `gitnexus/src/core/pr-impact/diff-mapping.ts`
- `gitnexus/test/unit/pr-impact-report.test.ts`
- `gitnexus/test/unit/pr-impact-diff-mapping.test.ts`
- `gitnexus/test/fixtures/pr-impact/golden-basic-report.md`

Implemented behavior:

- Experimental JSON schema version: `pr-impact.v1alpha1`.
- Deterministic Markdown rendering with golden fixture coverage.
- Changed-symbol, unmatched-range, new/unmapped-symbol, deleted-symbol, impact, API-impact, test-signal, verdict, and caveat fields.
- Diff range classification for:
  - overlapping modified ranges,
  - unmatched ranges,
  - old-side deleted ranges,
  - added ranges that become new/unmapped symbols.
- Conservative test-reference signal:
  - `has_test_reference` only when all impact entries have known test references,
  - otherwise `unknown_or_unreferenced`.
- Deterministic verdict rules:
  - `UNKNOWN` for stale/ambiguous graph evidence,
  - `BLOCK` for deleted symbols with inbound callers, critical API mismatches, or high/critical direct impact without known test reference,
  - `NEEDS_DISCUSSION` for high-risk unmatched ranges, broad process/fan-in signals, or API impact without clear tests,
  - `PROCEED` for bounded low-risk evidence.
- Optional Markdown sections render only when evidence exists.

Not implemented in this slice:

- No CLI command.
- No MCP tool exposure.
- No GitHub PR comments, checks, tokens, Actions, or PR URL ingestion.
- No Codex remediation.
- No generated tests.
- No broad rewrite of `detect_changes`.

TDD / verification:

```powershell
npm test -- test/unit/pr-impact-report.test.ts test/unit/pr-impact-diff-mapping.test.ts
npm test -- test/unit/pr-impact-report.test.ts test/unit/pr-impact-diff-mapping.test.ts test/unit/parse-diff-hunks.test.ts test/unit/detect-changes-worktree.test.ts test/unit/impact-confidence.test.ts test/unit/impact-pagination.test.ts test/integration/api-impact-e2e.test.ts
git diff --check
npm run build
```

Results:

- Initial red test failed because `src/core/pr-impact/report.js` and `diff-mapping.js` did not exist.
- Focused PR Impact tests passed: 2 files, 7 tests.
- Nearby diff/impact/API baseline passed: 7 files, 91 tests.
- Diff whitespace check passed.
- Build passed.

Next boundary:

- Create the next sequential Goal for a thin `gitnexus pr-impact` CLI wrapper if MAIN wants the feature exposed through the local CLI.
- Keep MCP and GitHub automation deferred.

### 2026-06-06T12:17+01:00 - Checkpoint Snapshot Created

Snapshot commit:

- `568e24de` - `checkpoint local features through task 4 readiness`

Included boundary:

- Long-horizon/control docs and research artifacts.
- Project workflow/routing cleanup, including `AGENTS.md` and removal of unnecessary `CLAUDE.md`.
- Task 1 Auto-Reindexing implementation and tests.
- Task 2 Auto-Updating Code Wiki planner/runner implementation and tests.
- Task 3 README MCP/group tool-surface reconciliation.
- Task 4 PR Impact / Blast Radius readiness documentation.

Verification before commit:

```powershell
git diff --check
npm test -- test/unit/reindex-auto-sweep.test.ts test/unit/reindex-watcher.test.ts test/unit/reindex-control.test.ts test/unit/reindex-operations.test.ts test/unit/reindex-api-wiring.test.ts test/unit/reindex-freshness-wiring.test.ts test/unit/staleness.test.ts test/unit/wiki-auto-refresh.test.ts test/unit/wiki-flags.test.ts test/unit/wiki-grouping-batch.test.ts test/unit/wiki-mermaid-sanitizer.test.ts test/unit/wiki-llm-client.test.ts test/unit/tools.test.ts test/unit/group/group-tools.test.ts test/unit/mcp/group-repo-routing.test.ts test/unit/resources.test.ts test/unit/parse-diff-hunks.test.ts test/unit/detect-changes-worktree.test.ts test/unit/impact-confidence.test.ts test/unit/impact-pagination.test.ts test/unit/tool-direct-cli.test.ts test/unit/cli-index-help.test.ts test/integration/api-impact-e2e.test.ts
git add -A
git diff --cached --stat
git diff --cached --name-status
git commit -m "checkpoint local features through task 4 readiness"
git status --short --branch
```

Results:

- Diff whitespace check passed.
- Focused validation passed: 23 test files, 366 tests.
- Commit `568e24de` created.
- Working tree was clean immediately after the checkpoint commit.

Next boundary:

- It is now safe to create the next sequential Task 4 PR Impact implementation Goal.
- The next implementation Goal should use the exact `pr-impact` report-core slice recorded in `plans.md`.

### 2026-06-06T12:12+01:00 - WIP Boundary Review

Goal:

- Resolve whether the current branch is ready for Task 4 PR Impact source implementation.

Dirty tree buckets:

| Bucket | Files | Boundary meaning |
| --- | --- | --- |
| Long-horizon/control docs | `.agent/long-horizon/gitnexus-local-features/prompt.md`, `plans.md`, `implement.md`, `documentation.md`, plus new `feature-map.md`, `brainstorming-pr-review-blast-radius.md`, `enterprise-feature-intended-functions-scratchpad.md`, `gitnexus-router-indexing-note.md`, `plan.md` | Planning/control surface and research evidence for the local-features workstream |
| Project workflow/routing docs | `AGENTS.md`, deleted `CLAUDE.md` | Durable repo workflow/routing cleanup; `CLAUDE.md` intentionally removed as unnecessary |
| Task 1 Auto-Reindexing | `gitnexus/src/server/reindex-auto-sweep.ts`, `gitnexus/src/server/api.ts`, `gitnexus/src/server/reindex-operations.ts`, `gitnexus/test/unit/reindex-auto-sweep.test.ts`, `gitnexus/test/unit/reindex-api-wiring.test.ts`, `gitnexus/test/unit/reindex-operations.test.ts` | Approved and verified implementation WIP |
| Task 2 Auto-Updating Code Wiki | `gitnexus/src/core/wiki/auto-refresh.ts`, `gitnexus/test/unit/wiki-auto-refresh.test.ts` | Approved and verified implementation WIP |
| Task 3 Multi-Repo Support Improvements | `README.md` | Approved docs-only reconciliation WIP |

Evidence:

- `git status --short --branch` shows all buckets are still uncommitted.
- `git diff --stat` shows large planning/control edits plus source/test changes for Tasks 1 and 2.
- Source review confirms Task 1 and Task 2 changes are coherent and isolated, but they are still unsnapshotted.
- Task 4 readiness docs now name new files for a future `pr-impact` source slice. Starting those files before checkpointing would mix a new feature implementation into the existing multi-feature WIP.

Commands run:

```powershell
git status --short --branch
git diff --stat
git diff --name-status
git diff -- gitnexus/src/server/api.ts gitnexus/src/server/reindex-operations.ts gitnexus/test/unit/reindex-api-wiring.test.ts gitnexus/test/unit/reindex-operations.test.ts
Get-Content gitnexus/src/server/reindex-auto-sweep.ts -TotalCount 260
Get-Content gitnexus/src/core/wiki/auto-refresh.ts -TotalCount 320
Get-Content gitnexus/test/unit/wiki-auto-refresh.test.ts -TotalCount 260
git diff -- README.md AGENTS.md .agent/long-horizon/gitnexus-local-features/prompt.md .agent/long-horizon/gitnexus-local-features/implement.md --stat
```

Boundary recommendation:

- Do not begin Task 4 PR Impact source work in this dirty tree.
- Create a deliberate checkpoint/snapshot first, preferably a git commit or equivalent user-approved checkpoint containing Tasks 1-3 plus the control-documentation updates.
- If MAIN explicitly chooses no snapshot, record that no-snapshot decision in this file before creating the Task 4 implementation Goal.

Next-step decision:

- The next active Goal should not be the Task 4 implementation Goal yet.
- The next required action is a human/operator snapshot decision:
  - approve creating a checkpoint commit/snapshot for the current WIP, or
  - explicitly record `MAIN | NO_SNAPSHOT_APPROVED` before Task 4 source work.

### 2026-06-06T11:15+01:00 - Task 4 Readiness Refresh Completed

Objective:

- Finish the Task 4 readiness refresh without editing PR Impact source files.

Files updated:

- `.agent/long-horizon/gitnexus-local-features/plans.md`
- `.agent/long-horizon/gitnexus-local-features/documentation.md`
- `.agent/long-horizon/gitnexus-local-features/feature-map.md`

Readiness outputs recorded:

- Expected-vs-actual behavior table.
- Source ownership map for CLI command registration, diff parsing, range-to-symbol mapping, impact traversal, API/route evidence, MCP schema, and PR review methodology references.
- Smallest safe first implementation slice.
- Proposed future write set.
- Fixture/golden report plan.
- Focused TDD test plan.
- Risks, stop rules, and implementation approval boundary.
- Snapshot/no-snapshot prerequisite before Task 4 source edits.

Verification:

```powershell
npm test -- test/unit/parse-diff-hunks.test.ts test/unit/detect-changes-worktree.test.ts test/unit/impact-confidence.test.ts test/unit/impact-pagination.test.ts test/unit/tool-direct-cli.test.ts test/unit/cli-index-help.test.ts test/integration/api-impact-e2e.test.ts
git diff --check -- .agent/long-horizon/gitnexus-local-features/plans.md .agent/long-horizon/gitnexus-local-features/documentation.md .agent/long-horizon/gitnexus-local-features/feature-map.md
rg -n "next allowed work is Task 3|Task 3 readiness mapping only|paused until the Task 4 gate|Not approved for source implementation|Do not edit PR Impact / Blast Radius source files until Tasks 1-3" .agent/long-horizon/gitnexus-local-features/plans.md .agent/long-horizon/gitnexus-local-features/documentation.md .agent/long-horizon/gitnexus-local-features/feature-map.md
```

Results:

- Focused baseline passed: 7 test files, 102 tests.
- Diff whitespace check passed.
- Drift check found one historical Task 2 checkpoint line (`Not approved for source implementation`) that was true at the time and was left intact.

Conclusion:

- Task 4 readiness Goal is complete.
- Do not create the Task 4 implementation Goal or edit PR Impact source until the current WIP snapshot/no-snapshot boundary is resolved.

### 2026-06-06T11:10+01:00 - Task 4 PR Impact Readiness Refresh Started

Goal:

- Complete a Task 4 readiness refresh after Tasks 1-3, without PR Impact source edits.

Evidence gathered:

- `brainstorming-pr-review-blast-radius.md` already defines V1 as deterministic `diff ranges -> symbols -> impact -> report`.
- `gitnexus/src/cli/index.ts` has no `pr-impact` command yet; current direct tool CLI commands include `query`, `context`, `impact`, `cypher`, and `detect-changes`.
- `gitnexus/src/cli/tool.ts` exposes `detectChangesCommand()` as a thin wrapper around `LocalBackend.callTool('detect_changes')`.
- `gitnexus/src/storage/git.ts::parseDiffHunks()` parses new-side `git diff -U0` ranges and skips pure deletions where the new-side count is 0.
- `gitnexus/src/mcp/local/local-backend.ts::detectChanges()` maps changed hunks to indexed symbols by `filePath` and `startLine`/`endLine` overlap, then maps changed symbols to affected processes.
- `gitnexus/src/mcp/local/local-backend.ts::impact/_runImpactBFS()` already has bounded BFS traversal, a visited-set cycle guard, per-depth output, pagination, risk scoring, and process/module enrichment.
- `api_impact`, `route_map`, and `shape_check` exist in `local-backend.ts` and have focused unit/integration coverage.
- GitNexus graph checks showed `detectChanges` is called through `LocalBackend.callTool`, and a depth-2 upstream impact query for `detectChanges` currently reports `HIGH` risk with affected CLI/MCP processes.

Commands run:

```powershell
rg -n "detect_changes|detectChanges|api_impact|apiImpact|route_map|routeMap|shape_check|shapeCheck|impact\(|blast|pr-impact|pr_review|pr-review" gitnexus/src gitnexus/test README.md .agent/long-horizon/gitnexus-local-features/brainstorming-pr-review-blast-radius.md
Get-Content gitnexus/src/cli/index.ts -TotalCount 330
Get-Content gitnexus/src/cli/tool.ts -TotalCount 260
Get-Content gitnexus/src/mcp/tools.ts -TotalCount 580
Get-Content gitnexus/src/mcp/local/local-backend.ts | Select-Object -Skip 2350 -First 520
Get-Content gitnexus/src/storage/git.ts | Select-Object -Skip 320 -First 70
gitnexus query --repo gitnexus-local-features "detect_changes parse diff hunks impact api_impact route_map shape_check pr impact report" --limit 8
gitnexus context detectChanges --repo gitnexus-local-features --file gitnexus/src/mcp/local/local-backend.ts
gitnexus impact detectChanges --repo gitnexus-local-features --file gitnexus/src/mcp/local/local-backend.ts --depth 2 --limit 20
```

Current conclusion:

- PR Impact V1 should reuse existing diff/impact/API primitives, but it needs a dedicated report core and richer range/deletion/unmatched evidence handling.
- The smallest future source slice is a deterministic report core with fixture/golden JSON and Markdown tests, then a thin `gitnexus pr-impact` CLI wrapper after the core is green.
- MCP exposure, GitHub PR URL ingestion, GitHub comments/checks, Codex remediation, generated tests, and UI are out of V1.
- Source implementation should wait for the current WIP snapshot/no-snapshot boundary before creating the Task 4 implementation Goal.

### 2026-06-06T11:04+01:00 - Sequential Goal Lifecycle Rule

Decision:

- Goals are created one at a time.
- The next Goal is created only after the current Goal is achieved or legitimately blocked.
- The next Goal must be based on the next known feature/slice boundary.
- Do not pre-create a backlog of active Goals.

Reason:

- This keeps readiness, implementation, verification, and documentation aligned with the actual current feature rather than scattering attention across future work.

### 2026-06-06T10:57+01:00 - Task 3 README Reconciliation Implemented

Objective:

- Implement the approved Task 3 docs-only slice after readiness completion.

File changed:

- `README.md`

Implementation:

- Changed the MCP tool count from 16 to 13.
- Added missing current MCP tools: `api_impact`, `route_map`, `tool_map`, and `shape_check`.
- Removed removed legacy MCP tools from the README tool table: `group_contracts`, `group_query`, and `group_status`.
- Added MCP group-mode guidance: use `query`, `context`, or `impact` with `repo: "@<groupName>"` or `repo: "@<groupName>/<memberPath>"`.
- Added group resource rows for `gitnexus://group/{name}/contracts` and `gitnexus://group/{name}/status`.
- Kept CLI `gitnexus group query/contracts/status` guidance intact because those remain real CLI commands.

Verification:

```powershell
rg -n '16 tools|group_contracts|group_query|group_status|13 MCP tools|@<groupName>|gitnexus://group/\{name\}/contracts|gitnexus://group/\{name\}/status|api_impact|route_map|tool_map|shape_check' README.md ARCHITECTURE.md
npm test -- test/unit/tools.test.ts test/unit/group/group-tools.test.ts test/unit/mcp/group-repo-routing.test.ts test/unit/resources.test.ts
npm test -- test/integration/group
git diff --check -- README.md .agent/long-horizon/gitnexus-local-features/plans.md .agent/long-horizon/gitnexus-local-features/documentation.md .agent/long-horizon/gitnexus-local-features/feature-map.md
```

Results:

- Text check confirms README now says 13 MCP tools and includes the current tool/resource names.
- Focused MCP/group unit tests passed: 4 files, 75 tests.
- Group integration tests passed: 5 files, 15 tests.
- Diff whitespace check passed.

Scope:

- No GitNexus source code changed for Task 3.
- No MCP schema changed.
- No CLI behavior changed.
- No unified cross-repo graph work was started.

### 2026-06-06T10:55+01:00 - Standing Conditional Implementation Authorization

Decision:

- MAIN authorizes implementation for all feature Goals conditionally.

Condition:

- Each feature must complete readiness/research first.
- The implementation slice and write set must be exact and documented.
- The implementation must stay inside the documented constraints.
- If readiness reveals a broader architecture path, source-code behavior change, new dependency, schema/API change, or unresolved risk, stop and document the new approval boundary before editing.

Current application:

- Task 3 Multi-Repo Support Improvements has completed readiness for a docs-only `README.md` tool-surface reconciliation slice.
- That slice may proceed under this standing conditional authorization.

### 2026-06-06T10:53+01:00 - Task 3 Readiness Map Completed

Objective:

- Decide the smallest safe Multi-Repo Support Improvements slice from source, tests, runtime, and public evidence.

Additional evidence:

- `ARCHITECTURE.md` matches current source: 13 MCP tools, group-aware `query/context/impact`, and group contracts/status resources.
- Public upstream `ARCHITECTURE.md` on GitHub matches local `ARCHITECTURE.md`.
- Public upstream `AGENTS.md` changelog records removal of `group_query/group_contracts/group_status` MCP tools and addition of group resource URIs.
- `README.md` is stale in "What Your AI Agent Gets": it still says 16 MCP tools and lists removed `group_contracts`, `group_query`, and `group_status` as tools.
- `gitnexus/test/unit/tools.test.ts` asserts the current source truth: 13 tools, with 2 group-specific tools.

Verification:

```powershell
npm test -- test/unit/group
npm test -- test/integration/group
```

Results:

- Group unit suite passed: 31 files, 573 passed, 8 skipped.
- Group integration suite passed: 5 files, 15 tests.

Conclusion:

- The smallest safe Task 3 implementation slice is documentation/tool-surface reconciliation in `README.md` only.
- No group service, bridge, MCP schema, CLI behavior, or unified graph source change is recommended for the first Task 3 slice.
- A suggested `MAIN | READY_FOR_IMPLEMENTATION` approval block is recorded in `plans.md`.

### 2026-06-06T10:50+01:00 - Task 3 Readiness Goal Started

Goal:

- Complete Task 3 Multi-Repo Support Improvements readiness mapping without Task 3 source edits.

Evidence gathered:

- `gitnexus status` reports this repo's host index up to date at commit `b5ce5ab`.
- `gitnexus group --help` lists CLI commands: create, add, remove, list, status, sync, impact, query, contracts.
- `gitnexus group list` reports no configured groups on this workstation.
- `gitnexus/src/cli/group.ts` implements current CLI group commands.
- `gitnexus/src/mcp/tools.ts` registers only `group_list` and `group_sync` as group-specific MCP tools.
- `gitnexus/src/mcp/resources.ts` exposes `gitnexus://group/{name}/contracts` and `gitnexus://group/{name}/status`.
- `gitnexus/src/mcp/local/local-backend.ts` routes `query`, `context`, and `impact` to `GroupService` when `repo` starts with `@`.
- `test/unit/mcp/group-repo-routing.test.ts` verifies `@group` routing and verifies removed MCP `group_query`, `group_contracts`, and `group_status` throw migration guidance.

Verification:

```powershell
npm test -- test/unit/group/group-tools.test.ts test/unit/mcp/group-repo-routing.test.ts test/unit/resources.test.ts
```

Result:

- Passed: 3 test files, 52 tests.

Conclusion:

- Task 3 should not be framed as "build multi-repo from scratch." Current group support is substantial.
- The first likely improvement area is surface reconciliation and ergonomics: make CLI, MCP tool, MCP resource, and documentation guidance agree.
- Task 3 source implementation remains blocked pending a decision-complete plan and exact MAIN write set.

### 2026-06-06T10:47+01:00 - Pre-Goal Control Review

Objective:

- Review the map/control docs and prepare the next appropriate Goal without opening unapproved source work.

Fixes made:

- Updated current status from Task 2 implementation mode to Task 3 readiness mode.
- Clarified that Task 1 and Task 2 are implemented locally but unsnapshotted.
- Clarified that Task 3 readiness/research can proceed before a snapshot, but Task 3 source edits cannot.
- Updated stale sequencing text that still treated Task 2 as a future plan.

Next action:

- Create an active Goal for Task 3 Multi-Repo Support Improvements readiness mapping.

### 2026-06-06T10:45+01:00 - Comprehensive Feature Map Created

Objective:

- Stop relying on scattered planning fragments and give future agents one explicit map of the whole seven-feature workstream.

Files changed:

- `.agent/long-horizon/gitnexus-local-features/feature-map.md`
- `.agent/long-horizon/gitnexus-local-features/plans.md`
- `.agent/long-horizon/gitnexus-local-features/documentation.md`

Map contents:

- Control-surface roles for `prompt.md`, `plans.md`, `implement.md`, and `documentation.md`.
- Operating map for branch, routing, embeddings, hooks, gates, and TDD.
- Inventory of all seven candidate features.
- Cross-feature dependency map.
- Per-feature source/test/status/gate mapping.
- Current WIP boundary for Auto-Reindexing and Auto-Updating Code Wiki.
- Next gaps and recommended next actions.

Scope:

- Documentation/planning only.
- No source implementation permission is implied.
- Task 3 remains readiness-only until MAIN approves an exact write set.

### 2026-06-06T10:16+01:00 - Task 2 MAIN Approval Recorded

Approval:

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

Next action:

- Proceed TDD, beginning with a failing `wiki-auto-refresh.test.ts` for graph-freshness gating, existing wiki meta, provider readiness, dry-run/status, and result shaping.

### 2026-06-05T18:12+01:00 - Task 2 Readiness Goal Setup

Objective:

- Move from the completed local Auto-Reindexing implementation slice into Task 2 preimplementation/readiness without mixing source work.

Review findings:

- No active Codex Goal was present at review time.
- The worktree still contains unsnapshotted Auto-Reindexing source/test WIP plus planning/docs changes.
- The four-file bundle now agrees that the current tranche is Task 1, Task 2, Task 3, then a pause before Task 4 PR Impact / Blast Radius.
- Task 2 is not approved for source implementation.

Safe precursor actions recorded:

- Strengthen the Task 2 Goal Contract in `plans.md` so it covers readiness, not just later implementation.
- Make the Task 2 precursor checklist explicit: wiki source/test review, expected-vs-actual analysis, dependency map from Task 1, provider/cost/publication policy, smallest safe slice, proposed write set, TDD plan, risks, stop rules, and MAIN approval text.
- Keep all Task 2 source edits blocked until the readiness plan is complete and MAIN approves a write set.

Next action:

- Create the active Codex Goal for Task 2 readiness.
- Then work autonomously on evidence gathering and planning only, starting with wiki source/tests and current local behavior.

### 2026-06-05T18:16+01:00 - Task 2 Wiki Readiness Evidence Checkpoint

Objective:

- Begin the active Task 2 Auto-Updating Code Wiki Goal without source edits.

Evidence gathered:

- Local wiki ownership is concentrated in `gitnexus/src/cli/wiki.ts`, `gitnexus/src/core/wiki/generator.ts`, `gitnexus/src/core/wiki/graph-queries.ts`, `gitnexus/src/core/wiki/llm-client.ts`, local CLI provider clients, CLI help/i18n, and focused wiki tests.
- The existing wiki generator already supports full generation, incremental updates, review-only module tree generation, HTML viewer generation, language cache guard, provider routing, explicit timeout/retry, and Mermaid sanitization.
- `WikiGenerator` checks `wiki/meta.json.fromCommit` against `git rev-parse HEAD` and reads the graph through LadybugDB. Therefore auto-updating must be gated by confirmed graph freshness; wiki freshness alone is not graph freshness.
- Public README describes `gitnexus wiki` as graph-backed LLM documentation generation with custom model/provider, force, timeout/retry, and language options.
- Public issue #302 supports caution around first-party docs ownership: adopting/generated docs is a product/docs ownership decision, so local Task 2 should focus on the existing wiki generator rather than external docs-site publishing.

Commands run:

```powershell
rg -n "wiki|Code Wiki|generateWiki|WikiGenerator|wiki-flags|wiki-grouping|wiki-llm|mermaid|provider|llm" gitnexus/src gitnexus/test ARCHITECTURE.md README.md
rg --files gitnexus/src/core/wiki gitnexus/src/cli gitnexus/test/unit | rg "wiki|help-i18n|i18n"
rg -n "describe\(|it\(" gitnexus/test/unit/wiki-flags.test.ts gitnexus/test/unit/wiki-grouping-batch.test.ts gitnexus/test/unit/wiki-llm-client.test.ts gitnexus/test/unit/wiki-mermaid-sanitizer.test.ts
gitnexus query --repo gitnexus-local-features "WikiGenerator wikiCommand incrementalUpdate generateOverview llm-client graph-queries" --limit 8
npm test -- test/unit/wiki-flags.test.ts test/unit/wiki-grouping-batch.test.ts test/unit/wiki-mermaid-sanitizer.test.ts test/unit/wiki-llm-client.test.ts
```

Verification:

- Focused wiki baseline passed: 4 test files, 119 tests.
- Planning update recorded in `plans.md`.

Current conclusion:

- Task 2 first slice should likely be refresh orchestration/status after successful reindex/freshness, with dry-run/status-first behavior, provider readiness checks, skip when no existing wiki exists unless explicitly configured, and operation visibility.
- Task 2 source implementation remains blocked until MAIN approves the exact write set.
- `plans.md` now contains the proposed Task 2 write set, out-of-scope files, TDD shape, and suggested `MAIN | READY_FOR_IMPLEMENTATION` approval text for review.

### 2026-06-06T10:24+01:00 - Wiki Generator Analysis Checkpoint

Objective:

- Analyse the existing wiki generator before broadening the auto-update implementation.

Key finding:

- GitNexus has a functional manual wiki generator, but it is not itself an unattended auto-update mechanism. Auto-update needs a conservative preflight/orchestration layer.

Capabilities confirmed:

- `gitnexus wiki --help` works and exposes provider/model/base-url/api-key/api-version/reasoning/concurrency/timeout/retries/gist/verbose/review/lang options.
- `gitnexus status` reports this repo's host index is up to date at commit `b5ce5ab`.
- Existing focused wiki tests cover the main manual-generator surfaces.
- New WIP auto-refresh tests pass after the first implementation step: `npm test -- test/unit/wiki-auto-refresh.test.ts` -> 1 file, 5 tests.

Deficiencies that changed or reinforced the plan:

- Wiki freshness is commit-based, while generator content comes from the existing graph. Therefore graph freshness must be proven before refresh.
- The CLI path can prompt and save config, so automation must not call `wikiCommand` directly.
- The generator mutates output during normal operation, including directory creation, HTML viewer generation, and force-mode deletion/regeneration.
- The generator collapses missing/corrupt meta into `null`; auto-refresh needs clearer metadata status.
- Incremental generation is useful but heuristic, so first-slice automation should not overclaim perfect incremental correctness.
- No existing generated wiki meta was found locally, so default automation should skip missing wiki rather than create one.
- No saved LLM config was found locally; provider readiness must be explicit.

Plan impact:

- Keep the first slice as a status/dry-run-first preflight and runner.
- Do not change generator prompts, graph queries, grouping, HTML viewer, or publication behavior in this slice.
- Do not wire API/server auto-mutation yet unless the pure core planner/runner is proven and MAIN confirms the next write boundary.

### 2026-06-06T10:26+01:00 - Task 2 Core Slice Implemented

Objective:

- Implement the approved status/dry-run-first Code Wiki auto-refresh core without mutating wiki output or invoking unattended LLM generation by default.

Files changed:

- `gitnexus/src/core/wiki/auto-refresh.ts`
- `gitnexus/test/unit/wiki-auto-refresh.test.ts`

Implementation summary:

- Added `planWikiAutoRefresh`.
- Added `runWikiAutoRefresh`.
- Added `readWikiAutoRefreshMeta`.
- The planner requires graph freshness, existing valid wiki metadata by default, provider readiness, and explicit mutation opt-in.
- Dry-run/status is the default when prerequisites are ready.
- The runner calls only an injected generator function, and only when `dryRun: false` plus `mutateOutput: true`.
- Missing and corrupt wiki metadata are reported distinctly.

Verification:

```powershell
npm test -- test/unit/wiki-auto-refresh.test.ts
npm test -- test/unit/wiki-auto-refresh.test.ts test/unit/wiki-flags.test.ts test/unit/wiki-grouping-batch.test.ts test/unit/wiki-mermaid-sanitizer.test.ts test/unit/wiki-llm-client.test.ts
npm test -- test/unit/reindex-auto-sweep.test.ts test/unit/reindex-watcher.test.ts test/unit/reindex-control.test.ts test/unit/reindex-operations.test.ts test/unit/reindex-api-wiring.test.ts test/unit/reindex-freshness-wiring.test.ts test/unit/staleness.test.ts
npm run build
git diff --check
```

Results:

- Focused auto-refresh test passed: 1 file, 8 tests.
- Focused wiki suite passed: 5 files, 127 tests.
- Focused reindex/freshness suite passed: 7 files, 62 tests.
- Build passed.
- Diff whitespace check passed.

Scope review:

- No generated wiki output was created or mutated.
- No unattended LLM generation was run.
- No provider credentials or config were changed.
- No new dependency was added.
- No server/API wiring was added in this first slice.
- No PR Impact source, regression-forensics, E2E, or OCaml work was started. Multi-Repo later received a docs-only README reconciliation slice.

Next boundary:

- Decide whether the next Task 2 slice should be:
  - keep core-only and add more preflight status surfaces,
  - add a manual status endpoint/command,
  - or wire status-only planning into successful reindex events.
- Do not mutate wiki output automatically until provider/cost/output policy is approved.

### 2026-06-05T17:17+01:00 - Inter-Feature Autonomy Rule

Objective:

- Continue autonomously without letting feature work become mixed or discombobulated.

Rule:

- Work one feature at a time.
- After a feature implementation slice, record verification and source scope.
- Before starting the next feature's source edits, ensure the previous feature is committed or the user records a deliberate no-commit/snapshot decision.
- Preimplementation research, source reading, test discovery, and decision-plan drafting for the next feature may proceed before the snapshot boundary, provided no next-feature source files are edited.
- Each feature must get a particularized Goal before its implementation work starts.

Current application:

- Auto-Reindexing is implemented locally and verified, but it is unsnapshotted WIP.
- Auto-Updating Code Wiki core status/dry-run-first slice is implemented locally and verified, but it is unsnapshotted WIP.
- Multi-Repo Support Improvements later completed a docs-only README reconciliation slice.
- PR Impact / Blast Radius is Task 4. Its readiness refresh is complete; source work remains blocked until the WIP snapshot/no-snapshot boundary is resolved and the implementation Goal is created.

### 2026-06-05T17:13+01:00 - Auto-Reindexing Slice Implemented

Objective:

- Implement the approved opt-in, dry-run-default, server-side commit-staleness sweep over validated registered repos.

Files changed in the approved write set:

- `gitnexus/src/server/reindex-auto-sweep.ts`
- `gitnexus/src/server/reindex-operations.ts`
- `gitnexus/src/server/api.ts`
- `gitnexus/test/unit/reindex-auto-sweep.test.ts`
- `gitnexus/test/unit/reindex-api-wiring.test.ts`
- `gitnexus/test/unit/reindex-operations.test.ts`

Implementation summary:

- Added `planAutoReindexSweep` and `runAutoReindexSweep`.
- Sweep planning loads registered repos through an injected loader, checks commit staleness, selects stale repos, and skips fresh repos.
- Dry-run mode reports stale repos without starting reindex work.
- Non-dry-run mode sends stale repos through the existing `ReindexQueue` before calling the injected start callback.
- Added `auto-reindex` to `REINDEX_OPERATION_TRIGGERS`.
- Wired `api.ts` to run the auto sweep only when `GITNEXUS_REINDEX_WATCHER` enables the existing watcher config.
- The server uses `listRegisteredRepos({ validate: true })`, `checkStalenessAsync`, `reindexQueue.request`, and `startReindexJob(..., { trigger: 'auto-reindex' })`.
- The sweep interval is cleared during graceful shutdown.

TDD evidence:

- Red 1: `reindex-auto-sweep.test.ts` failed because `reindex-auto-sweep.js` did not exist.
- Green 1: added `planAutoReindexSweep`; narrow test passed.
- Red 2: dry-run test failed because `runAutoReindexSweep` did not exist.
- Green 2: added runner dry-run path; narrow test passed.
- Red 3: `reindex-operations.test.ts` failed because `auto-reindex` was not an accepted trigger.
- Green 3: extended `REINDEX_OPERATION_TRIGGERS`; operation tests passed.
- Red 4: `reindex-api-wiring.test.ts` failed because `api.ts` did not wire the auto sweep.
- Green 4: wired validated registry, staleness, queue, auto trigger, interval, and cleanup; API wiring tests passed.

Verification:

```powershell
npm test -- test/unit/reindex-auto-sweep.test.ts test/unit/reindex-watcher.test.ts test/unit/reindex-control.test.ts test/unit/reindex-operations.test.ts test/unit/reindex-api-wiring.test.ts test/unit/reindex-freshness-wiring.test.ts test/unit/staleness.test.ts
npm run build
git diff --check
```

Results:

- Focused tests passed: 7 files, 62 tests.
- Build passed: `npm run build`.
- Diff whitespace check passed.
- Build rewrote web output during compilation but left no tracked web/dist changes.

Scope review:

- No hooks added.
- No dependencies added.
- No Docker/Podman runtime or embedding config changed.
- No PR Review, Code Wiki, OCaml, multi-repo, regression-forensics, or E2E generation work started.

### 2026-06-05T17:05+01:00 - MAIN Approval Recorded

Approval:

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

Next action:

- Proceed TDD one behavior at a time, beginning with a failing `reindex-auto-sweep.test.ts` for stale repo selection and fresh repo skip.

### 2026-06-05T16:31+01:00 - Auto-Reindexing Plan Ready For MAIN Review

Objective:

- Convert the research-backed Auto-Reindexing shape into a decision-complete implementation plan without touching GitNexus source files.

Current readiness verdict:

- Ready for MAIN approval review.
- Not approved for implementation.
- The implementation gate remains closed until MAIN records `MAIN | READY_FOR_IMPLEMENTATION` with the accepted Auto-Reindexing write scope.

Evidence inspected in this checkpoint:

- Four-file control surface:
  - `.agent/long-horizon/gitnexus-local-features/prompt.md`
  - `.agent/long-horizon/gitnexus-local-features/plans.md`
  - `.agent/long-horizon/gitnexus-local-features/implement.md`
  - `.agent/long-horizon/gitnexus-local-features/documentation.md`
- Local source:
  - `gitnexus/src/server/reindex-watcher.ts`
  - `gitnexus/src/server/reindex-control.ts`
  - `gitnexus/src/server/reindex-operations.ts`
  - `gitnexus/src/server/api.ts`
  - `gitnexus/src/core/git-staleness.ts`
  - `gitnexus/src/storage/repo-manager.ts`
  - `gitnexus/package.json`
- Local tests:
  - `gitnexus/test/unit/reindex-watcher.test.ts`
  - `gitnexus/test/unit/reindex-control.test.ts`
  - `gitnexus/test/unit/reindex-operations.test.ts`
  - `gitnexus/test/unit/reindex-api-wiring.test.ts`
  - `gitnexus/test/unit/reindex-freshness-wiring.test.ts`
  - `gitnexus/test/unit/staleness.test.ts`
- Host graph query:
  - `gitnexus query --repo gitnexus-local-features "ReindexWatcherScheduler startReindexJob ReindexQueue checkStalenessAsync listRegisteredRepos auto reindex" --limit 8`
- Public/reference evidence:
  - GitNexus releases list identifies PR #205 as the hook-based auto-reindex-with-embedding-preservation feature.
  - GitNexus PR #205 documents the original PostToolUse hook approach and its motivation: proactive freshness after commits and embedding preservation.
  - GitNexus PR #1070 documents the later correction that PostToolUse is notification-only because synchronous analyze can block and risk corruption/timeouts.
  - GitNexus issue #1400 records Windows registry/index recognition failure evidence, supporting validated registry use.
  - GitNexus RUNBOOK records stale index remediation as a real operational workflow.
  - Node filesystem docs warn that `fs.watch` can be unreliable or unavailable on network filesystems and host filesystems under virtualization such as Docker, supporting sweep-based correctness.

Commands run:

```powershell
rg -n "startReindexJob|ReindexQueue|ReindexOperationTrigger|ReindexWatcherScheduler|checkStalenessAsync|listRegisteredRepos|scheduleSweep|requestReindex|dryRun|pending-rerun|direct" gitnexus/src gitnexus/test
gitnexus query --repo gitnexus-local-features "ReindexWatcherScheduler startReindexJob ReindexQueue checkStalenessAsync listRegisteredRepos auto reindex" --limit 8
npm test -- test/unit/reindex-watcher.test.ts test/unit/reindex-control.test.ts test/unit/reindex-operations.test.ts test/unit/reindex-api-wiring.test.ts test/unit/reindex-freshness-wiring.test.ts test/unit/staleness.test.ts
```

Verification result:

- Focused baseline passed: 6 test files, 56 tests.
- `gitnexus query` found the expected local source surfaces, including `api.ts:startReindexJob`, `reindex-watcher.ts`, `reindex-control.ts`, `reindex-operations.ts`, and `repo-manager.ts:listRegisteredRepos`.

Planning conclusion:

- The first implementation slice should be opt-in, dry-run-default, server-side commit-staleness sweep over validated registered repositories.
- It should use `listRegisteredRepos({ validate: true })`, `checkStalenessAsync`, existing `ReindexQueue`, existing `startReindexJob`, and existing operation records.
- It should add `auto-reindex` as a distinct operation trigger.
- It should not use Git hooks, native filesystem watching as correctness, internal HTTP self-calls, new dependencies, Docker/Podman changes, PR Review work, or Code Wiki refresh work.

Proposed write set if MAIN approves:

- `gitnexus/src/server/reindex-auto-sweep.ts`
- `gitnexus/src/server/reindex-operations.ts`
- `gitnexus/src/server/api.ts`
- `gitnexus/test/unit/reindex-auto-sweep.test.ts`
- `gitnexus/test/unit/reindex-api-wiring.test.ts`
- `gitnexus/test/unit/reindex-operations.test.ts`
- `gitnexus/test/unit/reindex-watcher.test.ts` only if scheduler behavior is directly reused

Next gate:

- MAIN may approve, revise, or reject the proposed write set in `plans.md`.
- Until then, source files remain read-only for this feature.

### 2026-06-05 - `gitnexus-host` Helper Quarantined

Objective:

- Remove the redundant host helper so future agents use only two active routes: bare `gitnexus` for host/npm and `gitnexus-podman` for Podman/container.

Decision:

- Quarantined `C:\Users\steve\.local\bin\gitnexus-host.cmd` to `C:\Users\steve\.local\bin\gitnexus-host.disabled-20260605.cmd`.
- Quarantined `C:\Users\steve\.local\bin\gitnexus-host.py` to `C:\Users\steve\.local\bin\gitnexus-host.disabled-20260605.py`.
- Active guidance should not use `gitnexus-host`; historical mentions must be read as pre-quarantine evidence.

Boundary:

- This changed workstation routing helpers and guidance only. It did not change GitNexus source behavior or Podman runtime/index state.

### 2026-06-05 - Podman-First Embedding Route Recorded

Objective:

- Resolve confusion between upstream Docker guidance, the local Podman llama.cpp sidecar, and host/npm `gitnexus` embedding behavior.

Decision:

- The normal runtime/indexing path for Podman-managed repos is `gitnexus-podman` or `podman exec gitnexus-server gitnexus ...` against `/workspace/<repo>`.
- The local Podman profile extends upstream Docker with an internal llama.cpp sidecar, reachable from `gitnexus-server` as `http://gitnexus-embed:8080/v1`.
- The sidecar is not published to a Windows host port. The temporary `127.0.0.1:18082` compose mapping was removed before any runtime restart.
- Host/npm `gitnexus` remains a separate Windows route. It should not be assumed to use the Podman llama.cpp sidecar.

Verification:

- `podman port llama-cpp-gitnexus-embeddings` returned no host mapping.
- `podman exec gitnexus-server node -e ".../v1/models..."` returned `snowflake-arctic-embed-l-v2.0`.
- `podman exec gitnexus-server sh -lc "env | grep GITNEXUS_EMBEDDING | sort"` showed the container-side HTTP embedding configuration.
- `Get-ChildItem Env:GITNEXUS_EMBEDDING*` returned no host environment variables.
- `gitnexus-podman list` still reported the Podman-visible indexed repos `deepwiki-open` and `Prometheus`.

Boundary:

- This was a workstation/runtime guidance correction. It did not approve GitNexus source implementation and did not set host PowerShell/User embedding environment variables.

### 2026-06-05 - Goal-Backed Non-Interactive Workflow Recorded

Objective:

- Record how future agents should run this work with Codex Goals and non-interactive worker runs.

Decision:

- Each candidate feature now has a Goal Contract in `plans.md`.
- The supervisor thread owns the active feature Goal and keeps the work to one feature at a time.
- Non-interactive `codex exec` worker runs must repeat the active Goal Contract, read `AGENTS.md` and this four-file bundle, and report checkpoint, skills/tools used, commands, evidence, changed files, verification, blockers, and next step.
- Relevant skill/tool routing is now recorded in `implement.md`, including Superpowers workflow skills, research skills, OpenAI/Codex docs skill, GitNexus skills, Context7, explicit GitNexus CLI routes, GitHub issues/PRs, and official docs.

Boundary:

- This workflow note does not open implementation. The gate remains `MAIN | READY_FOR_IMPLEMENTATION`.

### 2026-06-05 - Goal Contract Review Against Codex Guidance

Objective:

- Evaluate the drafted feature Goal Contracts against OpenAI's Codex Goal guidance and the user's provided six-part Goal template.

Review finding:

- The first draft had useful outcomes, verification surfaces, and constraints, but boundaries, iteration policy, and blocked stop conditions were mostly implicit.
- This was not strong enough for long-running non-interactive worker runs, because completion must be evidence-based and the agent must know when to continue, when to stop, and what evidence unlocks progress.
- The attached review note clarified the distinction between a thin valid Goal, which needs a durable objective and verifiable stopping condition, and this workstream's stronger six-part Goal Contracts.
- The same note reinforced operational scaffolding: reading list, checkpoints, progress log, and compact status reports.

Fix applied:

- `implement.md` now states the required six Goal Contract elements.
- `implement.md` now also states the minimum Goal standard and the operational additions required for non-interactive worker runs.
- `plans.md` now gives each of the seven feature Goals explicit outcome, verification surface, constraints, boundaries, iteration policy, and blocked stop condition.

Boundary:

- This review improved process documentation only. It does not approve implementation or change runtime/source behavior.

## Status Update - 2026-06-05T09:52:22+01:00

Current verdict:

- Interim pre-main router cleanup is complete.
- GitNexus source feature implementation is paused and not started.
- No tracked GitNexus source files, compose files, containers, normal runtime config, or Podman indexes were changed in this pre-task.
- Workstation CLI state did change: the hidden bare-router was quarantined and the host/npm CLI was aligned to `1.6.6-rc.109`.
- Ignored local repo index state exists under `.gitnexus` from the earlier repo-local indexing pass; that was separate from the later router/CLI pre-task and is not a tracked source change.
- Host/npm CLI alignment is complete for the pinned rc.109 line.

Verified current command state:

- `gitnexus --version` reports `1.6.6-rc.109`.
- Historical pre-quarantine check: `gitnexus-host --version` reported `1.6.6-rc.109`; after helper quarantine, use `gitnexus --version` for the host/npm route.
- `gitnexus-podman --version` reports `1.6.6-rc.109`.
- Global npm install reports `gitnexus@1.6.6-rc.109`.

Verified runtime state:

- `Invoke-RestMethod http://127.0.0.1:4747/api/health` returned `{ "status": "ok" }`.
- `gitnexus-podman list` still reports exactly the current Podman-visible indexed repos:
  - `deepwiki-open`
  - `Prometheus`

Current routing rule:

- Use `gitnexus-podman` for the Podman-backed GitNexus runtime and indexes.
- Use bare `gitnexus` for the host/npm CLI.
- Do not restore the hidden bare-router as a convenience path.

Current working-tree note:

- The active branch is `local/gitnexus-local-features`.
- Current changes include documentation/planning, workstation-guidance updates, and the implemented Auto-Reindexing source/test slice.
- Existing untracked local-feature planning artifacts and Auto-Reindexing source/test additions remain uncommitted until the user decides how to snapshot this planning state.
- Task 0 is complete locally, pending snapshot/commit. The four-file bundle is not fully done under `prompt.md`'s done criteria until the planning artifacts are snapshotted.
- Inter-feature implementation should not proceed to PR Review / Blast Radius source edits until the Auto-Reindexing WIP boundary is snapshotted or explicitly accepted as unsnapshotted.

Next boundary:

- Resolve the Auto-Reindexing snapshot/commit boundary.
- Start Task 2 Auto-Updating Code Wiki preimplementation/readiness with a refreshed feature Goal.
- Keep Task 3 Multi-Repo Support Improvements queued after Task 2.
- Do not edit PR Impact / Blast Radius source files until the WIP snapshot/no-snapshot boundary is resolved and the implementation Goal is created.

## Evidence Summary

Auto-Reindexing research:

- Existing local reindex API/queue/freshness abstractions are substantial enough that the first slice should wire opt-in freshness orchestration rather than build reindexing from scratch.
- Focused tests run during research:
  `npm test -- test/unit/reindex-watcher.test.ts test/unit/reindex-control.test.ts test/unit/reindex-operations.test.ts test/unit/reindex-api-wiring.test.ts test/unit/reindex-freshness-wiring.test.ts`
- Result: 5 files passed, 47 tests passed.

PR Review / Blast Radius research:

- Existing primitives include `detect_changes`, `impact`, and `api_impact`.
- First slice should be report-first and local, not immediate GitHub comment automation.
- Focused tests run during research:
  `npm test -- test/unit/tools.test.ts test/unit/tool-direct-cli.test.ts test/unit/detect-changes-worktree.test.ts test/integration/api-impact-e2e.test.ts`
- Result: 4 files passed, 71 tests passed.

Auto-Updating Code Wiki research:

- Existing `gitnexus wiki` already supports full generation, incremental updates, commit metadata, review mode, HTML viewer output, provider routing, timeout, retry, and language handling.
- First slice should be refresh orchestration around the existing generator after graph freshness exists.
- Focused tests run during research:
  `npm test -- test/unit/wiki-flags.test.ts test/unit/wiki-grouping-batch.test.ts test/unit/wiki-mermaid-sanitizer.test.ts test/unit/wiki-llm-client.test.ts`
- Result: 4 files passed, 119 tests passed.

Deferred feature scoping:

- `eval/` already contains SWE-bench-style evaluation infrastructure.
- `gitnexus/src/core/group/` already contains substantial group/multi-repo support.
- `gitnexus-shared/src/languages.ts` and `gitnexus/src/core/ingestion/languages/index.ts` do not include OCaml.
- Current multi-repo source/architecture does not match all stale tool tables: group-aware behavior is through `query`, `context`, and `impact`, with group status/contracts exposed as resources rather than current `group_query` / `group_contracts` / `group_status` tools.

## Checkpoint Log

### 2026-06-05T10:39+01:00 - Coordinated Feature-Wide Research Tranche

Objective:

- Increase research depth across all seven candidate features before implementation planning.
- Track objective time in the scratchpad.
- Preserve sources and commands frequently.
- Keep implementation blocked until `MAIN | READY_FOR_IMPLEMENTATION`.

Time evidence:

- Continuation tranche start marker: `2026-06-05T10:39:32.0861881+01:00`.
- Local source block marker: `2026-06-05T10:40:11.2470025+01:00`.
- Graph/source synthesis marker: `2026-06-05T10:41:58.2308028+01:00`.
- Scratchpad checkpoint marker: `2026-06-05T10:42:18.1492525+01:00`.
- The scratchpad explicitly records that this continuation checkpoint is not, by itself, a completed 60-90 minute wall-clock block.

Source classes checked:

- Local files: `pr-swarm-review/README.md`, `pr-swarm-review/orchestration.md`, `gitnexus/skills/gitnexus-pr-review.md`, `gitnexus/src/mcp/server.ts`, `ARCHITECTURE.md`, and `eval/README.md`.
- Local searches: PR review, wiki, group/multi-repo, regression/eval/test-generation, and OCaml/language-provider surfaces.
- GitNexus graph checks: explicit `gitnexus query --repo gitnexus-local-features ...` queries for group resources, PR review, wiki, eval/regression, and OCaml/language support.
- Public GitNexus evidence: PRs #205, #1070, #1446, #1851; issues #253 and #1400; README, RUNBOOK, and AGENTS.
- Official/reference evidence: Node.js `fs.watch` caveats, GitHub Actions security/event docs, DORA small-batches/trunk-based development, and OpenAI Codex execution-plan guidance.

Conclusions that changed or strengthened planning:

- Auto-Reindexing remains the only `decision-grade now` first candidate. The safest shape is an opt-in server-side freshness sweep around validated registry entries, commit staleness, queue dispatch, operation visibility, and dry-run default.
- File watching must not be the correctness mechanism because Node documents watcher unreliability on network/virtualized filesystems; this matters for Windows/Podman.
- PR Review / Blast Radius should start as a local Markdown/JSON report over existing `detect_changes`, `impact`, `api_impact`, and PR-swarm review discipline. GitHub posting/check automation is later because privileged PR workflows need a security design.
- Auto-Updating Code Wiki should orchestrate the existing wiki generator only after freshness behavior and LLM/provider/cost/publication policy are explicit.
- Multi-Repo Support Improvements should first reconcile current source/architecture reality with stale tool tables. Current architecture exposes group-aware `query`, `context`, and `impact`, plus group resources, rather than current `group_query` / `group_contracts` / `group_status` tools.
- Auto Regression Forensics and End-to-End Test Generation remain deferred because local evidence shows eval/test infrastructure but no product-level workflow.
- OCaml remains deferred as a separate language-support project, not a minor parser toggle.

Next boundary:

- Draft a decision-complete Auto-Reindexing implementation plan before any source edits.
- Request `MAIN | READY_FOR_IMPLEMENTATION` for Auto-Reindexing only.
- Keep all other feature work research/planning-only until their turn.

### 2026-06-05T10:49+01:00 - Coordinated Research Continuation

Objective:

- Continue the research tranche using objective timestamps and coordinated blocks.
- Strengthen software-methodology evidence, feature-intent evidence, and local implementation-shape evidence.
- Keep all source implementation blocked.

Time evidence:

- Continuation marker: `2026-06-05T10:49:52.2376303+01:00`.
- Core-file re-read marker: `2026-06-05T10:50:04.8063243+01:00`.
- Local graph/source block marker: `2026-06-05T10:50:53.6905795+01:00`.
- Synthesis marker: `2026-06-05T10:52:24.2300296+01:00`.
- The scratchpad records that this is a structured continuation, not a completed 60-90 minute wall-clock claim.

Source classes checked:

- Methodology: DORA small batches, DORA trunk-based development, trunk-based short-lived branch guidance, and OpenAI Codex ExecPlan guidance.
- Official/API docs: Context7 `/nodejs/node` plus official Node filesystem docs for `fs.watch` and `fs.watchFile`; GitHub Actions secure-use docs for privileged PR workflow risks.
- Public GitNexus evidence: GitNexus README, issue #1400, issue #422 index, and previously recorded PR/issue evidence.
- Local evidence: `reindex-watcher.ts`, `reindex-control.ts`, `reindex-operations.ts`, `api.ts`, `wiki/generator.ts`, `pr-swarm-review/`, `ARCHITECTURE.md`, and `eval/README.md`.

Conclusions:

- One shared branch remains the route, but only with WIP limit one, small verified slices, and documentation checkpoints before moving to the next feature.
- Auto-Reindexing should be sweep/staleness based. Context7 and official Node docs both warn that native file watching can be inconsistent or unavailable, especially on virtualized/host filesystems.
- GitNexus PR #1070 makes the OSS hook distinction explicit: current hook behavior is notification-only, while Enterprise Auto-reindexing remains a separate product line item. The local feature should not be hook-driven.
- PR Review / Blast Radius should start as a local risk report. GitHub posting/check automation is later because privileged PR workflows need a security design.
- Auto-Updating Code Wiki should reuse the current generator after freshness exists and after LLM/provider/cost/publication policy is explicit.
- Code Wiki analogues (CodeWiki, repowise, RepoDoc, DeepWiki Open) support graph-backed incremental documentation, but they also reinforce that GitNexus's missing first decision is refresh policy, not generator capability.
- Deferred features remain deferred because their missing first questions are workflow-level: failing-test evidence for regression forensics, app/test environment for E2E generation, current-surface gap for multi-repo, and provider onboarding scope for OCaml.
- Auto Regression Forensics specifically needs a failing-test/known-good/known-bad evidence contract; End-to-End Test Generation specifically needs an app launch/browser/test-framework contract. Local `eval/` is useful evidence, but it is not either product workflow.
- OCaml is feasible in principle because a public Tree-sitter grammar exists, but local source confirms no OCaml enum, extension mapping, language provider, or query set. Treat it as a full language-onboarding project.

### 2026-06-05T14:01+01:00 - TDD Execution Discipline Recorded

Objective:

- Record how implementation should proceed if MAIN later opens the Auto-Reindexing write scope.
- Keep this as process documentation only; no source implementation is approved by this note.

Decision:

- Use TDD for behavior changes: baseline focused tests, write one failing test, verify the red failure, implement the smallest green change, verify, refactor, then repeat.
- For Auto-Reindexing, likely first red tests are stale repo selected, fresh repo skipped, dry-run no-op, coalescing, invalid registry entry handling, explicit auto/freshness operation trigger, and watcher failure not blocking sweep recovery.

Boundary:

- This TDD note does not open implementation. The gate remains `MAIN | READY_FOR_IMPLEMENTATION`.

### 2026-06-05 - Interim Router Cleanup Executed

Objective:

- Remove the hidden workstation `gitnexus` router before main feature implementation so Docker/Podman behavior is explicit and agents do not design against an undocumented host shim.

Commands and observations:

- `Get-Command gitnexus -All` before cleanup showed `C:\Users\steve\.local\bin\gitnexus.cmd` ahead of the npm shims.
- `gitnexus --version` before cleanup reported `1.6.6-rc.109` through the hidden router.
- `gitnexus-host --version` reported `1.6.6-rc.53`.
- `gitnexus-podman --version` reported `1.6.6-rc.109`.
- `gitnexus --gitnexus-router-diagnostics` selected `C:\Users\steve\.local\bin\gitnexus-podman.cmd` and reported `gitnexus-server` running.
- `Invoke-RestMethod http://127.0.0.1:4747/api/health` returned `{ "status": "ok" }`.
- Renamed `C:\Users\steve\.local\bin\gitnexus.cmd` to `C:\Users\steve\.local\bin\gitnexus-router.disabled-20260605.cmd`.
- Renamed `C:\Users\steve\.local\bin\gitnexus.py` to `C:\Users\steve\.local\bin\gitnexus-router.disabled-20260605.py`.
- `Get-Command gitnexus -All` after cleanup resolved to the npm shims, not `.local\bin\gitnexus.cmd`.
- `gitnexus --version` and `gitnexus-host --version` after cleanup reported `1.6.6-rc.53`.
- `gitnexus-podman list` saw `deepwiki-open` and `Prometheus`.
- Normal runtime health remained OK.

Decision impact:

- The hidden router is no longer a current workflow dependency.
- Use `gitnexus-podman` for Podman-backed rc.109 checks.
- Historical immediate post-quarantine state: bare `gitnexus` was stale host/npm until the later host CLI alignment checkpoint below.
- Source-feature implementation remains blocked until the accepted Task 1 write set is recorded.

### 2026-06-05 - Host CLI Alignment

Objective:

- Update out-of-date GitNexus workstation guidance and align the host/npm CLI with the current pinned rc.109 local runtime, without changing GitNexus source or containers.

Commands and observations:

- `npm view gitnexus version dist-tags --json` reported `latest: 1.6.5` and `rc: 1.6.6-rc.148`.
- `npm view gitnexus@1.6.6-rc.109 version --json` confirmed `1.6.6-rc.109` exists on npm.
- `npm list -g gitnexus --depth=0` initially showed `gitnexus@1.6.6-rc.53`.
- Ran `npm install -g gitnexus@1.6.6-rc.109`.
- `gitnexus --version`, `gitnexus-host --version`, and `gitnexus-podman --version` all reported `1.6.6-rc.109` after the update.
- `Invoke-RestMethod http://127.0.0.1:4747/api/health` still returned `{ "status": "ok" }`.
- Updated `C:\Users\steve\.codex\Tools.md` and the global GitNexus skills under `C:\Users\steve\.agents\skills\gitnexus-*` so future agents use explicit `gitnexus-podman` plus bare host `gitnexus` routing instead of stale `npx gitnexus` guidance.

Decision impact:

- The host/npm CLI is no longer stale relative to the pinned rc.109 runtime.
- The latest npm `rc` dist-tag is newer (`1.6.6-rc.148`), but this task intentionally did not retarget the source branch or normal runtime beyond rc.109.
- Bare `gitnexus` is now version-aligned, but it is still the host/npm route; use `gitnexus-podman` for Podman-backed indexes and runtime checks.

### 2026-06-05 - Expanded Research Pass: Auto-Reindexing Readiness

Objective:

- Increase the research depth before implementation and keep the conclusion inside the canonical four-file bundle.
- Clarification recorded after review: the research phase is feature-wide across all seven candidates, not Auto-Reindexing-only. Auto-Reindexing remains the decision-grade-now focus because it is the likely first implementation slice, but dependency shape and sequencing must be derived from the whole feature map.

Objective time tracking:

- End timestamp captured locally: `2026-06-05T00:43:14.4415498+01:00`.
- This was an expanded follow-on pass after the earlier 2026-06-05 research and bundle migration.

Skills and method used:

- Used Superpowers/research-related discipline from `using-superpowers`, `autoresearch`, `writing-plans`, and `verification-before-completion`.
- Applied a lightweight autoresearch loop: inspect local evidence, compare against primary/public sources, synthesize into this checkpoint, then update the live plan.
- Did not create a separate research workspace; this bundle remains the control surface.

Source classes checked:

- Local source and tests:
  - `gitnexus/src/server/reindex-watcher.ts`
  - `gitnexus/src/server/reindex-control.ts`
  - `gitnexus/src/server/reindex-operations.ts`
  - `gitnexus/src/server/reindex-follow-up.ts`
  - `gitnexus/src/server/api.ts`
  - `gitnexus/src/core/git-staleness.ts`
  - `gitnexus/src/storage/repo-manager.ts`
  - `gitnexus/test/unit/reindex-watcher.test.ts`
  - `gitnexus/test/unit/reindex-control.test.ts`
  - `gitnexus/test/unit/reindex-operations.test.ts`
  - `gitnexus/test/unit/reindex-api-wiring.test.ts`
  - `gitnexus/test/unit/reindex-freshness-wiring.test.ts`
  - `gitnexus/test/unit/staleness.test.ts`
- Context7 / official docs:
  - Context7 `/nodejs/node` docs for `fs.watch`, `fsPromises.watch`, `fs.watchFile`, recursive watching, `AbortSignal`, and virtualization caveats.
  - Official Node.js filesystem docs: https://nodejs.org/api/fs.html
- GitHub/public GitNexus evidence:
  - GitNexus CLI skill docs: https://github.com/abhigyanpatwari/gitnexus/blob/main/gitnexus-claude-plugin/skills/gitnexus-cli/SKILL.md
  - GitNexus PR #205: https://github.com/abhigyanpatwari/GitNexus/pull/205
  - GitNexus issue #1400: https://github.com/abhigyanpatwari/GitNexus/issues/1400
  - GitNexus RUNBOOK stale-index section: https://github.com/abhigyanpatwari/GitNexus/blob/main/RUNBOOK.md
  - GitNexus GUARDRAILS stale-graph section: https://github.com/abhigyanpatwari/GitNexus/blob/main/GUARDRAILS.md
- Secondary watcher context:
  - Chokidar/npm docs were checked only to confirm that adding a watcher dependency is not needed for the first slice.

Local findings:

- `ReindexWatcherScheduler` already exists and supports env-driven config, ignored paths, debounce, dry-run behavior, manual/sweep scheduling, and `requestReindex` injection.
- Watcher env defaults are conservative: disabled by default and dry-run by default.
- The existing reindex API path already has substantial safety:
  - registered repo resolution
  - `ReindexQueue` concurrency/coalescing
  - worker option constraining through `buildReindexWorkerOptions`
  - operation records
  - pending-rerun follow-up handling
  - graph-read guard during pending-rerun overlap
  - explicit backend refresh after successful reindex
- Current operation triggers are only `direct` and `pending-rerun`. If auto-reindex needs observability, the operation trigger union and tests should be extended instead of hiding the cause as `direct`.
- `checkStalenessAsync` already provides the commit-based freshness primitive needed for sweep selection.
- `listRegisteredRepos({ validate: true })` can provide a safer registry boundary than blindly trusting stale registry entries.

External findings:

- Official Node docs warn that `fs.watch` is not consistent across platforms and can be unreliable or impossible on network filesystems or host filesystems under virtualization such as Docker/Vagrant. `fs.watchFile` exists as stat polling but is slower and less reliable.
- Upstream GitNexus docs still describe stale-index remediation as running `analyze` when MCP/resources report stale results; this supports freshness orchestration as a real user problem.
- GitNexus PR #205 explicitly identified synchronous hook-driven full analyze as dangerous because it can block, timeout, and leave index state inconsistent. This reinforces the existing decision that Git hooks are not the implementation route.
- GitNexus issue #1400 shows Windows/local indexing and registry recognition have had real failure modes, so registry validation and explicit operation failure visibility matter.

Research conclusion:

- We have enough evidence to plan Auto-Reindexing as the first implementation candidate, but not to mutate source until MAIN opens the gate.
- The safest first slice is an opt-in server-side freshness orchestrator:
  - validated repo registry loading
  - commit-staleness sweep
  - existing scheduler/debounce where useful
  - existing queue and `startReindexJob` pathway
  - operation-ledger visibility
  - dry-run by default
- Native file watching should not be the correctness mechanism. It can be a later acceleration path only after the sweep path is correct.
- Do not add Chokidar or any watcher dependency for the first slice without MAIN approval.
- Do not implement hooks.
- Do not call the server's HTTP API from inside the server; factor a server-local helper if the current route-local `startReindexJob` closure needs reuse.

Recommended implementation-readiness checks:

- Before source edits, inspect whether `startReindexJob` should remain in `api.ts` or move to a focused helper module.
- Confirm the minimal type change for `ReindexTrigger`, likely adding an auto/freshness trigger such as `auto-reindex`.
- Add tests before implementation for stale selection, fresh skip, dry-run skip, coalescing, invalid registry entries, watcher failure fallback, and operation trigger visibility.
- Keep source edits inside server reindex/freshness surfaces unless MAIN expands scope.

Expanded feature-map implications:

- Auto-Updating Code Wiki is Task 2 because existing wiki generation is substantial and should be orchestrated after successful freshness/reindex, not rebuilt from scratch.
- Multi-Repo Support Improvements is Task 3 because current group support is already substantial and the near-term work is reconciliation/ergonomics, not unified cross-repo graph expansion.
- PR Impact / Blast Radius is Task 4 and paused before source work; it depends on fresh-enough graph state and already has useful primitives: `detect_changes`, `impact`, and `api_impact`.
- Auto Regression Forensics and End-to-End Test Generation remain deferred until PR impact/report schemas exist.
- OCaml Support remains deferred as a separate language-provider/parser project with dependency, fixture, and parity-test burden.

Commands and evidence gathered:

- `rg -n "startReindexJob|reindexOperations|ReindexOperation|trigger|requestReindex|ReindexWatcher" gitnexus/src/server`
- `Get-Content -Raw gitnexus/src/server/reindex-operations.ts`
- `Get-Content -Raw gitnexus/src/server/reindex-follow-up.ts`
- `Get-Content -Raw gitnexus/test/unit/reindex-control.test.ts`
- `Get-Content -Raw gitnexus/test/unit/reindex-operations.test.ts`
- `Get-Content -Raw gitnexus/test/unit/reindex-api-wiring.test.ts`
- `Get-Content -Raw gitnexus/test/unit/reindex-freshness-wiring.test.ts`
- `Get-Content -Raw gitnexus/test/unit/staleness.test.ts`
- `rg -n "ReindexOperationTrigger|REINDEX_OPERATION_TRIGGERS|isReindexTrigger|trigger: 'direct'|trigger: 'pending-rerun'" gitnexus/src gitnexus/test`
- `ctx7 library node "fs.watch caveats recursive AbortSignal Docker virtualization watchFile polling"`
- `ctx7 docs /nodejs/node "fs.watch caveats fsPromises.watch recursive support Docker virtualization watchFile polling AbortSignal"`
- Web searches for GitNexus auto-reindex/stale-index issues, Node watcher caveats, and Chokidar watcher behavior.

Next step:

- Await `MAIN | READY_FOR_IMPLEMENTATION` before source edits. If approved, write the first failing tests for the sweep/orchestrator behavior before implementation.

### 2026-06-05 - Canonical Bundle Migration

Objective:

- Prevent planning and implementation from becoming discombobulated by moving the control surface into the real source repo.

Actions:

- Created branch `local/gitnexus-local-features` from `local/enterprise-handoff/rc109-fix5-dirty-baseline`.
- Created `.agent/long-horizon/gitnexus-local-features/`.
- Added `prompt.md`, `plans.md`, `implement.md`, and `documentation.md`.

Verification run:

- `git status --short --branch`
- Result: branch is `local/gitnexus-local-features`; only `.agent/` is untracked before commit.
- `rg -n "local/gitnexus-local-features|READY_FOR_IMPLEMENTATION|Git hooks|podman|one shared|Do not create one branch per feature|no Git hooks|implementation gate" .agent/long-horizon/gitnexus-local-features`
- Result: found the shared branch, approval gate, canonical/legacy doc boundary, one-branch rule, and no-hooks rule across the bundle.
- `Get-ChildItem -Path .agent\long-horizon\gitnexus-local-features -File`
- Result: all four files exist.

Next step:

- Commit this bundle as a docs-only planning checkpoint before source implementation.
