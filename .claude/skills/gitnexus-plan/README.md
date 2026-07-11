# gitnexus-plan — implementation-ready engineering plans

Generates deep, implementation-ready engineering plans by combining GitNexus
repository intelligence, statement-level Program Dependence Graph analysis,
and the agent's native targeted source verification.

## Invocation

| CLI | How to invoke | Adapter file |
|-----|---------------|--------------|
| **Claude Code** | `/gitnexus-plan <task>` | `.claude/skills/gitnexus-plan/SKILL.md` |
| **Codex CLI** | Ask: "run gitnexus-plan for <task>" (Codex reads `AGENTS.md`) — or install the user-level prompt below | `AGENTS.md` § Engineering planning |
| **Any AGENTS.md-aware agent** | Ask it to "read `.claude/skills/gitnexus-plan/SKILL.md` and follow it for <task>" | `AGENTS.md` § Engineering planning |

```
/gitnexus-plan Add retry support to the ingestion pipeline
/gitnexus-plan Fix the stale warm-cache invalidation bug in exportedTypeMap
/gitnexus-plan depth:deep impact_depth:3 Migrate the emit phase to streaming COPY
```

Output: `docs/plans/YYYY-MM-DD-gitnexus-plan-<slug>.md` — a 13-section plan whose
section 11 is a machine-readable **implementation context pack** that a
follow-up agent can consume without re-investigating the repository.

### Codex (optional user-level slash command)

Codex prompts are user-level only (not repo-shareable). To get a
`/gitnexus-plan` slash command, create `~/.codex/prompts/gitnexus-plan.md`:

```markdown
---
description: Implementation-ready engineering plan via GitNexus + PDG + source verification
argument-hint: <task description>
---
Read `.claude/skills/gitnexus-plan/SKILL.md` in this repo and follow it for: $ARGUMENTS
Load its references/ files at the phases that call for them. Planning only — never
edit code; the only repo file you write is the plan document.
```

## Architecture note: how GitNexus and the agent interact

Three layers, strictly ordered:

1. **GitNexus navigates** (`query` → `context` → `impact`/`trace` →
   `cypher` last-resort). The graph answers *where to look* and *what is
   connected*: execution flows, callers/callees, blast radius, related tests.
   Every call must answer a named planning question.
2. **PDG constrains** (`pdg_query` controls/flows, `impact {mode:"pdg",
   direction, line}` statement slices, `explain` for taint). The
   statement-level layers
   answer *what gates and feeds the behavior* inside the few functions the
   change centers on. Results are filtered into a bounded slice
   (`references/pdg-slice.md`), never dumped.
3. **The agent verifies** (targeted line-range reads). Current source is
   authoritative; graph results are navigation hints until verified. On
   disagreement: trust source, record the discrepancy, recommend re-indexing.

Token efficiency comes from the **context ledger**
(`references/context-ledger.md`): every query and read is recorded with the
question it answered, and nothing is re-fetched unless the source changed, a
contradiction surfaced, or one of the ledger's defined escalations applies
(summary→detail drill-down, ambiguity narrowing, a changed parameter answering
a new question). The ledger also enforces symbol budgets (5 primary /
20 related by default), and progressive disclosure keeps the big schemas out
of context until the phase that needs them.

## Files

| File | Purpose |
| --- | --- |
| `SKILL.md` | The skill: phases 0–5, hard rules, config, fallback |
| `references/pdg-slice.md` | PDG slice construction: tools, inclusion criteria, schema, security/performance modes |
| `references/context-ledger.md` | Ledger schema + anti-reread rules |
| `references/plan-template.md` | The 13-section plan document template |
| `references/context-pack.md` | Implementation context pack schema + stability contract |

## Requirements and graceful degradation

- Requires a GitNexus index (`node .gitnexus/run.cjs analyze`); statement-level
  sections additionally require `analyze --pdg`.
- No PDG layer → the plan says so and skips statement-level claims (never
  reconstructs fake edges).
- No GitNexus at all → fallback mode: targeted grep/read exploration, findings
  labelled **source-derived**, with a recommendation to index.

## Limitations

- `pdg_query` is intra-procedural; cross-function flow comes from `explain`
  (taint) or `impact {mode:"pdg"}` inter-procedural reach.
- The skill is planning-only by contract: the only repository file it writes
  is the plan document — it will not fix what it finds.
