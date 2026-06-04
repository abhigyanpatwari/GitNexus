# GitNexus Local Features - Implementation Rulebook

Created: 2026-06-05

## Long-Horizon Control Surface

The required long-horizon control surface for this task is:

- `prompt.md` holds the durable objective and constraints.
- `plans.md` holds the live queue and feature sequencing.
- `implement.md` holds the execution discipline.
- `documentation.md` holds the checkpoint truth.

Archived notes, external handoffs, scratch work, and files under `C:\Users\steve\podman\gitnexus` must not override these four files.

## Execution Gate

Do not edit GitNexus source files for a feature until `MAIN | READY_FOR_IMPLEMENTATION` records:

- accepted feature slice
- allowed branch/worktree
- allowed write set
- required tests or acceptance checks

Planning and documentation edits to this bundle are allowed when they directly improve continuity.

## Branch Discipline

- Work on `local/gitnexus-local-features`.
- Use one shared branch for all approved local features.
- Do not create one branch per feature.
- Implement features sequentially.
- Keep commits scoped: planning-only commits first, then one feature slice at a time.

## Research Discipline

Every feature must distinguish:

- expected behavior from public positioning
- observed current local behavior
- fact versus inference
- dependency shape
- smallest safe implementation slice
- verification plan
- risks and stop rules

Use Context7 first for current library, SDK, CLI, or API behavior when relevant. Use official docs, source, GitHub issues/PRs, and web search as needed. Public enterprise positioning is evidence for expected value only; it is not proof of local OSS behavior.

## Implementation Loop

For each approved feature:

1. Read `prompt.md`, `plans.md`, this file, and `documentation.md`.
2. Confirm the feature status is approved for implementation.
3. Inspect the current source and tests before editing.
4. Make the smallest coherent change.
5. Run focused tests that can fail for the right reason.
6. Repair failures before broadening scope.
7. Update `documentation.md` with commands, results, files changed, decisions, and next step.
8. Stop before the next feature until the current feature is verified and documented.

## Non-Negotiable Stop Rules

- Stop before any Git hook implementation route.
- Stop before adding dependencies unless MAIN has approved the dependency.
- Stop before changing public APIs unless the accepted scope requires it.
- Stop before mutating the promoted normal runtime unless the user explicitly requests it.
- Stop if source state conflicts with this bundle or another agent has changed files in the active write set.

## Verification Expectations

- Documentation-only changes: verify content with `rg` and `git status`.
- Feature implementation: run focused unit/integration tests first, then broader checks if the change crosses subsystem boundaries.
- Agentic or recurring workflows: capture reusable checks, fixtures, or runbook notes when a failure would otherwise repeat.

Do not claim completion without verification or an explicit blocker.
