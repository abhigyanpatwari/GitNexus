# Lexical binding provenance benchmark

Run from `gitnexus/` after building the checkout under test:

```sh
node --import tsx bench/lexical-binding-provenance/measure.cjs --check
```

`BENCH_SOURCE_ROOT` selects another repository checkout. Each checkout needs its
own built `gitnexus-shared` and worker output. `--output report.json` writes the
full report; `--arm position-index` selects an arm; `--verify` checks semantics
without timing and is useful while other tests are using the machine.

## Measurement protocol

The predeclared `duration-calibrated-v2` protocol in `baseline.json` uses a pilot,
five warmup batches, fifteen measured batches, and three input sizes spanning 4×
growth. This is a custom Node.js harness, not BenchmarkDotNet. Its 500 ms pilot
target follows the [official BenchmarkDotNet iteration-time guidance](https://benchmarkdotnet.org/articles/guides/console-args.html).

The pilot tries 1, 2, 4, … invocations per batch until three consecutive batches
at the same count each contain at least 500 ms of measured work. It fails after
64 pilot batches or when 1,048,576 invocations cannot meet the target. That count
then remains fixed for all five warmup and fifteen measured batches. Baseline
and candidate calibrate independently using the same protocol; faster code can
need more invocations to reach the target duration.

Every invocation creates a fresh index/context. Its input preparation runs
outside its timing window, even within a batch. A sample is the batch's total
measured work divided by its invocation count, so all reported summary times are
per-operation averages. The standard deviation describes those batch averages,
not the latency distribution of individual invocations. Reports retain every
pilot, warmup, and measured batch's invocation count, measured work, and wall
time, as well as every normalized sample. No outliers are removed and no measured
batches are retried to obtain a passing result.

The prior single-operation protocol produced millisecond-scale samples with
large runtime transients. Its failed reports remain evidence; they must not be
mixed with v2 measurements. A protocol change requires rerunning both revisions.
Only relative scaling is gated, so results do not depend on a particular CPU's
absolute speed. For both the minimum and median, the normalized factor is:

```text
(larger time / smaller time) / (larger units / smaller units)
```

Both 2× and 4× comparisons must be at most 1.8. The ceiling is fixed before the
candidate measurements; a failure requires investigation rather than a wider
ceiling. These measurements bound behavior on the generated workloads; they do
not prove an asymptotic bound for arbitrary source programs. Prefer an idle host
without concurrent builds, tests, or indexing. Alternatively, pin both benchmark
processes to the same dedicated CPU and partition other work onto disjoint CPUs,
using identical conditions for baseline and candidate. CPU affinity does not
isolate shared caches or memory bandwidth, so disclose concurrent work and retain
the full sample distributions. Linux reports include the process's exact
`Cpus_allowed_list` as `environment.allowedCpus`; `BENCH_ENVIRONMENT_NOTE` adds an
explicit note to the report, for example:

```sh
BENCH_ENVIRONMENT_NOTE='Benchmark CPU 7; native integration suite restricted to CPUs 0-3; caches and memory bandwidth shared' \
  taskset -c 7 node --import tsx bench/lexical-binding-provenance/measure.cjs --check
```

Parsing and `ParsedFile` creation happen outside extraction timing. The operation
under test creates its indexes on every measured invocation. Wrapper extraction
also gets a fresh AST for each invocation, prepared outside timing; this prevents
the historical module WeakMap from hiding index construction in the baseline.
Correctness checks run before timing and on the final result. They and the
fingerprints remain outside timing. Returning no facts cannot pass.

| Arm                       | Sizes                 | Measured operation                                                 | Exact semantic guard                                                      |
| ------------------------- | --------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `position-index`          | 2,000 / 4,000 / 8,000 | Build index, then N outer reads after N completed siblings         | Every read returns root                                                   |
| `position-deep-completed` | 2,000 / 4,000 / 8,000 | Build index, then N reads after N completed nested scopes          | Every read returns root                                                   |
| `spread-aliases`          | 128 / 256 / 512       | Fresh framework extraction across N functions                      | N exact GET paths                                                         |
| `completed-scopes`        | 128 / 256 / 512       | Fresh extraction of N outer reads after N completed functions      | N exact GET paths                                                         |
| `wrapper-aliases`         | 128 / 256 / 512       | Fresh wrapper context, all definition facts and call candidates    | N seeds, URL carriers, exact call/path identities                         |
| `nested-helpers`          | 128 / 256 / 512       | All facts for N reachable sibling helpers and their outer function | N+1 seeds, one URL carrier                                                |
| `nested-helper-chain`     | 32 / 64 / 128         | All facts for deeply nested reachable helpers                      | N+1 seeds, one URL carrier                                                |
| `reverse-chain`           | 1,000 / 2,000 / 4,000 | Fresh classifier with seed last, then N decisions                  | Every chain node matches                                                  |
| `name-collisions`         | 1,000 / 2,000 / 4,000 | Fresh classifier with N same-name definitions, half negative       | Exact bound decisions, unresolved name rejected, unique positive retained |

The deep helper sizes keep parser/model setup practical while still exposing
repeated descendant work. Parsing costs are not included in these measurements.
The classifier arms include index construction and all call decisions; they do
not include filesystem or route extraction overhead.

The baseline predates the classifier factory. `baseline-closure.cjs` reproduces
the historical closure algorithm only for the pinned `routes.ts` SHA-256; it
refuses other source revisions. The candidate calls the production factory.
The collision workload records the baseline's known false positive explicitly
as `known-baseline-failure`; those rows are not semantically equivalent to the
candidate and cannot pass `--check`. Other workload fingerprints must agree.
Reports record the adapter, revision, dirty flag, source hashes, and harness
fingerprint so a dirty candidate is never presented as a clean commit result.

## Exact call graph comparison

Prepare the corpus once before changing production code, then use that same
directory for the baseline and candidate exports:

```sh
node --import tsx bench/lexical-binding-provenance/edges.mjs \
  --prepare-corpus /tmp/binding-corpus
BENCH_SOURCE_ROOT=/path/to/baseline-checkout node --import tsx \
  bench/lexical-binding-provenance/edges.mjs \
  --corpus /tmp/binding-corpus --output /tmp/baseline-edges.json
node --import tsx bench/lexical-binding-provenance/edges.mjs \
  --corpus /tmp/binding-corpus --output /tmp/candidate-edges.json
node --import tsx bench/lexical-binding-provenance/edges.mjs \
  --compare /tmp/baseline-edges.json --candidate /tmp/candidate-edges.json \
  --output /tmp/edge-diff.json
```

The frozen corpus contains all TS/JS source files from the
`test/fixtures/lang-resolution` fixture groups that contain those languages,
their JSON/YAML configuration, and the targeted binding ownership probe here.
The actual ingestion pipeline runs with MRO enabled; only derived community and
process extraction is skipped. Each export records the git revision, every input
file's hash, corpus fingerprint, and sorted `CALLS` and `METHOD_OVERRIDES` edge
arrays. Edge records retain `id`, `sourceId`, `targetId`, and readable source and
target names, paths, and lines. Arrays preserve graph-edge multiplicity.

Comparison refuses different corpus manifests, exports from dirty checkouts, and
a candidate export whose revision is not the checkout running the comparison. It
always fails if an override
edge changes. Every added/removed call edge is written in full for review. Add
`--check` when zero call changes are expected; the ownership fix intentionally
changes the annotated closure probe's target, so its first comparison requires
reviewing that exact delta rather than blessing aggregate counts.

The captured pre-fix revision is `565e50276dc9aa4e3b6e36dfabe8a92571b0d699`:
117 fixture groups, 432 input files, 432 `CALLS`, and 11 `METHOD_OVERRIDES`.
Corpus SHA-256:
`88be1faf45e9aec145f9d168b8959d67f31ec3b09b5455e9c8d8b2b1681ade5a`.

The final corpus differs from the first capture only in formatting of the
standalone ownership probe. Both final exports use this identical corpus and
the baseline remains the untouched revision above.
