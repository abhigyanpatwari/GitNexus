# GitNexus Local Features - Documentation

Created: 2026-06-05
Last updated: 2026-06-05

## Current Status

This task is tracked as a long-horizon Codex task through the four-file bundle in `.agent/long-horizon/gitnexus-local-features/`. This `documentation.md` file is the checkpoint authority.

Current state:

- Branch: `local/gitnexus-local-features`
- Baseline: `local/enterprise-handoff/rc109-fix5-dirty-baseline`
- Mode: planning bundle migration and approval-gated implementation preparation
- Canonical docs: this source repo bundle
- Legacy docs: `C:\Users\steve\podman\gitnexus`
- Implementation gate: closed until `MAIN | READY_FOR_IMPLEMENTATION`

## Decisions

- 2026-06-04: MAIN decided to use one shared branch for all planned local features.
- 2026-06-05: User chose `local/gitnexus-local-features` as the shared branch name.
- 2026-06-05: User chose to move the canonical planning bundle inside the source repo.
- Git hooks are not the implementation route.
- Auto-Reindexing remains the first implementation candidate.
- PR Review / Blast Radius and Auto-Updating Code Wiki remain `next`.
- Auto Regression Forensics, End-to-End Test Generation, Multi-Repo Support Improvements, and OCaml Support remain `defer`.

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

## Checkpoint Log

### 2026-06-05 - Expanded Research Pass: Auto-Reindexing Readiness

Objective:

- Increase the research depth before implementation and keep the conclusion inside the canonical four-file bundle.

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

- PR Review / Blast Radius remains `next`, because it depends on fresh-enough graph state and already has useful primitives: `detect_changes`, `impact`, and `api_impact`.
- Auto-Updating Code Wiki remains `next`, because existing wiki generation is substantial and should be orchestrated after successful freshness/reindex, not rebuilt from scratch.
- Auto Regression Forensics and End-to-End Test Generation remain deferred until PR review/report schemas exist.
- Multi-Repo Support Improvements remain deferred because current group support is already substantial; avoid expanding into unified cross-repo graph work without MAIN approval.
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
