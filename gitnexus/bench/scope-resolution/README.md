# Scope-resolution measurements

Run from `gitnexus/` after `npm run build`:

```sh
node --import tsx bench/scope-resolution/measure.mts --check --output /tmp/scope-resolution.json
```

CI runs every language in both `SupportedLanguages` and `SCOPE_RESOLVERS`, serially.
Missing corpus or resolver entries fail the inventory check. Each language has
100- and 1,000-entity workloads with 20 generated members or procedures per entity,
plus callers and helpers. Rust also needs a root
module file; Objective-C has a header and implementation per entity. Java adds an
isolated producer file and exercises transitive factory returns and repeated
unreachable return-name lookups. Swift uses same-module visibility; COBOL exercises
program references and procedure pointers. R sources the preceding file and calls
through an R6 instance; the second call of its chain stays unresolved, because R6
method results carry no type. Other arms import the preceding file and call through its
return value. These generated sources exercise the analyzer; they are not builds
or representative application benchmarks.

Every sample runs in a fresh process through real parsing with one worker and the
production scope-resolution pass. COBOL also runs its standalone structural parser.
Configuration files are written to a temporary workspace and loaded through the resolver's normal
configuration hook. No production heap, file-count, or propagation limit is imposed.

The JSON artifact and GitHub job summary report the median of three samples:

- Parsing and scope-resolution wall time separately.
- JavaScript heap immediately after parsing and after resolution. These are endpoint
  samples, not peak heap or retained heap after garbage collection.
- Process peak RSS through resolution, including worker memory. This is the OS
  high-water mark, not a timer that can miss synchronous allocation spikes.
- Module and total type-binding counts, node/edge counts, and cross-file calls.
- An order-independent fingerprint of node identities and complete relationship
  endpoints, types, confidence and reasons. Equal counts alone are insufficient.

The check requires every source to reach scope resolution, nonempty declarations
and cross-file calls, identical graph fingerprints between trials, and equality
with committed graph baselines. Type-binding counts must be deterministic and must
not exceed the recorded counts; reductions are allowed. These measured allocation
budgets catch redundant table growth even when the graph stays identical. Runtime
and heap/RSS are measurements, without uncalibrated
absolute performance thresholds. Compare the same workload on the same machine
before choosing an optimization.

For a smaller diagnostic run:

```sh
node --import tsx bench/scope-resolution/measure.mts --language java --sizes 10,100 --methods 20 --repetitions 3
```

To establish baselines after reviewing a fixture, semantic, or allocation change,
run the default all-language workload with `--record` instead of `--check` and inspect
`baselines.json`. CI never records or accepts a new baseline automatically.

## Finalization import-miss probe

To reproduce the allocation trigger isolated while investigating #3695:

```sh
node --expose-gc --import tsx bench/scope-resolution/finalize-miss.mts 500
```

Run in fresh processes on each revision after building. This constructs 500
files with chained wildcard imports, a terminal module with an unresolved external
wildcard import, and a consumer importing a missing name from that terminal module.
The missing name cannot be supplied by re-exports, so it should not trigger
construction of the unrelated chain's
transitive export tables. The JSON reports finalization time, endpoint heap
growth, process peak RSS, and a fingerprint of all finalized imports, bindings,
SCCs and statistics. It is a synthetic finalizer workload, not a full Java
indexing run or a reproduction of the reporter's private repository.

For a real indexing run, the existing `GITNEXUS_DEBUG_HEAP=1` and
`GITNEXUS_HEAP_PROBE_FILE` settings now include `sr-finalize-*` markers for input
preparation, import-target resolution, SCCs, ambiguity checks, transitive exports
(only if requested), linking, wildcard expansion, bindings and workspace indexes.
`sr-extract-start` precedes `sr-post-nodeLookup`; a last `sr-post-nodeLookup`
marker therefore points into finalization after extraction.

## Post-resolution memory probes (#3695)

```sh
node --expose-gc --import tsx bench/scope-resolution/call-signature-memory.mts 500000
GITNEXUS_DEBUG_HEAP=1 node --import tsx bench/scope-resolution/dense-java.mts 300 20 10
```

CI runs both probes once with `--check` in the existing
`scope-resolution-benchmark` job, alongside its all-language measurements.
The ordinary-call check rejects any retained signatures. The dense Java check
requires the default 300/20/10 workload and its reviewed full graph fingerprint
below. Heap and timing remain measurements, without absolute thresholds.
Both outputs join the existing `scope-resolution-benchmark` artifact: the
collector's JSON and dense Java's log, including `sr-emit-*` heap checkpoints.
Omit `--check` for comparisons against older revisions or custom workloads.

The first probe isolates ordinary calls with no indirect-call facts. Previously
the deferred-call collector retained a signature object and position key for
every call even though none could be consumed. At 500,000 calls, three fresh
processes measured a median 90.29 MiB retained overhead before the change and
0.08 MiB afterward. With `--max-old-space-size=160`, the old collector exhausted
the heap (exit 134); the updated collector completed. Input records remain live
through both measurements. This measures one allocation source, not total
indexing memory.

The second probe uses real worker parsing and scope resolution on generated
Java: 300 files, 20 methods per file, 10 receiver calls per method. It reports
per-stage heap samples and a fingerprint of complete nodes and relationships.
Before and after the change it produced 66,300 nodes and 126,600 relationships,
with fingerprint `3209302e91e7023328464540ec7d0ac72ac03bf49fa73303817a56ed3d415ef5`.
It uses the in-memory graph helper, so its RSS is not a measurement of the CLI's
streaming graph sink. Calls pass `null` to match each receiver's parameter type;
the 300-file workload compiles with `javac --release 17`. The probe measures
analysis and does not execute the generated Java.

`GITNEXUS_DEBUG_HEAP=1` now adds `sr-emit-*` checkpoints after receiver calls,
free calls, replay, references, property passes, callable flow, imports and
provider hooks, including elapsed emit time and graph counts. `sr-post-resolve`
marks the end of the initial registry lookup only; substantial resolution still
follows it. These markers distinguish that work on the next reporter run.
The private repository's complete OOM has not been reproduced by these probes.
