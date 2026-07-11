# gitnexus-work — execute a gitnexus-plan

The executor counterpart to `gitnexus-plan`: consumes a plan's §11
implementation context pack and ships it as verified atomic commits, with
GitNexus discipline baked in — `impact` before every symbol edit,
`detect_changes` before every commit, tests from the plan's scenarios, and a
drift check that re-anchors the plan's evidence at current HEAD before
relying on it.

## Invocation

| CLI | How to invoke |
|-----|---------------|
| **Claude Code** | `/gitnexus-work [plan path]` (blank → newest `docs/plans/*.md`) |
| **Codex CLI** | Ask: "run gitnexus-work on <plan path>" (Codex reads `AGENTS.md`), or install the skill user-level (below) |

### Codex (user-level install)

```
cp -r .claude/skills/gitnexus-work ~/.agents/skills/gitnexus-work
```

Optionally, for an explicit slash command, create
`~/.codex/prompts/gitnexus-work.md`:

```markdown
---
description: Execute a gitnexus-plan as verified atomic commits (impact-checked, detect_changes-gated)
argument-hint: <plan path, or blank for the newest plan>
---
Use the gitnexus-work skill for: $ARGUMENTS

Read `~/.agents/skills/gitnexus-work/SKILL.md` (prefer the repo copy at
`.claude/skills/gitnexus-work/SKILL.md` when present) and follow its phases in
order. This skill edits code; honor its impact-before-edit and
detect_changes-before-commit rules without exception.
```

## Contract with gitnexus-plan

- Input: the 13-section plan document; §11's `implementation_context` fields
  are the machine-readable interface (see
  `../gitnexus-plan/references/context-pack.md` for the stability contract).
- The plan is never mutated; deviations are recorded in commit messages and
  the final report.
- Material drift or failed assumptions route back to `gitnexus-plan` Deepen
  mode instead of being coded around.
