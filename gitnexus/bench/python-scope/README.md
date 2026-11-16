# Python capture and value-reference benchmarks

Run from `gitnexus/` after `npm run build`:

```sh
node --import tsx bench/python-scope/measure.mjs --check
node --import tsx bench/python-scope/import-target-fingerprint.mjs --check
```

The existing CI Python benchmark step runs both commands. The first retains the
DAO capture scaling and fixture fingerprint checks and also runs the value-reference
benchmark for #3942 and #3943. Its JSON includes the full `value_references` report.
The value-reference resolver arm requires the compiled parse worker; the original
capture arm imports source directly.

To run only the new benchmark and save its samples:

```sh
node --import tsx bench/python-scope/value-references.mjs --check --output /tmp/python-value-references.json
```

Two generated Python files contain growing sets of constants, helper functions,
and reader classes. Capture extraction uses 128, 256 and 512 entities; resolution
continues through 1,024 and 2,048, spanning 16× input growth. Each class exercises bare imported reads despite a class member
with the same name, explicit `self` access, keyword callbacks, direct calls,
`Depends` defaults, `Annotated` metadata, parameter shadowing and a plain type
annotation. Definitions and references both grow with the entity count.

- **Captures:** measures parsing and `emitPythonScopeCaptures` on the reader file.
  Exact counts require two bare constant reads and three helper value captures per
  entity, including the shadowed capture whose resolution must subsequently fail.
- **Resolution:** parses both files once with a real worker, then measures the
  production scope-resolution pass. Each invocation starts with a fresh graph,
  semantic model and deep copy of the parsed files. Completion checks assert that
  the resolver used those exact worker results instead of silently reparsing.
  Preparation is outside timing; no resolved state or lookup cache is reused
  between invocations. Exact edge
  identities require four accesses, two value uses and two calls per entity. These
  include the existing access edge accompanying a callable value use. Metadata uses
  belong to the class definition scope; `Depends` defaults retain the analyzer's
  existing method-owned synthetic call. Shadowed callbacks and plain type
  annotations must not reach the imported helper, and callback uses must not become
  calls.

Both arms check semantics before timing and again afterward, and require identical
results from fresh invocations. Committed fingerprints cover all captures and the
complete graph, including relationship identities, endpoints, confidence and reason.
A faster run that drops facts cannot pass. Review intentional semantic changes
before updating `value-references-baseline.json`; the check never records baselines.

The measurement protocol follows `lexical-binding-provenance`'s
`duration-calibrated-v2`: double the invocation count until three consecutive pilot
batches each contain at least 500 ms of measured work, then keep that count for five
warmup and fifteen measured batches. All pilot, warmup and measured samples are
reported. Nothing is discarded or retried to obtain a passing result.

For both the minimum and median batch-average time, comparisons with the smallest
input use `(larger time / smaller time) / (larger entities / smaller entities)`.
Each must be finite and at most the predeclared 1.8 budget. Adjacent 2× steps also
must stay at or below 1.5. Near 1 means linear measured growth; a dominant quadratic
term approaches the input-size multiplier. The 16× resolution span helps expose a
quadratic term that is small at the starting size. This is a regression
gate on these workloads, not a proof of an asymptotic bound for every Python
program. Run on an otherwise idle host; the report records Node, CPU, load,
revision, dirty status and hashes of the relevant source, compiled Python modules,
compiled shared lookup and built worker.

`--verify` checks semantics without timing. `--sizes 256,512,1024` selects both arms'
sizes for a diagnostic sweep; `--check` requires the committed default sizes and real timing.
The output includes errors for diagnostic sweeps as well, but only `--check`
enforces a nonzero exit for timing or fingerprint failures.

An expanded run on Node 22.23.3, Linux x64, Intel i9-12900K produced the following
batch medians. The shared host had other jobs running (initial one-minute load
14.49). All eight semantic checks and both timing gates passed; the graph grew
from 1,538 nodes / 2,561 edges to 24,578 nodes / 40,961 edges. Times are per
invocation; scaling is normalized to 128 entities. The gate uses both the median
shown here and the minimum, with all samples and standard deviations in the JSON.

| Entities | Capture median (ms) | Capture scaling | Resolution median (ms) | Resolution scaling |
| -------- | ------------------- | --------------- | ---------------------- | ------------------ |
| 128      | 333.21              | —               | 55.54                  | —                  |
| 256      | 799.85              | 1.200           | 128.95                 | 1.161              |
| 512      | 1,578.85            | 1.185           | 244.50                 | 1.101              |
| 1,024    | —                   | —               | 609.19                 | 1.371              |
| 2,048    | —                   | —               | 1,218.39               | 1.371              |

The subsequent combined CI command also passed every fingerprint and timing gate.
Its full-span normalized median ratios were 1.071 for captures and 1.622 for
resolution (minimum ratios 1.129 and 1.674). Its largest adjacent ratio was 1.275.
These results bound measured growth on this corpus; they do not establish strict
linear or sublinear complexity for the entire ingestion pipeline.

The largest input used the worker's built-in preparation retry after its initial
30-second timeout. An earlier expanded attempt aborted during worker replacement
under severe host contention (load above 100); it produced no complete timing
report. Worker preparation is outside the resolution measurement. Neither run
changed timeouts or scaling budgets.

Fault-injection checks rejected dropped value captures, missing baselines and
fallback reparsing. Injected quadratic work preserved the output fingerprints but
failed the timing gate (normalized capture median 2.295, limit 1.8).
