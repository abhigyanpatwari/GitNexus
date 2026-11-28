# Go ownership and callable-flow scaling

Run the CI check from `gitnexus/` after installing dependencies.

```sh
npm run build
node --experimental-test-module-mocks bench/go-resolution-scaling/measure.cjs --check
```

The fixture doubles from 1,024 to 8,192 Go files over four sizes. Each pair of files adds an independent package with the same declaration names. One file defines `Client.ID`, `Client.Run`, and `Step`. The other defines `Apply`, which calls the function passed by `Run`. Every ingestion must register one method and one field per package and resolve each indirect call from `Apply` to its own package's `Step`.

The runner times the built `reconcileOwnership` and `emitCallableValueFlow` functions inside the ingestion pipeline. Each run starts with a fresh graph and semantic model. One warmup per size counts ownership lookups and entries returned. Five timed rounds rotate the order of the sizes and use the original lookup methods.

`--check` applies the limits in [baseline.json](baseline.json).

- At every size, ownership may perform at most one lookup and return at most one bucket entry per Go file. The callable-flow solver may take at most three iterations per file.
- For each pass, the runner divides median milliseconds by file count and compares every pair of sizes. Linear growth gives a ratio near 1. The limit of 1.75 allows for timing variation. A quadratic pass would give ratios near 2 at each doubling and 8 over the full range.

A failed budget produces a nonzero exit status and identifies the pass or counter and file count. Add `--output path.json` to save all samples, medians, work counts, ratios, and failures. CI uploads that report as the `go-resolution-scaling` artifact.

The workload reproduces the repeated names and cross-file callbacks from the investigation into [issue #4027](https://github.com/abhigyanpatwari/GitNexus/issues/4027). Its scaling limits apply to this fixed-fan-out fixture. The 48,853-file repository in the issue is private.
