# GitNexus Local Features - Prompt

Created: 2026-06-05

## Long-Horizon Task Definition

A long-horizon Codex task refers to a complex, multi-session objective where an AI coding agent operates autonomously over hours or days.

Instead of relying on single prompts, these tasks use structured, multi-document environments and state checkpoints to track progress, handle interruptions, and maintain focus.

For this task, the canonical multi-document environment is:

- `prompt.md`
- `plans.md`
- `implement.md`
- `documentation.md`

## Objective

Build independently implemented local GitNexus features inspired by public enterprise-style positioning, while keeping the work versioned, sequential, reviewable, and tied to the real source repo.

The first implementation candidate is Auto-Reindexing. PR Review / Blast Radius and Auto-Updating Code Wiki are next candidates after graph freshness is solved. Deferred candidates remain research-only until reprioritized.

## Branch And Source Of Truth

- Canonical repo: `C:\Users\steve\projects\gitnexus\source-rc109-integration`
- Canonical branch for this work: `local/gitnexus-local-features`
- Baseline branch: `local/enterprise-handoff/rc109-fix5-dirty-baseline`
- Canonical planning bundle: `.agent/long-horizon/gitnexus-local-features/`
- Legacy source material: `C:\Users\steve\podman\gitnexus`

The `podman\gitnexus` planning files are useful history, but they are no longer the canonical control surface once this bundle exists in the source repo.

## Hard Constraints

- Use one shared implementation branch only: `local/gitnexus-local-features`.
- Implement features sequentially, one at a time.
- Do not create one branch per feature.
- Do not use Git hooks as the implementation route.
- Do not call this implementation "Enterprise" in code, user-facing text, branch names, or product copy except when quoting or describing public product-positioning evidence.
- Do not mutate the promoted normal runtime unless the user explicitly requests it.
- Do not implement source changes until `MAIN | READY_FOR_IMPLEMENTATION` records the accepted scope, branch/worktree, and write set.

## Candidate Features

1. Auto-Reindexing - `now`, decision-grade research complete enough to propose first.
2. PR Review / Blast Radius - `next`, report-first over existing graph primitives.
3. Auto-Updating Code Wiki - `next`, refresh orchestration after graph freshness exists.
4. Auto Regression Forensics - `defer`.
5. End-to-End Test Generation - `defer`.
6. Multi-Repo Support Improvements - `defer`.
7. OCaml Support - `defer`.

## Done When

- The four-file bundle is committed in the source repo.
- Each approved feature is implemented only after its readiness gate is cleared.
- Each feature has focused tests and documented verification.
- `documentation.md` records every material decision, command, result, blocker, and next step.
- No active competing roadmap remains outside the source repo.
