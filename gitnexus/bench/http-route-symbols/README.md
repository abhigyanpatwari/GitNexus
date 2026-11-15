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

Every fixture also holds as many symbols again in files that no route names
(`lib/o<n>.opaque`). Every invocation checks that the symbol queries returned
exactly the rows of the requested files: 6N for `spread` and `dense`, 6 for
`sparse`. A loader that reads more of the repository than it was asked for
fails the run, whatever its timings.

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
tuples, returned rows and ID reads. Invalid measurements fail. `--check` requires all arms,
the reviewed sizes and at least seven samples. Overrides without `--check`
are diagnostics. These bounded checks detect regressions; they are not a proof
of linear complexity for every source-scan, name-resolution or database-failure
path in the extractor.

## Implementation bound

Each pass of the extractor names the files it is about to read: the route files
before the graph provider pass, then the scanned files with detections. The
first lookup after that loads every named file with one query, which joins the
three symbol tables to the list of paths. The engine plans that as a hash join:
one scan per table whatever the length of the list, and only the named files'
rows are returned and kept. A healthy extraction therefore issues two symbol
queries, and its work grows with the size of the tables plus the rows it needs.

Two alternatives were measured and rejected:

- `filePath IN $filePaths` is a `LIST_CONTAINS` filter, which walks the list for
  every scanned row. Capping the list at 500 files bounds that work per query
  and repeats the table scans once per 500 files.
- One scan of every symbol row has no list, and returns the rows of every other
  file in the repository as well. Row transfer costs far more per row than the
  scan does, so that was slower than one query per file as soon as the
  requested files were a minority of the symbols.

A file's rows are sorted on their node table and scan offset before the
first-match resolvers read them, so the result does not depend on which query
loaded the file or on the order the engine delivered the rows. ID maps are built
once per requested file, keeping the first row for a duplicate ID.

If the batch query fails, each of its files falls back to its own per-file
query and the healthy-path bound no longer applies. One query returns all the
named files' rows, so its duration grows with them; the per-file fallback also
covers a batch that exceeds the pool's query timeout. The focused regression
tests cover the fallback, files named by each pass, missing files, row order
and first-row behavior.
