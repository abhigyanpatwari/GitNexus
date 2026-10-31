# Java overload and ingestion scaling

Build the package, then measure the current implementation:

```sh
npm run build
node bench/java-overload-resolution/measure.js --check --output /tmp/java-overload-check.json
```

CI runs this check in the scope-resolution benchmark job and uploads
`java-overload-resolution-benchmark.json` with that job's measurements.

`measure.js` runs three fresh-process samples at 128, 512 and 2,048 units. Each
unit adds seven methods and four calls. Two shapes exercise increasing file
counts and increasing declarations within one class. Every overload family has
two candidates; package width and inheritance depth stay fixed. The spread
shape uses separate packages with an explicit import so package-size limits
cannot silently reduce resolution work.

Each sample runs real worker parsing, scope resolution, graph construction and
database writes, with a cold cache, a warm cache and one edited source file.
The edit casts one argument to `Object`, changing exactly one selected overload.
The calls cover reference specificity, widening before boxing, `var` receiver
inference through a factory call and cross-file member resolution. Expected target IDs
are generated independently of the implementation. Missing methods or calls,
incorrect targets, suppressed calls, extraction failures, incorrect cache reuse
and truncated process detection all fail the run.

The harness uses one parser worker, private temporary storage, a 128 MiB database
buffer pool, and no FTS or embeddings. It raises the file-size and process limits
to include the entire generated corpus. Each scenario forces graph reconstruction
and persistence; warm and changed scenarios reuse parse-cache chunks. Editing one
file can reparse other files in its cache chunk. This measures full graph writes,
not the separate selective database-update path.

The report includes raw samples, median wall time and process CPU time for the
whole analysis and the scope-resolution phase, main-thread heap at completion,
and process peak RSS (including workers/native memory). Peak RSS is cumulative
across the three scenarios in each child. Heap is sampled before an explicit
post-analysis collection. The built JavaScript digest identifies the measured
runtime and detects changes to it during the run.

`--check` verifies the committed corpus, call-target and cache fingerprints, then
gates every adjacent size pair and the full span. For every time and memory
metric, `(large cost / small cost) / (large size / small size)` must be at most
**1.5**. The shared gate and its quadratic-growth tests come from
`../method-declaration-facts/scaling.mjs`. Absolute baseline timings are reference
measurements, not machine-independent thresholds.

These are bounded scaling checks, not a proof of linear complexity for arbitrary
Java programs. In particular, this corpus does not increase overload-family
width, inheritance depth or generic constraint complexity. Startup and database
costs can hide growth at small sizes; the separate scope measurements and
deterministic lookup-work regression tests help expose it.

After reviewing an intentional workload or semantic change, record a baseline:

```sh
node bench/java-overload-resolution/measure.js --record --output /tmp/java-overload-record.json
```

Recording also requires all scaling and correctness checks to pass, uses at least
three samples, and is disabled in CI. `--root /path/to/built/gitnexus` selects an
isolated runtime. `--sizes 128,512,2048 --samples 1` is useful for diagnostic runs;
one-sample runs cannot record or check a baseline. Completed samples are saved
after each child so a later failure leaves usable diagnostic evidence.
The output path must not already exist; existing files and symlinks are rejected.
