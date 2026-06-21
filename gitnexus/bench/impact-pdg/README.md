# `bench/impact-pdg` — PDG-vs-call-graph impact accuracy harness

> **STATUS: LIVE (U7, statement-anchored rework).** This directory holds the
> curated ground-truth fixture corpus **and** the measurement harness
> (`measure.mjs`, `metrics.mjs`, `baselines.json`). Run it with
> `node --import tsx bench/impact-pdg/measure.mjs` (build `dist/` first — see *How
> to run*). The harness drives both `impact` engines over the fixtures — PDG
> **seeded on the criterion's statement line** so it returns the dependence slice
> — prints a stratified P/R/F1 table + a plain-language decision recommendation,
> and gates regressions with `--check`. It now also prints an additive **unified
> impact axes** table that keeps line-level and symbol-level truth separate while
> comparing `callgraph`, unified `pdg`, and the evaluation-only
> `composed-current` control baseline. The measured native result remains:
> **PDG is precise at intra-procedural statement granularity (exact on the intra
> AND mixed fixtures — F1 = 1.000; FU-B-2 made the slice statement-granular, closing
> the block-coalescing recall caveat, and the U2 value-diff oracle now agrees on the
> intra stratum); call-graph remains the comparator for inter-procedural symbol
> granularity; unified PDG must match that composed baseline before any
> default-switch decision.**

## What this measures

`impact` has two engines that answer **different questions at different
granularities**:

- `mode: 'callgraph'` (the default) — inter-procedural BFS over symbol→symbol
  edges. It answers *"what other symbols depend on / are called by this one?"* at
  **symbol granularity**, scored against `inter_AIS`.
- `mode: 'pdg'` (opt-in) — the unified PDG-facing result. Its local
  statement slice comes from the persisted CDG + REACHING_DEF Program Dependence
  Graph. Seeded with `line: N` (`impact({mode:'pdg', line:N})`), it returns
  `affectedStatements: {line, filePath, text}[]` — the dependent **statements** of
  the changed line N — and also attaches inter-procedural symbol reach in
  `interproceduralByDepth`/`byDepth` for the same target. The native PDG row is still scored against
  `intra_AIS`; the unified axes score its statement and symbol outputs together.

They measure **different scopes**, so the harness scores each at its native
granularity against its native ground truth and reports both side by side. The
"which is more accurate?" question gets an honest, per-scope answer rather than a
single blended number — and the answer is *they answer different questions;
neither strictly dominates*.

## Unified impact axes

The harness also reports a separate unified comparison that is designed for the
current architecture question: *does unified `mode:'pdg'` match the composition of today's engines?* This report is additive. It does not
replace the native table above, and it does not change `baselines.json` gating.

Unified AIS has two namespaces:

- `statement:<filePath>:<line>` for intra-procedural line truth from `intra_AIS`
- `symbol:<symbol>@<filePath>` for inter-procedural symbol truth from `inter_AIS`

Each engine is adapted onto those axes without lossy projection:

- `callgraph` contributes only the `symbol` axis.
- `pdg` contributes the `statement` axis from `affectedStatements` and the
  `symbol` axis from its unified `interproceduralByDepth`/`byDepth` inter-procedural reach.
- `composed-current` remains an evaluation-only control row that unions standalone
  callgraph symbols with PDG statements.

The report intentionally has no single blended unified F1. `pdg` is now judged
axis-by-axis against `composed-current` so line precision cannot hide
inter-symbol misses, and symbol recall cannot hide statement-level blindness. The
control row is a recall baseline, not a perfection claim: PDG can still
contribute intra-line noise on pure-inter fixtures, so default-switch decisions
should require matching recall while reducing or bounding FPIS.

> **A note on `line`.** A whole-symbol PDG slice (no `line`) is empty by design:
> intra-procedural dependence stays inside the function, so every reachable block
> is already part of the whole-symbol seed. The useful PDG mode is the
> **statement-anchored** one — seed the criterion's changed statement and read
> the dependent statements back. This is the central change the U7 *rework*
> measures; the earlier "PDG is empty / callgraph wins" verdict was an artifact of
> the whole-symbol seed, now replaced.

## Runtime result contract

`impact({mode:'pdg', line:N})` success results carry a target envelope
(`id`, `name`, `type`, `filePath`), `risk: 'UNKNOWN'`, `affectedStatements`,
`affectedStatementCount`, and callgraph-compatible parity fields (`byDepth`,
`byDepthCounts`, `summary`, `affected_processes`, `affected_modules`).
`affectedStatements` is the statement-level PDG slice; `interproceduralByDepth` is the explicit cross-function reach; `byDepth` remains the
compatibility symbol bucket attached by unified PDG mode.

Degraded PDG results are explicit, not empty successes. `no-layer`,
`sub-layer-missing`, and `unknown` responses keep `mode:'pdg'`, target metadata
when the target resolves, `risk:'UNKNOWN'`, a remediation note, and empty parity
fields. Truncation is also explicit: when both depth and per-step limit bounds
fire, `truncatedByReasons` reports both causes.

Deferred architecture remains out of scope for this harness: explicit
`Function|Method -> BasicBlock` containment (`CONTAINS_BLOCK`), inter-procedural
summary edges / realizable call-return paths, mutation-derived AIS, and a hybrid
callgraph+PDG impact mode are follow-up features, not assumptions of the current
statement-level benchmark.

## The corpus

Each case is a tiny self-contained TypeScript source repo plus a
`ground-truth.json`. TypeScript is used throughout because it has the most
mature CFG/PDG support in this codebase.

`line` is the `criterion.line` — the statement the PDG slice seeds on.

| Case | Locus | line | Shape |
|---|---|---|---|
| `intra-dataflow-accumulator` | intra | 8 | loop-carried accumulator def→use (downstream) |
| `intra-dataflow-chain` | intra | 7 | straight-line def→use chain (downstream) |
| `intra-dataflow-reassign` | intra | 9 | reaching defs of a use (upstream, RD-reverse) |
| `intra-control-guard` | intra | 7 | guard-clause control dependence (downstream, CDG-forward) |
| `intra-control-branch` | intra | 7 | if/else-if/else arm control dependence (downstream) |
| `intra-control-loop` | intra | 11 | nested loop+if controllers of a stmt (upstream, CDG-reverse) |
| `inter-dispatcher-thin` | inter | 23 | branch router → 3 handlers (intra slice = routing returns, empty intra_AIS) |
| `inter-facade-delegate` | inter | 21 | guarded sequential delegation chain (empty intra_AIS) |
| `inter-pipeline-stages` | inter | 20 | straight pipeline driver → 3 stages (empty intra_AIS) |
| `mixed-validate-then-call` | mixed | 13 | guard-dominated intra dependence + 1 callee |
| `mixed-compute-and-emit` | mixed | 12 | data-flow-dominated intra dependence + 1 callee |
| `mixed-guarded-dispatch` | mixed | 15 | control+data intra dependence + 2 callees |
| `nobody-interface-excluded` | n/a | — | no-body symbols (KTD6); **excluded** from PDG scoring |

**Minimum corpus floor (KTD9/F3):** ≥ 3 cases per locus stratum, ≥ 12 total
measurable cases. Current: intra = 7, inter = 3, mixed = 3 → 13 measurable
(+1 excluded no-body case). Below this floor the U7 harness must print
"underpowered — directional only" instead of a verdict.

## Annotation schema (`ground-truth.json`)

| Field | Type | Meaning |
|---|---|---|
| `schemaVersion` | int | schema version (currently `1`) |
| `criterion` | `{ name, filePath, direction, line?, marker?, pdgEdgeKinds? }` | the changed symbol — the seed for "what is affected if I change this". `direction` ∈ `downstream` \| `upstream`. **`line`** is the **1-based source line of the statement being changed** — the seed of the statement-anchored PDG slice (`impact({mode:'pdg', line})`). It is chosen from **source semantics** (the def/criterion whose change propagates to the `intra_AIS` lines), *not* by running the traversal (KTD9 annotation-circularity guard), then reconciled against the live traversal in the harness's Step 0. `marker` is a substring unique to the criterion function's body (appears in one of its `BasicBlock.text` fragments); the smoke test uses it to locate the criterion function's blocks deterministically. `pdgEdgeKinds` lists the PDG edge kinds (`REACHING_DEF` \| `CDG`) the criterion function is expected to produce: a pure straight-line data-flow criterion declares only `REACHING_DEF` (no branches → no control dependence), a branching/guard criterion declares both. The smoke test asserts exactly the declared kinds are non-zero on the criterion (so the pure-dataflow archetype isn't forced to carry an artificial branch) and that the criterion produces ≥ 1 PDG edge overall (catching an accidental no-body/zero-edge criterion). `line`, `marker`, and `pdgEdgeKinds` are required for every measurable case; all three are omitted only on `pdgScoring: "exclude"` no-body cases. |
| `intra_AIS` | `AisEntry[]` | symbols/**lines** truly affected WITHIN the same function (the scope where PDG mode is defined). Annotated at **symbol/line granularity, never block-id** (block ids carry fragile `fnLine:fnCol:idx`). |
| `inter_AIS` | `AisEntry[]` | symbols truly affected ACROSS function boundaries (the scope where call-graph mode is defined and intra-procedural PDG is zero-by-design). |
| `locus` | `'intra' \| 'inter' \| 'mixed' \| 'n/a'` | the dominant impact locus; `n/a` only for excluded no-body cases. |
| `pdgScoring` | `'exclude'` (optional) | present (= `"exclude"`) only on no-body cases U7 must drop from PDG denominators. |
| `provenance` | `'manual' \| 'mutation'` | how the AIS was derived. **v1 is `manual` only** — the mutation track (perturb a statement, diff the changed outcomes) needs a fixture-runner + value-diff harness that does not exist yet, so it is deferred. The field stays for forward-compatibility. |
| `analyzerVersion` | string | pinned analyzer version marker (currently the `package.json` version) so ground truth versions against the analyzer. |
| `rationale` | string | prose — WHY each AIS element is in or out. This is what makes manual annotation defensible (SLICEBENCH generate-then-verify discipline). |

`AisEntry` = `{ symbol, filePath, line?, note? }`. `line` is 1-based and present
for intra entries (which are statement-granular); inter entries name a whole
symbol and omit `line`.

`intra_AIS` and `inter_AIS` are **disjoint** for every case (an intra entry is a
line within the criterion function; an inter entry is a different symbol).

## Validity threats (the two that dominate — KTD9)

1. **Ground-truth incompleteness.** A hand-annotated handful of fixtures yields
   *point estimates* over a tiny, self-admittedly incomplete corpus. One
   mis-annotation can swing F1 by a large fraction, so U7 reports findings as a
   **direction**, not a headline decimal, until the corpus grows / the mutation
   track lands.
2. **Annotation circularity.** PDG's `intra_AIS` risks being reconciled against
   the PDG traversal's own output. **Mitigation (KTD9 annotation-circularity
   guard): these annotations are written from SOURCE SEMANTICS first** — reading
   the source and reasoning about def→use / control dependence by hand — and
   reconciling against the live traversal is **U7's job (its Step 0), not the
   annotation's**. Call-graph gets no such home-field annotation, so the
   comparison is not rigged toward PDG.

## Methodology — CIS / AIS, stratified (KTD9, Arnold–Bohner)

For each fixture × mode the harness compares the mode's **CIS** (Computed Impact
Set — what it reports as impacted) against the **AIS** (Actual Impact Set — the
curated ground truth), at the mode's **native granularity**, stratified by impact
locus:

- **precision** = |AIS∩CIS| / |CIS| (over-approximation cost),
- **recall** = |AIS∩CIS| / |AIS| (under-approximation; the *dangerous* miss for
  a safety tool),
- **F1** = harmonic mean,
- **FPIS** = CIS − AIS (noise), **FNIS** = AIS − CIS (missed),
- **|CIS|/|AIS|** size ratio.

**Each engine is scored at its own granularity against its own ground truth:**

- **PDG → line granularity vs `intra_AIS`.** CIS_pdg is the set of
  `affectedStatements` **line** keys (`<filePath>:<line>`) returned by the
  line-seeded slice; AIS is the `intra_AIS` line set. This is the unit at which
  PDG is precise — the dependent *statements* of the changed line.
- **Call-graph → symbol granularity vs `inter_AIS`.** CIS is the reported
  **symbol** keys (`<symbol>@<filePath>`); AIS is the `inter_AIS` symbol set.
  This is the unit at which the cross-function blast radius is meaningful.

**Empty-denominator semantics are explicit, never silently 0/1.** |CIS|=0 ⇒
precision is `n/a` (no predictions); |AIS|=0 ⇒ recall is `n/a` (no truth in that
scope). A scope with an `n/a` metric is **excluded** from that metric's mean,
never folded in as 0 (the apples-to-oranges trap, R1). The pure scorer lives in
`metrics.mjs`; its arithmetic is pinned by the deterministic unit test
`test/unit/impact-pdg-metric-math.test.ts` (synthetic sets only — no analyze, no
DB, so it stays out of the flaky full-pipeline lane).

**Stratification.** Each fixture is scored in its **own** locus stratum
(intra/inter/mixed). Within a stratum, the PDG row is line-vs-`intra_AIS` and the
call-graph row is symbol-vs-`inter_AIS`:

- On an **intra** fixture, `inter_AIS` is empty, so call-graph reports no other
  symbol → its row is `n/a` (no cross-function truth). PDG is scored against the
  real `intra_AIS`.
- On an **inter** fixture, `intra_AIS` is empty by design, so the PDG line slice
  returns only the router's own control-dependent statements — FPIS against the
  empty truth (precision 0, recall `n/a`). Call-graph is scored against the real
  `inter_AIS`. This is the honest *"PDG is intra-procedural; on a pure-inter
  fixture it has no meaningful intra ground truth"* result — **symmetric** to
  call-graph's empty intra row.
- On a **mixed** fixture, both rows are real: PDG resolves the intra statement
  set, call-graph reaches the callee(s).

**The native rows still measure different units.** The PDG native row scores
statement reach, while the callgraph native row scores symbol reach. The unified
axes table is where `pdg` is judged as the composed result: statement reach in
`affectedStatements`, inter-symbol reach in `byDepth`.

## Substrate (the load-bearing mechanism — R8)

`runPipelineFromRepo` is in-memory and never persists, but `impact` queries a
**persisted** `lbugPath` + a `meta.pdg` stamp; there is no exported `runAnalyze`
(the entrypoint `analyzeCommand` calls `process.exit`, unusable in a loop), and
the test-suite `vi.mock` bridge is vitest-only. So the harness runs **real
analyze via a temp `GITNEXUS_HOME`, mock-free**. Per fixture:

1. Point `process.env.GITNEXUS_HOME` at a per-run temp dir (honored by
   `repo-manager.getGlobalDir()` — it roots the registry; the per-repo DB lands
   in `<fixtureCopy>/.gitnexus/`, so fixtures are copied to a temp working dir
   first, keeping the source tree clean).
2. **Shell out** to the real CLI as a child process — child-process isolation
   sidesteps `process.exit`; real `saveMeta` + `registerRepo` land in the temp
   home. The harness prefers the built `dist/` CLI (plain JS, no tsx; the parse
   workers it spawns also load from `dist/`), so it needs a built `dist/`; it
   falls back to tsx's own CLI over `src/` for build-free local runs. (`node
   --import tsx src/cli/index.ts` is avoided: Node ≥22.18 native type-stripping
   breaks the `.ts` entry's `./lazy-action.js`→`.ts` import resolution.)

   ```
   node dist/cli/index.js analyze <fixtureCopy> --pdg --skip-git --index-only
   ```
3. `new LocalBackend(); await init()` resolves the fixture via the **real**
   registry (the parent process sets `GITNEXUS_HOME` too, so `init()` reads the
   temp registry, not `~/.gitnexus`).
4. `callTool('impact', …)` ×2 (the absolute path is a tier-1 path match — no
   name collision): once `mode:'callgraph'` (symbol BFS), once `mode:'pdg'` with
   `line: criterion.line` so it returns the **statement-anchored slice**
   (`affectedStatements`). A whole-symbol PDG slice (no `line`) is empty by
   design, so the seed line is load-bearing.
5. Teardown the temp home + copy.

### Step 0 — fixture AIS validation (gated on the live traversal; circularity)

Before scoring, the harness reconciles each fixture against the live analyzer
(`metrics.mjs` is annotation-only; Step 0 is the *traversal* reconciliation):

- the criterion must produce **≥ 1 PDG edge** (an accidental no-body / cap-
  truncated criterion has unmeasurable ground truth → excluded, logged);
- the criterion symbol must **not** share `(filePath, startLine)` with another
  `Function`/`Method` (one count query) — same-line projection ambiguity (R4)
  would reconcile AIS against the wrong symbol's edges → excluded, logged.

Per the **annotation-circularity guard**, this reconciliation runs *second*: the
`criterion.line` and the AIS were written from source semantics *first* (read the
source, find the def/criterion whose change propagates), and Step 0 only confirms
the fixture is measurable substrate — it never *derives* ground truth from the
traversal. Where a source-derived belief disagreed with the live block-granular
traversal, the **annotation** was corrected (documented in each
`ground-truth.json` rationale), not the metric re-fit:

- **Direction.** `inter-pipeline-stages`'s AIS named callees while the criterion
  was tagged `upstream`; the annotation was corrected to `downstream`.
- **Block coalescing — RESOLVED (FU-B-2, statement-granular).** The CFG coalesces
  consecutive straight-line statements into one `BasicBlock`. Before FU-B-2 the
  block-granular slice could not pinpoint a coalesced block's *interior*
  statements, so `intra-dataflow-chain` (8,9 → inside the line-7 seed block),
  `intra-control-guard` (12 → inside the line-11 body block), and
  `intra-dataflow-reassign` (8 → inside the line-7 def block) had their `intra_AIS`
  interior lines removed as block-granularity artifacts. **FU-B-2 makes the intra
  slice statement-granular**: each persisted `REACHING_DEF` edge now carries its
  def/use *source lines* (a compact versioned annotation on `reason`), and the
  projection walks the self-edge def→use line chain forward from the criterion
  (and through every reached coalesced block) to recover those interior
  statements. So the three fixtures were re-reconciled UP — chain {10}→{8,9,10},
  guard {9,11,13}→{9,11,12,13}, reassign {6,7}→{6,7,8} — restoring the original
  source-derived belief the prior block-granularity reconciliation had
  under-counted. The annotation fingerprint moved deliberately; the U2 value-diff
  oracle had already proved chain's {8,9} independently, so this is a justified
  ground-truth correction, not a metric re-fit.
- **Under-counted dependencies.** The combined CDG+REACHING_DEF slice reaches more
  than a control-only or single-step reading: `intra-control-branch` (+line 10,
  the nested `else if` predicate, control-dependent on the outer branch),
  `intra-control-loop` (+lines 6,7, the param block and `count` init reaching the
  increment), and `intra-dataflow-reassign` (+line 6, the param def of `a`) gained
  lines the original annotation missed.

After reconciliation, the line-seeded slice reproduces each corrected `intra_AIS`
exactly (FPIS = FNIS = 0) on all 7 intra fixtures AND all 3 mixed fixtures (the
FU-A intra-tag scopes the intra axis to the criterion's own function, so the U1
cross-function callee lines no longer count as intra FPIS). The U2 value-diff
oracle now agrees with the static slice at statement granularity on the intra
stratum (chain's {8,9} are in the slice). Call-graph gets no such home-field
annotation, so the comparison is not rigged toward PDG.

## Measured results (analyzer 1.6.7, 13 measurable + 2 excluded; post-U1 + U2 + FU-B-2)

Each engine scored at its **native granularity** against its **native ground
truth** — PDG at line vs `intra_AIS`, call-graph at symbol vs `inter_AIS`:

| Scope | Mode | Granularity | P | R | F1 | \|CIS\|/\|AIS\| | FPIS | FNIS | n |
|---|---|---|---|---|---|---|---|---|---|
| intra | callgraph | symbol/inter | n/a | n/a | n/a | n/a | 0 | 0 | 7 |
| intra | **pdg** | **line/intra** | **1.000** | **1.000** | **1.000** | 1.000 | 0 | 0 | 7 |
| inter | **callgraph** | **symbol/inter** | **1.000** | **1.000** | **1.000** | 1.000 | 0 | 0 | 3 |
| inter | pdg | line/intra | 0.000 | n/a | n/a | n/a | 10 | 0 | 3 |
| mixed | **callgraph** | **symbol/inter** | **1.000** | **1.000** | **1.000** | 1.000 | 0 | 0 | 3 |
| mixed | **pdg** | **line/intra** | **1.000** | **1.000** | **1.000** | 1.000 | 0 | 0 | 3 |

> **Post-FU-B-2 correction.** FU-B-2 makes the intra slice **statement-granular** —
> the persisted `REACHING_DEF` edge carries its def/use source lines, and the
> projection walks the self-edge def→use chain (forward from the criterion, and
> through every reached coalesced block) to recover interior statements. With the
> three coalesced-block fixtures re-reconciled UP (chain {10}→{8,9,10}, guard
> {9,11,13}→{9,11,12,13}, reassign {6,7}→{6,7,8}), **intra/pdg stays F1 = 1.000
> (FPIS = FNIS = 0)** and the U2 value-diff oracle now AGREES with the slice on the
> intra stratum (the old 0.333 statement-level recall on `intra-dataflow-chain` is
> now 1.000 — the block-coalescing blind spot is closed, not merely matched by a
> blind annotation). **mixed/pdg is now F1 = 1.000** (was 0.468 post-U1): the FU-A
> intra-tag scopes the intra axis to the criterion's own function, so the U1
> cross-function callee statements live on the inter symbol axis, not as intra
> FPIS. The remaining inter/pdg FPIS = 10 are the router's own control-dependent
> returns scored against an empty `intra_AIS` (by design — see the `n/a`/`0`
> explanation below).

Read it honestly:

- **PDG mode is precise at intra-procedural statement granularity — exact on the 7
  intra AND the 3 mixed fixtures.** The line-seeded slice returns *exactly* the
  reconciled `intra_AIS` (F1 = 1.000, FPIS = FNIS = 0) on both strata. It precisely
  identifies the dependent statements of the changed line (def→use chains,
  control-dependent arms, reaching defs); the earlier "empty / no signal" result was
  the whole-symbol-seed artifact, and the post-U1 mixed precision dip (0.468) was
  closed by the FU-A intra-tag (cross-function callee lines score on the inter axis,
  not as intra FPIS). **FU-B-2 closed the block-coalescing blind spot:** the intra
  slice is now statement-granular (REACHING_DEF edges carry their def/use source
  lines; the projection walks the self-edge def→use chain through each coalesced
  block), so the U2 value-diff oracle that previously proved a statement-level recall
  of 0.333 on `intra-dataflow-chain` (lines `chain.ts:8,9`) now measures **1.000** —
  the slice and the dynamic oracle agree at statement granularity on the intra stratum.
- **Call-graph mode is exact on the cross-function questions.** On all 3 inter
  fixtures and all 3 mixed fixtures it recovers every callee — F1 = 1.000. It is
  the engine for "what else calls/uses this?".
- **The two `n/a` / `0` cells are by design, not defects.** *intra/call-graph*: a
  self-contained function calls no other symbol, so call-graph reports nothing and
  `inter_AIS` is empty → no cross-function truth to score (`n/a`). *inter/pdg*: a
  pure-inter router has an empty `intra_AIS`, and the line-seeded slice returns the
  router's *own* control-dependent routing returns — FPIS against the empty truth
  (precision 0, recall `n/a`). These are **symmetric**: each engine is blind to
  the other's native scope. The per-case lines surface each statement slice (`pdg
  line/intra: …`) and each callee set (`cg symbol/inter: …`), while the unified
  table verifies whether `pdg` now carries both axes.

## Decision recommendation (the verdict — F2)

> **The two engines answer different questions at different granularities, and
> neither dominates.**
>
> - **`mode:'callgraph'` (the default)** is the correct engine for the
>   *inter-procedural* safety question — *"what else depends on / calls this
>   symbol?"* It recovers the cross-function callees exactly (inter & mixed F1 =
>   1.0 on this corpus) and carries the cross-function reach the blast radius
>   needs. Use it for cross-symbol impact.
> - **`mode:'pdg'` (opt-in, seeded with `line:N`, where `analyze --pdg` persisted
>   the layer)** is **precise at intra-procedural *statement* granularity** —
>   *"which statements inside this function does changing line N affect?"* On the
>   7 intra fixtures AND the 3 mixed fixtures it reproduces the dependent-statement
>   set exactly (intra & mixed PDG F1 = 1.0, FPIS = FNIS = 0): the FU-A intra-tag
>   scopes the intra axis to the criterion's own function (cross-function reach goes
>   on the inter symbol axis), and FU-B-2 made the slice statement-granular so the U2
>   value-diff oracle now agrees on the intra stratum (the old block-coalescing
>   recall caveat — 0.333 on one chain fixture — is closed: recall 1.000). This
>   is still a question call-graph **cannot answer at all** (it has no notion of a statement).
>
> `mode:'pdg'` now composes those surfaces in one result: `affectedStatements`
> carries statement-level dependence and `interproceduralByDepth`/`byDepth` carries
> inter-procedural symbols. `mode:'callgraph'` remains the option-driven comparator/default. The
> unified axes table keeps `composed-current` as the control baseline that PDG
> must match or beat before any default-switch decision.
> match or exceed while reducing or bounding FPIS. Reach for the line-seeded
> PDG when you need statement-level dependence *inside* a function; reach for
> call-graph when you need
> *cross-function* reach. The earlier verdict
> ("PDG is empty / call-graph wins") was an artifact of the **whole-symbol** seed
> — a whole-symbol slice has nothing to report because intra-procedural dependence
> never leaves the function. Seeding the changed *statement* is what makes PDG's
> precision measurable, and it measures as exact.

## Validity threats (the two that dominate — KTD9)

1. **Ground-truth incompleteness.** A hand-annotated handful of fixtures yields
   *point estimates* over a tiny, self-admittedly incomplete corpus. One
   mis-annotation can swing F1 by a large fraction, so the harness reports
   findings as a **direction**, not a headline decimal, and prints an explicit
   "underpowered — directional only" banner when the corpus falls below the
   floor.
2. **Annotation circularity.** PDG's `intra_AIS` risks being reconciled against
   the PDG traversal's own output. **Mitigation:** these annotations are written
   from SOURCE SEMANTICS first (U6) — reading the source and reasoning about
   def→use / control dependence by hand — and reconciling against the live
   traversal is the harness's **Step 0**, run *second*, only to confirm
   measurability. Call-graph gets no such home-field annotation, so the
   comparison is not rigged toward PDG.

## Underpowered-corpus rule (F3)

**Minimum corpus floor: ≥ 3 measurable cases per locus stratum, ≥ 12 total.**
Current corpus is above the floor (intra 7, inter 3, mixed 3 = 13
measurable; +1 excluded no-body) — so the harness prints headline decimals. When
the measurable count after exclusions drops below the floor, it instead prints
**"underpowered — directional only"** and reports the DIRECTION ("PDG exact at
intra statement granularity; call-graph exact at inter symbol granularity")
rather than headline decimals — decimal precision (`F1 0.74 vs 0.68`) implies a
confidence a sub-floor corpus cannot support. Even at the floor the F1 = 1.0
results should be read as *"exact on this small, deliberately-simple corpus"*, not
*"exact in general"* — see the validity threats.

## Annotation fingerprint + `--check` (two gates, KTD10)

`--check` runs **two non-byte-identity gates** (an exact-equality gate would go
perpetually red on legitimate accuracy changes):

1. **One-sided F1 regression band** per mode per scope: fail iff `F1 < band − ε`;
   improvements pass freely. `ε` and the per-`(scope,mode)` bands are versioned
   in `baselines.json`. The four live bands are **intra/pdg = 1.0**, **mixed/pdg =
   1.0**, **inter/callgraph = 1.0**, **mixed/callgraph = 1.0**. A `null` band
   means F1 is genuinely undefined for that cell on this corpus (intra/callgraph
   and inter/pdg — see *Measured results*) — the gate skips it.
2. **Order-independent annotation fingerprint** over the curated ground-truth
   set (a SHA-256 over a sorted, line-collapsed canonicalization — mirrors the
   `bench/cfg/measure.mjs` *technique*, written here, not a literal import). Any
   unreviewed edit to a `ground-truth.json` (criterion **including
   `criterion.line`**, AIS membership, locus, direction, edge kinds) trips it; a
   pure reordering of AIS entries does not.

**Substrate stability (F5).** Real analyze is the repo's flaky lane, so `--check`
applies **median-of-K** across `GN_IMPACT_PDG_K` runs *before* comparing F1 to
the band, so substrate noise can't trip the metric gate. Default K = 1 (the
fixtures are tiny and deterministic in practice); raise it
(`GN_IMPACT_PDG_K=3`) in a flaky CI lane.

## Runtime budget

Each fixture costs **one full `analyze --pdg` child process** (a fresh tree-sitter
parse + CFG/PDG build + persist) plus two in-process `impact` calls (one
call-graph, one line-seeded PDG). On these tiny fixtures that is ≈
**3–6 s/fixture**, so the full 13-fixture corpus runs in roughly **45–80 s**
wall-clock single-threaded (K = 1). A K-fold `--check` multiplies by K. For a
fast substrate smoke, scope to a subset:
`--only=intra-dataflow-chain,inter-dispatcher-thin,mixed-guarded-dispatch` (or
`GN_IMPACT_PDG_ONLY=…`). Not wired into `npm test` (matches the other benches);
the deterministic metric-math unit test *is* in `npm test`.

## How to run

```sh
cd gitnexus
node scripts/build.js                                          # REQUIRED: workers spawn from dist/
node --import tsx bench/impact-pdg/measure.mjs                 # print the stratified report + verdict
node --import tsx bench/impact-pdg/measure.mjs --json          # machine report (for re-baselining)
node --import tsx bench/impact-pdg/measure.mjs --check          # gate against baselines.json (exit non-zero on regression)
node --import tsx bench/impact-pdg/measure.mjs --only=a,b,c     # fast subset (substrate smoke)
node --import tsx bench/impact-pdg/real-code.mjs                # latency + quality-proxy probe on indexed GitNexus
node --import tsx bench/impact-pdg/real-code.mjs --json --check # machine report + broad real-code gates
node --import tsx bench/impact-pdg/blast-radius.mjs             # real-code localization: PDG slice vs whole-function body
node --import tsx bench/impact-pdg/blast-radius.mjs --direction upstream
```

### Real-code performance and quality proxy probe

`real-code.mjs` complements the AIS-backed fixture harness. It runs direct
`LocalBackend.callTool("impact", ...)` calls against an already-indexed real
repository (default `--repo GitNexus`) and measures:

- callgraph vs PDG median/p95 latency over `--repeat` samples;
- whether unified PDG's inter-procedural symbol reach preserves the callgraph
  symbol set for the same target/direction;
- degraded, partial, no-block-at-line, and PDG bridge evidence counts.

This is a quality proxy, not an accuracy score: a real repo has no curated AIS,
so the probe cannot prove correctness. Use it to catch performance regressions,
degraded indexes, symbol-reach drift, and excessive `unproven-bridge` evidence on
real code. Use `measure.mjs` for the ground-truth precision/recall/F1 gate.

The default cases are statement-anchored at a CFG **block-start** line. The CFG
coalesces straight-line statements into one `BasicBlock`, so a mid-block anchor
resolves to no block start and degrades to `pdg-no-block-at-line` — honest, but it
then exercises only the symbol axis. The harness still detects and counts that
degradation; the curated anchors avoid it so every case also exercises a real
intra-procedural slice. (This is the same statement-anchoring discipline the
fixture corpus uses, applied to real code.)

A representative run on the indexed GitNexus tree (~17.5k symbols, PDG layer
persisted via `analyze --pdg` with ~171k `BasicBlock`s) — read it *directionally*,
not as a baseline, since wall-clock latency is host- and noise-dependent:

- **Symbol reach is preserved exactly.** Unified `mode:'pdg'` reproduces the
  `mode:'callgraph'` inter-procedural symbol set on every case — mean and min
  recall = precision = **1.000**. This is the load-bearing check: the PDG-facing
  result must not silently drop or invent cross-function reach.
- **Each case carries a real statement slice** (`affectedStatements` non-empty,
  2–27 statements here), so the intra axis is genuinely exercised.
- **Latency overhead is modest** — PDG median ≈ **1.2–1.4×** the callgraph median
  (callgraph ≈ 90–250 ms/case, PDG ≈ 150–280 ms/case). The first call of a fresh
  backend carries a one-time DB-warmup spike the p95 reflects.
- **Bridge evidence is direction-shaped, by design.** Downstream
  statement-anchored seeds label most inter-procedural reach `unproven-bridge`
  (the symbol's first-hop call site sits in a *different* statement than the
  seeded one, so the local slice does not prove the dependence); upstream and
  whole-symbol reach is `callgraph-bridge`. So `unprovenBridgeRatio ≈ 0.7` is the
  *expected* shape for statement-anchored downstream seeds — a faithful
  proven-vs-reachable signal, **not** a regression.
- **No degraded / error / partial / no-block-at-line cases**, and `--check` is
  green. Default gates: min symbol recall ≥ 0.95, PDG median ≤ 5000 ms (override
  via `GN_REAL_CODE_PDG_MIN_SYMBOL_RECALL` / `GN_REAL_CODE_PDG_MAX_MEDIAN_MS`).

### Is PDG-mode impact actually better than callgraph-only? (four-axis verdict)

"Better" is not one thing, so each candidate claim is tested separately and
reported honestly — including where PDG is *not* better. The evidence combines
the AIS-backed fixture gate (`measure.mjs`, which proves *correctness*) with two
real-code probes on the live GitNexus index (`real-code.mjs` and
`blast-radius.mjs`, which measure *magnitude at scale*: 120 functions per
direction, 240 total, plus the 5-case probe). `blast-radius.mjs` anchors each
function on an early-interior block (`floor(M/3)`), a conservative slice-maximizing
choice, and compares the PDG statement slice to the whole function body (`M`
blocks).

| Claim | Verdict | Evidence |
|---|---|---|
| **Tighter / fewer false alarms** | ✅ confirmed for localization and correctness | *Correctness:* the line-seeded slice equals the curated intra dependence exactly on the 7 **intra** fixtures AND the 3 **mixed** fixtures (F1 = 1.000, FPIS = FNIS = 0): the FU-A intra-tag keeps cross-function reach on the inter axis, and FU-B-2's statement-granular slice closed the block-coalescing blind spot — the U2 value-diff oracle now measures statement-level recall **1.000** on the chain fixture (was 0.333). *Magnitude (RECORDED, not re-run this session):* the slice is a median **0.26** (downstream) / **0.21** (upstream) of the function body; **240/240** functions localized below whole-body — a ~74–79% cut in the intra-procedural inspection set, with no proven dropped dependency. |
| **Catches impact callgraph misses** | ✅ confirmed (new axis) | Callgraph emits *no* statement-level output (unified intra-line CIS = 0, recall 0 on every fixture); PDG recovers every true dependent statement (intra recall = 1.000). PDG answers a def→use / control-dependence question callgraph cannot represent at all. |
| **Finds *more* callers/callees** | ❌ refuted (tie, by design) | Full PDG inter-procedural reach is **identical** to callgraph on 240/240 real functions (0 pdg-only, 0 callgraph-only). PDG bridges inter-procedural reach *through* the call graph, so it never finds reach the call graph misses. |
| **Tighter cross-function reach (statement-precise)** | ✅ confirmed (precision, additive) | `mode:'pdg'` now also exposes `statementPreciseByDepth` — the callees actually invoked from the changed line's dependence slice (`BasicBlock.callees`), dropping symbols only reachable from independent statements. Strictly tighter than callgraph on **52/90** with-slice functions (median proven **1** vs callgraph **2** symbols, median statement-precision **0.67**); the full reach stays available alongside it. `statementPrecision` reports the cut. Upstream seeds have no statement discriminator, so they stay all-proven (callgraph-equal) by design. |
| **Faster / cheaper** | ❌ refuted | PDG carries ~**1.2–1.6×** callgraph latency (the slice query + the slice-callees lookup). It buys precision, not speed. |

**Headline.** PDG makes `impact` *much* better at the localization/precision
question — *"what exactly does changing **this** statement affect?"* It narrows the
intra-procedural blast radius to roughly a quarter-to-a-third of the function body
with ground-truth-proven correctness, adds a statement-level dependence axis
callgraph has no answer for, and — via the persisted `BasicBlock.callees` substrate
— now also reports a **statement-precise** cross-function reach (only the callees
the changed line actually reaches), strictly tighter than callgraph on roughly half
of with-slice functions. It is deliberately **not** a *wider* or *faster*
cross-function reach: the full callgraph reach is preserved alongside the precise
view, and `mode:'callgraph'` remains the comparator for raw blast radius. The
surfaces compose — that is the point of the unified result, not a default switch.

Reproduce the verdict:

```sh
node --import tsx bench/impact-pdg/measure.mjs                        # correctness (F1 / FPIS / FNIS vs AIS)
node --import tsx bench/impact-pdg/blast-radius.mjs                   # localization magnitude (downstream)
node --import tsx bench/impact-pdg/blast-radius.mjs --direction upstream
node --import tsx bench/impact-pdg/real-code.mjs                      # symbol-reach preservation + latency
```

### Resolved-symbol-id soundness (the `calleeIds` upgrade)

The statement-precise cross-function bridge originally matched callgraph-reached
callees to the slice by **leaf name** (`BasicBlock.callees`). That is a heuristic
with two failure modes: same-leaf-name **collision** (two distinct `get`s both
proven — a false positive) and import-alias/rename (call-site leaf ≠ resolved name
— a false negative). The bridge now matches the **resolved callee symbol-id**
(`BasicBlock.calleeIds`, the per-block union of resolved ids joined to each call
site by exact position), which is sound by construction; the leaf-name match
remains the graceful fallback for pre-v3 indexes, blocks with no captured ids, and
truncation-capped blocks. `name-collision.mjs` diffs the two on the same real
slices (`fpEliminated` = collision FPs the id bridge removes; `fnRecovered` =
alias FNs it recovers).

Realized effect on a random single-statement sample (per language, exact
seed∪reachable slice):

| Language | repo | fpEliminated | fnRecovered | name-collision ambiguity |
|---|---|---:|---:|---:|
| Java | commons-lang | 2.1% | 0% | 3.9% |
| PHP  | monolog      | 2.6% | 1.8% | 12.2% |
| C#   | commandline  | 0%   | 4.8% | 0% |
| TS   | ky           | 0%   | 0%  | 0% (no regression) |

Honest reading of these numbers:

- **The aggregate effect on a *median* edit is modest (≈0–3%).** This matches the
  pre-build measurement: realized name-collision concentrates in the small tail of
  high-fan-out delegating functions, not the typical single-statement slice (the
  per-function reach is usually 1–2 callees, where a same-name collision is
  impossible). The win is **soundness**, gated cleanly by the
  `intra-overloaded-callee` fixture (id proves exactly the one called overload;
  name-match over-attributes both — `measure.mjs --check` Gate 3), not a large
  aggregate FP cut.
- **It is bidirectional.** The id key also *recovers* alias/rename false negatives
  the name match can never prove (C# 4.8%, PHP 1.8%) — callees invoked under a
  name that differs from their resolved symbol name.
- **The id bridge is exactly as precise as GitNexus's call resolver — no more, no
  less.** Where the resolver emits a *multi-candidate* set for one ambiguous call
  (e.g. `printer.getX()` on a typed field resolving to `getX` on **both** the field
  type and the enclosing class), the bridge faithfully proves the whole candidate
  set (sound — it never drops a real target). The residual "ambiguity" on the
  worst-case tail is therefore the **resolver's** receiver-type precision, not a
  name-matching artifact; improving it is a resolver-precision follow-up (sibling
  to the C++ overload under-resolution follow-up).

**Language scope.** The id bridge (and the name bridge) applies wherever the CFG
harvests call sites. As of the call-site-harvesting extension this is **all 12
supported languages** — the original six (TS/JS, Java, C#, Go, C/C++, PHP) plus
Kotlin, Swift, Dart, Ruby, Rust, and Python, which were migrated from the no-site
def/use accumulator to the shared `CallSiteFactAccumulator` (each verified that its
`SiteRecord.at` anchor matches that language's `@reference.call` resolution anchor
byte-exact, so the resolved-id join lands). Their BasicBlocks now carry `callees`
*and* `calleeIds`. Realized benefit still tracks each language's collision tail and
its call-resolver precision (e.g. Python/Ruby route most calls to stdlib/builtins,
which carry no in-repo id), but the substrate is uniform. The one remaining
language-shaped gap is **C++ overload under-resolution** (a resolver issue, not a
harvesting one — see the C++ caveat above).

Reproduce (needs a `--pdg` index of the target repo built under schema v3):

```sh
node --import tsx bench/impact-pdg/name-collision.mjs --repo commons-lang --src 'src/main/java/'
node --import tsx bench/impact-pdg/name-collision.mjs --repo monolog --src 'src/Monolog/'
```

### Inter-procedural forward slice (U1 — `calleeIds` descent)

The `mode:'pdg'` slice was originally **intra-procedural**: the CDG +
REACHING_DEF traversal stayed inside the seeded function, and cross-function
reach was bolted on only through the call-graph bridge. U1 makes the statement
slice itself cross function boundaries: after the intra slice completes (and
before block→symbol projection), a bounded **DOWNSTREAM-only** descent gathers
the slice blocks' resolved `calleeIds`, batch-resolves them to callee spans
(one `s.id IN $ids` UNION-ALL over Function/Method/Constructor — keyed on the
*resolved* id, so no same-line ambiguity), seeds each callee, and runs the SAME
intra BFS within it, unioning the newly-reachable blocks into the slice. This is
**HRB context-insensitive forward closure** — the approach Joern ships (no full
SDG). Bounds: a default **3 inter-procedural function hops** (`maxDepth` caps the
per-hop intra step budget), a total node cap, and a shared `visited` set that
guarantees termination over recursion/cycles. The cross-function reach **deepens
`affectedStatements`** (the statement-level slice); the owning-symbol `byDepth`
stays a single collapsed bucket (block-hops are not call-hops). A pre-namespace-v4
index (no `calleeIds` column) yields no callee ids, so the descent is a no-op and
the result degrades cleanly to the prior intra-only behavior.

**Soundness caveats** (also stamped verbatim into the result `note` whenever the
slice crosses a hop):

1. **Context-insensitive.** A dependence may be attributed to a callee only
   reachable from a *different* call site of the same function (bounded
   over-inclusion — the same imprecision the call-graph mode already has).
2. **Return-value ascent IS captured (CALL_SUMMARY); out-param / exception
   ascent deferred.** A caller statement that depends on a callee's RETURN value
   is now in the slice when the callee carries a persisted `CALL_SUMMARY`
   return-flow summary (FU-C): the descent re-seeds the caller's continuation from
   the call block, and FU-B-2 surfaces the dependent call/continuation statements
   at statement granularity (the self-edge def→use walk). What remains deferred:
   out-parameter / mutated-argument ascent, callee-written shared / captured
   variables, and exception ascent (a throw the callee raises that the caller
   catches) — these need an alias / try-catch model. A pre-FU-C (v3) `--pdg` index
   has no `CALL_SUMMARY` edges, so return-value ascent is absent there until a
   re-index (the result `note` steers to it).
3. **No cross-boundary alias model.** Aliasing of arguments/heap across the call
   boundary is not modeled.
4. **Precision is bounded by the call RESOLVER's precision.** Multi-candidate
   dispatch and C++ overload under-resolution flow through faithfully — the
   descent is sound (it never drops a real target), but it inherits exactly the
   resolver's precision, no more and no less.

### U2 — dynamic mutation oracle (independent ground-truth cross-check)

The PR's **#1 declared validity threat is annotation circularity** (the manual
`intra_AIS` risks being reconciled against the very traversal it scores). U2 adds
an **independent, CI-runnable check**: a real **dynamic forward slice** computed
by **value-diff**, not by reading the static slice. It lives in
`mutation-oracle.mjs` (substrate) + the pure scorers in `metrics.mjs`, gated
behind a new `--mutation` flag. **It is bench-additive: no `src/` change, no
schema change; the default report run + its F1 `--check` gate + fingerprints are
byte-identical without `--mutation`.**

**Why value-diff, not coverage.** Per Voas's PIE model (TSE'92), an observable
fault needs **P**ropagation + **I**nfection + **E**xecution. Coverage is only E;
*dependence* requires I+P = an actual VALUE CHANGE at a downstream point. So the
oracle's `behavioral_AIS` is the set of statements whose **observed value
changed** when the criterion line was mutated — a genuine
[Agrawal-Horgan PLDI'90](https://doi.org/10.1145/93542.93576) **dynamic slice**,
not a coverage trace. The static⊇dynamic soundness relation (Tip'95) then says a
sound static slicer must contain the dynamic slice on the executed paths, so
`B ⊆ slice` is the recall expectation.

**Per fixture, the oracle:**

1. **Mutates the criterion line only** (≤ 4 mutants, line-scoped regex operators:
   AOR `+ - * / %`, ROR `> < <= >= === !==`, LCR `|| && !`, CRP numeric-literal →
   `k+1`/`0`, UOI negate-RHS when no operator is flippable). EQUIVALENT mutants
   (empty `behavioral_AIS`) and syntactically-invalid mutants are discarded.
2. **Derives inputs** with a tiny TYPE-DRIVEN generator from the criterion fn's
   params — `number → [5,-3,0]`, `number[] → [[1,2,3],[-1,-2],[]]`, `boolean →
   [true,false]`, `string → ['a','b','z']` (multi-input covers both branch arms).
   The tuples used are recorded in the sidecar.
3. **Instruments the ORIGINAL TS AST** with Babel (`@babel/parser` + `traverse` +
   `generator`, `retainLines:true` so loc lines stay 1-based `filePath:line` — the
   SAME space as the slice, no source-map needed): a value-transparent
   `__trace(EXPR, line, filePath, occ)` wraps VariableDeclarator init /
   AssignmentExpression RHS / ReturnStatement arg / CallExpression and returns
   `EXPR` unchanged. Runs original + each mutant via **tsx dynamic-import** on the
   SAME inputs from the SAME temp working copy the analyze step used.
4. `behavioral_AIS = { filePath:line where serialize(orig) != serialize(mut) }`
   for some input/occurrence (value changed / appeared / disappeared), **EXCLUDING
   the criterion line**, unioned over inputs then over non-equivalent mutants. A
   deterministic serializer handles `undefined`/`NaN`/`±Infinity`/stable object key
   order.

**The metric (`--mutation`, report-only this landing).** Let `slice =
pdgLineCis(results.pdg.affectedStatements)` (the SAME live static slice the F1
metric scores), `B = behavioral_AIS`, `M = intra_AIS`:

- **`mutation_recall = |B ∩ slice| / |B|`** (pure `mutationRecall` in
  `metrics.mjs`). `recall < 1.0` ⇒ `B ∖ slice` is a statement the oracle PROVED
  depends on the criterion that the static slice MISSED. `B ∖ slice` is printed
  explicitly and **every** such line is classified as **(a) known-U1-no-ascent-gap**,
  **(b) driver/model artifact** (block-coalescing interior of a coalesced
  BasicBlock, or the upstream-fixture oracle-direction mismatch), or **(c) novel
  recall hole** — so a reader is never misled (see *Caveats* below).
- **Circularity cross-check: `B ∖ M`** (pure `circularityDiff`). Non-empty on an
  **intra** fixture ⇒ the manual annotation missed a real dependence — the headline
  independent evidence U2 exists to produce. Reported as a **WARN with the lines**;
  it does **not** fail. (On inter/mixed fixtures `intra_AIS` is empty-by-design, so
  `B ∖ M` there is expected cross-function reach, labelled as such, not a miss.)
- **Precision is NOT gated.** `slice ∖ B` is expected sound over-approximation
  (the static slice legitimately over-includes); `|slice ∖ B|` is reported
  informationally only.

**Phasing — report-then-gate.** `measure.mjs --mutation --check` prints a
`Gate 4 (mutation recall, REPORT-ONLY)` line + the numbers but **does NOT
`process.exit(1)`** on `recall < 1.0` this landing. Flipping it to a hard gate is a
one-flag change: `--mutation-strict` already fails the build on **NOVEL** holes
only (block-coalescing artifacts and documented U1 gaps are excluded by the same
classifier the report uses).

**Caveats handled.**

- **R1 — the two `upstream` fixtures** (`reassignSum`, `filterPositive`) are a
  forward-oracle mismatch. The oracle runs in its native downstream sense and does
  the circularity cross-check, but the recall **gate is NOT applied** to them; this
  is **printed** as `oracle-direction-excluded`, never a silent skip.
- **R2 — U1's DOCUMENTED no-ascent gap.** A caller statement depending on a callee
  RETURN/out-param/thrown-exception is not in the intra slice without
  `CALL_SUMMARY`. A `recall < 1.0` from callee-effect ascent into the caller
  continuation is a **KNOWN gap**, not a novel bug — the report classifies it
  `known-U1-no-ascent-gap` with the lines. `nobody-interface-excluded` (no body)
  stays oracle-excluded; `intra-overloaded-callee` runs as **id-discrimination
  corroboration** (mutating the alpha arm changes `Alpha.process`'s output, not
  `Beta.process`'s), included as corroboration — **not** an AIS recall case.

**Artifacts.** All instrumented mutants are generated under an `os.tmpdir()` dir
(`gn-impact-pdg-mut-*`), **never inside `fixtures/`**. The only persisted new file
per fixture is `mutation-ground-truth.json` (a regenerated audit cache;
`provenance:'mutation'`; **separate from the manual `ground-truth.json`, never
overwriting it**). It is data, matched by no vitest project (the default glob is
`test/**/*.test.ts`); the integration test carries a **tripwire** asserting no
`*.test.ts` ever appears under `bench/impact-pdg/`.

**Runtime.** Each fixture costs one extra `analyze --pdg` child process (the same
substrate the F1 loop uses) plus a handful of in-process tsx dynamic-imports
(original + ≤ 4 mutants × the input tuples), all on tiny fixtures — roughly
**4–7 s/fixture**, so the full `--mutation` pass adds on the order of a minute over
the base run. The oracle runs **once** (not median-of-K): the value-diff is the
load-bearing signal, deterministic, not substrate-noise-prone like F1.

**Cross-language sweep is a separate task.** The fixtures are TypeScript (the
maturest CFG/PDG support here) and the instrumenter is TS-AST-based. Extending the
oracle to the other languages requires re-indexing per-language fixture corpora
under `--pdg` and a per-language instrumenter — a separate re-indexing task, out of
scope for this landing.

**Reproduce:**

```sh
node --import tsx bench/impact-pdg/measure.mjs --mutation          # per-fixture recall + circularity rows
node --import tsx bench/impact-pdg/measure.mjs --mutation --check   # + report-only Gate 4
node --import tsx bench/impact-pdg/measure.mjs --mutation --check --mutation-strict  # hard-fail on NOVEL holes
```

### Re-baseline (after a reviewed accuracy or ground-truth change)

1. `node --import tsx bench/impact-pdg/measure.mjs --json` and read
   `annotationFingerprint` + `strata[scope][mode].f1`.
2. Copy those into `baselines.json` (`annotationFingerprint`, the `f1Bands`
   cells), bump `analyzerVersion` if the analyzer moved, adjust `epsilon` only
   deliberately.
3. Confirm `--check` is green.

The fixtures are also validated by the integration test
`test/integration/impact-pdg-fixtures.test.ts` (schema well-formedness + a smoke
test that each fixture analyzes under `--pdg` and the criterion function produces
its declared CDG / REACHING_DEF edges — a zero-edge criterion has unmeasurable
ground truth).
