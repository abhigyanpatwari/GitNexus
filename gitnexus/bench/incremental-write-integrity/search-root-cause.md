# Incremental search failures: native cause and regression contracts

Issues [#3421](https://github.com/abhigyanpatwari/GitNexus/issues/3421) and
[#3423](https://github.com/abhigyanpatwari/GitNexus/issues/3423) reported two
symptoms after a small incremental write: valid source strings caused Property
FTS to fail in `LOWER`, and unchanged symbols stopped resolving by both name and
UID. A full rebuild restored service in both reports.

## Cause and effective fix

LadybugDB 0.18.3's `StringColumn::scanFiltered` compared a position in the output
vector with a segment-local length. When a scan crossed segments after selective
DELETE/COPY, it could skip valid string positions. The native scan could return
blank or stale string values while a labeled primary-key lookup still returned
the correct tuple. This establishes an incorrect read, not physical byte loss.

Upstream [LadybugDB #737](https://github.com/LadybugDB/ladybug/pull/737), commit
`a10cecbc76e05f993af6c6f4a57edbbf438bb376`, passes the current segment's scan length
into `scanFiltered` and bounds positions by
`offsetInResult <= pos < offsetInResult + numValuesToScan`. The local read offset
is `startOffsetInChunk + pos - offsetInResult`. The correction first shipped in
LadybugDB 0.19.0.

GitNexus already includes it through the 0.21.1 dependency in
[#3442](https://github.com/abhigyanpatwari/GitNexus/pull/3442), commit
`412446408d0e3f286b9e461fc451c25bf6283b3c`. Keep that native correction and the
existing publication reconciliation. Changing only the UID query to a labeled
lookup would hide one symptom while leaving name scans and FTS vulnerable.

## Controlled causal check

On Linux x64, a clean build of upstream tag `v0.18.3` reproduced both symptoms via
the native C API, without GitNexus, its parser, or the Node binding. Applying
**only the two production-file changes from #737** to that same checkout and
rebuilding removed both failures using the same CSV input and FTS extension
(`v0.18.1/linux_amd64`, the extension ABI used by core 0.18.3).

| Observation after selective COPY | Untouched 0.18.3 | 0.18.3 + #737 only |
| --- | --- | --- |
| Label-free retained UID lookup | 0 rows | Correct row |
| Label-free retained name lookup | 0 rows | Correct row |
| Labeled primary-key control | Correct row | Correct row |
| Function scan with blank ID/name | 1,984 rows | 0 rows |
| Property FTS creation | `LOWER: Invalid UTF-8` | Success |
| Property scan with blank ID/name | 1,984 rows | 0 rows |
| Property `LOWER(content)` | `Invalid UTF-8` | Success |
| Drop/recreate Property FTS | Missing index / orphan table | Success |

The Node fixtures also fail on published core 0.18.3 and pass on 0.21.1. Incorrect
tuple counts vary with the fixture and scan shape (1,984 or 3,936 observed).
The UTF-8 exception itself varies between runs: a failed string scan can return
blank values without throwing. Therefore the regression oracle compares every
source field and checks lookup results, rather than requiring an exception or
treating a successful FTS build as sufficient.

FTS creation expands into multiple statements in the extension's
`create_fts_index.cpp`: it creates internal tables, tokenizes property values
with `LOWER`, then registers the index. A failure during tokenization can leave
`0_property_fts_appears_info` without a catalog index. Dropping by index name then
fails, and creating again can encounter the orphan table. FTS-only repair cannot
correct the underlying string scan. The experiment reproduced this failure
chain, but not #3421's exact missing-index message without an appended native
error. Neither reporter's overwritten private database was available, so this
is a controlled reproduction of both reported symptoms, not a historical replay.

## Permanent regressions

From `gitnexus/`:

```sh
node bench/incremental-write-integrity/reproduce-search.cjs context
node bench/incremental-write-integrity/reproduce-search.cjs property
npx vitest run test/integration/lbug-incremental-search.test.ts
```

Each workload loads 8,192 rows, checkpoints, deletes the first and last owners
(64 rows), then copies back exactly those rows. Row 64 remains untouched.

- `context` uses out-of-line ASCII names and a second node table. Those details
  matter: a single table can turn the UID query into a healthy primary-key scan,
  and short names can stay readable while their IDs are blank. It runs the
  label-free UID/name query shapes from `LocalBackend.resolveContextSymbol` plus
  the labeled primary-key control.
- `property` uses valid, variable-length Unicode in name/content/description,
  builds all three FTS columns, checks the catalog and a retained unique search
  term, exercises `LOWER` on each column, and drops/recreates the index. It uses
  the production FTS result shape (`RETURN node, score`).

Both compare the complete expected tuple set before/after the write, after an
explicit checkpoint, and after read-only reopen. The Property fixture also
checks the repair cycle. The Vitest wrapper runs each native workload in a child
process, requires every expected phase, and rejects nonzero exits and signals.
It belongs to the serialized `lbug-db` project and the Windows/macOS native test list.

The harness requires no network access. It defaults to the pinned core and
vendored platform FTS library. For a diagnostic comparison, set `LBUG_MODULE`
to an absolute path to another installed `@ladybugdb/core` and `FTS_LIBRARY`
to its matching native extension. Core 0.18.3 is expected to exit nonzero; do not
skip the test on that version. `--keep` retains only the synthetic fixture files;
otherwise cleanup errors are reported and fail the command.
