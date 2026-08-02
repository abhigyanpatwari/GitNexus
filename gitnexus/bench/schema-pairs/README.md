# Schema pair-set bench (#2793)

What a bigger `CodeRelation` FROM/TO pair set costs at query time, measured
against a real `@ladybugdb/core` database.

```bash
# from gitnexus/
node --import tsx bench/schema-pairs/measure.mjs           # print one JSON line per size + a summary
node --import tsx bench/schema-pairs/measure.mjs --check    # gate vs baselines.json
```

## Why it exists

`src/core/lbug/schema.ts` generates its relation pairs from two cross products,
and declines to add a third one **on the strength of a number** — roughly 1.04×
at 450 declared pairs, 1.6× at 786, 2.1× at 1024. That measurement used to live
in a scratch directory, so nobody proposing a third rule could re-run it. This
harness is that measurement, committed — and it reproduces those figures.

Run it before widening a rule, and quote the new ratio in the review.

Observed on the reference box, **four runs** (ratios vs the 332-pair list):

| pairs | untyped    | typed (floor) |
| ----- | ---------- | ------------- |
| 332   | 1.00×      | 1.00×         |
| 450   | 0.93–1.05× | 0.98–1.17×    |
| 641   | 1.22–1.43× | 1.11–1.23×    |
| 786   | 1.52–1.75× | 1.19–1.31×    |
| 1024  | 2.03–2.34× | 1.31–1.57×    |

Production's 450 came out _faster_ than 332 on three of the four runs, so at this
size the pair count is inside run-to-run noise. Everything past ~640 is not.
**Quote the range, not a single run** — one run is not evidence here.

## What it measures

For each pair-set size it builds a fresh database with all 32 node tables, a
`CodeRelation` table declaring exactly that many FROM/TO pairs, and **identical
data**, then times two query shapes over 40 anchors × 15 reps (median):

- **`untyped_ms_<size>`** — `MATCH (a {id: $id})-[r:CodeRelation]->(b)`. Neither
  endpoint is labelled, so LadybugDB must treat every declared pair as a
  candidate. This is the shape `impact`, `context` and `detect_changes` issue
  when they walk out from one node id, and the only one whose plan depends on
  how many pairs the table declares.
- **`typed_ms_<size>`** — `MATCH (a:Function {…})-[r]->(b:Function)`, the lower
  bound. Both endpoints labelled prunes the plan to a single pair, so this was
  expected to be flat in the pair count. **It is not** — up to 1.17× at 450 and
  1.57× at 1024 — so a declared-but-unused pair costs something even when the
  planner never considers it. `typed_ratio_*` is therefore the floor, not a noise
  control; the real cost of widening sits between it and `ratio_*`. A run where
  `typed_ratio` moves _more_ than `ratio` is noise-dominated and should be
  rerun.
- **`ratio_<size>`** — `untyped_ms_<size> / untyped_ms_332`. `ratio_450` is the
  figure `schema.ts` quotes.

### Sizes

The pair set is a prefix of a fixed 32×32 (`NODE_TABLES`²) enumeration, so each
size is a strict superset of the smaller ones. The four pairs the synthetic data
uses are pinned to the front, so **the same rows are reachable by the same query
at every size** — the only variable is how many unused pairs are declared. The
harness fails if the row counts ever differ across sizes.

| size | what it is                                                                                                                                                                                                |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 332  | the pre-#2792 hand-written list — the reference for every ratio                                                                                                                                           |
| 450  | production today (two cross products + 72 hand-declared pairs)                                                                                                                                            |
| 641  | the third cross product `schema.ts` defers (`DEFINITION_ANCHOR_LABELS × {CodeElement, Section, Typedef, Union, Namespace, Impl, TypeAlias, Static, Template}`), which would leave ~29 hand-declared lines |
| 786  | the size an earlier revision of that comment attributed to the third rule — it is 641; kept as a measured waypoint                                                                                        |
| 1024 | the full cross product, the ceiling                                                                                                                                                                       |

## Correctness gate

Before timing anything, the harness round-trips the **real** `SCHEMA_QUERIES`
through a real database and asserts that `CALL SHOW_CONNECTION('CodeRelation')`
reports exactly the pairs `parseRelationSchemaPairs` finds in `RELATION_SCHEMA`.

No magic number is baked in: the invariant is that the DDL LadybugDB _accepted_
carries the pair set our own parser believes it declares. The absolute count is
reported as `declared_pairs`. A pair declared twice would not reach this check at
all — LadybugDB rejects the `CREATE REL TABLE` outright, which is why a duplicate
kills every `analyze` rather than one repository's.

## What it does NOT measure

- **Ingest / `COPY` cost.** Pair-set size also multiplies the number of per-pair
  CSVs the emitter routes to (`src/core/lbug/rel-pair-routing.ts`); that cost is
  covered by `bench/emit-persistence`.
- **At-scale absolute numbers.** Row counts here are small and deliberately
  constant. The ratios are the signal; the milliseconds are box-specific.

## Regenerating the baseline

`baselines.json` holds one budget, `ratio_450_budget` — the ceiling on what
production's own pair count may cost relative to the 332-pair hand-list it
replaced. Re-run without `--check` **several times** and copy the top of the
observed `ratio_450` range plus headroom — the spread between runs on this box
is wider than the effect being measured at 450, so a single run cannot set it.
