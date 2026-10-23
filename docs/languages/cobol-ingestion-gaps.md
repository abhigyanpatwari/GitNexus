# COBOL Ingestion Gaps

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

The receiver benchmark marks COBOL N/A because its emitter has no method-call receiver chains. The registered resolver uses `scopeResolutionEdgeMode: callable-flow-only`: it contributes procedure-pointer CALLS while the established COBOL processor owns structural CALLS and IMPORTS.

## Planning candidates

| ID       | Evidence       | Gap or boundary                                                     | Next planning step and acceptance                                                                                                                      |
| -------- | -------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| COBOL-01 | Coverage gap   | OO receiver shapes do not measure COBOL call resolution.            | Inventory direct CALL, procedure-pointer, PERFORM and COPY cases against the existing suites; add a measurement only where coverage is missing.        |
| COBOL-02 | Boundary audit | Structural and callable-flow edges have separate production owners. | Compare exact target identities, qualified data names and duplicate program names. Assert neither path introduces duplicate or unjustified call edges. |

## Code and regression entry points

- [Language provider directory](../../gitnexus/src/core/ingestion/languages/cobol/).
- [Scope resolver](../../gitnexus/src/core/ingestion/languages/cobol/scope-resolver.ts).
- [cobol-scope.test.ts](../../gitnexus/test/integration/resolvers/cobol-scope.test.ts).
- [cobol-parsing-coverage.test.ts](../../gitnexus/test/integration/resolvers/cobol-parsing-coverage.test.ts).
- [cobol-pipeline-benchmark.test.ts](../../gitnexus/test/integration/cobol-pipeline-benchmark.test.ts).

Evidence details: [receiver baseline notes](../../gitnexus/bench/receiver-resolution/BASELINE.md) and
[current roadmap](../../type-resolution-roadmap.md#current-backlog).
