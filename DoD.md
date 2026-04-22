# Definition of Done — GitNexus

This document defines the repo-wide completion bar for production-ready changes in GitNexus.

Use it together with:
- `AGENTS.md`
- `GUARDRAILS.md`
- `CONTRIBUTING.md`
- `TESTING.md`
- `ARCHITECTURE.md`

This file is the stable baseline.
Implementation prompts, agent behavior, and review workflows may add task-specific checks, but they should not weaken this bar.

## Core Definition of Done

A change is done only when all relevant items below are true:

- [ ] The requested behavior is implemented end-to-end in the real runtime path for the affected surface.
      No dead code, partial wiring, or test-only behavior.

- [ ] The change is placed in the correct package and layer:
      - `gitnexus/` for CLI, MCP, HTTP bridge, ingestion, graph, and runtime logic
      - `gitnexus-web/` for browser UI
      - `gitnexus-shared/` for shared contracts, types, and constants

- [ ] Existing contracts are preserved unless the task explicitly requires a contract change.
      Any contract change is intentional, explicit, and reflected in direct consumers.

- [ ] The implementation is the smallest correct solution for the requirement.
      No speculative abstraction, unnecessary indirection, clever but hard-to-follow control flow, or unrelated cleanup.

- [ ] The code is easy for the next contributor to understand and extend.
      Naming, control flow, ownership, and extension points are clear.

- [ ] Comments are minimal and useful.
      They explain intent, invariants, contracts, or non-obvious constraints.
      No stale comments, placeholder comments, narrated code, or commented-out code.

- [ ] Performance is acceptable for the affected path.
      No repeated avoidable work, unnecessary scans, unnecessary round-trips, unbounded caches, or obvious hot-path regressions.

- [ ] Tests cover the real changed path.
      They would fail if behavior, wiring, or contracts were broken.
      Assertions are meaningful and fixtures are realistic enough for the risk of the change.

- [ ] Required validation for the touched area has been run, or any gap is explicitly called out in the final handoff / PR description.

- [ ] Residual risks, compatibility impacts, and operational concerns are either resolved or clearly stated.

## GitNexus-Specific Requirements

Apply the following when relevant to the change:

### Shared contracts and cross-surface changes

- [ ] If `gitnexus-shared/` changes, direct CLI and web consumers are verified together.
- [ ] If API shapes, MCP tool/resource behavior, or HTTP bridge behavior changes, handlers and consumers remain aligned end-to-end.
- [ ] If user-visible behavior or public usage changes, the relevant docs, examples, help text, or migration notes are updated in the same change.

### Ingestion, graph, and language-support changes

- [ ] Pipeline and architecture boundaries remain explicit.
      Do not introduce hidden cross-phase coupling or leak language-specific logic into shared infrastructure without a clear architectural reason.

- [ ] Runtime and graph behavior remain consistent.
      Do not patch symptoms in one layer while leaving the real source of truth inconsistent in another.

- [ ] If the change touches indexing, query, impact analysis, rename flows, or route/tool mapping, the affected runtime path is validated through the real entry points, not only isolated helpers.

### Agent / graph-assisted workflow

- [ ] Where graph tooling is available and relevant, impact is checked before changing non-trivial symbols, contracts, or runtime paths.
- [ ] Before finalizing, diff scope is checked so the resulting change matches the intended symbols, files, and processes.
- [ ] If an indexed repo already has embeddings and re-analysis is required, preserve embeddings rather than accidentally dropping them.

## Validation Baseline

Run the commands relevant to the touched area.
If something cannot be run in the current environment, say so explicitly.

### If `gitnexus/` changed

- [ ] `cd gitnexus && npx tsc --noEmit`
- [ ] `cd gitnexus && npm test`

### If `gitnexus-web/` changed

- [ ] `cd gitnexus-web && npx tsc -b --noEmit`
- [ ] `cd gitnexus-web && npm test`
- [ ] `cd gitnexus-web && npm run test:e2e` when browser flows or user-facing UI behavior changed

### If `gitnexus-shared/` changed

- [ ] Shared package outputs stay compatible with direct consumers
- [ ] Dependent packages still typecheck after the shared change

## Task-Specific DoD Template

Use this in implementation and review prompts.
Keep it short and tailor it to the actual change.

```md
# Definition of Done for this implementation

- [ ] Runtime wiring is complete for the affected path.
- [ ] Requested behavior is correct and relevant contracts are preserved or explicitly updated.
- [ ] The design stays scoped, readable, and proportionate to the task.
- [ ] Tests prove the changed behavior and catch broken wiring.
- [ ] Required validation for touched packages has been run, or any gap is explicitly noted.
- [ ] Repo boundaries, performance expectations, and operational safety are respected.
```

## How to Use This File in Claude Review

Reference this file as the repo-wide completion bar.
Then add a task-specific review instruction such as:

```md
Review this change against `DoD.md` and the repo docs (`AGENTS.md`, `GUARDRAILS.md`, `CONTRIBUTING.md`, `TESTING.md`, `ARCHITECTURE.md`).
Treat `DoD.md` as the minimum bar for production readiness.
Flag anything that is partially wired, contract-unsafe, under-tested, architecturally misplaced, or harder to maintain than necessary.
```

## What Does Not Belong in This File

To avoid duplication and drift, this file should not contain:

- full agent personas or role-play instructions
- step-by-step implementation prompts
- verbose review output formatting rules
- detailed repo walkthroughs already covered by other docs
- temporary task-specific acceptance criteria

Those belong in prompts, PR templates, or the relevant repo docs.
