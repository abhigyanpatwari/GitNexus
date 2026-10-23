# Kotlin Ingestion Gaps

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
| `optionalChain`         | RESOLVES       |
| `nonNullAssert`         | RESOLVES       |
| `awaitParen`            | RESOLVES       |
| `explicitTypeArgs`      | RESOLVES       |
| `indexElement`          | RESOLVES       |
| `fieldReceiverCall`     | RESOLVES       |
| `decoratedReceiverBase` | N/A            |
| `decoratedFieldType`    | RESOLVES       |

Every applicable shape in this row resolves. Separate qualified-factory controls retain conservative ownership boundaries: inherited receivers need re-established bases and canonical MRO evidence; companion fallback requires captured proof that the companion header has no supertype. This is not a complete build-system classpath model.

## Planning candidates

| ID        | Evidence            | Gap or boundary                                                               | Next planning step and acceptance                                                                                                                                    |
| --------- | ------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KOTLIN-01 | Documented boundary | Complete companion inheritance is outside the delivered factory fallback.     | Reproduce a bounded inherited-companion case before extending it. Keep unknown bases and shadowed factories unresolved and preserve worker/cache ownership evidence. |
| KOTLIN-02 | Coverage audit      | The passing matrix does not measure every package-qualified factory spelling. | Retain the identifier, implicit-receiver and shadow-boundary suites; identify a concrete missing case before proposing broader inference.                            |

## Code and regression entry points

- [Language provider directory](../../gitnexus/src/core/ingestion/languages/kotlin/).
- [Scope resolver](../../gitnexus/src/core/ingestion/languages/kotlin/scope-resolver.ts).
- [kotlin-qualified-factory-implicit-receivers.test.ts](../../gitnexus/test/integration/kotlin-qualified-factory-implicit-receivers.test.ts).
- [kotlin-qualified-factory-type-ownership.test.ts](../../gitnexus/test/integration/kotlin-qualified-factory-type-ownership.test.ts).
- [kotlin-qualified-factory-identifier-review.test.ts](../../gitnexus/test/integration/kotlin-qualified-factory-identifier-review.test.ts).

Evidence details: [receiver baseline notes](../../gitnexus/bench/receiver-resolution/BASELINE.md) and
[current roadmap](../../type-resolution-roadmap.md#current-backlog).
