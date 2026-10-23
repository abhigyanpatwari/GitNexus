# Go Ingestion Gaps

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

| Shape                   | Recorded state | Expression or exclusion                                                                                 |
| ----------------------- | -------------- | ------------------------------------------------------------------------------------------------------- |
| `plainChain`            | RESOLVES       | `svc.GetUser().Save()`                                                                                  |
| `plainDeepChain`        | RESOLVES       | `svc.GetUser().Address.Save()`                                                                          |
| `optionalChain`         | N/A            | Go has no optional-chaining operator.                                                                   |
| `nonNullAssert`         | N/A            | Go has no non-null assertion operator.                                                                  |
| `awaitParen`            | N/A            | Go has no await expression; concurrency is channel-based.                                               |
| `explicitTypeArgs`      | N/A            | Go methods cannot declare type parameters, so there is no call-site type-argument spelling on a method. |
| `indexElement`          | RESOLVES       | `repos[0].Save()`                                                                                       |
| `fieldReceiverCall`     | RESOLVES       | `h.f.ValM()`                                                                                            |
| `decoratedReceiverBase` | RESOLVES       | `h.f.ValM()`                                                                                            |
| `decoratedFieldType`    | RESOLVES       | `h.f.PtrM()`                                                                                            |

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
