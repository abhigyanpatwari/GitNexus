# Go ownership and callable-flow scaling

This benchmark measures two parts of Go ingestion from [issue #4027](https://github.com/abhigyanpatwari/GitNexus/issues/4027). It times `reconcileOwnership` and `emitCallableValueFlow` inside a normal ingestion run. Each repetition starts with a fresh graph and semantic model. The timers cover only the calls to those two functions.

Run from `gitnexus/` with dependencies installed:

```sh
npm run build
npm test -- --config bench/go-resolution-scaling/vitest.config.ts
```

To compare source revisions, copy this benchmark directory into each checkout's `gitnexus/bench/`, build that checkout, and run the same package counts and repetition count. Run one checkout at a time.

The default sweep uses 64, 128, 256, 512 and 1,024 packages. Each package has two Go files. To run a larger sweep:

```sh
GO_BENCH_PACKAGES=512,1024,2048,4096 GO_BENCH_REPS=5 \
  npm test -- --config bench/go-resolution-scaling/vitest.config.ts
```

Each package defines its own `Client` struct, field and method. The method passes `Step` to `Apply` in the other file. `Apply` calls that function parameter. Every package reuses the same declaration names, with one possible callback target per invocation. The benchmark verifies the caller and target file of every indirect edge on every run. Larger inputs add independent packages while keeping the body size, fan-out and number of calls per file constant.

The first round records ownership-registry lookups and the total length of the buckets they return. Subsequent rounds use the original registry methods and rotate the order of the sizes. The `GO_RESOLUTION_SCALING` JSON line reports the individual wall times in milliseconds, their medians, the number of definitions, deferred sites and solver iterations, and the fitted time exponent for each pass. An exponent of 1 corresponds to a doubling of time when file count doubles. Inspect the per-size times alongside the fit, especially when the smallest samples take less than a millisecond.

## Measured results

Median milliseconds on Linux x64, Node 22.23.3, with five measured samples per size. Both source revisions used the same Vitest 5.1.0 runner, tree-sitter 0.25.1 runtime and tree-sitter-go 0.25.0 grammar. The release figures therefore describe the tagged resolver source on this harness. The reporter's container and corpus were unavailable.

| Go files | v1.6.12 ownership | main ownership | v1.6.12 callable flow | main callable flow |
| ---: | ---: | ---: | ---: | ---: |
| 1,024 | 3.88 | 3.14 | 94.51 | 87.82 |
| 2,048 | 29.14 | 6.98 | 214.99 | 205.50 |
| 4,096 | 113.36 | 14.51 | 449.90 | 462.84 |
| 8,192 | 459.33 | 22.73 | 938.09 | 1,008.21 |
| Fitted time exponent | 2.26 | 0.96 | 1.10 | 1.17 |

At `v1.6.12`, the total length of the ownership buckets returned was exactly `P × (P − 1) / 2` for `P` packages. The final doubling increased ownership time from 113 to 459 ms. On `main`, ownership made two registry lookups per package, each returning an empty bucket. Its wall time was consistent with linear growth over the larger sweep.

Both revisions resolved one callback and performed six solver iterations per package at every size. Callable-flow wall time grew faster than the iteration count over the larger sweep. On `main`, eight times as many files took 11.5 times as long. The timer includes building the solver's indexes, propagating targets and emitting edges. These measurements do not attribute the additional time to any one of those operations.

The [raw samples and counters](results.json) include both sweeps and the source commit IDs.
