---
name: gitnexus-work
description: "Use when executing an engineering plan produced by gitnexus-plan (or a small bounded task directly) — implements step by step with GitNexus impact checks before every symbol edit, tests from the plan's scenarios, and detect_changes gating every commit. Examples: \"/gitnexus-work docs/plans/2026-07-11-gitnexus-plan-ingestion-retry.md\", \"/gitnexus-work\" (latest plan), \"execute the plan\"."
---

# gitnexus-work — execute a gitnexus-plan

Execute an implementation plan produced by `gitnexus-plan`, shipping it as a
sequence of verified, atomic commits. The plan's section 11
(`implementation_context` pack) is the primary machine-readable input; the
prose sections are its rationale. This skill **does** edit code — it is the
executor counterpart to the planning-only `gitnexus-plan`.

```
/gitnexus-work <plan path>        # execute this plan
/gitnexus-work                    # execute the newest docs/plans/*.md
/gitnexus-work <small task text>  # direct mode, see Input triage
```

## Input triage

- **Plan path** (or blank → newest `docs/plans/*.md`): the normal mode;
  continue to Phase 1.
- **Bare task text**: trivial and bounded (1–2 files, no architectural
  decisions) → implement directly, still honoring the Execution discipline
  below. Anything larger → recommend running `/gitnexus-plan` first; honor
  the user's choice if they decline.

## Phase 1 — Load and re-anchor the plan

1. Read the plan document completely. It is a decision artifact, not a
   script: scope boundaries and `avoid` entries bind you; exact code is
   yours to write. Never edit the plan body.
2. Parse the §11 `implementation_context` pack: `files_to_modify`,
   `execution_path`, `pdg_constraints`, `architectural_patterns`, `tests`,
   `verification_commands`, `risks`, `assumptions`, `open_questions`, `avoid`.
3. **Drift check.** The plan header pins the commit its evidence was
   verified at. If HEAD has moved since, diff the pinned commit against HEAD
   for the pack's `files_to_modify` — untouched files keep their verified
   status; changed files get their cited ranges re-read before you rely on
   them. Material drift (a planned seam no longer exists) → stop and send
   the plan back through `gitnexus-plan` Deepen mode.
4. **Re-verify `assumptions` cheaply** (each one names what to check).
   A failed assumption is a stop-and-replan signal for the steps that
   depend on it, not something to code around silently.
5. Note `open_questions` — if one blocks a step and the answer materially
   changes the work, ask the user before that step, not after.

## Phase 2 — Environment

- On the default branch → create a feature branch named from the plan slug.
  Already on a meaningful feature branch → stay on it.
- Confirm the `verification_commands` from the pack actually run in this
  checkout (dependencies installed, builds present) before starting, not
  after the last step.

## Phase 3 — Execute the Implementation Sequence

Work through plan §7 step by step, in order. For each step:

1. **Impact before editing.** For every symbol the step modifies, run
   `impact {target, direction: "upstream"}` first and account for the
   direct (d=1) dependents. HIGH or CRITICAL risk → surface it to the user
   with the blast radius before proceeding (repo mandate — see AGENTS.md
   GitNexus rules).
2. **Honor the constraints.** `pdg_constraints` entries state ordering and
   dependence facts the change must preserve; `avoid` entries are hard
   prohibitions; `architectural_patterns` name the shape to mirror (read the
   example location before inventing one).
3. **Implement minimally.** The smallest change that completes the step,
   following the surrounding code's conventions.
4. **Test from the plan's scenarios.** Each `tests[]` scenario (input →
   action → expected outcome) becomes a real test in the named file. Add
   coverage the plan missed if the step's behavior demands it; never delete
   or weaken an assertion to make a step pass.
5. **Verify.** Run the step-relevant `verification_commands` (they carry
   their build prerequisites; use them as written).
6. **Commit atomically.** `detect_changes {scope: "staged"}` before every
   commit to confirm only the expected symbols and flows are affected
   (repo mandate); then one conventional commit per step. Unexpected
   affected flows → investigate before committing, not after.

Steps are independently actionable: after any commit the tree is coherent.
If a step reveals the plan is wrong, stop that step, re-verify the affected
claims at HEAD, and either adapt (small, in-scope deviation — record it in
the commit message and final summary) or route back to `gitnexus-plan`
Deepen mode (structural miss) — with a one-line ask to the user when the
choice isn't obvious.

## Phase 4 — Finish

1. Run the full `verification_commands` suite once, at the end, even if
   every step already passed individually.
2. Walk plan §13 (Definition of Done) item by item; anything unmet is
   either finished now or reported as explicitly unmet — never silently
   dropped.
3. Report: steps completed, commits made, deviations from the plan (with
   why), assumptions that failed re-verification, DoD status, and anything
   deferred. Test failures are reported with their output, not smoothed
   over.

## Never

- Edit a symbol without the Phase 3 impact check, or commit without
  `detect_changes`.
- Expand scope beyond the plan — §12's deferred follow-ups stay deferred.
- Mutate the plan document, weaken failing tests, or present unverified
  work as verified.
