# GitNexus Local Features - Plans

Created: 2026-06-05

## Operating Notes

- This is a long-horizon Codex task using the four-file control surface in this directory.
- The source repo bundle is canonical. Old planning files in `C:\Users\steve\podman\gitnexus` are legacy source material only.
- Use branch `local/gitnexus-local-features` for all approved feature work.
- Implement one feature at a time on the shared branch.
- Implementation is blocked until `MAIN | READY_FOR_IMPLEMENTATION` names the accepted write scope.

## Feature Queue

| Order | Feature | Research depth | Disposition | Current implementation status |
| --- | --- | --- | --- | --- |
| 1 | Auto-Reindexing | `decision-grade now` | `now` | Waiting for `MAIN | READY_FOR_IMPLEMENTATION` |
| 2 | PR Review / Blast Radius | `medium now` | `next` | Waiting for Auto-Reindexing freshness shape |
| 3 | Auto-Updating Code Wiki | `medium now` | `next` | Waiting for Auto-Reindexing freshness shape and LLM policy |
| 4 | Auto Regression Forensics | `light scoping only` | `defer` | Research-only |
| 5 | End-to-End Test Generation | `light scoping only` | `defer` | Research-only |
| 6 | Multi-Repo Support Improvements | `light scoping only` | `defer` | Research-only |
| 7 | OCaml Support | `light scoping only` | `defer` | Research-only |

## Task 0 - Version The Planning Bundle

Status: active

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

## Task 1 - Auto-Reindexing

Status: pending approval

Objective:

- Add opt-in, non-hook, server-side freshness orchestration so registered repository indexes do not silently go stale.

Expected behavior:

- Detect stale registered repos through existing Git commit/index metadata.
- Reuse existing reindex API/queue semantics instead of creating a parallel reindex path.
- Default disabled or dry-run until explicitly enabled.
- Provide enough observable state for verification.
- Treat native filesystem watching as optional acceleration only, not the correctness mechanism.

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

Stop rules:

- Stop if the design requires Git hooks.
- Stop if the design needs a new dependency before MAIN approves it.
- Stop if Windows/Podman file-watching reliability is required for correctness.
- Stop if reindex can race graph reads outside existing guarded semantics.

## Task 2 - PR Review / Blast Radius

Status: next

Objective:

- Produce local Markdown/JSON change-risk reports over existing GitNexus graph primitives.

Expected first slice:

- Orchestrate existing `detect_changes`, `impact`, and `api_impact` outputs.
- Prefer local branch/diff reporting before GitHub comment or review automation.
- Defer GitHub Actions and PR posting until report schema and permission model are stable.

Research verification already run:

- `npm test -- test/unit/tools.test.ts test/unit/tool-direct-cli.test.ts test/unit/detect-changes-worktree.test.ts test/integration/api-impact-e2e.test.ts`
- Result: 4 files passed, 71 tests passed.

Dependency:

- Requires fresh enough graph state from Task 1.

## Task 3 - Auto-Updating Code Wiki

Status: next

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

Dependency:

- Requires Task 1 freshness behavior and explicit LLM execution policy.

## Deferred Tasks

- Auto Regression Forensics: wait for PR Review report schema and CI/failure evidence model.
- End-to-End Test Generation: wait for PR Review risk model and explicit test-framework target.
- Multi-Repo Support Improvements: existing group support is substantial; keep to group/status/contract ergonomics unless MAIN expands scope.
- OCaml Support: separate language-support project with parser/provider/test burden; do not mix into the first feature sequence.
