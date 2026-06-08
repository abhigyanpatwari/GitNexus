# Fast-Pace Methodology Research Scratchpad

Created: 2026-06-08

## Research Block

- Start: 2026-06-08T14:09:38+01:00
- Purpose: identify a faster-paced methodology for the GitNexus local-features workstream that lets Codex continue autonomously without loosening evidence, testing, or red-lane boundaries.
- User-provided candidate framing: Agentic Kanban reinforced with XP and CI/CD.
- Scope: workflow methodology, agentic software engineering process, Kanban/WIP/flow, XP/TDD, CI/CD/small batches, and Codex long-horizon applicability.
- Out of scope: changing GitNexus source behavior, adding CI workflows, adding GitHub automation, or selecting the next feature packet.

## Sources Checked

| Source | Type | What it contributes | Local conclusion |
| --- | --- | --- | --- |
| Atlassian Kanban guide: https://www.atlassian.com/agile/kanban | Methodology / field guide | Kanban emphasizes visualizing work, limiting WIP, managing flow, standardizing workflow, cycle-time/cumulative-flow metrics, and continuous improvement. It also contrasts Kanban's continuous flow with Scrum's fixed sprint cadence. | Kanban is the best base layer for agents because selected tasks can move through states continuously and priority can change without sprint ceremony. |
| DORA Trunk-Based Development: https://dora.dev/capabilities/trunk-based-development/ | Delivery research | DORA describes trunk-based work as small batches integrated frequently, warns that heavy/asynchronous review blocks small batches, and ties CI to fast automated tests after commits. | We should not adopt long-lived per-feature branches. Our one shared feature branch should behave like a small-batch integration lane with frequent checkpoints. |
| DORA Working in Small Batches: https://dora.dev/capabilities/working-in-small-batches/ | Delivery research | Small batches reduce feedback time, make triage easier, and are explicitly called out as a countermeasure for AI-generated large changes. DORA recommends work units that can finish in hours to a couple of days and are independent/testable. | Faster pace should come from smaller packets and more frequent verification, not from skipping tests or review. |
| DORA Test Automation: https://dora.dev/capabilities/test-automation/ | Delivery research | Fast feedback comes from continuous automated testing; developers should write tests, use TDD, keep suites fast, and avoid declaring work complete without automated acceptance evidence. | This supports the GitNexus testing ladder promoted into `AGENTS.md` / `implement.md`. |
| Agile Alliance XP guide: https://agilealliance.org/glossary/xp/ | Methodology | XP is the most engineering-practice-specific agile framework and includes small releases, testing, refactoring, pair programming, continuous integration, simple design, and coding standards. | XP is the engineering discipline layer: TDD, simple design, refactor only under tests, and reviewer-agent pair-style review. |
| Martin Fowler, Continuous Integration: https://martinfowler.com/articles/continuousIntegration.html | Engineering practice | CI depends on self-testing code, frequent integration, fast builds, and fixing broken builds immediately. Fowler also stresses that no code should sit unintegrated for long and that small chunks make conflicts easier. | Our shared branch should be checkpointed after small verified tranches; if verification fails, fixing that outranks starting new work. |
| Basecamp Shape Up, Principles of Shaping: https://basecamp.com/shapeup/1.1-chapter-02 | Product/work shaping | Shape Up separates shaping from building, sets boundaries/appetite, and keeps shaped work rough, solved, and bounded rather than over-specified. | Use lightweight "appetite" boxes for selected tasks so we move quickly without over-planning every detail. |
| Agentsway paper: https://arxiv.org/html/2510.23664v1 | Emerging agentic-methodology research | Defines human orchestrator plus planning, prompting, coding, testing, and fine-tuning agents; emphasizes human oversight, structured agent roles, testing, reports, and continuous learning. | Useful support for specialist worker/reviewer roles, but too broad/heavy to import wholesale. |
| Agentic coding manifests paper: https://arxiv.org/abs/2509.14744 | Empirical agent-workflow research | Finds agent manifests provide project context, identity, operational rules, commands, implementation notes, and architecture context. | Supports keeping the fast workflow in `AGENTS.md` and the four-file long-horizon bundle, not only in chat. |
| Coding-agent failure study: https://arxiv.org/abs/2605.29442 | Empirical caution | Study of 20,574 sessions reports recurring failures around project reading, intent interpretation, rule-following, action bounding, implementation/execution, and progress reporting; visible resolutions often required explicit user correction. | Faster autonomy still needs packet boundaries, explicit stop rules, tests, and review-agent gates. |
| OpenAI Codex non-interactive docs: https://developers.openai.com/codex/noninteractive | Tool workflow docs | `codex exec` supports script/CI-style runs, machine-readable outputs, sandbox/approval controls, and pipeline use. | Non-interactive workers fit the Kanban "agent pulls a ready packet" model if prompts include the selected-task packet and bundle context. |
| OpenAI Codex workflows: https://developers.openai.com/codex/workflows | Tool workflow docs | Local review is a second set of eyes; iterate after findings. | Reviewer-agent gate belongs after executable tests, especially before checkpointing mixed WIP. |
| OpenAI GPT-5.4 release note: https://openai.com/index/introducing-gpt-5-4/ | Model/product release note | GPT-5.4 is rolling out in Codex, improves long-horizon/tool/computer-use workflows, and `/fast` mode in Codex can increase token velocity. | Do not bind packet appetite to slow human wall-clock estimates; use packet boundary and verification-loop size instead. |

## Synthesis

The best fit for this workstream is not Scrum or a fixed sprint method. It is:

> Continuous Agentic Kanban = Kanban flow control + XP engineering discipline + CI/CD-style verification + Codex selected-task packets.

This is close to the user's pasted recommendation, but adapted to our actual repo constraints:

- We already have one shared branch, so speed comes from small verified tranches and frequent checkpoints, not from per-feature branches.
- We already have long-horizon control files, so agent state should be board-like inside `plans.md`, `feature-map.md`, and `documentation.md`.
- We already have a testing ladder, so XP/TDD can be concrete rather than aspirational.
- We can run non-interactive Codex review as a reviewer-agent gate, but not as a replacement for Vitest/build/golden verification.

## Proposed Continuous Agentic Kanban Board

Use this state flow for future selected tasks:

```text
Backlog
  -> Ready Packet
  -> Active Build
  -> Test Ladder
  -> Reviewer Agent
  -> Checkpoint
  -> Done
```

State meanings:

| State | Meaning | Exit requirement |
| --- | --- | --- |
| Backlog | Candidate feature/slice exists but is not yet actionable. | A selected-task packet is shaped. |
| Ready Packet | Goal, scope, risk lane, write set, acceptance criteria, tests, and stop rules are known. | Codex can start without asking a new permission question unless red-lane work is involved. |
| Active Build | One implementation slice is being changed. | Focused source/test work is complete. |
| Test Ladder | The right tests/build/checks for the touched boundary have run. | Evidence passes or blocker is documented. |
| Reviewer Agent | Non-interactive Codex/manual review checks the diff when tranche size/risk justifies it. | Findings fixed or consciously deferred. |
| Checkpoint | `documentation.md` records changed files, commands, result, risks, and next baton. | Commit/checkpoint recommendation exists. |
| Done | Slice is locally complete. | Next selected task is recorded or `NO_NEXT_TASK_SELECTED` is recorded. |

## Fast-Pace Rules

1. Keep WIP to one active implementation slice.
2. Keep a tiny ready queue of up to three shaped packets so Codex can keep moving after a slice completes.
3. Each packet must be small enough to finish in one bounded verification loop; if not, split it.
4. Use appetite boxes:
   - Green lane: micro/small packet sized to one focused red-green-review loop.
   - Amber lane: larger but still bounded packet with premortem and rollback notes.
   - Time is an observation metric, not a permission gate; Codex 5.4 may complete well-shaped packets much faster than human estimates.
   - Red lane: stop for human-operator direction.
5. Do not spend more time planning a green-lane slice than implementing its first red test unless the source ownership is unclear.
6. Use TDD for behavior changes and the GitNexus testing ladder for verification depth.
7. Prefer local report/CLI/MCP/golden slices over provider/GitHub/CI/runtime mutation when both would create value.
8. Do not start another feature while verification is failing.
9. Use non-interactive `codex exec` review after executable verification for mixed, risky, or checkpoint-worthy tranches.
10. Record cycle time, blocker, and next baton after every slice.

## Agent Packet Template

Each ready packet should include:

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

## What To Promote

Promote only the compact methodology rule into durable docs:

- Name: `Continuous Agentic Kanban`.
- Definition: Kanban for task flow, XP/TDD for engineering discipline, CI/CD-style testing/build/review gates for enforcement, and selected-task packets for Codex continuity.
- Rules: one active implementation slice, up to three ready packets, micro/small green packets, bounded amber packets, test ladder, reviewer gate, checkpoint/baton.

Do not copy this entire scratchpad into `AGENTS.md`.

## Working Recommendation

Adopt Continuous Agentic Kanban as the faster-paced variant of the existing Structured Delegation rule. This preserves the current green/amber/red autonomy model but reduces friction by making "ready packets" the unit of motion and by allowing Codex to keep pulling the next shaped packet without waiting for fresh ceremony.
