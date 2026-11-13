# ownership-reconcile

Correctness and scaling gate for `reconcileOwnership`
(`src/core/ingestion/scope-resolution/pipeline/reconcile-ownership.ts`), the
pass that mirrors every field-kind and class-like def into the SemanticModel's
owner-keyed registries before scope resolution reads them.

Defs with no owner (module-level values, locals of free functions, top-level
types) share one registry bucket per name across the whole repository. The pass
skips a def whose node id is already registered under its `(owner, name)`, and
answering that by scanning the bucket for every def is quadratic in the number
of same-named ownerless declarations. This gate fails if it becomes quadratic
again.

```sh
node --import tsx bench/ownership-reconcile/measure.mjs --check   # CI profile
node --import tsx bench/ownership-reconcile/measure.mjs --full    # 75 samples
node --import tsx bench/ownership-reconcile/measure.mjs --shape 2000 --reps 5 --warmup 1
```

Build-free: the corpus goes through the real TypeScript scope extractor and
`populateOwners` on the main thread; no parse worker, no `dist/`.

## Workload

N files, each declaring `logger`, `router` and `config` at module level and a
top-level `interface Options { level: number }`. small = 250 files, large =
1000 files. The timed workload is two passes over a fresh model: the first
registers every def, the second reconciles the same files again (what a later
language pass sees in the shared model) and must register nothing.

## Gates (`baseline.json`)

| Gate | Budget | What it catches |
| --- | --- | --- |
| `shapes` (exact, with fingerprints) | equal | any change in what the pass registers, or in registry order |
| `reconcile_files_scaling_ratio` | 1.5 | per-def time growing with the file count |
| `registry_entries_read_files_scaling_ratio` | 1.1 | registry entries read per def growing with the file count (deterministic) |

The work count comes from a wrapper around each registry's `lookupAllByOwner`,
installed outside the timed passes, that adds up the length of every bucket the
pass reads.

## Negative control

With the per-key node-id sets reverted (the bucket scan), shapes and
fingerprints are unchanged and `--check` fails on both gates:

```
reconcile_files_scaling_ratio: 4.193624253622248 > 1.5
registry_entries_read_files_scaling_ratio: 4.002001334222816 > 1.1
```

`baseline.json` records the measured runs, the sizing rationale and how to
triage each kind of failure.
