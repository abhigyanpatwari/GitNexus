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
in the construction timings below.

A second workload runs the whole semantic planner (`planGraphRename`: parsing,
scope resolution, provider receiver proofs, rewrite validation and before/after
binding verification) over one generated TypeScript module. It renames a method
called 2,000 and then 8,000 times from receivers constructed in 20-call
functions, and checks that the produced edits rewrite exactly the declaration and
every call. The normalized planning ratio must stay below 2. This catches
per-occurrence rescans of a file's occurrences, syntax tree or edit list, which
make planning quadratic in file size while leaving small fixtures untouched.

The preview workload grows from 1,000 to 4,000 edits. The normalized scaling
ratio must stay below 2, and the large preview must remain below a generous
one-second ceiling. These gates catch a return to repeated whole-string copying
or repeated prefix line counting. The 100-source, eight-edited-file apply case
reports median time without a filesystem timing gate.

A local Node 22.18.0 comparison on PR #3557 measured:

| Workload                               |   Before |   After |
| -------------------------------------- | -------: | ------: |
| 1,000-edit preview                     |   175 ms |  4.3 ms |
| 4,000-edit preview                     | 2,823 ms | 13.8 ms |
| Normalized preview scaling             |     4.03 |    0.80 |
| Apply: 100 sources, eight edited files |   278 ms |  101 ms |

These are local prepared-plan measurements, not end-to-end indexing timings.

Reviewed previews retain source text only for edited files. Other supported
sources, including existing files absent from the index, retain SHA-256 hashes
and canonical targets. Validation streams those files in 64 KiB chunks and
batches at most eight concurrent reads before each atomic replacement. I/O
remains proportional to source count times edited-file count; retained text is
proportional to edited source bytes. The shared package contains no filesystem
or native-parser adapter.

The harness reports conventional medians (the mean of the two middle samples
for even sample counts), retained text bytes, and preview retention/validation
with 100 and 400 sources. An additional pair leaves half the sources unindexed
to measure their evidence capture. Both 400-source validation cases must stay
below one second and a normalized scaling ratio of 2.5. Reviewed application
also has a one-second ceiling. The existing rename step in `ci-tests.yml` runs
all these checks with `--check`.
