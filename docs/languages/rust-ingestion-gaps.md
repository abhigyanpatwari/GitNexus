# Rust Ingestion Gaps

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

| Shape                   | Recorded state | Expression or exclusion                                             |
| ----------------------- | -------------- | ------------------------------------------------------------------- |
| `plainChain`            | RESOLVES       | `svc.get_user().save();`                                            |
| `plainDeepChain`        | RESOLVES       | `svc.get_user().address.save();`                                    |
| `optionalChain`         | N/A            | Rust `?` is error propagation, not optional chaining on a receiver. |
| `nonNullAssert`         | N/A            | Rust has no non-null assertion operator.                            |
| `awaitParen`            | RESOLVES       | `(svc.get_user_async().await).save();`                              |
| `explicitTypeArgs`      | RESOLVES       | `svc.get_typed::<User>().save();`                                   |
| `indexElement`          | RESOLVES       | `repos[0].save();`                                                  |
| `fieldReceiverCall`     | RESOLVES       | `self.repo.save();`                                                 |
| `decoratedReceiverBase` | RESOLVES       | `self.repo.save();`                                                 |
| `decoratedFieldType`    | RESOLVES       | `self.repo.save();`                                                 |

Every applicable shape resolves, including the bounded Box/Rc/Arc field case and the newly executed `(svc.get_user_async().await).save()` fixture. The prior await N/A was an untested exclusion, not a syntax restriction. The delivered pointer normalization is conservative: local pointer/trait methods, qualified pointees and opaque implementations can prevent unwrapping. The baseline also records workspace-wide suppression for unresolved non-standard imports or macro_rules definitions.

## Planning candidates

| ID      | Evidence            | Gap or boundary                                                                                                    | Next planning step and acceptance                                                                                                                         |
| ------- | ------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RUST-01 | Documented boundary | A conservative dispatch guard can suppress otherwise useful pointer-field resolution in another file.              | Measure recall on a fixed crate and identify the exact missing proof before narrowing the guard. Preserve pointer-owned and local-trait method negatives. |
| RUST-02 | Documented boundary | Qualified pointees, projections and opaque/macro-generated dispatch are outside the proven field-unwrapping slice. | Take one owner-provable form at a time with exact targets; do not infer full Rust autoderef or macro expansion from the passing decoratedFieldType cell.  |

## Code and regression entry points

- [Language provider directory](../../gitnexus/src/core/ingestion/languages/rust/).
- [Scope resolver](../../gitnexus/src/core/ingestion/languages/rust/scope-resolver.ts).
- [rust-pointer-expansion-dispatch.test.ts](../../gitnexus/test/integration/rust-pointer-expansion-dispatch.test.ts).
- [rust-pointer-opaque-dispatch.test.ts](../../gitnexus/test/integration/rust-pointer-opaque-dispatch.test.ts).
- [rust-qualified-factory-boundaries.test.ts](../../gitnexus/test/integration/rust-qualified-factory-boundaries.test.ts).

Evidence details: [receiver baseline notes](../../gitnexus/bench/receiver-resolution/BASELINE.md) and
[current roadmap](../../type-resolution-roadmap.md#current-backlog).
