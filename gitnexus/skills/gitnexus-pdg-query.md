---
name: gitnexus-pdg-query
description: "Use when querying or extending GitNexus's PDG control/data-dependence surface (the `pdg_query` MCP tool, CDG/REACHING_DEF edges), or reasoning about \"what controls X\" / \"where does Y flow\" / guard clauses. Examples: \"what guards this statement?\", \"trace this variable within the function\", \"why is the pdg_query result empty?\", \"add a CDG query\"."
---

# PDG query surface with GitNexus

Expert knowledge for the `pdg_query` MCP tool and the control/data-dependence
edges it reads — the opt-in `--pdg` program-dependence layers. Read this before
touching `gitnexus/src/mcp/local/local-backend.ts` (`_pdgQueryImpl`) or the
`pdg_query` tool def, or when explaining a `pdg_query` result.

## When to Use

- "Under what condition does this statement run?" (guarding predicates).
- "Where does this variable flow inside the function?" (def→use).
- Guard-clause discovery (early-return guards — subsumes the #559 heuristic).
- Extending or reviewing `pdg_query` / the CDG / REACHING_DEF read path.
- Debugging an empty or surprising `pdg_query` result.

## The layered substrate (build order)

`pdg_query` runs **on** the same graph taint runs on. Each layer is opt-in
behind `--pdg`; a default `analyze` run records none of them (byte-identical).

```
L1  CFG            per-function basic blocks + control-flow edges   (M1 #2081)
L2  REACHING_DEF   GEN/KILL def→use data dependence (pure solver)   (M2 #2082)
L5  CDG            Ferrante control dependence (post-dominators)    (M5 #2085)
```

All three are `BasicBlock → BasicBlock` edges in the single `CodeRelation` table
(keyed by the `type` property). There is **no** `Function → BasicBlock` edge.

## The two modes

- `pdg_query({ mode: 'controls', target })` — CDG. For the anchored function,
  each edge: controlling predicate block → dependent block + branch sense in
  `label` (`'T'` = predicate's true/taken arm, `'F'` = false/fall-through). An
  edge into an early-return/throw block is flagged `guard: true`.
- `pdg_query({ mode: 'flows', target, variable? })` — REACHING_DEF def→use
  edges; `variable` filters to one binding.

`target` is **required** — a file path or a symbol/function name (resolved like
`context()`). There is no anchorless mode (see below).

## The corrected guard-clause Cypher

The RFC #567 §2 form (`[:CDG {label:'F'}]`) does **not** run as written. Edges
are values of the single `CodeRelation` table's `type` property, and the branch
sense is in `reason`, NOT a `label` column:

```cypher
MATCH (pred:BasicBlock)-[r:CodeRelation {type: 'CDG'}]->(dep:BasicBlock)
WHERE dep.text STARTS WITH 'return' OR dep.text STARTS WITH 'throw'
RETURN pred.startLine, r.reason AS branch, dep.startLine, dep.text
```

`r.reason` is the sense the predicate took to reach the early exit. For
`if (!ok) return;` the return rides the predicate's **true** arm (`'T'`) and the
protected body rides the **false** arm (`'F'`) — polarity depends on the guard,
so don't hard-code one sense.

## Gotchas (the load-bearing ones)

- **Always anchored + LIMIT-bounded.** LadybugDB has no rel-property index, so
  an unanchored `[:CDG*]`/`[:REACHING_DEF*]` path scan is unbounded. `pdg_query`
  requires `target` and bounds the page; raw `cypher` callers must anchor on a
  file id-prefix or symbol span themselves.
- **BasicBlock↔symbol join is reconstructed.** No `Function→BasicBlock` edge:
  the block is matched by its id-prefix (`BasicBlock:<file>:<fnStartLine>:…`)
  plus `startLine` within the symbol's span. BasicBlock `startLine` is **1-based**
  while the symbol node's `startLine`/`endLine` are **0-based**, so **both** bounds
  are shifted `+1` (`[symStart+1, symEnd+1]`): the upper `+1` keeps a guard/def/use
  on the function's **final line**, the lower `+1` excludes an adjacent function's
  block on the line directly **above**. Same-line / nested functions anchor coarsely.
- **No PDG layer ⇒ a note, not an error.** If the repo wasn't indexed with
  `--pdg` the tool returns `{ results: [], note: "no PDG layer …" }` (cheap meta
  probe on `RepoMeta.pdg.maxCdgEdgesPerFunction` / `maxReachingDefEdgesPerFunction`).
- **CDG labels are binary in M5/M6.** Every `switch`-case arm is `'T'`; per-case
  conditions are not yet distinguished.
- **Intra-procedural only.** Cross-function flow is taint's domain (`explain`).

## Mirror, don't fork

`_pdgQueryImpl` is the front half of `_explainImpl` (WAL wrapper, meta no-layer
probe, limit validation, `resolveSymbolCandidates` anchoring) with CDG/
REACHING_DEF instead of TAINTED — and none of taint's path-codec / interproc
`TAINT_PATH` machinery. Reuse those shared helpers; do not re-implement them.
