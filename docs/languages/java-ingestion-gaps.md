# Java Ingestion Gaps

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

| Shape                   | Recorded state | Expression or exclusion                                                                                                                                                    |
| ----------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plainChain`            | RESOLVES       | `svc.getUser().save();`                                                                                                                                                    |
| `plainDeepChain`        | RESOLVES       | `svc.getUser().address.save();`                                                                                                                                            |
| `optionalChain`         | N/A            | Java has no optional-chaining operator.                                                                                                                                    |
| `nonNullAssert`         | N/A            | Java has no non-null assertion operator.                                                                                                                                   |
| `awaitParen`            | N/A            | Java has no await expression in the core language.                                                                                                                         |
| `explicitTypeArgs`      | RESOLVES       | `svc.<User>getTyped().save();`                                                                                                                                             |
| `indexElement`          | VISIBLE-GAP    | `repos[0].save();`                                                                                                                                                         |
| `fieldReceiverCall`     | RESOLVES       | `this.repo.save();`                                                                                                                                                        |
| `decoratedReceiverBase` | N/A            | Java `this` carries no type decoration.                                                                                                                                    |
| `decoratedFieldType`    | N/A            | Java's only field-type decorations are containers (arrays, generics), which change the member set and are measured by indexElement rather than by a type-preserving strip. |

The matrix resolves plain/deep chains, explicit type arguments and field receivers. `repos[0].save()` with a `User[]` parameter is a visible gap. The explicit-type-argument fixture declares a concrete User return regardless of its type parameter. Its exact target passes, but it does not prove generic return substitution.

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
