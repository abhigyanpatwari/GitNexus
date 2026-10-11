# Semantic rename benchmarks

Run from `gitnexus/`:

```sh
node --import tsx bench/rename/measure.mjs
node --import tsx bench/rename/measure.mjs --check
```

The harness executes prepared semantic plans against real temporary files. It
checks exact output, edit counts, line numbers, UTF-16 offsets and CRLF reports;
previews must preserve the source. Native parsing and graph resolution are
covered by the per-language persisted integration suites, rather than included
in these construction timings.

The preview workload grows from 1,000 to 4,000 edits. The normalized scaling
ratio must stay below 2, and the large preview must remain below a generous
one-second ceiling. These gates catch a return to repeated whole-string copying
or repeated prefix line counting. The 100-source, eight-edited-file apply case
reports median time without a filesystem timing gate.

A local Node 22.18.0 comparison on PR #3557 measured:

| Workload | Before | After |
| --- | ---: | ---: |
| 1,000-edit preview | 175 ms | 4.3 ms |
| 4,000-edit preview | 2,823 ms | 13.8 ms |
| Normalized preview scaling | 4.03 | 0.80 |
| Apply: 100 sources, eight edited files | 278 ms | 101 ms |

These are local prepared-plan measurements, not end-to-end indexing timings.

Application still reads every source snapshot before each atomic replacement.
The CLI reuses UTF-8 snapshot buffers and batches at most eight concurrent reads.
This keeps the existing source-change detection and partial-write semantics;
I/O remains proportional to source count times edited-file count. Cached buffers
add memory proportional to the source snapshot bytes and are released with the
operation. The shared package contains no filesystem or native-parser adapter.
