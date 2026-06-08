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

The current local V1 tranche has implemented the initial slices for Auto-Reindexing, Auto-Updating Code Wiki, Multi-Repo Support Improvements, PR Impact / Blast Radius, Auto Regression Forensics, End-to-End Test Generation, and OCaml Support. Continue one selected task at a time on the shared branch using the green/amber/red lane model. Deferred or broader candidate slices remain research/readiness-only until selected and lane-classified.

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
- The human operator is `MAIN` and has superseding authority over this workstream's rules.
- Current implementation control is the selected-task packet plus green/amber/red risk lanes, not a separate `MAIN | READY_FOR_IMPLEMENTATION` phrase.
- Green/amber lane repo-local work may proceed autonomously once the selected task, likely write set, verification surface, and stop rules are clear.
- Red-lane work stops for explicit human-operator direction: secrets/tokens, paid/provider execution, GitHub comments/checks/reviews, CI/workflow mutation, destructive git, production/external writes, unbounded background automation, or major architecture/language-semantics expansion.

## Candidate Features

1. Auto-Reindexing - local V1 complete; broaden only through a selected-task packet and lane classification.
2. Auto-Updating Code Wiki - local read-only/status/provider-readiness/manual-refresh planning slices and execution-boundary readiness complete; output mutation and provider execution remain red-lane/deferred.
3. Multi-Repo Support Improvements - local docs/tool-surface reconciliation complete; unified graph expansion remains a broader future slice.
4. PR Impact / Blast Radius - local report core, CLI, and read-only MCP surface complete; GitHub automation remains red-lane/deferred.
5. Auto Regression Forensics - local report core and CLI complete; CI/artifact/bisect automation remains deferred.
6. End-to-End Test Generation - local proposal/report, CLI, deterministic UI generated specs, and API-smoke generated specs complete; browser/CI/GitHub execution remains deferred.
7. OCaml Support - experimental local V1 and Query Depth V2 complete; full module-system semantics remain a broader future slice.

## Done When

- The four-file bundle is committed in the source repo.
- Each selected feature slice is implemented only after readiness is clear enough to name the risk lane, likely write set, TDD path, and verification surface.
- Each feature has focused tests and documented verification.
- `documentation.md` records every material decision, command, result, blocker, and next step.
- No active competing roadmap remains outside the source repo.
