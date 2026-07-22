# gitnexus-lfg — plan → gate → work → review

Thin pipeline orchestrator over three existing skills: `gitnexus-plan`
produces the plan (asking up front how deep to go), the user chooses at a
blocking gate to proceed or stop (an explicit deepen request is still
honored), `gitnexus-work` executes it as verified atomic commits, and
`gitnexus-review` reviews the result (the open PR if one exists, else the
branch diff against the default branch). One bounded fix cycle for review
findings, then a final report. It never pushes or opens a PR on its own.

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
description: GitNexus pipeline — plan (depth asked up front), user gate, work, PR review
argument-hint: <task description or plan path>
---
Use the gitnexus-lfg skill for: $ARGUMENTS

Read `~/.agents/skills/gitnexus-lfg/SKILL.md` (prefer the repo copy at
`.claude/skills/gitnexus-lfg/SKILL.md` when present) and follow its lanes in
order, invoking the real gitnexus-plan / gitnexus-work / gitnexus-review
skills for each lane. Stop at the plan gate for the user's choice.
```

## The three lanes

| Lane | Skill | Gate |
|------|-------|------|
| Plan | `gitnexus-plan` (`.claude/skills/gitnexus-plan/`) | Depth asked up front; blocking gate: proceed / stop |
| Work | `gitnexus-work` (`.claude/skills/gitnexus-work/`) | Structural drift routes back to the plan gate |
| Review | `gitnexus-review` (`.claude/skills/gitnexus-review/`) | One fix cycle max, then report |

## Threshold governance (maintainers)

The Lane 1 planning boundary (~35 turns) is a promoted benchmark policy from
the GitNexus repository's `eval/workflow_bench/` paired candidate loop.
Re-evaluate it offline whenever the named model or tool harness changes, and
at least every 90 days; update the SKILL.md threshold only after the
deterministic promotion gate shows no quality regression. Reading agents
never self-edit it from a live task.
