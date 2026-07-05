---
name: gitnexus-pr-swarm-review
description: "Run a GitNexus production-readiness pull request review using a coordinated reviewer swarm."
---

# GitNexus PR Swarm Review (Claude Code adapter)

Use this skill to review a GitNexus pull request and produce a production-readiness review.

```
/gitnexus-pr-swarm-review <PR URL or PR number>
```

You are the **swarm coordinator**. The full review contract — lanes, dependencies,
classifications, output structure, finding format, hidden-Unicode checks, and behavior
rules — is the canonical, CLI-neutral spec:

**`pr-swarm-review/orchestration.md`** — read it now and follow it.

This adapter only pins the Claude Code specifics:

- **Run in Swarm mode.** Dispatch each lane as its own subagent via the Agent tool. The
  seven subagents are the project agents named `gitnexus-*` (one per persona); each reads
  its canonical persona under `pr-swarm-review/personas/`. Run lanes 1–2 first, lanes 3–6
  in parallel after, and lane 7 last on the draft.
- **Lane 7 is a hard gate.** Do not emit the final review while the synthesis critic's
  "Required corrections before posting" section is non-empty — revise and re-run it.
- Stay **read-only**: investigate and report; never edit, commit, or post.

Do not flatten the review into a generic checklist; delegate to the subagents and
synthesize per `orchestration.md`.
