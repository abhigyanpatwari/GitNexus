# Shared callable declaration facts

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
