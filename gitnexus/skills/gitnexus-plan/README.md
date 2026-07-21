# gitnexus-plan — implementation-ready engineering plans

Generates deep, implementation-ready engineering plans by combining GitNexus
repository intelligence, statement-level Program Dependence Graph analysis,
and the agent's native targeted source verification.

## Invocation

| CLI                           | How to invoke                                                                                          | Adapter file                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| **Claude Code**               | `/gitnexus-plan <task>`                                                                                | `.claude/skills/gitnexus-plan/SKILL.md`        |
| **Codex CLI**                 | Ask: "run gitnexus-plan for <task>" (Codex reads `AGENTS.md`) — or install the user-level prompt below | `AGENTS.md` § Engineering planning & execution |
| **Any AGENTS.md-aware agent** | Ask it to "read `.claude/skills/gitnexus-plan/SKILL.md` and follow it for <task>"                      | `AGENTS.md` § Engineering planning & execution |

```
/gitnexus-plan Add retry support to the ingestion pipeline
/gitnexus-plan Fix the stale warm-cache invalidation bug in exportedTypeMap
/gitnexus-plan depth:deep impact_depth:3 Migrate the emit phase to streaming COPY
```

Output: `docs/plans/YYYY-MM-DD-gitnexus-plan-<slug>.md` — a 13-section plan whose
section 11 is a machine-readable **implementation context pack** that a
follow-up agent can consume without re-investigating the repository. Compact
and full packs both include versioned evidence provenance: a canonical global
dirty digest and a sorted, per-layer cited-path manifest. An npm-dependency-free,
versioned Node helper shared byte-for-byte with `gitnexus-work` is the only
supported serializer, so planner and executor hash identical bytes. The same
helper is the only supported existing-plan reader and plan writer. Its
descriptor-anchored `read-plan` receipt binds the canonical path, exact base64
bytes, and SHA-256 digest before Deepen or execution. The writer accepts a repo-relative
`docs/plans/<date>-gitnexus-plan-<slug>.md` destination, rejects symlink
traversal and accidental replacement, and publishes the verified UTF-8
document through a descriptor-anchored atomic no-replace move. Deepen first
requires the exact canonical path and digest from one read receipt, preserves
the prior plan in a verified Git-admin backup, and also publishes without replacement. A safe read/write
failure blocks the operation; there is no
external-output or read-only-checkout fallback.

### Codex (user-level install)

Codex discovers SKILL.md skills from `~/.agents/skills/` (the same path the
other `gitnexus-*` skills install to). To make this skill auto-discoverable in
every Codex session:

```
cp -r .claude/skills/gitnexus-plan ~/.agents/skills/gitnexus-plan
```

Codex prompts are user-level only (not repo-shareable). Optionally, for an
explicit `/gitnexus-plan` slash command, also create
`~/.codex/prompts/gitnexus-plan.md`:

```markdown
---
description: Implementation-ready engineering plan via GitNexus + PDG + source verification
argument-hint: <task description>
---

Use the gitnexus-plan skill for: $ARGUMENTS

Read `~/.agents/skills/gitnexus-plan/SKILL.md` (if this repo has its own copy at
`.claude/skills/gitnexus-plan/SKILL.md`, prefer that one) and follow its phases in
order, loading its `references/` files at the phases that call for them. Planning
only — never edit code; the only repo file you write is the plan document.
```

## Architecture note: how GitNexus and the agent interact

Three layers, strictly ordered:

1. **GitNexus navigates** (`query` → `context` → `impact`/`trace` →
   `cypher` last-resort). The graph answers _where to look_ and _what is
   connected_: execution flows, callers/callees, blast radius, related tests.
   Every call must answer a named planning question.
2. **PDG constrains** (`pdg_query` controls/flows, `impact {mode:"pdg",
direction, line}` statement slices, `explain` for taint). The
   statement-level layers
   answer _what gates and feeds the behavior_ inside the few functions the
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
20 related by default), pins dirty working-tree evidence as well as HEAD, and
uses progressive disclosure to keep the big schemas out of context until the
phase that needs them.

## Files

| File                                | Purpose                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------- |
| `SKILL.md`                          | The skill: phases 0–5, hard rules, config, fallback                                   |
| `references/pdg-slice.md`           | PDG slice construction: tools, inclusion criteria, schema, security/performance modes |
| `references/context-ledger.md`      | Ledger schema + anti-reread rules                                                     |
| `references/plan-template.md`       | The 13-section plan document template                                                 |
| `references/context-pack.md`        | Implementation context pack schema + stability contract                               |
| `references/evidence-provenance.md` | Versioned byte contract for dirty-tree evidence                                       |
| `scripts/evidence-provenance.mjs`   | Snapshot serializer plus descriptor-anchored plan reader/writer                       |

## Requirements and graceful degradation

- Requires a GitNexus index; statement-level sections additionally require the
  `--pdg` layers.
- Freshness is a gate, priced by category: full-plan categories (refactor,
  security, performance, concurrency, architecture) default to
  `freshness: strict` — a stale index (or missing PDG layer) is refreshed once with
  `analyze --index-only [--pdg]` — run via `node .gitnexus/run.cjs` when the
  project has one, else the installed `gitnexus` CLI
  (`npm install -g gitnexus`), else `npx gitnexus` — before the graph is relied
  on, but only when that runner's provenance is known-current.
  Compact-plan categories default to `accept` (source-weighted, refresh only
  if a graph claim becomes load-bearing). `--index-only` touches only the
  `.gitnexus` store, never repo files. Stale analyzer provenance is a
  disclosed **source-weighted limitation**: planning does not rebuild analyzer
  output, and it does not use that graph for load-bearing claims.
- PDG layer still unavailable after that → the plan says so and skips
  statement-level claims (never reconstructs fake edges).
- No GitNexus at all → fallback mode: targeted grep/read exploration, findings
  labelled **source-derived**, with a recommendation to index.
- Reading or publishing a plan requires Linux `/proc/self/fd`, `O_DIRECTORY`,
  and `O_NOFOLLOW`; publication also requires a validated absolute Python 3
  PATH candidate with libc `renameat2(RENAME_NOREPLACE)` support, a
  writable target repository, and a shared filesystem for the plan and
  Git-admin vault. The writer fails closed when those guarantees are
  unavailable; it never redirects the plan elsewhere.

## Limitations

- `pdg_query` is intra-procedural; cross-function flow comes from `explain`
  (taint) or `impact {mode:"pdg"}` inter-procedural reach.
- The skill is planning-only by contract: the only repository file it writes
  is the plan document, and the only other state it may touch is the
  `.gitnexus` index store for a freshness refresh. It must not build
  analyzer `dist/` output or mutate source, tests, configuration, benchmark,
  or evaluation files. Instruction feedback is chat-only.
