---
name: gitnexus-lfg
description: "Use when the user wants the GitNexus engineering pipeline run end-to-end on a task: gitnexus-plan, then their choice to deepen the plan or execute it with gitnexus-work, finishing with a gitnexus-pr-review of the result. Examples: \"/gitnexus-lfg Add retry support to the ingestion pipeline\", \"run the gitnexus pipeline on this\", \"plan, build and review this feature\"."
---

# gitnexus-lfg — plan → (deepen | work) → review

Thin orchestrator over three existing skills. It adds no engineering logic of
its own — it sequences `gitnexus-plan`, `gitnexus-work`, and
`gitnexus-pr-review`, with the user deciding at the plan gate. Run every lane
by actually invoking the named skill (read its SKILL.md and follow it);
never inline a summary of what the skill would have done.

```
/gitnexus-lfg <task description>
/gitnexus-lfg docs/plans/<existing-plan>.md    # skip lane 1, start at the gate
```

## Lane 1 — Plan

Invoke `gitnexus-plan` with the task (knob overrides pass through verbatim).
If the input is already a plan file path, skip to Lane 2. The plan lands in
`docs/plans/` — record its path; every later lane consumes it.

## Lane 2 — The plan gate (user choice, blocking)

Present the plan's chat summary (objective, proposed changes, sequence, top
risks, open questions, plan path), then ask the user — as a blocking
question (`AskUserQuestion` in Claude Code; a numbered list in chat on CLIs
without a blocking tool):

1. **Deepen the plan** — run `gitnexus-plan` Deepen mode on the plan file,
   then return to this gate with the strengthened plan.
2. **Proceed to work** — continue to Lane 3.
3. **Stop here** — the plan file is the deliverable; end the pipeline.

Loop on 1 as many times as the user asks. Do not proceed past the gate
without an explicit choice — the gate is the pipeline's only checkpoint and
exists precisely because execution is expensive to unwind.

## Lane 3 — Work

Invoke `gitnexus-work` with the plan path. It re-anchors the plan at HEAD,
executes the Implementation Sequence as verified atomic commits, and reports
deviations. If it routes back for re-planning (structural drift), run the
Deepen pass and return to the Lane 2 gate rather than pushing through.

## Lane 4 — Review

Invoke `gitnexus-pr-review` on the completed work:

- An open PR exists for the branch (`gh pr view`) → review that PR.
- No PR → review the branch diff against the default branch
  (`git diff <default>...HEAD` + `detect_changes {scope: "compare",
  base_ref: "<default>"}`), which the skill supports directly.

Surface the review verdict and findings to the user. Findings the user wants
fixed → hand them to `gitnexus-work` as a small bounded task (direct mode),
then re-run this lane once. Do not loop unbounded; after one fix cycle,
remaining findings are reported, not silently retried.

## Final report

One message: plan path, deepen cycles run, commits produced, verification
status, review verdict with unresolved findings, and what (if anything) was
explicitly left undone. The pipeline does not push or open a PR on its own —
offer both as next steps.
