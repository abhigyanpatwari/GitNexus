# Incremental node identity reconciliation

## Compact graph writes (#3852)

Changed analyses retain incremental parsing and file/dependent counts, but write
the complete graph into a fresh LadybugDB file with bulk COPY. The old database
is not cloned for row updates. Derived layers and FTS are rebuilt; compatible
legacy vectors are restored before their index is rebuilt. Unchanged snapshots
still take the no-op path. Existing platform-specific publication rules apply.

Run the native reduction and the production analyzer comparison from `gitnexus/`:

```sh
node bench/incremental-write-integrity/reproduce-growth.cjs
node bench/incremental-write-integrity/reproduce-growth.cjs --large
npm run build
node bench/incremental-write-integrity/measure-compact-writes.mjs --profile --output /tmp/compact-writes.json
```

Both harnesses create isolated temporary fixtures and remove them by default;
`--keep` retains them. The analyzer harness also accepts `--runtime /path/to/repo`
to compare another checkout's compiled runtime. `--profile` records elapsed time
by analyzer progress phase. Timing and file sizes are measurements, not CI
pass/fail thresholds.

The native reduction uses serial uncompressed COPY, a Function node table and
three relationships per node, with no parser, FTS or GitNexus adapter. It measures
individual DELETE/CREATE/SET operations and twelve identical one-file rewrites.
Every rewrite and fresh reload must preserve an exact node/edge tuple fingerprint.
The default fixture has 32,768 nodes, 98,304 edges and repeated 1 KiB content;
`--large` doubles the graph and uses distinct content. It reports checkpointed,
reopened sizes, free-page counts and warm scan medians. These isolate native
storage amplification, without establishing a particular C++ allocation defect.

On Linux x64, Node 22.23.3 and `@ladybugdb/core` 0.22.0, the default fixture grew
from 18.93 MiB to 32.07 MiB after one rewrite (1.69×), then plateaued over the
remaining cycles. A fresh COPY returned it to 18.92 MiB with identical tuples.
The larger fixture grew from 98.64 MiB to 123.36 MiB (1.25×). The smaller fixture
used a 256 MiB native pool; the larger required 1 GiB.

The production comparison uses 128 TypeScript files with 32 mutually calling
functions each, FTS enabled and no generated embeddings. It checks no-op inode
stability and compares sorted node identities plus relationship endpoints,
types and reasons against a forced rebuild of the final source state.

| Three one-file comment edits          | Previous row writes | Fresh-file writes |
| ------------------------------------- | ------------------: | ----------------: |
| Final database                        |           24.85 MiB |         22.52 MiB |
| Fresh rebuild control                 |           22.52 MiB |         22.52 MiB |
| Per-edit elapsed time                 |           6.2–6.5 s |       11.5–13.0 s |
| Node/edge fingerprint matches control |                 yes |               yes |

Fresh-file writes trade additional indexing work and temporary disk space for
compact published storage. These timings came from a shared development host;
they are not an isolated throughput benchmark or a claim of universal speedup.
A repeat on the final build while the full test suite was running took 18.2–19.4 s
per edit, with the same 22.52 MiB size and exact graph fingerprint.
These measurements preceded the empty-table FTS optimization. Profiling showed
that native FTS creation incurs substantial fixed cost even for empty tables.
Analysis now builds indexes only for populated tables. Verification and search
accept an absent index only when a fresh native count proves that table empty;
failed or incomplete count reads retain the normal build/query checks. No table
counts are cached across requests or mutations.

Two serial paired runs compared the initial fresh-file implementation
(`a329a1095`) with this optimization, reversing the order for the second pair.
No tests or repository indexing ran concurrently. Across six one-file edits
per version on the same fixture:

| Measurement                           | All 23 FTS indexes | Only 2 populated indexes |
| ------------------------------------- | -----------------: | -----------------------: |
| Median changed-analysis time          |             8.89 s |                   3.99 s |
| Changed-analysis range                |        8.66–9.73 s |              3.84–4.03 s |
| FTS phase                             |        5.43–6.33 s |              0.72–0.79 s |
| No-op time                            |        0.35–0.37 s |              0.33–0.34 s |
| Final database / fresh control        |  22.52 / 22.52 MiB |        22.52 / 22.52 MiB |
| Node/edge fingerprint matches control |                yes |                      yes |

That is a 55% reduction in median changed-analysis time for this fixture.
Populated tables still require full re-tokenization, and repositories using more
node-table types will save less. Native integration tests compare ranked core
and pooled search results with an independent all-indexes control and exercise
empty-to-populated transitions. The native harness measures query latency
separately. Neither harness proves bounded memory use or Windows native
close/swap behavior.

For the native cause of #3421/#3423 and regressions covering both missing
context results and Unicode Property FTS, see [search-root-cause.md](search-root-cause.md).

From `gitnexus/`:

```sh
node --import tsx bench/incremental-write-integrity/measure.cjs --check
node bench/incremental-write-integrity/reproduce.cjs
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

With the original `@ladybugdb/core` 0.18.3, this reduction produced:

| Phase                     |  Rows | Incorrect tuples |
| ------------------------- | ----: | ---------------: |
| Initial COPY + checkpoint | 8,192 |                0 |
| DELETE                    | 8,128 |                0 |
| Incremental COPY          | 8,192 |            3,936 |
| Explicit checkpoint       | 8,192 |            3,936 |
| Read-only reopen          | 8,192 |            3,936 |

With `@ladybugdb/core` 0.21.1, the same reduction returns zero incorrect
tuples in every phase. The production reconciliation and negative controls
remain required; this result covers the reduced fixture, not a replay of the
original incident.

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

## Memory scaling

`memory.mjs` measures the compiled production reader in a fresh process, without
forcing GC between reads. It records full identity verification, elapsed time,
sampled heap/RSS, the process RSS high-water mark, and initial/final retained heap.
The native pool is 512 MiB for measurements and 1 GiB for fixture creation.

Build the runtime with `npm run build`. Save this configuration outside the repo:

```json
{
  "runtime": "/absolute/path/to/GitNexus",
  "storage": "/tmp/gnx-identity-memory",
  "output": "/tmp/gnx-identity-memory/seed.json",
  "count": 1048576,
  "width": 0,
  "mode": "seed",
  "reader": "stream",
  "iterations": 40
}
```

Run from `gitnexus/`:

```sh
node --expose-gc --max-old-space-size=4096 bench/incremental-write-integrity/memory.mjs /tmp/config.json
```

Then change `mode` to `measure` and choose a new output file. Run each measurement
in a new process and use one process per database at a time. To compare the
original array-based implementation, set `runtime` to its separately built
checkout and `reader` to `baseline`; keep the same fixture and memory limits.

Vary `count` with separate fixtures to measure node scaling. `width` adds that
many ASCII bytes to each of ID, name and path, so it measures identity size
independently of node count. Repeat each point and hold the largest size out of
the fitted curve. A finite RSS fit is evidence over that range, not a guarantee
about every native allocator or the rest of the indexing pipeline.

The streaming verifier retains expected-node maps and one decoded row rather
than a full table of JavaScript rows. The expected maps grow linearly with graph
size; the native query result and the original graph still consume memory.
