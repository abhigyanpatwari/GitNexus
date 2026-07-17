---
name: gitnexus-plan
description: "Use when you need a deep, implementation-ready engineering plan for a code change — built from GitNexus graph intelligence, statement-level PDG analysis, and targeted source verification, compact enough that an implementation agent can start without re-investigating. Also strengthens existing plans via Deepen mode. Examples: \"/gitnexus-plan Add retry support to the ingestion pipeline\", \"/gitnexus-plan deepen docs/plans/<plan>.md\", \"plan this change using the knowledge graph\"."
---

# gitnexus-plan — implementation-ready engineering plans

Produce an implementation-ready plan for an engineering task. GitNexus is the
navigation layer (where to look), statement-level PDG is the constraint layer
(what gates and feeds the behavior), and your native targeted source reads are
the verification layer (what is actually true right now). The output is a plan
document plus a compact, machine-readable **implementation context pack**
that a follow-up implementation agent (`gitnexus-work`, or any executor) can
consume without repeating the investigation.

```
/gitnexus-plan <task description>
/gitnexus-plan impact_depth:3 depth:deep <task description>   # knob overrides, see Configuration
```

**This skill plans. It never implements.** Do not modify production code,
tests, or configuration while running it. The only repository file it writes
is the plan document (a working ledger kept outside the repo is fine). The
only other permitted state changes are the freshness gate's: an index
refresh via `analyze --index-only` (writes only the `.gitnexus` index store,
never repo files) and the analyzer `dist/` rebuild that may precede it
(build output only).

## Hard rules

- **Ledger first.** Before every GitNexus call and every repo file read, check
  the context ledger. Never repeat a query or reread an unchanged range that
  already answered the same question (allowed repeats are defined in
  `references/context-ledger.md`; this skill's own reference files are exempt
  from ledger bookkeeping).
- **Every graph query answers a named planning question.** Record the question
  and the conclusion in the ledger. No exploratory dredging.
- **Source beats graph.** The graph navigates; current source is authoritative.
  Verify before asserting (see Phase 4). Comments are the weakest evidence —
  never stronger than executable code.
- **No fabrication.** Never invent symbols, filenames, test names, tool
  results, or PDG edges. Unknowns go to *Assumptions and Open Questions*.
- **No scope creep.** Adjacent refactors the task didn't ask for go to plan
  §12 as explicitly-deferred follow-ups, not into Proposed Changes.
- **Stop when you have enough.** Sufficient evidence ends exploration; plans
  do not improve monotonically with tokens spent.

## Phase 0 — Parse and classify

Read `references/context-ledger.md` and open the ledger with the task:
original request, interpreted goal, acceptance criteria. Classify the task:

| Category | Posture (depth · plan form · tool-call budget · freshness) |
| --- | --- |
| Bug fix (local) | Narrow, 1–2 primary symbols, `impact_depth` 1 · compact · ~15 · accept |
| Feature | Default knobs · compact · ~30 · accept |
| Refactor / shared API change | Impact mandatory, `impact_depth` 3 · full · ~45 · strict |
| Performance | Default + performance PDG mode (`references/pdg-slice.md`) · full · ~45 · strict |
| Security | Default + security PDG mode + `explain` taint findings · full · ~45 · strict |
| Dependency upgrade / migration | Impact + compatibility focus; PDG rarely needed · compact · ~20 · accept |
| Concurrency / transactional | Control-flow + state-mutation PDG focus · full · ~45 · strict |
| Test improvement / docs | Narrowest: usually no impact or PDG pass · compact · ~10 · accept |
| Architecture change / spike | Widest: clusters + processes first · full · no cap · strict |

The category posture overrides the Configuration baseline; explicit `key:value`
invocation knobs override both. A task matching several rows combines them:
take the widest depth, union the focus areas.

**Seeded evidence.** When a completed investigation already supplies
verified findings — a finished review, a triage document with `path:line`
anchors and named failing scenarios — open the ledger FROM it: cite the
source document as the opening ledger entries and plan directly against
them instead of re-running the graph ladder over ground it already covers.
Re-deriving what the evidence proves is budget spent against the
turn-economy rule. Phase 4 still source-verifies whatever Proposed Changes
will cite, at the pinned commit — seeding replaces exploration, never
verification.

**Depth is the user's decision, asked once, up front.** In an interactive
session, when the invocation carries no explicit depth signal (no `depth:`,
`form:`, or `freshness:` knob, and not Deepen mode), ask one blocking
question before Phase 1 — how deep should this plan go?

1. **Quick** — `depth:narrow form:compact freshness:accept`. Fastest useful
   plan: 1–2 primary symbols, minimal graph work, core sections only.
2. **Standard** — the category posture above, unchanged. Recommend this
   unless the classification argues otherwise.
3. **Deep** — `depth:deep form:full freshness:strict`. All 13 sections,
   `impact_depth` 3, clusters/processes read, PDG slices for the central
   functions.

The answer sets the knobs exactly as if they had been typed in the
invocation; explicit knobs win and skip the question. Headless runs never
ask — the category posture applies unchanged. Asking up front replaces
offering to deepen a finished plan afterwards: Deepen mode (below) remains
the mechanism for strengthening an existing plan document — a later session,
review findings, an executor route-back — not a default follow-up question.

**Turn economy is a deliverable.** The plan is judged on decision quality per
token, not thoroughness theater (measured: a 63-turn plan for a two-line
change — the GitNexus repo's `eval/workflow_bench/`). Stay within the category's tool-call
budget; when the budget runs out with questions still open, record them in
§12 instead of digging further — the executor re-verifies cheaply anyway.

## Phase 1 — Anchor and freshness

1. Resolve the target repo: `list_repos` if in doubt, else the indexed repo
   covering the working directory. Pass `repo` explicitly on every call when
   more than one repo is indexed.
2. Record the repo's current HEAD commit in the ledger — every line-number
   citation in the plan is pinned to it.
3. **Resolve the analyzer runner** (used by every `analyze` command in this
   skill): `node .gitnexus/run.cjs analyze …` when the project has a runner
   (a previous analyze dropped it next to the index), else
   `gitnexus analyze …` (installed CLI — `npm install -g gitnexus`), else
   `npx gitnexus analyze …`.
4. Read `gitnexus://repo/{name}/context` — codebase overview + staleness check.
   **Freshness gate.** Plans built on a stale graph make stale blast-radius
   claims — but a refresh (analyzer rebuild + re-index) is the single
   largest fixed cost a planning session carries (measured in the GitNexus
   repo's `eval/workflow_bench/`), so the gate is category-priced:
   - Compact-plan categories default to `freshness: accept`: plan on the
     current graph with source verification weighted higher — their plans
     cite little graph evidence. Escalate to a refresh mid-plan only when a
     graph claim becomes load-bearing (e.g. Proposed Changes rest on a d=1
     dependent list), and only then.
   - Full-plan categories default to `freshness: strict`, and under it:
   - **Runner build check — before any refresh.** If the target repo builds
     the analyzer from its own source (a `bin` → `dist/` mapping, as in this
     repo's `gitnexus/` package), the built output must be current, or the
     refresh re-indexes with outdated extraction logic and defeats the gate.
     Rebuild when any analyzer source file is newer than the built entrypoint
     (e.g. `find gitnexus/src -newer gitnexus/dist/cli/index.js -print -quit`
     prints anything — when in doubt, rebuild: `npm run build` in the
     package) and prefer that freshly built CLI for the refresh. Note the
     rebuild in `index_refresh`.
   - Stale index → run `analyze --index-only` via the resolved runner
     (append `--pdg` when the task category will reach Phase 3) and re-read
     the context resource. Refresh budget, stated once here: at most one
     `--index-only` refresh in Phase 1 **plus** at most one later `--pdg`
     upgrade in Phase 3 (only when Phase 1's refresh lacked `--pdg`) per
     planning session — a Deepen run is its own session. Record each command
     and outcome in the ledger's `index_refresh`.
   - Refresh failed or impractical (no write access to the index, prohibitive
     repo size), or `freshness: accept` was passed → proceed on the stale
     graph, weight source verification higher, and state the staleness and
     the skipped refresh in the plan header and Assumptions.
   - Resources unreadable but tools working → proceed on tools alone, treat
     freshness as unknown (weight source higher), and note it in the plan.
   - GitNexus unavailable entirely → switch to **Fallback mode** (below).
5. For architecture-scale tasks only, also read
   `gitnexus://repo/{name}/clusters` and `.../processes`.

## Phase 2 — Graph navigation ladder

Use the narrowest operation that answers the current ledger question, in this
order. Budgets: at most `max_primary_symbols` (5) primary symbols and
`max_related_symbols` (20) related symbols active in the ledger.

1. `query {search_query, task_context}` — locate concepts, execution flows,
   modules, and related tests for the task.
2. `context {name}` — 360° view of each candidate primary symbol: callers,
   callees, categorized refs, processes. Promote to primary or discard. An
   `ambiguous` result (ranked candidates) is answered by one retry narrowed
   with `kind` / `file_path` / uid — that retry is an allowed repeat.
3. `impact {target, direction}` — upstream/downstream blast radius for shared
   or high-connectivity symbols (`maxDepth` = `impact_depth`; `summaryOnly:
   true` first for hub symbols, then drill in — an allowed repeat). Record the
   d=1 items — the **direct (depth-1) dependents** — the plan must account
   for every one of them.
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

For the 1–3 functions most central to the change, build a bounded **PDG
context slice**. Read `references/pdg-slice.md` and follow it — it owns the
tool calls, inclusion criteria, depth bounds, slice schema, the security and
performance modes, and the no-PDG-layer fallback.

## Phase 4 — Targeted source verification

GitNexus said where to look; now confirm what is there. Using ordinary file
reads (exact line ranges, not whole files unless genuinely required):

- Read every source range the plan will cite: signatures, branch conditions,
  state mutations, error paths, nearby comments that change behavior. Compact
  plans cite less — verify what they cite, don't expand the citation set to
  have more to verify.
- Read the tests GitNexus associated with the primary symbols; never claim a
  test exists without having located it.
- Verify the build/test commands the plan will name actually exist
  (package.json scripts / CI workflows), and prefer the script form that
  carries its prerequisites (pre-hooks) over invoking underlying binaries
  directly.
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

1. Read `references/plan-template.md` and fill the category's form — compact
   (core sections, ≤80 lines excluding the pack) or full (all 13 sections) —
   from the ledger, tagging claims with the template's four classes —
   `[verified]`, `[graph]`, `[inferred]`, `[assumed]` — and routing open
   questions to §12.
2. Build the implementation context pack per `references/context-pack.md`
   (this is section 11 of the plan).
3. Write the document to `docs/plans/YYYY-MM-DD-gitnexus-plan-<slug>.md` under the
   root of the repo being planned (the Phase 1 target repo, not necessarily
   the cwd). Create the directory if missing; kebab-case slug, 3–5 words.
   The `out:<path>` knob overrides the destination (use it for read-only
   checkouts). Repo-relative paths inside the document.
4. Present in chat: objective, proposed-changes summary, implementation
   sequence, top risks, open questions, and the plan file path. Do not paste
   the whole document into chat.

## Deepen mode

`/gitnexus-plan deepen <plan-path>` strengthens an existing plan in place
instead of creating a new one:

1. Re-run Phase 1 in full — runner build check, freshness gate (a Deepen
   run is its own session, with its own refresh budget).
2. **Re-anchor before re-pinning.** Diff the plan's old evidence pin against
   current HEAD for every file backing a `[verified]` claim: unchanged files
   keep the tag; changed files get their cited ranges re-read — or the claim
   downgraded — *before* the header pin moves to the new HEAD. Moving the
   pin without this step silently launders stale claims as verified.
3. Escalate to `depth: deep` (impact_depth 3, clusters/processes read)
   unless the invocation overrides knobs explicitly.
4. Seed the ledger from the plan's §11 pack, then re-verify: every
   `[graph]`/`[inferred]` claim gets a targeted pass toward `[verified]`;
   every `[assumed]` claim is resolved or kept with its reason; direct
   (d=1) dependent accounting is re-checked against the refreshed graph;
   PDG slices are built or expanded for the central functions when the
   layer is present.
5. **Reconcile execution state.** If `gitnexus-work` already landed commits
   for this plan (a mid-execution route-back), mark the §7 steps present at
   HEAD as completed and re-sequence the remainder — the rewritten plan must
   be executable from the top without redoing landed steps.
6. Strengthen whatever the deeper pass showed thin — test scenarios, risks,
   Definition of Done — and carry claim-tag upgrades through the prose.
7. Rewrite the **same file**: same 13 sections, context pack kept in sync,
   evidence header updated. Summarize the delta in chat: claims upgraded,
   claims that failed re-verification, sections changed.

## Configuration

Baseline defaults — the Phase 0 category posture overrides them, and inline
`key:value` tokens before the task text override both (the repo has no
skill-config file mechanism; invocation args are the mechanism):

| Knob | Default | Meaning |
| --- | --- | --- |
| `depth` | by category | `narrow` = `impact_depth` 1, PDG only if one function is clearly central; `default` = this table; `deep` = `impact_depth` 3 + clusters/processes read |
| `form` | by category | `compact` (core sections + mini-pack, ≤80 lines excl. pack — see `references/plan-template.md`) or `full` (all 13 sections) |
| `impact_depth` | 2 | `maxDepth` for `impact` |
| `pdg_data_depth` | 2 | Data-dependence hops in the PDG slice |
| `pdg_control_depth` | 2 | Control-dependence hops in the PDG slice |
| `max_primary_symbols` | 5 | Ledger budget (active symbols; discards don't count) |
| `max_related_symbols` | 20 | Ledger budget (active symbols; discards don't count) |
| `max_snippet_lines` | 30 | Longest source excerpt quoted in the plan |
| `out` | `docs/plans/` in target repo | Plan document destination |
| `freshness` | by category | `strict` (full-plan categories) = refresh a stale index (and a missing PDG layer) with `analyze --index-only [--pdg]` before relying on the graph; `accept` (compact categories) = plan on the current graph, source-weighted and labelled, refreshing only if a graph claim becomes load-bearing |

## Fallback mode (GitNexus or PDG unavailable)

1. Say so, first thing, in chat and in the plan.
2. Use targeted repo exploration (grep/glob/reads) to approximate callers,
   dependencies, execution flow, state changes, and related tests.
3. Label every such finding **source-derived** in the plan — never present it
   as graph-derived, and never fabricate statement-level edges.
4. Recommend `analyze --index-only` (add `--pdg` for the PDG layers) via
   the resolved runner — `node .gitnexus/run.cjs`, installed `gitnexus`, or
   `npx gitnexus` — when it would materially raise confidence.

## Skill feedback (GitNexus repo only)

If this run exposed friction in this skill's own instructions — wrong or
missing guidance, a wasted tool budget, a phase that misrouted — and the repo
carries `eval/workflow_bench/`, append one JSON line to
`eval/workflow_bench/learnings.jsonl` (create the file if absent):
`{"skill": "gitnexus-plan", "date": "YYYY-MM-DD", "task": "<one line>", "friction": "<one line>", "suggestion": "<one line>"}`.
Never edit this skill file itself from a live task: improvements go through
the offline candidate loop (`eval/workflow_bench/README.md` § Prompt and
skill evolution loop), where a candidate must beat the incumbent on the
paired benchmark before a human merges it.
