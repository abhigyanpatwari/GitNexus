# C++ Ingestion Gaps

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

| Shape                   | Recorded state | Expression or exclusion                                                                                           |
| ----------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------- |
| `pointerArrowChain`     | RESOLVES       | `svc->getUser()->save();`                                                                                         |
| `valueDotChain`         | RESOLVES       | `svc2.getUser()->save();`                                                                                         |
| `plainChain`            | RESOLVES       | `svc->getUser()->save();`                                                                                         |
| `plainDeepChain`        | RESOLVES       | `svc->getUser()->addr.save();`                                                                                    |
| `optionalChain`         | N/A            | C++ has no optional-chaining operator.                                                                            |
| `nonNullAssert`         | N/A            | C++ has no non-null assertion operator.                                                                           |
| `awaitParen`            | VISIBLE-GAP    | `(co_await getUserAsync()).save();`                                                                               |
| `explicitTypeArgs`      | VISIBLE-GAP    | `svc->getTyped<User>()->save();`                                                                                  |
| `indexElement`          | RESOLVES       | `repos[0].save();`                                                                                                |
| `fieldReceiverCall`     | RESOLVES       | `this->repo.save();`                                                                                              |
| `decoratedReceiverBase` | N/A            | C++ `this` is implicitly a pointer with no written decoration; the pointer base is measured by pointerArrowChain. |
| `decoratedFieldType`    | RESOLVES       | `this->repo->save();`                                                                                             |

The canonical `plainChain` now executes `svc->getUser()->save()` and resolves to `User.save`; the separate pointer-arrow and value-dot controls also resolve. The old N/A meant duplicate coverage, not a failed plain chain. Deep-chain, indexed and field-receiver cases also reach their exact expected owners. `explicitTypeArgs` remains a visible gap: reading `getTyped<User>()` does not generally substitute its declared return type `T` with `User`.

## Planning candidates

| ID     | Evidence       | Gap or boundary                                                                                       | Next planning step and acceptance                                                                                                                                        |
| ------ | -------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CPP-01 | Measured gap   | `explicitTypeArgs` has no call edge and records a receiver drop.                                      | Tie substitutions to the selected declaration and explicit arguments. Test exact owners, ambiguous overloads and unknown mappings; preserve conversion-only suppression. |
| CPP-02 | Boundary audit | Qualified factories, aliases and headers have dedicated regression suites beyond this matrix.         | Retain namespace and alias ownership checks while extending templates. Evaluate header classification jointly with C rather than treating the C all-N/A row as success.  |
| CPP-03 | Measured gap   | `(co_await getUserAsync()).save()` is VISIBLE-GAP despite an awaiter declaring `User await_resume()`. | Trace coroutine result typing; require User.save and retain an unknown awaiter negative. The minimal C++20 probe passed a compiler syntax check.                         |

## Code and regression entry points

- [Language provider directory](../../gitnexus/src/core/ingestion/languages/cpp/).
- [Scope resolver](../../gitnexus/src/core/ingestion/languages/cpp/scope-resolver.ts).
- [cpp-qualified-template-review.test.ts](../../gitnexus/test/integration/cpp-qualified-template-review.test.ts).
- [cpp-qualified-factory-review.test.ts](../../gitnexus/test/integration/cpp-qualified-factory-review.test.ts).
- [cpp-qualified-receiver-boundaries.test.ts](../../gitnexus/test/integration/cpp-qualified-receiver-boundaries.test.ts).

Evidence details: [receiver baseline notes](../../gitnexus/bench/receiver-resolution/BASELINE.md) and
[current roadmap](../../type-resolution-roadmap.md#current-backlog).
