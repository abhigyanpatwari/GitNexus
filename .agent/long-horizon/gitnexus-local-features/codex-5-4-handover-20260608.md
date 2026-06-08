# Codex 5.4 Handover - GitNexus Local Features

Created: 2026-06-08

## Purpose

This note is a supporting handover for the next Codex/GPT-5.4 session. The live control surface remains `AGENTS.md`, `prompt.md`, `plans.md`, `implement.md`, `documentation.md`, and `feature-map.md`. This note summarizes the current local-features state, the faster working method, and the boundaries that must not be lost during the model change.

OpenAI's GPT-5.4 release note says GPT-5.4 is rolling out in Codex, improves long-horizon/tool-heavy work, and supports faster Codex operation through `/fast` mode. Use that extra speed for smaller packet cycles and faster verification, not for weaker gates.

Source: https://openai.com/index/introducing-gpt-5-4/

## Current State To Inherit

- Branch: `local/gitnexus-local-features`
- Baton: `NO_NEXT_TASK_SELECTED` for feature expansion until a fresh selected-task packet is chosen.
- Control bundle: `.agent/long-horizon/gitnexus-local-features/`
- Checkpoint authority: `documentation.md`
- Feature map: `feature-map.md`
- Implementation discipline: `implement.md`
- Live queue: `plans.md`
- Project-wide rules: `AGENTS.md`

Completed local base:

- Task 1 Auto-Reindexing local V1.
- Task 2 Auto-Updating Code Wiki planner/runner, read-only status endpoint, provider-readiness status, `gitnexus wiki-refresh`, and explicit planning-only execution boundary.
- Task 3 Multi-Repo Support Improvements README/tool-surface reconciliation.
- Task 4 PR Impact / Blast Radius report core, CLI, read-only MCP `pr_impact`, changed/unmatched range evidence, and deleted-symbol evidence.
- Task 5 Auto Regression Forensics report core and local CLI.
- Task 6 E2E/API-smoke proposal/report core, CLI, generated UI specs for `/api/repos`, `/api/repo`, `/api/graph`, `/api/file`, and API-smoke specs for `/api/processes`, `/api/health`, `/api/info`.
- Task 7 OCaml experimental support, Query Depth V2, and Module-System Depth readiness.

Deferred boundaries:

- Wiki provider execution, secrets/tokens, config writes, output mutation/publication, unattended generation.
- GitHub PR comments, reviews, checks, Actions/workflow mutation, token-bearing automation.
- PR Impact historical/base graph indexes and provider compare semantics.
- Broad generated E2E/browser execution/CI integration.
- Dune, PPX, full OCaml module semantics, dependency upgrades, and production classification.

## Dirty Tree Warning

The worktree is intentionally dirty from the current tranche. It includes source, tests, docs, scratchpads, and structured review notes.

Before starting new feature behavior:

1. Run `git status --short --branch`.
2. Review `git diff --name-status` and `git diff --stat` by slice.
3. Read `documentation.md` current status and `plans.md` next-task queue.
4. Check whether the operator wants a checkpoint commit before broadening.

Do not start a new feature from stale queue notes.

## Fast-Flow Method For Codex 5.4

Use Continuous Agentic Kanban:

- Kanban controls task flow.
- XP/TDD controls engineering discipline.
- CI/CD-style checks enforce quality.
- Selected-task packets preserve Codex continuity.

Fast packet rule:

- Keep one active implementation slice.
- Maintain up to three ready packets when possible.
- Green lane means a micro/small packet sized to one focused red-green-review loop.
- Amber lane means a larger but still bounded packet with premortem and rollback notes.
- Track elapsed time as an observation metric, not as a permission gate. Codex 5.4 may finish well-shaped packets quickly.

Ready packet fields:

```text
Task:
Outcome:
Why now:
Lane:
Appetite:
Likely write set:
Acceptance criteria:
Testing ladder:
Reviewer gate:
Stop rules:
Rollback/checkpoint notes:
Next likely packet:
```

## Verification Rule

Use the GitNexus testing ladder:

1. Focused failing test first for behavior changes.
2. Small pure/sociable unit tests for core logic.
3. Fixture, CLI, MCP, local DB/index, API, or generated-output tests at boundary crossings.
4. Golden Markdown/JSON/spec tests for deterministic reports and generated artifacts.
5. `npm run build` plus `git diff --check` for source tranches.
6. Podman/browser/GitHub/runtime checks only when the selected task touches that boundary.
7. Non-interactive `codex exec` review after executable verification for mixed, risky, or checkpoint-worthy tranches.

## Red-Lane Stops

Stop for explicit human-operator direction before:

- secrets or tokens
- paid/provider execution
- GitHub comments/checks/reviews
- CI/workflow mutation
- destructive git
- production or external writes
- unbounded background automation
- major architecture or language-semantics expansion

## Recommended First Move For Codex 5.4

Do not pick a new feature immediately. The default first move is a checkpoint-readiness pass:

1. Read `AGENTS.md`, `prompt.md`, `plans.md`, `implement.md`, `documentation.md`, and `feature-map.md`.
2. Confirm the branch is `local/gitnexus-local-features`.
3. Review the dirty tree by feature slice.
4. Prefer checkpoint commit preparation or explicit checkpoint acceptance before shaping new ready packets.
5. Record the baton in `documentation.md` before starting new feature behavior.

Only after the checkpoint pass is accepted should the next session shape up to three ready packets. If choosing ready packets, prefer local green/amber packets that improve reviewability or user-visible local value without crossing red-lane boundaries.
