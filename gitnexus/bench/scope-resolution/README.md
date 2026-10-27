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
program references and procedure pointers. Other arms import the preceding file and call through its
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
files with chained wildcard imports, a terminal module, and a consumer importing
a missing name from that terminal module. The missing name cannot be supplied by
re-exports, so it should not trigger construction of the unrelated chain's
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
