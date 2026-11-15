---
name: pr-tri-review
description: "Review a GitHub PR with two engines: Codex coordinates and runs the GitNexus PR swarm (Solo mode), ce-code-review (report-only) and the adversarial review; Claude supplies the other legs through headless `claude -p`; a fresh Codex thread synthesizes, a Claude critic gates, and one inline-comment review is posted. Use for a thorough, high-signal PR review that ends with inline comments on the PR."
argument-hint: "<PR number or URL>"
---

# PR Tri-Review, coordinated from Codex

The canonical procedure is one file shared by both engines:

`/workspace/.claude/skills/pr-tri-review/SKILL.md`

Read it in full now and follow it for: $ARGUMENTS

You are running in **Codex**, so you are the home engine and **Claude is the other leg**. That file's phases are written for a Claude coordinator; its section **"Which engine is home"** gives the role swap and the exact commands for your side (the `claude -p` smoke test, the prior-context recall, legs C1 and C2, the synthesis thread, the Claude critic). Where that section and a phase disagree, the section wins for you.

Three things that are easy to get wrong from here:

- Launch every `claude -p` from `/workspace`, never from the PR worktree: a headless Claude session loads settings and hooks from its working directory without asking.
- Start every Claude prompt with the line `[independent-lane]` and set `SIDE_PANELS_BOARD=off`, so no lane is handed another lane's result.
- Run every Claude leg with `--settings '{"disableAllHooks":true}'`: otherwise session hooks open it with a memory timeline and output-style modes that a review lane must not have.
- If you have claude-mem tools yourself, do the prior-context recall directly; your own session-start memory context is leads to verify, never evidence.
- Artifacts are named for the engine that wrote them (`claude-*.md`, `codex-*.md`), each with a `<name>.exit` marker. If the smoke test fails, the review is Codex-only and the digest must say so.
