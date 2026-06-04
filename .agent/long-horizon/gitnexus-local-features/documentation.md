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
