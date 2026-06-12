---
name: gitnexus-taint-analysis
description: "Use when working on, reviewing, or extending GitNexus's CFG/taint/PDG subsystem (the `--pdg` layers), or when reasoning about source→sink data-flow findings. Examples: \"How does taint analysis work here?\", \"Why didn't explain find this flow?\", \"Add a new sink/source\", \"Review the interprocedural taint code\"."
---

# CFG & Taint Analysis with GitNexus

Expert knowledge for the opt-in `--pdg` program-analysis subsystem: control-flow
graphs, reaching definitions, and intra- + inter-procedural taint. Read this
before touching `gitnexus/src/core/ingestion/cfg/**` or
`gitnexus/src/core/ingestion/taint/**`, or when explaining a finding.

## When to Use

- "How does the taint engine work / why is this flow (not) reported?"
- Adding a source, sink, or sanitizer to the model.
- Extending or reviewing the CFG / reaching-defs / taint / summary code.
- Understanding the `explain` MCP tool's findings (intra- vs inter-procedural).
- Debugging a false positive or false negative in `--pdg` output.

## The layered substrate (build order)

Taint runs **on** the graph, not beside it. Each layer is opt-in behind `--pdg`
and a default `analyze` run is **byte-identical** (the golden parity gate is the
hard floor for every change here).

```
L1  CFG            per-function basic blocks + control-flow edges   (M1 #2081)
L2  REACHING_DEF   GEN/KILL def→use data dependence (pure solver)   (M2 #2082)
L3  Taint (intra)  source→sink over RD facts, minus sanitizers      (M3 #2083)
L4  Taint (inter)  per-function summaries composed over CALLS       (M4 #2084)
```

- **Worker-built, main-thread-solved.** The parse worker builds each function's
  CFG + harvests def/use + call-site facts onto `ParsedFile.cfgSideChannel`
  (plain, structured-clone-safe data — never AST nodes). The main thread runs
  the pure solvers. NEVER re-parse on the main thread (re-introduces the #1983
  OOM).
- **In-phase emit (KTD1).** L1–L4-harvest all run INSIDE the scope-resolution
  pdg window (`scope-resolution/pipeline/run.ts`, gated `input.pdg === true`),
  because the disk-backed ParsedFile store is cleared when that phase ends — a
  standalone post-`mro` phase would read empty data. The cross-function fixpoint
  (L4) is the exception: it runs in its OWN registered phase (`taintSummaries`)
  AFTER scope-resolution, because it needs the COMPLETE call graph, and consumes
  small plain summary data threaded out via `ScopeResolutionOutput`.
- **Pure-solver contract.** `computeReachingDefs`, `computeTaintFlows`,
  `harvestFunctionSummary`, and `solveInterprocTaint` are pure and deterministic
  (no graph, no I/O, no logger; sorted outputs). Snapshot tests and
  content-derived edge ids depend on it.

## Intra-procedural taint (L3)

Forward reachability over RD facts from matched **sources** to matched **sinks**,
killed by **sanitizers**. Key design points worth internalizing:

- **Occurrence-tagged sites.** A flat per-arg binding set cannot tell
  `exec(escape(x))` (safe) from `exec(x)` (finding); the harvest records nested
  call structure (`SiteRecord.parent`/via-tags) so sanitizer interposition is
  precise.
- **Kind-set sanitizer model.** A taint carries a set of *neutralized*
  `SinkKind`s; a sink fires unless its kind is in the set. So `escape(req.body)`
  suppresses `res.send` (xss) but STILL fires `db.query` (sql) — a kind-blind
  kill would be a suppressed live injection (the forbidden FN direction).
  `path.basename(t)` neutralizes path-traversal only, not command-injection.
- **Statement-level finding identity.** NOT block-pair (block conflation drops
  distinct findings; `exec(req.body, req.query)` is two findings).
- Persisted as `TAINTED` edges (BasicBlock→BasicBlock); the path rides the
  `reason` column via the shared versioned codec (`taint/path-codec.ts`).

## Interprocedural taint (L4) — the functional/summary method

The production approach (Sharir-Pnueli 1981; the same shape as Meta's Pysa and
Mariana Trench, and FB Infer) — NOT full IFDS tabulation. Each function is
reduced to a compact **summary**, and summaries are composed over the already-
resolved `CALLS` graph.

**Summary shape** (`taint/summary-model.ts`, whole-parameter granularity):

| Edge | Meaning | Analogue |
|------|---------|----------|
| `param→return` | a param flows to the return value | TITO — **reserved** (the floor already covers its recall; precision pass deferred) |
| `param→callee-arg` | a param flows into arg *j* of a call (carries the path's neutralized sink kinds) | TITO into callee |
| `param→sink` | a param reaches a modelled sink | partial/triggered sink |
| `source→return` | the function generates+returns a source | generative — **composed** via the caller's `callResults` |
| `source→callee-arg` | a generated source flows into a call | fixpoint SEED |
| `callResults` | a user-function call's result flows to a sink/return/callee-arg in the caller | composes with callee `source→return` |

**The fixpoint** (`taint/interproc-solver.ts`): the unit is `(function,
parameter, source)`. Seed from `source→callee-arg`, propagate via
`param→callee-arg`, fire a finding when a tainted param meets `param→sink`.

- **Cycle-safe by monotonicity.** The tainted-set is monotone over a finite
  lattice (`fn × param × source`), so the worklist converges — a recursive call
  just re-proposes an already-visited entry. SCC condensation would only refine
  processing order; correctness/termination don't require it.
- **Source-discriminated state (load-bearing).** Key the state by the SOURCE
  too. Keying only by `(fn, param)` collapses multi-source flows: a sink param
  tainted by source A is marked visited and a later flow from source B is dropped
  before firing — the recurring multi-source bug class. (Bit M3; bit M4 U9.)
- **Name-based call join.** Match a summary's call-arg edge to a `CALLS` edge by
  CALLEE NAME, not call-site line — line-base parity (CFG 1-based vs reference
  site) is fragile; the callee identity is exact and context-insensitivity
  taints the callee's param identically at every call site.
- Persisted as `TAINT_PATH` edges (Function→Function), function-level hop chain
  in `reason` via the same codec; confidence < the intra-procedural 1.0.

**Context-insensitivity** is the accepted trade-off at this tier: one summary
per function, return/call-site merging accepted (security-conservative). Expect
some FP from merging; the bigger FN sources are unmodeled features (below).

## Known false-negative classes (documented, deferred)

The largest is **closures/callbacks** (`arr.forEach(() => sink(y))`) — taint
into a callback is dropped without per-library models (true of CodeQL's JS libs
too). Also deferred: field/property flows (`obj.x = taint; sink(obj.y)`),
field-sensitive access paths, guard-style sanitizers, implicit/control-dependence
flows, promise/async-await threading, and **destructured/rest params before a
tainted simple param** (the summary port index is the binding ordinal, not the
formal arg position — needs a formal-param index threaded from the worker
`BindingEntry`). The interprocedural join is also context-insensitive: when one
caller invokes two distinct **same-named callees**, a flow into one
over-attributes to both (sound — over-report, never a missed flow). Absence of a
finding is NOT proof of safety.

## GitNexus-specific gotchas

- **Function↔CFG join.** `FunctionCfg.functionStartLine` is 1-based; `Function`/
  `Method` node `startLine` is 0-based — join at `startLine - 1`. Function nodes
  have no column, so same-line functions (`{a:()=>x(), b:()=>y()}`) are
  ambiguous → drop (the summary driver counts `unresolved`) rather than
  cross-wire.
- **No rel-property index (S1).** Kuzu has no secondary index on relationship
  properties, and unanchored `[:TAINTED*]`/`[:TAINT_PATH*]` queries explode.
  TAINT_PATH is therefore MATERIALIZED + anchored at analyze time, never
  traversed live; `explain` reads it source-anchored + LIMIT-guarded.
- **`explain` is the only discovery surface.** `TAINTED`/`TAINT_PATH` are
  deliberately OUT of `VALID_RELATION_TYPES` (impact's allow-list) and the web
  schema (pinned in `security.test.ts`). `explain` enumerates both layers
  (cross-function findings carry `interprocedural: true`).
- **One shared codec.** Both the emit path and `explain` import
  `taint/path-codec.ts`. Two hand-rolled copies of a wire format drift — never
  fork it. New metadata extends the format WITHIN the version when writer +
  reader ship together.
- **Cache versioning.** A worker-harvest shape change bumps the parse-cache pdg
  NAMESPACE (`pdg:N`), NOT `SCHEMA_BUMP` (which cold-invalidates every user).
  Persisted-graph/config changes ride `RepoMeta.pdg`'s key-union mismatch →
  full writeback. Model content rides `taintModelVersion`.

## Adding a source / sink / sanitizer

Edit the language model in `taint/typescript-model.ts` (registered via the
explicit `registerBuiltinTaintModels` seam, keyed by `SupportedLanguages`). The
spec is hashable data (no functions). A sanitizer's `neutralizes` lists the
EXACT sink kinds it defends — never a blanket kill. Add a fixture + assert the
finding (or its absence) in `test/unit/taint/` (real-source harness:
`test/helpers/ts-cfg-harness.ts`); the end-to-end proof is
`test/integration/cfg/`.

## Validation checklist for any `--pdg` change

```
1. tsc clean (schema additions are exhaustiveness-checked; watch the
   api.ts getNodeQuery runtime read-path if a node label is added).
2. Targeted vitest by directory (test/unit/taint, test/unit/cfg,
   test/integration/cfg) — verify by ISOLATION, not full-suite exit
   (known load-flakes). `node scripts/build.js` before worker/integration runs.
3. Flag-off golden byte-identical (pipeline-graph-golden.test.ts).
4. bench/cfg/measure.mjs --check (no fingerprint drift / budget regression).
5. detect_changes() before commit; impact({direction:'upstream'}) before
   editing shared symbols (KnowledgeGraph, RepoMeta, RelationshipType, codec).
```

## Prior art (for deeper design questions)

Sharir & Pnueli 1981 (functional approach); Reps-Horwitz-Sagiv IFDS (POPL 1995);
FlowDroid/StubDroid (access-path summaries); Pysa & Mariana Trench (TITO /
propagations, parallel SCC fixpoint); CodeQL Models-as-Data (the richest port
notation, incl. callback ports); Infer (content-keyed incremental summaries).
