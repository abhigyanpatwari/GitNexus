# Rust Ingestion Gaps

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
| `indexElement`          | RESOLVES       |
| `fieldReceiverCall`     | RESOLVES       |
| `decoratedReceiverBase` | RESOLVES       |
| `decoratedFieldType`    | RESOLVES       |

Every applicable shape resolves, including the bounded Box/Rc/Arc field case. The delivered pointer normalization is conservative: local pointer/trait methods, qualified pointees and opaque implementations can prevent unwrapping. The baseline also records workspace-wide suppression for unresolved non-standard imports or macro_rules definitions.

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
