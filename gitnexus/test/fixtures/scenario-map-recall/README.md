# Recall audit sources

`audit.json` records manually reviewed positive pairs and distinct scenarios from
PR #3686. The runtime detector still decides whether retrieved candidates are duplicates.

`retired-type-env.ts` preserves 12 pure `stripNullable` callbacks removed from
`test/unit/type-env.test.ts` after the full detector run on PR #3743 confirmed their
duplicates in `test/unit/shared-type-extractors.test.ts`. The callbacks and suite titles
were copied from commit `bd9586e008c6a2dbcd2f15598a3a20c3f2f44f03`; only the import's
relative path changed. These cases have no hooks or mocks.

`retired-shared-type-extractors.ts` preserves 16 `extractElementTypeFromString`
callbacks removed from `test/unit/shared-type-extractors.test.ts` after the
scenario-map detector (issue #3785) confirmed their duplicates in
`test/unit/extract-element-type-from-string.test.ts`. The `stripNullable` tests
remain in `shared-type-extractors.test.ts`.

The `.ts` suffix keeps these source fixtures out of Vitest's `*.test.ts` discovery.
`recall-audit.test.ts` explicitly parses them, keeping all positive audit pairs
while the ordinary test suite executes each scenario once.
