# Callable extraction: time and memory

Measurement follow-up for PR #3726. Baseline for the new comparison:
`e6744edcadbf93e789ab21a88e9e707cb3059ce7`.

## What is shared

The method extractor still supplies structure-only facts such as visibility,
modifiers, and annotations. Scope resolution consumes declaration facts and
applies language-specific arity rules. Both reuse immutable parameter records.
This follow-up also shares their common parameter-type array; a provider copies
only when it needs normalized types, unknown positional slots, or a variadic
marker. The worker builds overload groups once per class method map and reuses
them for definition IDs and enclosing-callable IDs.

Weak ownership lets declarations and native trees be collected. The projections
contain no AST references. Graph identities, persisted cache formats, and provider
semantics stay unchanged.

## Measurement definitions

- **End-to-end time:** sum of cold, warm-cache, and one-file-changed indexing in a
  fresh process, including graph persistence. One real parser worker, 128 MiB DB
  buffer pool, FTS/embeddings disabled, identical frozen source corpus.
- **Peak RSS:** operating-system process high-water mark over those three runs.
  Includes parser worker threads and native memory; excludes separate child
  processes. Per-scenario 20 ms samples are also retained in the raw results.
  Later cumulative peaks inherit earlier phases.
- **Retained JS heap:** forced-GC, single-isolate heap difference on 10,000
  declarations after scope and structure extraction. It includes projection-cache
  overhead. A separate measurement drops methods and the tree while retaining
  emitted metadata. This is not a whole-index peak-memory estimate.
- **Allocation counts:** an instrumented worker run; timing/RSS from that run are
  excluded. Counts describe transient work, not simultaneously live objects.

## Prior isolated indexing measurements

The earlier identity-guard optimization reduced total indexing latency, but did
not demonstrate a memory improvement. These are medians of three paired runs
against the previous PR revision `b31dfb73c368f3d1254cfafb6eb6b2ed7453e221`:

| Workload | Total time before → after | Peak RSS before → after |
| --- | ---: | ---: |
| Repository | 24.159 → 22.762 s (−5.78%) | 704.7 → 725.8 MiB (+2.99%) |
| Declarations | 15.601 → 14.686 s (−5.87%) | 615.0 → 644.2 MiB (+4.75%) |

Identical-code memory pairs varied by up to 6.4%; that variability prevents a
confident memory claim. Evidence:
[repository run](https://github.com/abhigyanpatwari/GitNexus/actions/runs/40271406528),
[declarations run](https://github.com/abhigyanpatwari/GitNexus/actions/runs/40272393865),
and [the latency report](callable-end-to-end-v2-report.md).

## Current isolated comparison

[Run 40289711096](https://github.com/abhigyanpatwari/GitNexus/actions/runs/40289711096)
used two separate Ubuntu runners, Node 22.23.3, the same dependencies on both
sides, three alternating pairs per corpus, and three identical-code A/A pairs.
Every child had a private identity-cache directory. Candidate production-source
SHA-256: `9687e759627ad3e80683e2009b6622a4e0f329a62c8417c7406457422fcd3811`.
The temporary workflow and exact patch are preserved in experiment commit
`1447c381e206aa40a8dd53a80e7cb0f554be66f5`; they are not added to the product PR.

| Workload | Total time before → after | Peak RSS before → after |
| --- | ---: | ---: |
| Repository | 23.387 → 23.342 s (−0.19%) | 734.1 → 710.9 MiB (−3.16%) |
| Declarations | 14.909 → 14.775 s (−0.90%) | 649.3 → 657.9 MiB (+1.33%) |

These changes do **not** establish an additional end-to-end speedup or a general
peak-RSS reduction. A/A total-time medians shifted +0.24% / +0.48%, and A/A peak
RSS shifted −3.28% / +0.28% for repository / declarations. No cold, warm, or
changed-file median regressed by more than the declared 3% guardrail. Raw paired
samples, manifests, and all phase medians are in
[the durable results](callable-memory-results.json).

### Retained JavaScript heap

Each runner performed five alternating pairs per language: ten pairs per language
across the two runners. Each fresh process parsed 10,000 two-parameter methods,
then exercised scope arity, method extraction, and graph-property construction.
The table gives medians across those ten pairs; the source tree itself is excluded
from the extraction delta.

| Probe | Heap after extraction before → after | Emitted metadata heap before → after |
| --- | ---: | ---: |
| Java | 12.994 → 11.498 MiB (−11.52%) | 6.933 → 5.436 MiB (−21.59%) |
| TypeScript | 12.955 → 11.461 MiB (−11.54%) | 6.895 → 5.400 MiB (−21.68%) |

All probe trees became collectible after release. Remaining heap above the empty
baseline increased from 0.371 to 0.629 MiB for Java and 0.333 to 0.593 MiB for
TypeScript, including weak-cache backing capacity and runtime warmup. The table's
savings already include that overhead. Full extraction in these small probes took
about 2.0% longer for Java and 2.75% longer for TypeScript; whole-index timings above
remain the latency acceptance measure. Probe-only RSS is retained in the JSON but
is not substituted for whole-index RSS.

### Repeated allocation

A separate instrumented declaration run verified **66 overload-lookup builds and
2,626 group arrays**, down from **2,690 builds and 110,210 arrays**: 97.6% fewer
arrays. The lookup is now built once per class method map. The previous helper's
instrumented cost was only about 19 ms, so this result does not justify a large
indexing-speed claim. Instrumented timing/RSS is excluded from comparisons.

### Validation and decision

Retain the changes for the measured retained-heap and allocation reduction.
**72 uninstrumented full analyses** passed exact graph parity and cache-replay
checks; warm runs reparsed zero files and changed runs reparsed one. Six additional
instrumented analyses preserved those graphs. Local native fixtures also exercised
all eight providers, including variadics, constructors, and wrapper declarations.
Production/test typechecks, 54 focused tests, and fresh-index graph change analysis
passed. Full-suite and platform CI status is tracked on
[PR #3726](https://github.com/abhigyanpatwari/GitNexus/pull/3726).

This establishes less retained declaration metadata on the measured shapes. It
does not establish a whole-process peak-memory win, zero cache overhead, or equal
savings for every provider and parameter shape. Disk serialization and later graph
phases can create separate arrays again. The method extractor remains necessary
for structure metadata that scope resolution does not supply.

Reproduction commands and caveats:
[benchmark README](../../gitnexus/bench/method-declaration-facts/README.md).
