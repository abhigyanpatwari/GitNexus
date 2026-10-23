# Java Ingestion Gaps

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
| `explicitTypeArgs`      | RESOLVES       |
| `indexElement`          | VISIBLE-GAP    |
| `fieldReceiverCall`     | RESOLVES       |
| `decoratedReceiverBase` | N/A            |
| `decoratedFieldType`    | N/A            |

The matrix resolves plain/deep chains, explicit type arguments and field receivers. `repos[0].save()` with a `User[]` parameter is a visible gap. The benchmark only checks caller/member names, so the passing explicit-type-argument case does not prove general generic substitution.

## Planning candidates

| ID      | Evidence       | Gap or boundary                                                     | Next planning step and acceptance                                                                                                                                    |
| ------- | -------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JAVA-01 | Measured gap   | `indexElement` has no call edge and records a receiver drop.        | Trace the array annotation through type bindings and receiver folding. Assert the exact User.save declaration and retain ambiguous/import-shadowed negatives.        |
| JAVA-02 | Coverage audit | Receiver aliases and local types have separate regression coverage. | Include those ownership boundaries in the array plan; document any classpath/source-root assumptions instead of inferring compiler-grade lookup from a passing cell. |

## Code and regression entry points

- [Language provider directory](../../gitnexus/src/core/ingestion/languages/java/).
- [Scope resolver](../../gitnexus/src/core/ingestion/languages/java/scope-resolver.ts).
- [java-receiver-alias-boundaries-review.test.ts](../../gitnexus/test/integration/java-receiver-alias-boundaries-review.test.ts).
- [java-javac-local-types.test.ts](../../gitnexus/test/integration/resolvers/java-javac-local-types.test.ts).
- [java.test.ts](../../gitnexus/test/integration/resolvers/java.test.ts).

Evidence details: [receiver baseline notes](../../gitnexus/bench/receiver-resolution/BASELINE.md) and
[current roadmap](../../type-resolution-roadmap.md#current-backlog).
