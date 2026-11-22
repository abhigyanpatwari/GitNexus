# Ruby parameter scope benchmarks

Run from `gitnexus/`:

```sh
npm run build
node --import tsx bench/ruby-block-param-stop/measure.mjs --check
node --import tsx bench/ruby-block-param-stop/scaling.mjs --check
```

`measure.mjs` checks exact call targets, decline counts, fingerprints, and the
CI scaling gates: 4× method count, 16× sibling blocks, and 4× nesting depth.
Its fixed-width indentation keeps input size linear in depth; each shape pins
`input_bytes`. `scaling.mjs` adds four-size sweeps:

| Workload | Sizes | Held constant | Timed phases |
| --- | --- | --- | --- |
| Sibling/nested blocks, method count | 64, 128, 256, 512 | 6 blocks per method | Capture, resolution |
| Sibling/nested blocks, block count/depth | 3, 6, 12, 24 | 64 methods | Capture, resolution |
| Lambda default parameters | 64, 128, 256, 512 | One lambda; each default reads an earlier parameter | Capture |
| Explicit calls beside parameters | 64, 128, 256, 512 methods | 3 calls per method | Capture |
| Wide parameter list and explicit calls | 64, 128, 256, 512 | Parameters and calls grow together in one method | Capture |

Each size runs in a fresh process, with two warmups and seven measured samples.
The reported time is the minimum sample. Capture includes parsing; resolution
replays worker output into a fresh graph before starting its timer. The resolver
sweeps assert zero missing and unexpected edges. The capture workloads assert
the corrected YARD binding, default scopes, explicit self calls, and absence of
false callable-cell invocations. The default workload also asserts that the
number of emitted lexical names grows linearly.

The JSON report includes work counts, timings, adjacent normalized growth, and
a fitted log-log exponent. Exponent 1 means linear measured growth; below 1 is
sublinear. `--check` allows scheduling/GC noise up to exponent 1.2 and normalized
endpoint growth 1.5. Passing those limits is evidence over the measured sizes,
not an asymptotic complexity proof.

The resolver sweeps keep one class/method per file. They do not cover the known
cost of putting many classes in one file. That layout can be measured separately:

```sh
node --import tsx bench/ruby-block-param-stop/measure.mjs --shape crowded 512 6 --reps 7 --warmup 2
```

Capture-only workloads use one file and include a wide parameter list,
exercising repeated parameter-name lookups at explicit calls.

The depth sweep stops at 24. Pre-existing shared capture and lookup costs
become superlinear at 96 levels; `baseline.json` records that boundary in
`_nested_depth_note`.

## Recorded run

2026-11-13, Linux x64, Node v22.23.3, Intel Core i9-12900K. Two complete
`scaling.mjs --check` runs passed on a shared host during the graph refresh,
using the benchmark harness from `35db3d7a6`. Ranges retain the variation
between runs:

| Workload | Capture exponent | Resolution exponent |
| --- | --- | --- |
| Sibling blocks, method count | 0.988–1.018 | 0.880–0.943 |
| Sibling blocks, block count | 0.677 | 0.594–0.613 |
| Nested blocks, method count | 0.998–1.014 | 0.920–1.006 |
| Nested blocks, depth | 0.885–0.966 | 0.638–0.673 |
| Lambda defaults | 0.839–0.848 | — |
| Explicit calls beside parameters | 0.917–1.048 | — |
| Wide parameter list and calls | 0.883–0.948 | — |

The largest normalized endpoint growth was 1.108 for capture and 0.995 for
resolution. Every resolver size had zero missing and unexpected edges. These
measurements support approximately linear or sublinear growth for both phases
over the tested sizes; they do not establish a strict O(N) bound.
