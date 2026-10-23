# Go Ingestion Gaps

Reviewed on 2026-10-23 against source `bbbc1b49e`. This inventory uses
checked-in evidence; no new ingestion or benchmark run was performed for this update.
See the [inventory guide](README.md) for evidence definitions, the source pin and
planning requirements. Broader ingestion coverage remains unassessed unless noted.

## Receiver shape snapshot

States below come from [baseline.json](../../gitnexus/bench/receiver-resolution/baseline.json).
The [harness](../../gitnexus/bench/receiver-resolution/measure.mjs) defines each
spelling and its N/A reason. RESOLVES checks caller/member names, not exact owners.

| Shape                   | Recorded state |
| ----------------------- | -------------- |
| `plainChain`            | RESOLVES       |
| `plainDeepChain`        | RESOLVES       |
| `optionalChain`         | N/A            |
| `nonNullAssert`         | N/A            |
| `awaitParen`            | N/A            |
| `explicitTypeArgs`      | N/A            |
| `indexElement`          | RESOLVES       |
| `fieldReceiverCall`     | RESOLVES       |
| `decoratedReceiverBase` | RESOLVES       |
| `decoratedFieldType`    | RESOLVES       |

Every applicable cell in the checked-in row resolves, including slice indexing and decorated receiver/field types. This is a bounded receiver snapshot, not proof that every package, build variant or import-qualified spelling resolves.

## Planning candidates

| ID    | Evidence       | Gap or boundary                                                                             | Next planning step and acceptance                                                                                                                                                                                        |
| ----- | -------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GO-01 | Coverage audit | No failing shape is recorded in this row; package ownership is exercised by separate tests. | Map those tests to package-qualified receivers, cross-file struct ownership and build variants. Add missing exact-owner cases before proposing a fix; independent modules with matching type names must remain isolated. |

## Code and regression entry points

- [Language provider directory](../../gitnexus/src/core/ingestion/languages/go/).
- [Scope resolver](../../gitnexus/src/core/ingestion/languages/go/scope-resolver.ts).
- [go-build-variant-owners.test.ts](../../gitnexus/test/integration/go-build-variant-owners.test.ts).
- [go-cross-file-struct-owner.test.ts](../../gitnexus/test/integration/go-cross-file-struct-owner.test.ts).
- [go-external-test-package.test.ts](../../gitnexus/test/integration/resolvers/go-external-test-package.test.ts).

Evidence details: [receiver baseline notes](../../gitnexus/bench/receiver-resolution/BASELINE.md) and
[current roadmap](../../type-resolution-roadmap.md#current-backlog).
