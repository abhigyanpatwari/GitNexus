# Import-emission memory benchmark (#3695)

CI uses the checked-in `baseline.json` and the measurement
runner below (from `gitnexus/`):

```sh
node bench/import-emission/measure.mjs --check --output /tmp/import-emission/measure.json
```

The runner starts three fresh processes with a 512 MiB old-space limit and
checks every sample's workload, edge count, ordered-edge hash and CSV hash.
It rejects more than 16 MiB of heap growth from the live-input checkpoint to
the first emitted edge. The previous global collector measured about 86.7 MiB
at this boundary; the optimized emitter measured about -1 MiB. The allowance
absorbs GC/runtime bookkeeping variation without accepting the old collector.
Elapsed time, RSS and later heap checkpoints remain diagnostic measurements.

`measure.json` retains the raw samples and check outcome, including failed
checks. Choose a new output path for each run; existing files are protected.
`--emitter /path/to/baseline/imports-to-edges.ts` checks another revision with
the same workload and sink. The runner never rewrites `baseline.json`.
The `scope-resolution-benchmark` job in `.github/workflows/ci-tests.yml` runs
this command and retains `measure.json` in its always-uploaded artifact.

For a single-process probe or custom workload:

```sh
node --expose-gc --max-old-space-size=512 --import tsx \
  bench/import-emission/probe.mts --files 17095 --imports 32
```

The probe retains synthetic inputs and uses the real streaming graph sink. It
reports heap after GC before emission, at the first and last edge, and after
return, plus process peak RSS and hashes of the complete ordered edge records
and persisted CSV. The default workload has 547,040 distinct import pairs and
140-character paths. It does not parse Java or perform database COPY.

To compare an older checkout, pass `--emitter` with the path to its
`src/core/ingestion/scope-resolution/graph-bridge/imports-to-edges.ts`; that checkout
must have its dependencies available. Alternate baseline and candidate order
in fresh processes. Compare both hashes, not just edge counts. GC and hashing
are part of the probe, so its elapsed time is not a speed benchmark. The signed
first-emission heap delta includes runtime bookkeeping and may be negative;
use the actual heap checkpoints for revision comparisons.

On Node 22.23.3/Linux, three paired fresh-process runs against the emitter at
`3c068dd11d53c1c8f373957d0c144da0acbfbc17` measured these median checkpoints:

| Heap after GC      |   Baseline | Per-file collector |
| ------------------ | ---------: | -----------------: |
| First emitted edge | 137.96 MiB |          51.01 MiB |
| Last emitted edge  | 345.84 MiB |         258.19 MiB |

All six runs produced CSV SHA-256
`4558668a68f94f4069ed0d471c553db82e0c370877bb3e145b3ac1f9e9f7a1bc`
and ordered-edge SHA-256
`780b5304a9656029612806468d0fb1f38acbb7f7da5f62fc8e8887a4c8823865`.
In a separate pair with `--max-old-space-size=288`, the baseline exhausted the
V8 heap and the per-file collector completed with the same hashes. Disable
core dumps before intentionally running the baseline under this limit.
The sink still retains graph data; these measurements do not establish that
the reporter's whole-repository OOM is fixed.

With `GITNEXUS_DEBUG_HEAP=1`, import emission now records
`sr-emit-imports-start`, `plan-progress`/`plan-end`, `collect-progress`,
`emit-progress`, and `complete` under the same `sr-emit-imports-` prefix.
Planning reports every 1,024 scopes; collection and emission report every
65,536 imports or pairs. `plan-end` identifies `per-file` or `global` mode.
The global compatibility path also records `sr-emit-imports-collected` before
emission. `GITNEXUS_HEAP_PROBE_FILE` retains these checkpoints synchronously.
The existing caller's `sr-emit-imports-end` marker remains unchanged.
