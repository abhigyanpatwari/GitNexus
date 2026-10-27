# MCP query performance

The **MCP query performance** CI job compares the checked-out commit with its
first parent. For a PR merge commit this is the exact base revision; release CI
compares the new main commit with the preceding main revision. Both complete
runtimes are built from their own lockfiles and run on the same Linux runner.

The job writes its table to the Actions summary and retains `report.json`,
`report.md`, `raw.jsonl`, and fixture-only server/index logs as
**mcp-query-performance** for 30 days. Reports
contain exact revisions, dependency fingerprints, fixture hash, all observations,
backend phase timings, response bytes/source characters, and server CPU/peak RSS.
No model API calls or keys are used. The existing release agent evaluation remains
the source for dollar cost and task outcomes.

## Run locally

Build both checkouts with `npm ci` and `npm run build` in `gitnexus/`, then install
the FTS extension using `npx tsx scripts/ensure-fts.ts`. From the candidate package:

```sh
node bench/mcp-query/measure.mjs \
  --baseline-root /path/to/base/gitnexus \
  --out /tmp/mcp-query-measurements --check
```

The output directory must not exist. `--candidate-root` selects another built
candidate. Without `--check`, `--sessions 1 --rounds 1` is a smoke run and cannot
establish a performance verdict. For an identical-code control, point both roots
at the same build. Do not discard slow samples or rerun until a check turns green.

The candidate indexes one fixed generated repository containing 32 short and 32
oversized TypeScript functions. Both servers read that same index. Index creation
is outside the timing window. Schemas must be compatible; an incompatible base
fails explicitly. Corpus generation and dependency installation use no model.

Eight fresh server pairs each run a warmup cycle and five measured rounds.
Request order alternates between baseline and candidate. Workloads cover small
and large sources, metadata-only queries, empty results, indexed-source context,
tool listing, and four concurrent large-source queries. Startup and startup plus
first query are recorded separately. Filesystem caches are not flushed.

## Decisions and limits

- Response identities, order and diagnostics must agree; timing, guidance and
  source representation are excluded from query equality. Indexed context source
  must agree. At least ten known matches must survive each nonempty query.
- Candidate query source cannot exceed 16,000 Unicode characters, cannot disappear
  entirely, and large previews must announce truncation. Context must retain the
  original indexed snippet (the indexer separately caps long function snippets).
  These guards prevent less work from masquerading as speed.
- Missing samples, query errors, incomplete results and invalid resource readings
  fail. A failure report and completed pairs remain available for diagnosis.
- Latency comparisons use geometric-mean paired ratios and 10,000 bootstrap draws
  clustered by server pair. A regression fails timing only when the lower bounds
  exceed both 5% and 5 ms. An upper bound below either threshold is within the
  threshold; other results are explicitly **inconclusive**, not a no-slowdown pass.
- Intervals are pointwise, not simultaneous guarantees over all workloads. p95,
  CPU and RSS are descriptive. CPU includes native worker threads; RSS is each
  server's final high-water mark. Client resources and indexing are excluded.

This bounded generated corpus guards MCP behavior and latency; it cannot establish
performance on all repository sizes, embedding search, platforms, or complete
agent sessions. Retain the separate agent-cost measurements when judging whether
an optimization actually makes agents cheaper.
