# Plan document template

Two forms, chosen by the Phase 0 category (`form` knob overrides): **compact**
for narrow/default work, **full** for deep work. Repo-relative paths for all
repo artifacts in both.

## Compact form

Same evidence header, then only the load-bearing sections — keep the §
numbers in the headings so `gitnexus-work`'s § references resolve:

```markdown
# GitNexus Engineering Plan

> Task: <one line>
> Evidence verified at commit <sha>; GitNexus index <...>.
> Evidence provenance schema 2; global dirty digest <sha256>; cited-path manifest <count> sorted entries; exact generated plan path excluded.

## Objective (§1)

## Current Behaviour (§2–3) — ≤10 lines, architecture folded in

## Findings (§4–5) — only load-bearing, each tagged + tool-named

## Proposed Changes (§6)

## Implementation Sequence (§7) — risks inline as step notes

## Test Strategy (§8)

## Implementation Context (§11) — the mini-pack (see context-pack.md)

## Assumptions and Open Questions (§12)

## Definition of Done (§13)
```

Hard cap: **80 lines excluding the §11 pack**. Anything cut that still
matters becomes one line in §12 — never padded prose. A compact plan that
outgrows the cap is a signal the task was misclassified: reclassify to full
rather than overflowing.

## Full form

Fill every section below. If a section is genuinely empty for this task
(e.g. no PDG layer indexed), keep the heading and state why in one line —
never silently drop it.

**Claim tagging.** Tag every load-bearing claim with its evidence class:
`[verified]` (source-read at the pinned commit), `[graph]` (GitNexus/PDG
output, not source-confirmed), `[inferred]` (evidence-backed reasoning),
`[assumed]` (unverified — must also appear in §12). Untagged prose is
narrative, not evidence.

```markdown
# GitNexus Engineering Plan

> Task: <one line>
> Evidence verified at commit <HEAD sha>; GitNexus index <fresh | refreshed this session (--index-only [--pdg]) | N commits behind, refresh skipped: <reason> | not used>.
> Evidence provenance schema 2; global dirty digest <sha256>; cited-path manifest <count> sorted entries; exact generated plan path excluded.

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
| ---- | ------- | ------ |

## 11. Reusable Implementation Context

The machine-readable context pack — see `context-pack.md`. Its mandatory
`evidence_provenance` field carries the full pinned commit, canonical
repository-wide dirty digest, and sorted cited-path manifest.

## 12. Assumptions and Open Questions

Clearly separate assumptions from confirmed facts. Explicitly-deferred
follow-up suggestions (adjacent work the task didn't ask for) land here too.

## 13. Definition of Done

Concrete, testable completion criteria.
```

Composition notes:

- Immediately before composition, emit `evidence_provenance.schema_version`,
  the full HEAD commit, the canonical `global_dirty_digest`, and the
  `cited_path_manifest` sorted by normalized repo-relative path. Include
  object kinds, rename endpoints, and HEAD/index/worktree/untracked layer
  digests. Exclude only the generated plan path from the global digest.
- Invoke `scripts/evidence-provenance.mjs` per `evidence-provenance.md` and
  copy its schema-2 JSON; never recreate canonical records in prose or shell.
- Publish the fully composed UTF-8 plan only with that helper's `write-plan`
  command. Initial planning must not replace an existing file; Deepen rewrites
  the same repo-relative path with `write-plan --replace
--expected-plan-path <path-from-read-plan>
--expected-plan-digest <digest-from-read-plan>`, which preserves the prior
  plan in the receipt's `prior_plan_backup_git_path`. Both expected values must
  come from the same receipt. Deepen must load and bind that canonical path and
  those original bytes through `read-plan` first. Snapshot, read, and
  publication must pass the same strict generated-plan filename/date validator.
- §2/§5 quote source excerpts at most `max_snippet_lines` (30) lines each, and
  only when the excerpt carries the argument.
- §4 findings each name the tool call they came from (tool + key args), plus a
  one-line quote of the result when the plan leans on it — that is what makes
  a tool claim auditable later. Stale-index or fallback-mode findings are
  labelled as such.
- §6 changes may only name symbols the ledger marks `source_verified`.
- §7 steps are ordered by dependency and independently actionable — an
  executor can stop after any step with the tree still coherent. Steps that
  change output guarded by fingerprints, goldens, or recorded baselines
  regenerate those artifacts ONCE, in the final step of the sequence — CI
  judges only the tip, and per-step refreshes churn every intermediate
  commit and re-drift as later steps land.
- §8 names real, located test files for updates; new tests get concrete
  scenario lists (input → action → expected outcome). Verification commands
  must exist AND be runnable: prefer the npm/CI script form that carries its
  prerequisites (pre-hooks, builds) over invoking underlying binaries directly.
- §9 must account for every direct (depth-1) dependent the impact pass
  reported.
