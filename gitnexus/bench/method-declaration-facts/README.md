# Shared callable declaration facts

## CI measurements

The existing **benchmarks (GITNEXUS_BENCH)** job in `ci-tests.yml` runs:

```sh
node --import tsx bench/method-declaration-facts/measure.mjs --check --output method-declaration-facts.json
```

`--check` compares the current build with committed `baseline.json`; no second
checkout is required. It checks all eight providers' semantic fingerprints and
shared parameter/type-array counts, cold/warm/changed graph and cache counts at
each workload size, and tree collection. Three fresh-process
samples report median wall/CPU time, endpoint heap, peak RSS, and retained heap,
with percentage differences from the recorded measurements. Timing and heap/RSS
are machine-dependent references, not absolute CI failure thresholds.

Like the C# pipeline benchmark, this check increases input size and compares cost
growth with input growth. It uses the stricter **1.5** normalized growth budget
already used by the Python scope benchmark:

```text
normalized growth = (large cost / small cost) / (large input / small input)
```

| Workload | Sizes | Gated costs |
| --- | --- | --- |
| Java + TypeScript, spread across files | 8 / 32 / 128 files per language, 40 methods per class | Cold/warm/changed wall time, CPU, endpoint heap, sampled peak RSS and process maximum RSS |
| Java + TypeScript, concentrated in one class per language | 320 / 1,280 / 5,120 methods per class | Same full-indexing measurements |
| Retained declaration metadata, separately for Java and TypeScript | 2,500 / 10,000 / 40,000 declarations | Extraction time, extraction retained heap, emitted retained heap |

Both indexing shapes contain 640 / 2,560 / 10,240 generated methods, plus fixed
call and edit probes. The harness verifies the emitted method and parsed/cache-hit
file counts, so silently dropping work cannot improve a scaling result. Size order
alternates between repetitions. Every adjacent pair **and the full size span** must
stay within the budget, using per-size medians from the same run. Missing, zero,
negative or non-finite measurements fail. `--record` also enforces these guards.
Unit tests demonstrate that quadratic time or memory growth fails the check.

The artifact includes raw samples, median costs and normalized ratios. These
bounded workloads guard against scaling regressions; they do not prove linear
complexity for every repository. Fixed startup costs can mask growth at small
sizes. Released heap deltas remain diagnostic because they can be zero or negative
after collection.

CI uploads raw samples and comparisons as `method-declaration-facts-benchmark`,
using the same five-day retention as the other benchmark artifacts. The separate
all-language [scope-resolution benchmark](../scope-resolution/README.md) remains
unchanged.

After reviewing an intentional fixture, semantic, or allocation change, run the
same command with `--record` instead of `--check`, then inspect `baseline.json`.
CI never records or accepts a new baseline automatically. Output files must not
already exist. The two-checkout commands below remain available for diagnostics.

## Detailed local measurements

Build the pre-change revision and candidate with `npm run build` in each package,
then run from the candidate's `gitnexus/` directory:

```sh
node bench/method-declaration-facts/measure.mjs \
  --baseline-root /path/to/baseline/gitnexus \
  --samples 3 --output /tmp/method-declaration-facts.json
```

The output file must not exist; existing files and symlinks are rejected before
measurements start. Without `--output`, the harness creates a private temporary
directory and prints the result path. Results are written after all pairs finish.

Use `--candidate-root` to measure a built candidate snapshot elsewhere. Put both
runtimes and their dependencies on the same filesystem. The source corpus always
comes from the checkout containing the script, and its content hash must match
between revisions. Each pair alternates revision order and uses fresh processes.

The harness measures three forced analysis runs per process: a cold index, warm
parse-cache replay, and a changed method signature. It uses one real parse worker,
disables FTS and embeddings, and materializes graph edges for comparison. It checks
all structural nodes and edges, excluding Community/Process nodes and their membership edges,
between revisions; warm replay must match cold output, and the edit must change
the graph. Cache hit/reparse counts accompany every measurement.

Two corpora exercise different costs: 64 generated Java/TypeScript class files
with 40 methods each, and the first 96 tracked ingestion provider sources plus
tracked same-arity, primary-constructor, record-component, and variadic fixtures.
Each includes a small file whose signature changes. These are bounded workloads,
not a claim about every repository or language distribution.

Pass `--providers-only` for a separate nine-file parity corpus covering all eight
migrated providers plus the changed-file probe. It includes overload declarations,
a Java record, a C# primary constructor, a Kotlin companion, Python decoration,
PHP variadics, and Swift/Dart constructors. Every provider must emit its sample
callable and a resolved call to it. This mode uses the same repeated cold, warm,
and changed-file graph comparisons; all eight grammars must be installed.

Counters separately run real scope and MethodInfo consumers for all eight
migrated languages. They report distinct parameter arrays and declaration-node
AST accesses, with semantic output hashes. These are instrumentation runs, outside
the timed analysis. A forced-GC probe reports collection of 100 discarded trees;
it does not add GC assertions to the unit suite.
Separate parameter-only timings call the callback twice for each of 1,000
declarations in a fresh tree, across nine trials per provider. Parsing, forced GC,
and the counter instrumentation are outside those timed regions.

Wall time includes analysis and persistence. CPU and RSS include worker threads.
RSS sampling uses 20 ms intervals; cumulative maximum RSS is the process high-water
mark, so later scenarios may inherit an earlier peak. GC duration covers only the
main isolate. Progress-phase times use callback intervals, not exclusive CPU
profiles. Compare distributions and report noise; reduced extraction counts alone
do not establish an end-to-end speedup.

See [the recorded results](RESULTS.md) for the initial measurements and their limits.

## Retained memory

Run the same probe against both built revisions, alternating their order across
at least five fresh-process pairs for each language:

```sh
node --expose-gc bench/method-declaration-facts/memory.mjs \
  --root /path/to/runtime/gitnexus --language java --declarations 10000
node --expose-gc bench/method-declaration-facts/memory.mjs \
  --root /path/to/runtime/gitnexus --language typescript --declarations 10000
```

The probe holds the parsed tree, runs scope arity and structure extraction, then
releases method records, the tree, and emitted metadata in stages. It reports
forced-GC JavaScript heap at each stage, a semantic digest, and whether the native
tree became collectible. `extractionRetainedBytes` subtracts the tree-only heap;
`emittedRetainedBytes` subtracts the initialized empty heap after releasing the
tree. `releasedDeltaBytes` includes remaining cache capacity and runtime warmup.
Compare those deltas rather than absolute process heap.

This probe measures one isolate and a small declaration shape. Its RSS and
extraction timing are **not** end-to-end indexing measurements. Use `measure.mjs`
for complete cold/warm/changed indexing, including worker and native-memory RSS.
Keep both runtimes on the same filesystem with the same dependencies and give
every end-to-end child a fresh private `XDG_RUNTIME_DIR` so analyzer identity
caches start equally cold. The CI check includes this retained-heap probe in
the same `method-declaration-facts-benchmark` report as the indexing measurements.

To count requests and distinct parameter arrays in real workers, use the optional
preload below from the candidate package. Repeat with the candidate runtime and a
different, nonexistent output file. The preload also runs inside parser workers;
group records by thread, tree, provider, and node, and count unique `(thread, array)`
pairs. These runs are instrumented: discard their timing and memory measurements.

```sh
FACT_RUNTIME_ROOT=/path/to/baseline/gitnexus \
FACT_COUNTER_LOG=/tmp/baseline-parameters.jsonl \
NODE_OPTIONS='--import=/absolute/path/to/gitnexus/bench/method-declaration-facts/trace-parameters.mjs' \
node --expose-gc bench/method-declaration-facts/measure.mjs \
  --child analysis --root /path/to/baseline/gitnexus --corpus repository
```
