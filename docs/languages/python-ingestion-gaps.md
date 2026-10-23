# Python Ingestion Gaps

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
| `awaitParen`            | RESOLVES       |
| `explicitTypeArgs`      | N/A            |
| `indexElement`          | RESOLVES       |
| `fieldReceiverCall`     | RESOLVES       |
| `decoratedReceiverBase` | N/A            |
| `decoratedFieldType`    | RESOLVES       |

All applicable measured cells resolve, including awaited, indexed and decorated-field receivers. The row does not establish support for every dynamic Python expression or every cross-module binding.

## Planning candidates

| ID        | Evidence       | Gap or boundary                                                                                    | Next planning step and acceptance                                                                                                                                                                       |
| --------- | -------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PYTHON-01 | Coverage audit | No failing cell is recorded; constructor-field receivers and module semantics have separate tests. | Map those suites to the language inventory, then add any missing exact-owner and import-shadowing cases. Require a current reproduction before labeling dynamic or cross-module behavior a product gap. |

## Code and regression entry points

- [Language provider directory](../../gitnexus/src/core/ingestion/languages/python/).
- [Scope resolver](../../gitnexus/src/core/ingestion/languages/python/scope-resolver.ts).
- [python-constructor-field-receiver.test.ts](../../gitnexus/test/integration/resolvers/python-constructor-field-receiver.test.ts).
- [python-namespace-semantics.test.ts](../../gitnexus/test/integration/resolvers/python-namespace-semantics.test.ts).
- [python-module-accessors.test.ts](../../gitnexus/test/integration/resolvers/python-module-accessors.test.ts).

Evidence details: [receiver baseline notes](../../gitnexus/bench/receiver-resolution/BASELINE.md) and
[current roadmap](../../type-resolution-roadmap.md#current-backlog).
