# Incremental node identity reconciliation

From `gitnexus/`:

```sh
node --import tsx bench/incremental-write-integrity/measure.cjs --check
node bench/incremental-write-integrity/reproduce.cjs --require-corruption
```

The first command measures the production reconciliation, including every
single-label scan and comparison of ID, name, path and source range. Construction,
CSV loading, checkpoints and correctness controls are outside the timed region.
Two warm-ups precede seven measured samples. Exact counts and SHA-256 fixture
fingerprints reject empty or incomplete work. `--check` gates normalized scaling
against the committed budget, rather than a machine-specific time limit.

On Node v24.19.0, Linux x64, Xeon Platinum 8370C, the initial measurement was
583 ms for 16,384 nodes and 2,810 ms for 65,536 nodes per reconciliation. The
normalized scaling was 1.206 (budget 2). Analyze performs two reconciliations:
after graph COPY/checkpoint and after FTS/embedding work plus a final checkpoint,
before registration, freshness metadata or staging publication.

The verifier covers retained nodes as well as the write set. A path/range filter
would let a corrupted field hide its own row; a count would miss swapped fields
or blank IDs. Folder lifecycle, preserved Community/Process layers and streamed
BasicBlock rows require other oracles and are excluded. Relationships and source
content are outside this identity check.

## Native-only reduction

`reproduce.cjs` uses only `@ladybugdb/core`, its native schema/query/COPY API, and
synthetic ASCII CSV files. There is no parser, parse cache, graph adapter, FTS,
relationship table, periodic checkpoint driver or concurrent writer. Compression
is disabled and COPY is serial, matching the production settings.

It loads 8,192 Function rows, checkpoints, deletes 64 rows belonging to the first
and last owners, then copies back those same 64 tuples. An independent tuple-set
oracle validates the complete single-label scan before and after each operation.
It also compares affected scan rows with primary-key lookups after reopening.
Use `--keep` to retain the synthetic database and CSV files; the JSON output gives
their directory. `--require-corruption` is a diagnostic assertion, deliberately
not a CI requirement: it should fail when the native defect is fixed.

With the pinned `@ladybugdb/core` 0.18.3, this reduction produced:

| Phase                     |  Rows | Incorrect tuples |
| ------------------------- | ----: | ---------------: |
| Initial COPY + checkpoint | 8,192 |                0 |
| DELETE                    | 8,128 |                0 |
| Incremental COPY          | 8,192 |            3,936 |
| Explicit checkpoint       | 8,192 |            3,936 |
| Read-only reopen          | 8,192 |            3,936 |

For example, the scan returned an empty `id` at native offset 64, while a
primary-key lookup at that same offset returned
`Function:src/owner2.ts:fn64` with the correct name/path/range. Smaller 1,024,
2,048 and 4,096-row fixtures remained healthy in the same three-cycle adapter
probe. The affected tuple count varies with fixture size and scan shape.

This isolates a native scan/lookup discrepancy introduced by incremental COPY
into a previously populated table. It survives checkpoint and reopen, but does
not establish physical byte loss or the precise C++ defect. The reported Unicode
change and FTS build are unnecessary for this reduction; this does not prove
that the original incident has exactly the same native cause.

The measurement harness runs selective native writes too. An independent oracle
requires the production verifier to reject any inconsistent scan, both before
and after checkpoint/reopen; healthy scans must certify their complete identity
set. It does not quietly treat the native discrepancy as a successful graph.

Missing-row and swapped-range negative controls separately verify that the
check fails closed. Publication tests inject damage after COPY and after FTS,
assert unchanged registry/freshness, preserve the live staged baseline, and
exercise automatic dirty-index recovery followed by a no-op run.
An in-place verification failure keeps a non-FTS dirty phase: an FTS-only
repair cannot clear the marker and recertify the inconsistent graph.
The same protection applies when FTS returns but analyzer finalization fails
before the final identity scan: recovery still rebuilds the graph.
