# C++ Ingestion Gaps

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
| `pointerArrowChain`     | RESOLVES       |
| `valueDotChain`         | RESOLVES       |
| `plainChain`            | N/A            |
| `plainDeepChain`        | RESOLVES       |
| `optionalChain`         | N/A            |
| `nonNullAssert`         | N/A            |
| `awaitParen`            | N/A            |
| `explicitTypeArgs`      | VISIBLE-GAP    |
| `indexElement`          | RESOLVES       |
| `fieldReceiverCall`     | RESOLVES       |
| `decoratedReceiverBase` | N/A            |
| `decoratedFieldType`    | RESOLVES       |

Pointer-arrow, value-dot, deep-chain, indexed and field-receiver examples resolve in the recorded matrix. `explicitTypeArgs` remains a visible gap: reading `getTyped<User>()` does not generally substitute its declared return type `T` with `User`.

## Planning candidates

| ID     | Evidence       | Gap or boundary                                                                               | Next planning step and acceptance                                                                                                                                        |
| ------ | -------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CPP-01 | Measured gap   | `explicitTypeArgs` has no call edge and records a receiver drop.                              | Tie substitutions to the selected declaration and explicit arguments. Test exact owners, ambiguous overloads and unknown mappings; preserve conversion-only suppression. |
| CPP-02 | Boundary audit | Qualified factories, aliases and headers have dedicated regression suites beyond this matrix. | Retain namespace and alias ownership checks while extending templates. Evaluate header classification jointly with C rather than treating the C all-N/A row as success.  |

## Code and regression entry points

- [Language provider directory](../../gitnexus/src/core/ingestion/languages/cpp/).
- [Scope resolver](../../gitnexus/src/core/ingestion/languages/cpp/scope-resolver.ts).
- [cpp-qualified-template-review.test.ts](../../gitnexus/test/integration/cpp-qualified-template-review.test.ts).
- [cpp-qualified-factory-review.test.ts](../../gitnexus/test/integration/cpp-qualified-factory-review.test.ts).
- [cpp-qualified-receiver-boundaries.test.ts](../../gitnexus/test/integration/cpp-qualified-receiver-boundaries.test.ts).

Evidence details: [receiver baseline notes](../../gitnexus/bench/receiver-resolution/BASELINE.md) and
[current roadmap](../../type-resolution-roadmap.md#current-backlog).
