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

## Goal-Backed Non-Interactive Workflow

Use Codex Goals as the feature-level completion contract for this workstream.

- Keep one active feature Goal at a time.
- Create the next Goal only after the current Goal is achieved or legitimately blocked and the next feature/slice boundary is known.
- Do not pre-create multiple Goals for the feature backlog.
- Goal baton rule: after a Goal is marked `complete` or `blocked`, the supervisor turn must not end until one of these is true:
  - `NEXT_GOAL_CREATED`: `get_goal` confirms no active Goal, the next approved implementation slice is known, and the next Goal has been created.
  - `READINESS_GOAL_CREATED`: implementation is not ready, but the next research/readiness boundary is known and a readiness Goal has been created.
  - `NO_NEXT_GOAL_CREATED`: no defensible next Goal exists, and `documentation.md` records the exact blocker and what would unlock progress.
- Baton audit checklist: call `get_goal`, read `plans.md`, `documentation.md`, and `feature-map.md`, choose implementation/readiness/no-next, then document the result before final response.
- The active Goal Contract is recorded in `plans.md`.
- `documentation.md` records the current checkpoint truth for that Goal.
- Non-interactive `codex exec` worker runs must repeat the active Goal Contract in the prompt.
- Worker runs must read `AGENTS.md`, `prompt.md`, `plans.md`, this file, and `documentation.md` before acting.
- Worker runs must not switch features, widen scope, or start implementation without `MAIN | READY_FOR_IMPLEMENTATION`.
- A Goal is complete only when its verification surface passes or its blocker is recorded clearly.

Minimum Goal standard:

- A durable objective.
- A verifiable stopping condition.

Strong Goal standard for this workstream:

- Outcome: what must be true when the Goal is done.
- Verification surface: the tests, commands, reports, artifacts, or source evidence that prove the outcome.
- Constraints: what must not regress or be changed.
- Boundaries: allowed files, repos, tools, data, branches, and routes.
- Iteration policy: how the agent chooses the next useful action after each checkpoint.
- Blocked stop condition: when the agent must stop, what evidence it must report, and what would unlock progress.

Operational additions required for non-interactive worker runs:

- Reading list: point the worker at the files, docs, issues, logs, and evidence it must read first.
- Checkpoints: require short progress logs after meaningful work blocks.
- Compact status reports: name the current checkpoint, what was verified, what remains, and whether the worker is blocked.

Default worker prompt skeleton:

```text
Active Goal:
<copy the feature Goal Contract from plans.md>

Required context:
- Read AGENTS.md first.
- Read .agent/long-horizon/gitnexus-local-features/prompt.md.
- Read .agent/long-horizon/gitnexus-local-features/plans.md.
- Read .agent/long-horizon/gitnexus-local-features/implement.md.
- Read .agent/long-horizon/gitnexus-local-features/documentation.md.
- Work only on the active feature.
- Use branch local/gitnexus-local-features.
- Do not implement source changes unless MAIN | READY_FOR_IMPLEMENTATION names this feature and write scope.

Required response:
- checkpoint reached
- skills/tools used
- commands run
- evidence found
- files changed, if any
- verification result
- blocker status
- recommended next step
```

Default local `codex exec` shape:

```powershell
@'
<worker prompt skeleton filled with the active Goal Contract>
'@ | codex exec `
  --cd "C:\Users\steve\projects\gitnexus\source-rc109-integration" `
  --sandbox workspace-write `
  --json `
  -
```

Research-only runs should state that source mutation is out of scope. Implementation runs may use `workspace-write` only after MAIN opens the write scope. Do not use `danger-full-access` for routine worker runs.

Local CLI verification on 2026-06-05 showed this workstation's `codex exec` supports `--cd`, `--sandbox`, `--json`, and stdin prompts. It does not expose `--ask-for-approval`; do not include that option in worker-run commands unless a later local `codex exec --help` confirms it exists.

## Skills And Tool Routing

For goal-backed worker runs, point agents to these local context files first:

- `AGENTS.md`
- `.agent/long-horizon/gitnexus-local-features/prompt.md`
- `.agent/long-horizon/gitnexus-local-features/plans.md`
- `.agent/long-horizon/gitnexus-local-features/implement.md`
- `.agent/long-horizon/gitnexus-local-features/documentation.md`
- `.agent/long-horizon/gitnexus-local-features/enterprise-feature-intended-functions-scratchpad.md` when detailed research evidence is needed

Use these skill families when available:

- Superpowers workflow skills: `using-superpowers`, `writing-plans`, `test-driven-development`, `systematic-debugging`, `verification-before-completion`, and `executing-plans`.
- Research skills: `autoresearch`, `ara-research-manager`, and `ara-rigor-reviewer` for evidence capture, synthesis, and adversarial review.
- OpenAI/Codex docs skill: `openai-docs` when Codex Goals, `codex exec`, AGENTS.md, skills, or other OpenAI product behavior matters.
- GitNexus workflow skills from `C:\Users\steve\.agents\skills`: `gitnexus-guide`, `gitnexus-exploring`, `gitnexus-impact-analysis`, `gitnexus-debugging`, `gitnexus-refactoring`, `gitnexus-pr-review`, and `gitnexus-cli`.

Use these tools in this order when relevant:

1. Local source, tests, architecture docs, and this four-file bundle.
2. GitNexus graph tools or CLI with explicit routes: bare `gitnexus` for host/npm indexes and `gitnexus-podman` for Podman indexes.
3. `ctx7` / Context7 for current library, SDK, CLI, API, or platform behavior.
4. Official docs, source, release notes, GitHub issues, and GitHub PRs.
5. Broader web/community evidence only as secondary context.

For this host multi-repo index, graph queries should specify `--repo gitnexus-local-features` when needed.

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

Research passes must be explicitly evidence-routed:

1. local source and tests for current behavior
2. Context7 or official docs for version-sensitive platform/API behavior
3. GitHub issues, PRs, release notes, and source for project history and failure modes
4. broader web/community evidence only as secondary context

Use relevant Codex/Superpowers/research skills when they apply. For this work, `using-superpowers`, `autoresearch`, `writing-plans`, and `verification-before-completion` are part of the expected discipline. Do not create a separate research workspace unless MAIN asks for it; write durable conclusions into this four-file bundle.

Record objective time evidence for decision-grade passes: start/end timestamp, source classes checked, commands run, and what changed the conclusion.

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
