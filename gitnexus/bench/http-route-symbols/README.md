# HTTP route symbol scaling

The initial before/after measurements and their limits are in [RESULTS.md](RESULTS.md).

From `gitnexus/`, with the package dependencies installed:

```sh
node --expose-gc --import tsx bench/http-route-symbols/measure.mjs \
  --check --output /tmp/http-route-symbols.json
```

The existing serial benchmark CI job runs this command and uploads the JSON,
including failed checks. Output paths must not already exist. `--root` selects
another checkout's `gitnexus/` package for a comparison; it needs the same
dependencies. Each report identifies the revision, working-tree changes,
extractor, lockfile, harness and scaling-guard hashes.

The harness calls the production `HttpRouteExtractor.extract()` with real
LadybugDB Function, Method and CodeElement tables. Its executor replays fixed
HANDLES_ROUTE rows and an empty FETCHES result, so symbol loading is isolated
from route-discovery query order. The repository directory is empty: this is
an extractor/symbol-loading benchmark, not an indexing or complete group-sync
benchmark. Database creation, imports and correctness assertions are outside
the timed operation. Query preparation, native execution, row transfer, cache
construction, handler lookup and contract assembly are inside it.

| Arm      | Growing input                                        | Expected output             |
| -------- | ---------------------------------------------------- | --------------------------- |
| `spread` | N handler files, six symbols per file                | N exact provider contracts  |
| `dense`  | One file, 6N symbols and N handlers                  | N exact provider contracts  |
| `sparse` | N files, six symbols per file, one requested handler | One exact provider contract |

N is 256, 1,024 and 4,096. All three node labels are populated. Each handler
selects the second Function in its unit, so dense lookups cannot pass by always
choosing the first row. Every invocation compares the full contract array,
including identity, name, file, method and metadata, to an independently
generated expectation. Merely preserving the number of contracts is insufficient.

Each arm/size runs in a fresh child process with one database execution thread
and a 128 MiB buffer pool. Two warmups precede seven samples. GC runs before
each measured invocation, outside its timing. Reports retain every sample and
use medians; there are no retries or removed outliers. Heap and RSS are measured
at the end of extraction. Process maximum RSS also includes fixture construction
and startup. These absolute memory measures include fixed runtime overhead,
which can mask small allocation changes.

An untimed instrumented invocation also records:

- Actual scanned tuples from each symbol query's native `PROFILE` plan. The
  complete plans are saved. Missing or unrecognized scan counters fail closed.
- Symbol-ID property reads through proxies around the real returned rows. This
  detects repeated array searches within one file even when native row transfer
  dominates elapsed time. Timed invocations do not use these proxies or PROFILE.

The shared callable-declaration scaling guard enforces a **1.5** ceiling on
`(large cost / small cost) / (large N / small N)` for every adjacent pair and
the whole 16× span. It gates wall time, CPU, heap, RSS, maximum RSS, scanned
tuples and ID reads. Invalid measurements fail. `--check` requires all arms,
the reviewed sizes and at least seven samples. Overrides without `--check`
are diagnostics. These bounded checks detect regressions; they are not a proof
of linear complexity for every source-scan, name-resolution or database-failure
path in the extractor.

## Implementation bound

At most 500 distinct files use selective lookups. A larger expected set, or
enough files discovered later, triggers one complete symbol scan whose rows
are grouped by file and reused for the rest of that extraction. The membership
list remains bounded: removing the batch cap alone would leave the database's
linear `LIST_CONTAINS` work per row. ID maps are built once per requested file,
preserving the first row for a duplicate ID. Name and containment resolution
continue to use the existing ordered arrays.

Sparse lookups still fetch only their requested symbols. A complete scan retains
all symbol rows, so its memory is proportional to the repository's symbol count.
If that query fails, the existing per-file fallback remains available and the
healthy-path scaling bound no longer applies. The focused regression tests cover
that fallback, later-discovered files, missing files and first-row behavior.
