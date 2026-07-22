---
name: gitnexus-lfg
description: "Use when the user wants the GitNexus engineering pipeline run end-to-end on a task: gitnexus-plan (plan depth chosen up front), a blocking gate to execute with gitnexus-work or stop, finishing with a gitnexus-review of the result. Examples: \"/gitnexus-lfg Add retry support to the ingestion pipeline\", \"run the gitnexus pipeline on this\", \"plan, build and review this feature\"."
---

# gitnexus-lfg — plan → gate → work → review

Thin orchestrator over three existing skills. It adds no engineering logic of
its own — it sequences `gitnexus-plan`, `gitnexus-work`, and
`gitnexus-review`, with the user deciding at the plan gate. Run every lane
by actually invoking the named skill (read its SKILL.md and follow it);
never inline a summary of what the skill would have done.

```
/gitnexus-lfg <task description>
/gitnexus-lfg docs/plans/<existing-plan>.md    # skip lane 1, start at the gate
```

## Lane 1 — Plan

**Boundary triage first.** If the task is plainly below the planning
boundary — trivial or small-bounded work an agent finishes in well under ~35
turns (the measured regime where a planning pass costs more than it returns;
measured in the GitNexus repository's `eval/workflow_bench/`) — say so and
offer `gitnexus-work` direct mode as an alternative to the full pipeline
before spending the plan lane. Honor the user's choice.

The threshold is a promoted benchmark policy measured offline, not a
timeless heuristic — never self-edit it from a live task. Its re-evaluation
governance lives in this skill's README.

Otherwise invoke `gitnexus-plan` with the task (knob overrides pass through
verbatim; `gitnexus-plan` owns the up-front depth question — never ask it
again here). If the input is already a plan file path, skip to Lane 2. The
plan lands in `docs/plans/` — record its path; every later lane consumes it.

## Lane 2 — The plan gate (user choice, blocking)

Present the plan's chat summary (objective, proposed changes, sequence, top
risks, open questions, plan path), then ask the user — as a blocking
question (`AskUserQuestion` in Claude Code; a numbered list in chat on CLIs
without a blocking tool):

1. **Proceed to work** — continue to Lane 3.
2. **Stop here** — the plan file is the deliverable; end the pipeline.

Depth was the user's up-front choice in Lane 1, so deepening is not offered
by default — but honor an explicit request for it at the gate: run
`gitnexus-plan` Deepen mode on the plan file and return here with the
strengthened plan, as many times as the user asks. Do not proceed past the
gate without an explicit choice — the gate is the pipeline's only checkpoint
and exists precisely because execution is expensive to unwind.

**Headless / non-interactive runs:** no one can answer the gate, so end the
pipeline after Lane 1 — the plan file is the deliverable (gate option 2) —
and say so in the final report. Never auto-proceed to execution.

## Lane 3 — Work

Invoke `gitnexus-work` with the plan path. It re-anchors the plan at HEAD,
executes the Implementation Sequence as verified atomic commits, refreshes
the knowledge graph when done (its Phase 4), and reports deviations. If it routes back for re-planning (structural drift), run the
Deepen pass and return to the Lane 2 gate rather than pushing through.

## Lane 4 — Review

Invoke `gitnexus-review` on the completed work. Pass an open PR URL/number
when one exists; otherwise pass the current branch. The review skill owns
target resolution, exact-SHA checkout/index alignment, and merge-base
selection. Do not duplicate that logic here. If work left local changes,
pass `local` as a second, separately labeled review surface.

Surface the review verdict and findings to the user. Findings the user
wants fixed: those within `gitnexus-work`'s direct-mode bounds (1–2 files,
no architectural decisions) → hand to `gitnexus-work` direct mode; anything
larger → offer the plan gate instead (Deepen the plan with the findings, or
stop). Then re-run this lane's review once. On that re-run, do not start
another fix cycle even if findings remain — report them and point the user
at `/gitnexus-work` (or the plan gate) to continue deliberately.

## Final report

One message: plan path, deepen cycles run, commits produced, verification
status, review verdict with unresolved findings, and what (if anything) was
explicitly left undone. The pipeline does not push or open a PR on its own —
offer both as next steps.
