# Plan document template

Fill every section. If a section is genuinely empty for this task (e.g. no PDG
layer indexed), keep the heading and state why in one line — never silently
drop it. Repo-relative paths for all repo artifacts.

**Claim tagging.** Tag every load-bearing claim with its evidence class:
`[verified]` (source-read at the pinned commit), `[graph]` (GitNexus/PDG
output, not source-confirmed), `[inferred]` (evidence-backed reasoning),
`[assumed]` (unverified — must also appear in §12). Untagged prose is
narrative, not evidence.

```markdown
# Compound Engineering Plan

> Task: <one line>
> Evidence verified at commit <HEAD sha>; GitNexus index <fresh | N commits behind | not used>.

## 1. Objective

A concise description of the requested outcome.

## 2. Current Behaviour

Describe the current implementation and execution path.

Include the most relevant symbols, files, and statement-level observations.

## 3. Relevant Architecture

Explain the involved modules, boundaries, dependencies, and established patterns.

## 4. GitNexus Findings

Summarise:

- primary symbols;
- callers and callees;
- impact radius;
- related implementations;
- related tests;
- important cross-module relationships.

## 5. Statement-Level PDG Findings

For each critical symbol, explain:

- relevant statements;
- control dependencies;
- data dependencies;
- state mutations;
- error branches;
- side effects;
- ordering constraints;
- planning implications.

Do not paste an unfiltered graph dump.

## 6. Proposed Changes

For every proposed change include:

- file;
- symbol;
- exact responsibility;
- intended behavioural change;
- dependencies;
- constraints;
- implementation notes.

## 7. Implementation Sequence

Provide an ordered sequence of implementation steps.

Each step must be independently actionable.

## 8. Test Strategy

Describe:

- tests to add;
- tests to update;
- edge cases;
- failure paths;
- regression coverage;
- integration boundaries;
- relevant verification commands.

## 9. Risk and Impact Analysis

Include:

- high-risk symbols;
- downstream consumers;
- compatibility concerns;
- performance concerns;
- concurrency or transaction risks;
- migration risks;
- observability requirements.

## 10. Files Expected to Change

| File | Symbols | Reason |
|---|---|---|

## 11. Reusable Implementation Context

The machine-readable context pack — see `context-pack.md`.

## 12. Assumptions and Open Questions

Clearly separate assumptions from confirmed facts.

## 13. Definition of Done

Concrete, testable completion criteria.
```

Composition notes:

- §2/§5 quote source excerpts at most `max_snippet_lines` (30) lines each, and
  only when the excerpt carries the argument.
- §4 findings each name the tool call they came from (tool + key args), plus a
  one-line quote of the result when the plan leans on it — that is what makes
  a tool claim auditable later. Stale-index or fallback-mode findings are
  labelled as such.
- §6 changes may only name symbols the ledger marks `source_verified`.
- §7 steps are ordered by dependency and independently actionable — an
  executor can stop after any step with the tree still coherent.
- §8 names real, located test files for updates; new tests get concrete
  scenario lists (input → action → expected outcome). Verification commands
  must exist AND be runnable: prefer the npm/CI script form that carries its
  prerequisites (pre-hooks, builds) over invoking underlying binaries directly.
- §9 must account for every direct (depth-1) dependent the impact pass
  reported.
