# Emit-persistence bench (#2203)

Build-free throughput + byte-identity guard for the **CSV-generation half** of
the graph-DB persistence pipeline (`streamAllCSVsToDisk`), which dominates
large-repo `analyze` wall time alongside parsing (issue #2203).

```bash
# from gitnexus/
node --import tsx bench/emit-persistence/measure.mjs           # print one JSON line
node --import tsx bench/emit-persistence/measure.mjs --check    # gate vs baselines.json
```

## What it measures

A synthetic `KnowledgeGraph` (files + functions + classes + 4 edge types across
the `File→Function`, `File→Class`, `Function→Function` label pairs) at two
scales:

- **`elapsed_ms_small` / `elapsed_ms_large`** — median wall-clock over `REPS`
  runs of `streamAllCSVsToDisk`.
- **`scaling_ratio`** — `(t_large/t_small)/(LARGE/SMALL)`; ~1.0 is linear. The
  `--check` gate fails if it exceeds `scaling_budget` (catches an O(n²)
  re-regression in the emit/routing path).
- **`fingerprint`** — order-independent sha256 over every emitted CSV line (node
  CSVs + per-FROM→TO-label-pair rel CSVs). This is the **byte-identity gate**:
  the U2 (direct per-pair routing) and U3 (per-row microtask elimination)
  optimisations must not change graph content, and any future change that does
  fails `--check`. Byte-identity holds for all quote-free ids; for an id
  containing a `"` the router intentionally diverges from — and is more correct
  than — the legacy regex oracle (see `src/core/lbug/rel-pair-routing.ts`).

## What it does NOT measure

- **The LadybugDB `COPY` half.** Bulk loading needs a live writable DB
  connection, so it can't run build-free. Its per-stage timing lives in the
  runtime `PROF_LBUG_LOAD=1` breakdown (`[lbug-load prof] csv-emit=… copy-nodes=…
  copy-rels=… fallback=… total=…`) and is exercised end-to-end by the
  integration round-trip tests (`test/integration/basicblock-roundtrip.test.ts`,
  `lbug-core-adapter.test.ts`).
- **Content extraction.** Bench nodes have no backing source files, so the
  `content` column is empty — emit cost here reflects the CSV machinery
  (routing, escaping, buffering, disk writes), not file reads.
- **At-scale absolute numbers.** The real postgres / kernel-`fs/` wall (issue
  #2203's table) is a maintainer-run measurement; this synthetic bench is the
  reproducible regression guard, not a substitute for those runs.

## Deferred follow-up

Parallelising the `COPY` loop (`PARALLEL=false` is load-bearing; LadybugDB is
single-writer) is **out of scope** for #2203 pending empirical validation of
concurrent-COPY support — the `PROF_LBUG_LOAD` breakdown is the prerequisite
that shows whether COPY is the dominant cost worth that risk.

## Regenerating the baseline

```bash
node --import tsx bench/emit-persistence/measure.mjs    # copy fingerprint + ratio into baselines.json
```
