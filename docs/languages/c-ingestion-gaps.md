# C Ingestion Gaps

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

| Shape                   | Recorded state | Expression or exclusion                                                                            |
| ----------------------- | -------------- | -------------------------------------------------------------------------------------------------- |
| `plainChain`            | N/A            | C has no method call on a returned value; dispatch is through struct function-pointer fields only. |
| `plainDeepChain`        | N/A            | `u->address->save()`: dispatch through a function-pointer field has no static callee in the graph. |
| `optionalChain`         | N/A            | C has no optional-chaining operator.                                                               |
| `nonNullAssert`         | N/A            | C has no non-null assertion operator.                                                              |
| `awaitParen`            | N/A            | C has no await expression.                                                                         |
| `explicitTypeArgs`      | N/A            | C has no generics.                                                                                 |
| `indexElement`          | N/A            | `repos[0].save()`: dispatch through a function-pointer field has no static callee in the graph.    |
| `fieldReceiverCall`     | N/A            | `u->save()`: dispatch through a function-pointer field has no static callee in the graph.          |
| `decoratedReceiverBase` | N/A            | C has no method receiver, so there is no receiver decoration.                                      |
| `decoratedFieldType`    | N/A            | A C struct field is a function pointer, not a typed receiver whose decoration could be stripped.   |

All receiver-shape cells are N/A. The benchmark calls through function-pointer fields with no static callee node; moving the structs into `main.c` did not create a named dispatch target. This does not measure ordinary C calls or establish complete C ingestion.

## Planning candidates

| ID   | Evidence     | Gap or boundary                                                                     | Next planning step and acceptance                                                                                                                                                      |
| ---- | ------------ | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-01 | Recorded gap | The baseline reports C structs in `.h` files being owned by the C++ provider.       | Reproduce with a C translation unit and header, then define ownership using source context. Preserve C++ and Objective-C header classification controls.                               |
| C-02 | Coverage gap | The all-N/A receiver row does not exercise direct calls, linkage or header imports. | Add language-appropriate cases with exact targets and duplicate static names across files. Specify a callable-value target contract before attempting function-pointer field dispatch. |

## Code and regression entry points

- [Language provider directory](../../gitnexus/src/core/ingestion/languages/c/).
- [Scope resolver](../../gitnexus/src/core/ingestion/languages/c/scope-resolver.ts).
- [c-coverage.test.ts](../../gitnexus/test/integration/resolvers/c-coverage.test.ts).
- [c-header-scan.test.ts](../../gitnexus/test/unit/scope-resolution/c/c-header-scan.test.ts).
- [c-static-linkage-side-channel.test.ts](../../gitnexus/test/unit/c-static-linkage-side-channel.test.ts).

Evidence details: [receiver baseline notes](../../gitnexus/bench/receiver-resolution/BASELINE.md) and
[current roadmap](../../type-resolution-roadmap.md#current-backlog).
