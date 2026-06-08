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

The human operator is `MAIN` and has superseding authority over this workstream's rules. A separate `MAIN | READY_FOR_IMPLEMENTATION` phrase is no longer required for reversible repo-local work on `local/gitnexus-local-features`.

Current implementation control is the selected-task packet plus the risk lane:

- Green lane: repo-local docs, tests, fixtures, source code, deterministic reports, dry-run/status behavior, local CLI/MCP surfaces, and focused refactors inside the selected task may proceed autonomously with verification.
- Amber lane: local generated-output mutation, local config-shape changes, dependency changes, public CLI/API shape changes, or broad shared-module edits may proceed with premortem, TDD where behavior changes, checkpointing, and rollback notes.
- Red lane: stop for explicit human-operator direction before secrets/tokens, paid/provider execution, GitHub comments/checks/reviews, CI/workflow mutation, destructive git, production/external writes, unbounded background automation, or major architecture/language-semantics expansion.

## Branch Discipline

- Work on `local/gitnexus-local-features`.
- Use one shared branch for all selected local features.
- Do not create one branch per feature.
- Implement features sequentially.
- Keep commits scoped: planning-only commits first, then one feature slice at a time.

## Autonomous Selected-Task Workflow

Use selected-task work packets as the feature-level completion control for this workstream.

Operating method:

- Use Structured Delegation via Evidence-Gated Small-Batch Kanban.
- Use Continuous Agentic Kanban as the faster-paced operating variant: Kanban flow control, XP/TDD engineering discipline, CI/CD-style verification, and Codex selected-task packets.
- Autonomous work means bounded selected-task packets, repo exploration before edits, small verified slices, fresh checkpoints, and explicit stop rules.
- For overnight or long unattended runs, continue through green/amber lane work when the selected-task packet is clear; stop only when the task crosses a red-lane boundary or loses a defensible verification path.

- Keep one selected task active at a time.
- Keep one active implementation slice at a time, but maintain up to three shaped ready packets when possible.
- Treat a ready packet as the unit of fast motion: task, outcome, lane, appetite, write set, acceptance criteria, testing ladder, reviewer gate, stop rules, rollback/checkpoint notes, and next likely packet.
- Appetite defaults: green-lane slices should be micro/small packets sized to one focused red-green-review loop; amber-lane slices may be larger but must stay bounded with premortem and rollback notes. Track elapsed time as an observation metric, not as a permission gate, because Codex 5.4 may complete well-shaped packets much faster than human estimates.
- Select the next task only after the current selected task is achieved or legitimately blocked and the next feature/slice boundary is known.
- Do not pre-create multiple task tracks for the feature backlog.
- Task baton rule: after a selected task is finished or blocked, the supervisor turn must not end until one of these is true:
  - `NEXT_TASK_SELECTED`: the next implementation slice is known, lane-classified, and recorded.
  - `READINESS_TASK_SELECTED`: implementation is not ready, but the next research/readiness boundary is known and recorded.
  - `NO_NEXT_TASK_SELECTED`: no defensible next task exists, and `documentation.md` records the exact blocker and what would unlock progress.
- Baton audit checklist: read `plans.md`, `documentation.md`, and `feature-map.md`, choose implementation/readiness/no-next, then document the result before final response.
- The selected-task packet is recorded in `plans.md` and/or `feature-map.md`.
- `documentation.md` records the current checkpoint truth for that selected task.
- Non-interactive `codex exec` worker runs must repeat the selected-task packet in the prompt.
- Worker runs must read `AGENTS.md`, `prompt.md`, `plans.md`, this file, and `documentation.md` before acting.
- Worker runs must not switch features, widen scope, or cross red-lane boundaries without explicit human-operator direction.
- A selected task is complete only when its verification surface passes or its blocker is recorded clearly.
- The Codex Goal tool is optional tracking only; do not block autonomous work merely because a formal Goal Contract has not been created.

Lane stop rules for autonomous or non-interactive runs:

- Stop for explicit human-operator direction before secrets/tokens, paid/provider execution, GitHub PR comments/checks/reviews, CI/workflow mutation, destructive git, production/external writes, unbounded background automation, or major architecture/language-semantics expansion.
- Stop if the selected task cannot name a likely write set, verification surface, rollback/reporting shape for amber-lane work, or TDD red/green path for behavior changes.
- Stop if verification repeatedly fails without a new diagnosis, or if source ownership cannot be established from local source plus documented evidence.

Minimum selected-task packet standard:

- A durable objective.
- A verifiable stopping condition.

Strong selected-task packet standard for this workstream:

- Outcome: what must be true when the selected task is done.
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
Selected task:
<copy the selected-task packet from plans.md / feature-map.md>

Required context:
- Read AGENTS.md first.
- Read .agent/long-horizon/gitnexus-local-features/prompt.md.
- Read .agent/long-horizon/gitnexus-local-features/plans.md.
- Read .agent/long-horizon/gitnexus-local-features/implement.md.
- Read .agent/long-horizon/gitnexus-local-features/documentation.md.
- Work only on the active feature.
- Use branch local/gitnexus-local-features.
- Follow branch-trusted green/amber/red lanes.
- Do not leave the selected task or cross red-lane boundaries without explicit human-operator direction.

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
<worker prompt skeleton filled with the selected-task packet>
'@ | codex exec `
  --cd "C:\Users\steve\projects\gitnexus\source-rc109-integration" `
  --sandbox workspace-write `
  --json `
  -
```

Research-only runs should state that source mutation is out of scope. Implementation runs may use `workspace-write` for selected-task green/amber lane work. Do not use `danger-full-access` for routine worker runs.

Local CLI verification on 2026-06-07 showed this workstation is running `codex-cli 0.135.0` and `codex exec` supports `-C`/`--cd`, `--sandbox`, `--json`, `--enable goals`, stdin prompts, and `--dangerously-bypass-approvals-and-sandbox`. It does not expose `--ask-for-approval`; do not include that option in worker-run commands unless a later local `codex exec --help` confirms it exists.

Non-interactive Goal caveat:

- Official OpenAI docs support `codex exec` for scripts/CI-style automation and `/goal` for durable objectives, but current public GitHub issue/PR evidence shows non-interactive Goal control is still evolving.
- There is no stable dedicated `codex goal ...` CLI contract documented for headless wrappers.
- Prefer selected-task packets in prompts over relying on implicit Goal lifecycle behavior.
- If using Goals through `codex exec`, make the prompt explicit and smoke-test Goal tool availability in the current session; do not infer tool availability solely from `features.goals = true`.
- Prefer a fresh non-interactive worker prompt per selected task unless local CLI help and a smoke test prove promptless resume is available.

## Skills And Tool Routing

For autonomous selected-task worker runs, point agents to these local context files first:

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

Use relevant Codex/Superpowers/research skills when they apply. For this work, `using-superpowers`, `autoresearch`, `writing-plans`, and `verification-before-completion` are part of the expected discipline. Do not create a separate research workspace unless the human operator asks for it; write durable conclusions into this four-file bundle.

Record objective time evidence for decision-grade passes: start/end timestamp, source classes checked, commands run, and what changed the conclusion.

## Implementation Loop

For each selected implementation slice:

1. Read `prompt.md`, `plans.md`, this file, and `documentation.md`.
2. Confirm the selected-task packet and risk lane.
3. Inspect the current source and tests before editing.
4. Make the smallest coherent change.
5. Run focused tests that can fail for the right reason.
6. Repair failures before broadening scope.
7. Update `documentation.md` with commands, results, files changed, decisions, and next step.
8. Stop before the next feature until the current feature is verified and documented.

## Testing Ladder

Use the researched GitNexus testing ladder from `testing-strategy-research-scratchpad.md` as the default verification shape:

1. Start with one focused failing test for behavior changes.
2. Prefer small pure or sociable unit tests for core logic, parsers, range mapping, verdict rules, renderers, formatters, and option parsing.
3. Add medium fixture/integration tests when behavior crosses parser, graph, filesystem, local DB/index, local server/API, CLI, MCP, or generated-output boundaries.
4. Use deterministic golden Markdown/JSON/spec tests for reports and generated artifacts.
5. Run `npm run build` plus `git diff --check` for source tranches.
6. Run Podman, browser, GitHub, provider, CI, or external-runtime checks only when the selected task touches that boundary and the lane permits it.
7. Use non-interactive `codex exec` review or security-style review as a documented second-opinion gate after executable verification, not as a substitute for tests.

## Non-Negotiable Stop Rules

- Stop before any Git hook implementation route.
- Treat dependency additions and public API changes as amber lane when they are repo-local and selected-task-bound; premortem, TDD, checkpoint, and document rollback notes.
- Stop before dependency or public API work if it crosses into red-lane external services, secrets, paid providers, production/runtime deployment, or major architecture expansion.
- Stop before mutating the promoted normal runtime unless the user explicitly requests it.
- Stop if source state conflicts with this bundle or another agent has changed files in the active write set.

## Verification Expectations

- Documentation-only changes: verify content with `rg` and `git status`.
- Feature implementation: run focused unit/integration tests first, then broader checks if the change crosses subsystem boundaries.
- Agentic or recurring workflows: capture reusable checks, fixtures, or runbook notes when a failure would otherwise repeat.

Do not claim completion without verification or an explicit blocker.
