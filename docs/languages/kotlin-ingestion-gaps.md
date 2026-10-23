# Kotlin Ingestion Gaps

Audited on 2026-10-23 with freshly built production sources at `c35806d24` and
the accompanying benchmark changes. See the [measurement audit](receiver-resolution-audit.md)
for commands, target checks, exclusions and test limits. Historical reports below
remain separate from freshly measured receiver cases; broader ingestion is not
exhaustively assessed.

## Receiver shape snapshot

States below come from [baseline.json](../../gitnexus/bench/receiver-resolution/baseline.json).
The [harness](../../gitnexus/bench/receiver-resolution/measure.mjs) defines each
spelling and its N/A reason. RESOLVES requires the exact expected declaration ID
and no same-named call to a different owner. WRONG-TARGET records incorrect edges.

| Shape                   | Recorded state | Expression or exclusion                   |
| ----------------------- | -------------- | ----------------------------------------- |
| `plainChain`            | RESOLVES       | `svc.getUser().save()`                    |
| `plainDeepChain`        | RESOLVES       | `svc.getUser().address.save()`            |
| `optionalChain`         | RESOLVES       | `svc?.getUser()?.save()`                  |
| `nonNullAssert`         | RESOLVES       | `svc!!.getUser().save()`                  |
| `awaitParen`            | RESOLVES       | `(svc.getUserAsync()).save()`             |
| `explicitTypeArgs`      | RESOLVES       | `svc.getTyped<User>().save()`             |
| `indexElement`          | RESOLVES       | `repos[0].save()`                         |
| `fieldReceiverCall`     | RESOLVES       | `this.repo.save()`                        |
| `decoratedReceiverBase` | N/A            | Kotlin `this` carries no type decoration. |
| `decoratedFieldType`    | RESOLVES       | `this.repo?.save()`                       |

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
