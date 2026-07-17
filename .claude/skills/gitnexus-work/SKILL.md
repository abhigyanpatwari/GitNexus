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
/gitnexus-work                    # newest docs/plans/*gitnexus-plan*.md here
/gitnexus-work <small task text>  # direct mode, see Input triage
```

## Input triage

- **Plan path** (or blank → the newest `docs/plans/*gitnexus-plan*.md` under
  the current repo root; plans written elsewhere — `out:` override, other
  target repo — must be passed by explicit path): the normal mode; continue
  to Phase 1. If Phase 1's pre-completed check finds every §7 step of that
  newest plan already landed, stop and ask instead of re-executing it.
- **Bare task text**: trivial and bounded (1–2 files, no architectural
  decisions) → implement directly with the same discipline: `impact` before
  every symbol edit, minimal change, tests when behavior changes,
  verification commands taken from the repo's own scripts (package.json /
  CI), `detect_changes` before every commit, and the Phase 4
  knowledge-graph refresh after the final commit. Anything larger → recommend
  running `/gitnexus-plan` first; honor the user's choice if they decline.

## Phase 1 — Load and re-anchor the plan

1. Read the plan document completely. It is a decision artifact, not a
   script: scope boundaries and `avoid` entries bind you; exact code is
   yours to write. Never edit the plan body.
2. Parse the §11 `implementation_context` pack: `acceptance_criteria`,
   `primary_symbols`, `related_symbols`, `files_to_modify`,
   `execution_path`, `pdg_constraints`, `architectural_patterns`, `tests`,
   `verification_commands`, `risks`, `assumptions`, `open_questions`, `avoid`.
   Compact plans carry the mini-pack subset — absent optional fields are
   empty, not errors.
3. **Drift check.** The plan header pins the commit its evidence was
   verified at. **HEAD equals the pin → every citation is still verified:
   skip all re-reading and go straight to work — that is the pin's entire
   point.** If HEAD has moved since, diff the pinned commit against HEAD
   for **every file the pack cites** — `files_to_modify`,
   `primary_symbols`/`related_symbols` files, files named in
   `pdg_constraints.affected_statements`, `architectural_patterns[]`
   example locations, `tests[].file` — untouched files keep their verified
   status; changed files get their cited ranges re-read before you rely on
   them. Material drift (a planned seam no longer exists) → stop and send
   the plan back through `gitnexus-plan` Deepen mode.
4. **Re-verify `assumptions` cheaply** (each one names what to check).
   A failed assumption is a stop-and-replan signal for the steps that
   depend on it, not something to code around silently.
5. Note `open_questions` — if one blocks a step and the answer materially
   changes the work, ask the user before that step, not after.
6. **Pre-completed check.** If commits for this plan already exist on the
   branch (a prior partial run, or a post-route-back Deepen cycle), verify
   which §7 steps have landed at HEAD: those are skipped and reported as
   pre-completed, and execution resumes at the first unlanded step. All
   steps landed → report that and stop.

## Phase 2 — Environment

- On the default branch → create a feature branch named from the plan slug.
  On a feature branch already → stay only if it is meaningful *for this
  plan* (name matches the plan slug, or the user confirms); otherwise
  branch from here with the slug name.
- If the plan document is not yet committed, commit it now
  (`docs(plans): add <slug> plan`) — the plan travels with the work it
  drives, and the final review diff then includes it.
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
   or weaken an assertion to make a step pass. Prove a new regression test
   discriminates: when the failure mode is subtle, run it once against the
   pre-fix tree (write the test before the fix, or stash the fix) and watch
   it fail — a test that passes both ways pins nothing.
5. **Verify.** Run the step-relevant `verification_commands` (they carry
   their build prerequisites; use them as written). If any part of the
   change executes from build output — worker entrypoints, dist-shipped
   CLIs, bundled assets — rebuild that output before every verification
   run: a pass or fail against outdated build output is noise, and "the
   fix doesn't work" is more often "the fix never loaded".
6. **Commit atomically.** `detect_changes {scope: "staged"}` before every
   commit to confirm only the expected symbols and flows are affected
   (repo mandate); then one conventional commit per step. Run stage →
   `detect_changes` → commit as one unbroken sequence from the repository
   root — interleaving other work between the gate and the commit is how
   the gate gets skipped. Unexpected
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
2. Walk plan §13 (Definition of Done) and the pack's `acceptance_criteria`
   item by item; anything unmet is either finished now or reported as
   explicitly unmet — never silently dropped.
3. **Refresh the knowledge graph.** The commits just changed the code the
   index describes; after the last commit has landed, run
   `analyze --index-only` via the resolved runner (`node .gitnexus/run.cjs`
   → installed `gitnexus` → `npx gitnexus`, the same ladder gitnexus-plan
   resolves), adding `--pdg` when the index carries the PDG layer (one
   `pdg_query` probe tells you). `--index-only` writes only the `.gitnexus`
   index store, never repo files, so the tree stays coherent — and the
   review lane and every later session query the finished work, not the
   pre-work graph. Skip only when no commit landed.
4. Report: steps completed, commits made, deviations from the plan (with
   why), assumptions that failed re-verification, DoD status, and anything
   deferred. Test failures are reported with their output, not smoothed
   over.

## Never

- Skip the Phase 3 gates: no symbol edit without `impact`, no commit without
  `detect_changes`.
- Expand scope beyond the plan — §12's deferred follow-ups stay deferred.
- Mutate the plan body (committing the file verbatim in Phase 2 is not
  mutation), weaken failing tests, or present unverified work as verified.

## Skill feedback (GitNexus repo only)

If this run exposed friction in this skill's own instructions — wrong or
missing guidance, a wasted tool budget, a phase that misrouted — and the repo
carries `eval/workflow_bench/`, append one JSON line to
`eval/workflow_bench/learnings.jsonl` (create the file if absent):
`{"skill": "gitnexus-work", "date": "YYYY-MM-DD", "task": "<one line>", "friction": "<one line>", "suggestion": "<one line>"}`.
Never edit this skill file itself from a live task: improvements go through
the offline candidate loop (`eval/workflow_bench/README.md` § Prompt and
skill evolution loop), where a candidate must beat the incumbent on the
paired benchmark before a human merges it.
