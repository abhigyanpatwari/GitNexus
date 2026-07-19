# gitnexus-work — execute a gitnexus-plan

The executor counterpart to `gitnexus-plan`: consumes a plan's §11
implementation context pack and ships it as verified atomic commits, with
GitNexus discipline baked in — `impact` before every symbol edit,
`detect_changes` before every commit, tests from the plan's scenarios, and a
two-layer drift check that re-anchors both commit and dirty working-tree
evidence before relying on it.

## Invocation

| CLI             | How to invoke                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| **Claude Code** | `/gitnexus-work [plan path]` (blank → newest `docs/plans/*gitnexus-plan*.md` in this repo)                 |
| **Codex CLI**   | Ask: "run gitnexus-work on <plan path>" (Codex reads `AGENTS.md`), or install the skill user-level (below) |

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
- `evidence_provenance` is mandatory in compact and full plans. Work always
  loads the plan only through its byte-identical helper's descriptor-anchored
  `read-plan` command, consumes the exact base64 bytes from that receipt, and
  recomputes the global dirty digest and sorted cited-path manifest even at
  the same HEAD. Schema-2 `generated_plan_path` is a normalized
  repo-relative `docs/plans/<date>-gitnexus-plan-<slug>.md` path; external,
  escaping, or differently scoped values are invalid. It must also equal the
  read receipt's canonical target-repo-relative path byte-for-byte.
  Missing or schema-1 evidence re-anchors under schema 2.
- The plan is never mutated; deviations are recorded in commit messages and
  the final report.
- Changed citations are re-read, new uncited dirty paths are assessed for
  scope, and unreadable evidence blocks dependent work. Deepen is reserved
  for drift that invalidates scope, requirements, a key technical decision,
  or the planned seam.

## Graph freshness

One fail-closed **Build-current/index-current procedure** runs before every
graph-dependent impact query and again before final graph verification. It
compares indexed commit and the schema-4 runner identity (including its
`gitnexus-analyzer-dependency-runtime-v4` dependency payload/runtime digest),
requires no incomplete-index recovery markers, invalidates on
relationship-affecting committed or uncommitted edits, builds and invokes the
current local analyzer with PDG indexing when needed, and treats timestamps
only as a conservative trigger. Build, refresh, or identity failures block
impact and completion; the executor never falls back to a stale runner.
