# GitNexus PR Reviewer Swarm — Claude Code adapter

This is the **Claude Code** entrypoint for the cross-CLI GitNexus PR reviewer swarm. The
review logic itself is CLI-neutral and lives in **[`pr-swarm-review/`](../pr-swarm-review/README.md)**
— that README is the canonical guide and covers every CLI (Claude Code, Gemini, Copilot,
Cursor, Codex, and any AGENTS.md-aware agent).

## Invocation (Claude Code)

```
/gitnexus-pr-swarm-review <PR URL or PR number>
```

Runs in **Swarm mode**: the coordinator skill dispatches the seven `gitnexus-*` subagents in
parallel (lanes 1–2 first, 3–6 in parallel, lane 7 last as a hard gate).

## Files in this adapter

| File | Role |
|------|------|
| `.claude/skills/gitnexus-pr-swarm-review/SKILL.md` | Coordinator — runs Swarm mode per `pr-swarm-review/orchestration.md` |
| `.claude/agents/gitnexus-*.md` | Seven thin subagent wrappers; each reads its canonical persona in `pr-swarm-review/personas/` |

Each subagent keeps valid Claude Code frontmatter (model, tools, etc.); the mechanical
verifier lanes (`test-ci-verifier`, `branch-hygiene-reviewer`) run on Haiku, the analytical
lanes on Sonnet.

## Key properties

- **Read-only.** Tools limited to Read/Grep/Glob/Bash, and every persona enforces an
  explicit permitted/prohibited Bash list. No agent edits files, commits, or posts.
- **Evidence-grounded**; **missing visibility becomes verification work**; **manually invoked.**

## Editing

Edit review behavior in the canonical files under `pr-swarm-review/` (orchestration +
personas), **not** in these wrappers. After adding or editing files in `.claude/agents/`,
restart Claude Code so it reloads the agent definitions.

## Relationship to `/gitnexus-pr-review`

Coexists with the single-agent `/gitnexus-pr-review` skill (a linear checklist using GitNexus
MCP tools). This swarm is the multi-persona deep production-readiness review.
