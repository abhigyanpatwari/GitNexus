# C Ingestion Gaps

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
| `plainChain`            | N/A            |
| `plainDeepChain`        | N/A            |
| `optionalChain`         | N/A            |
| `nonNullAssert`         | N/A            |
| `awaitParen`            | N/A            |
| `explicitTypeArgs`      | N/A            |
| `indexElement`          | N/A            |
| `fieldReceiverCall`     | N/A            |
| `decoratedReceiverBase` | N/A            |
| `decoratedFieldType`    | N/A            |

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
