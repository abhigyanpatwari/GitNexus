# Python Ingestion Gaps

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

| Shape                   | Recorded state | Expression or exclusion                       |
| ----------------------- | -------------- | --------------------------------------------- |
| `plainChain`            | RESOLVES       | `svc.get_user().save()`                       |
| `plainDeepChain`        | RESOLVES       | `svc.get_user().address.save()`               |
| `optionalChain`         | N/A            | Python has no optional-chaining operator.     |
| `nonNullAssert`         | N/A            | Python has no non-null assertion operator.    |
| `awaitParen`            | RESOLVES       | `(await svc.get_user_async()).save()`         |
| `explicitTypeArgs`      | N/A            | Python has no call-site type-argument syntax. |
| `indexElement`          | RESOLVES       | `repos[0].save()`                             |
| `fieldReceiverCall`     | RESOLVES       | `self.repo.save()`                            |
| `decoratedReceiverBase` | N/A            | Python `self` carries no type decoration.     |
| `decoratedFieldType`    | RESOLVES       | `self.repo.save()`                            |

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
