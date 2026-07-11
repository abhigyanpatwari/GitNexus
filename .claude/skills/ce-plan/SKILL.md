---
name: ce-plan
description: "Use when you need a deep, implementation-ready engineering plan for a code change — built from GitNexus graph intelligence, statement-level PDG analysis, and targeted source verification, compact enough that an implementation agent can start without re-investigating. Examples: \"/ce-plan Add retry support to the ingestion pipeline\", \"/ce-plan Fix the stale warm-cache invalidation bug\", \"plan this change using the knowledge graph\"."
---

# ce-plan — Compound Engineering Plan

Produce an implementation-ready plan for an engineering task. GitNexus is the
navigation layer (where to look), statement-level PDG is the constraint layer
(what gates and feeds the behavior), Claude Code source reads are the
verification layer (what is actually true right now). The output is a plan
document plus a compact, machine-readable **implementation context pack** that
a follow-up agent (`ce-implement` or any executor) can consume without
repeating the investigation.

```
/ce-plan <task description>
/ce-plan impact_depth:3 depth:deep <task description>   # knob overrides, see Configuration
```

**This skill plans. It never implements.** Do not modify production code,
tests, or configuration while running it. The only file it writes is the plan
document.

## Hard rules

- **Ledger first.** Before every GitNexus call and every file read, check the
  context ledger (below). Never repeat a query or reread an unchanged range
  that already answered the same question.
- **Every graph query answers a named planning question.** Record the question
  and the conclusion in the ledger. No exploratory dredging.
- **Source beats graph.** The graph navigates; current source is authoritative.
  Verify before asserting (see Phase 4).
- **No fabrication.** Never invent symbols, filenames, test names, tool
  results, or PDG edges. Unknowns go to *Assumptions and Open Questions*.
- **Stop when you have enough.** Sufficient evidence ends exploration; plans
  do not improve monotonically with tokens spent.

## Phase 0 — Parse and classify

Restate the task as an interpreted goal plus acceptance criteria (open the
ledger with these). Classify it:

| Category | Depth posture |
| --- | --- |
| Bug fix (local) | Narrow: 1–2 primary symbols, impact depth 1–2 |
| Feature | Default knobs |
| Refactor / shared API change | Impact analysis mandatory, impact depth 3 |
| Performance | Default + performance PDG mode (see `references/pdg-slice.md`) |
| Security | Default + security PDG mode + `explain` taint findings |
| Dependency upgrade / migration | Impact + compatibility focus; PDG usually unnecessary |
| Concurrency / transactional | Control-flow and state-mutation focus in the PDG slice |
| Test improvement / docs | Narrowest: usually no impact or PDG pass |
| Architecture change / spike | Widest: clusters + processes resources first |

Raise a bounded-depth knob only when the change clearly crosses architectural
boundaries; say so in the plan when you do.

## Phase 1 — Anchor and freshness

1. Resolve the target repo: `list_repos` if in doubt, else the indexed repo
   covering the working directory. Pass `repo` explicitly on every call when
   more than one repo is indexed.
2. Read `gitnexus://repo/{name}/context` — codebase overview + staleness check.
   - Stale index → recommend `node .gitnexus/run.cjs analyze`, note the
     staleness in the plan's Assumptions, and continue with source
     verification weighted higher.
   - GitNexus unavailable entirely → switch to **Fallback mode** (below).
3. For architecture-scale tasks only, also read
   `gitnexus://repo/{name}/clusters` and `.../processes`.

## Phase 2 — Graph navigation ladder

Use the narrowest operation that answers the current ledger question, in this
order. Budgets: at most `max_primary_symbols` (5) primary symbols and
`max_related_symbols` (20) related symbols enter the ledger.

1. `query {search_query, task_context}` — locate concepts, execution flows,
   modules, and related tests for the task.
2. `context {name}` — 360° view of each candidate primary symbol: callers,
   callees, categorized refs, processes. Promote to primary or discard.
3. `impact {target, direction}` — upstream/downstream blast radius for shared
   or high-connectivity symbols (`maxDepth` = `impact_depth`; `summaryOnly:
   true` first for hub symbols). Record d=1 items — the plan must account for
   every one of them.
4. `trace {from, to}` — when the task hinges on *how A reaches B*, one call
   instead of chained context hops.
5. Statement-level PDG — Phase 3, for the functions the change centers on.
6. `cypher` — last resort, only for a precise graph question the tools above
   cannot express. Read `gitnexus://repo/{name}/schema` first; anchor and
   LIMIT every query.
7. `detect_changes {scope}` — only when planning against existing uncommitted
   or branch work.

Do not run every tool by default. A local test fix may finish the ladder at
step 2.

## Phase 3 — Statement-level PDG slice

For the 1–3 functions most central to the change, build a **PDG context
slice**: read `references/pdg-slice.md` and follow it. In short:

- `pdg_query {mode: "controls", target}` — what gates the behavior (guards,
  branch senses, early exits).
- `pdg_query {mode: "flows", target, variable?}` — def→use flow of the
  variables the change touches.
- `impact {mode: "pdg", target, line}` — statement-anchored dependence slice
  plus inter-procedural reach, when one statement is the seed of the change.
- Security tasks add `explain` (taint findings); performance tasks add the
  loop/blocking-call checklist.

Filter hard: only statements meeting the slice inclusion criteria enter the
plan, bounded by `pdg_data_depth`/`pdg_control_depth` (2). Never paste a raw
PDG dump. No `--pdg` layer indexed → record "PDG unavailable" in the ledger,
skip to Phase 4, and say so in the plan; do not reconstruct fake edges.

## Phase 4 — Targeted source verification

GitNexus said where to look; now confirm what is there. Using ordinary file
reads (exact line ranges, not whole files unless genuinely required):

- Read every source range the plan will cite: signatures, branch conditions,
  state mutations, error paths, nearby comments that change behavior.
- Read the tests GitNexus associated with the primary symbols; never claim a
  test exists without having located it.
- Check repo conventions that constrain the change (AGENTS.md, GUARDRAILS.md,
  lint/build config) — only the parts the change touches.
- Mark each ledger symbol `source_verified: true` as you go. **A symbol that
  is named in Proposed Changes must be source-verified.**
- On graph/source disagreement: trust source, record the discrepancy in the
  ledger and the plan, recommend re-indexing. Never present stale graph data
  as fact.

Evidence hierarchy, strongest first: current source and config → current tests
and executable behavior → compiler/build/lint output → GitNexus graph and PDG
→ documentation and comments.

## Phase 5 — Compose the plan

1. Read `references/plan-template.md` and fill all 13 sections from the
   ledger. Distinguish **confirmed facts / evidence-backed inferences /
   assumptions / open questions** throughout.
2. Build the implementation context pack per `references/context-pack.md`
   (this is section 11 of the plan).
3. Write the document to `docs/plans/YYYY-MM-DD-ce-plan-<slug>.md` (create the
   directory if missing; kebab-case slug, 3–5 words). Repo-relative paths
   everywhere.
4. Present in chat: objective, proposed-changes summary, implementation
   sequence, top risks, open questions, and the plan file path. Do not paste
   the whole document into chat.

## Context ledger

Maintain the ledger from Phase 0 onward — it is the skill's working memory and
its token budget enforcement. Schema and reread rules: `references/context-ledger.md`.
The final ledger feeds the plan; it is not itself published.

## Configuration

Defaults; override inline with `key:value` tokens before the task text (the
repo has no skill-config file mechanism — invocation args are the mechanism):

| Knob | Default | Meaning |
| --- | --- | --- |
| `depth` | by category | `narrow` / `default` / `deep` posture |
| `call_depth` | 2 | Caller/callee expansion in `context`/`trace` reasoning |
| `impact_depth` | 2 | `maxDepth` for `impact` |
| `pdg_data_depth` | 2 | Data-dependence hops in the PDG slice |
| `pdg_control_depth` | 2 | Control-dependence hops in the PDG slice |
| `max_primary_symbols` | 5 | Ledger budget |
| `max_related_symbols` | 20 | Ledger budget |
| `max_snippet_lines` | 30 | Longest source excerpt quoted in the plan |

## Fallback mode (GitNexus or PDG unavailable)

1. Say so, first thing, in chat and in the plan.
2. Use targeted repo exploration (grep/glob/reads) to approximate callers,
   dependencies, execution flow, state changes, and related tests.
3. Label every such finding **source-derived** in the plan — never present it
   as graph-derived, and never fabricate statement-level edges.
4. Recommend `node .gitnexus/run.cjs analyze` (add `--pdg` for the PDG layers)
   when it would materially raise confidence.

## Never

- Implement the feature, edit production code, or run mutating commands.
- Dump unfiltered graph/PDG output or full files into the plan.
- Repeat a search or reread an unchanged range already in the ledger.
- Expand scope into unrelated refactoring.
- Treat comments as stronger evidence than executable code.
- Continue exploring after the ledger answers all open planning questions.
