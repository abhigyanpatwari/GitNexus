# gitnexus-lfg — plan → (deepen | work) → review

Thin pipeline orchestrator over three existing skills: `gitnexus-plan`
produces the plan, the user chooses at a blocking gate to deepen it (as many
cycles as they want) or proceed, `gitnexus-work` executes it as verified
atomic commits, and `gitnexus-pr-review` reviews the result (the open PR if
one exists, else the branch diff against the default branch). One bounded
fix cycle for review findings, then a final report. It never pushes or opens
a PR on its own.

## Invocation

| CLI | How to invoke |
|-----|---------------|
| **Claude Code** | `/gitnexus-lfg <task description>` or `/gitnexus-lfg docs/plans/<plan>.md` |
| **Codex CLI** | Ask: "run the gitnexus pipeline on <task>" (Codex reads `AGENTS.md`), or install the skill user-level (below) |

### Codex (user-level install)

```
cp -r .claude/skills/gitnexus-lfg ~/.agents/skills/gitnexus-lfg
```

Optionally, for an explicit slash command, create
`~/.codex/prompts/gitnexus-lfg.md`:

```markdown
---
description: GitNexus pipeline — plan, user gate (deepen or execute), work, PR review
argument-hint: <task description or plan path>
---
Use the gitnexus-lfg skill for: $ARGUMENTS

Read `~/.agents/skills/gitnexus-lfg/SKILL.md` (prefer the repo copy at
`.claude/skills/gitnexus-lfg/SKILL.md` when present) and follow its lanes in
order, invoking the real gitnexus-plan / gitnexus-work / gitnexus-pr-review
skills for each lane. Stop at the plan gate for the user's choice.
```

## The three lanes

| Lane | Skill | Gate |
|------|-------|------|
| Plan | `gitnexus-plan` (`.claude/skills/gitnexus-plan/`) | Blocking user choice: deepen / proceed / stop |
| Work | `gitnexus-work` (`.claude/skills/gitnexus-work/`) | Structural drift routes back to the plan gate |
| Review | `gitnexus-pr-review` (`.claude/skills/gitnexus/gitnexus-pr-review/`) | One fix cycle max, then report |
