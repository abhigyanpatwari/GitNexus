# ownership-reconcile

Correctness and scaling gate for `reconcileOwnership`
(`src/core/ingestion/scope-resolution/pipeline/reconcile-ownership.ts`), the
pass that mirrors every field-kind and class-like def into the SemanticModel's
owner-keyed registries before scope resolution reads them.

Defs with no owner (module-level values, locals of free functions, top-level
types) share one registry bucket per name across the whole repository. The pass
skips a def whose node id is already registered under its `(owner, name)`, and
answering that by scanning the bucket for every def is quadratic in the number
of same-named ownerless declarations. The pass scans a bucket while it is short
(most keys hold one def) and answers from a node-id set once it is long. This
gate fails if the check becomes quadratic again.

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
registers each owned member, the second reconciles the same files again (what a later
language pass sees in the shared model) and must register nothing.

The module values and top-level `Options` stay in file-scoped indexes; their
owner-keyed buckets must be empty. Only `Options.level` registers here. The
complete language-fixture graph is compared with and without the former
ownerless entries in `test/integration/ownerless-registry-parity.test.ts`.

## Gates (`baseline.json`)

| Gate                                        | Budget | What it catches                                                                         |
| ------------------------------------------- | ------ | --------------------------------------------------------------------------------------- |
| `shapes` (exact, with fingerprints)         | equal  | a change in what the pass registers for this workload, or in registry order             |
| `reconcile_files_scaling_ratio`             | 1.5    | per-def time growing with the file count                                                |
| `registry_entries_read_files_scaling_ratio` | 1.1    | registry entries handed to the pass per def growing with the file count (deterministic) |

The workload never repeats a def within one pass, so the fingerprints do not
show whether a node-id set is kept current as the pass registers; the unit
tests in `test/unit/scope-resolution/reconcile-ownership.test.ts` cover that.

The work count comes from a wrapper around each registry's `lookupAllByOwner`,
installed outside the timed passes, that adds up the length of every bucket a
read hands back. It sees only reads through the registry: a per-def scan of
some other copy of a bucket leaves it at 1 and is caught by the timing ratio
alone, which is why both gates stay.

Under `--check` a timing ratio over its budget is sampled again, up to 3 rounds
of the profile's samples, before it fails. The budget does not move.

## Negative control

Restoring ownerless registration fails the exact bucket-size gate: a shared
bucket contains one def per file instead of zero. Before ownerless removal,
the scan-only implementation also failed these historical scaling checks:

```
reconcile_files_scaling_ratio: 4.636740799642482 > 1.5 (min of 75 samples)
registry_entries_read_files_scaling_ratio: 4.002001334222816 > 1.1
```

`baseline.json` records the measured runs, the sizing rationale and how to
triage each kind of failure.
