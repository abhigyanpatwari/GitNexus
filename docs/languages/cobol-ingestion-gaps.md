# COBOL Ingestion Gaps

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

| Shape                   | Recorded state | Expression or exclusion                                                                                                                            |
| ----------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plainChain`            | N/A            | The COBOL provider models structural/procedure-pointer calls, not object-oriented receiver chains; those calls have separate integration coverage. |
| `plainDeepChain`        | N/A            | The COBOL provider models structural/procedure-pointer calls, not object-oriented receiver chains; those calls have separate integration coverage. |
| `optionalChain`         | N/A            | The COBOL provider models structural/procedure-pointer calls, not object-oriented receiver chains; those calls have separate integration coverage. |
| `nonNullAssert`         | N/A            | The COBOL provider models structural/procedure-pointer calls, not object-oriented receiver chains; those calls have separate integration coverage. |
| `awaitParen`            | N/A            | The COBOL provider models structural/procedure-pointer calls, not object-oriented receiver chains; those calls have separate integration coverage. |
| `explicitTypeArgs`      | N/A            | The COBOL provider models structural/procedure-pointer calls, not object-oriented receiver chains; those calls have separate integration coverage. |
| `indexElement`          | N/A            | The COBOL provider models structural/procedure-pointer calls, not object-oriented receiver chains; those calls have separate integration coverage. |
| `fieldReceiverCall`     | N/A            | The COBOL provider models structural/procedure-pointer calls, not object-oriented receiver chains; those calls have separate integration coverage. |
| `decoratedReceiverBase` | N/A            | The COBOL provider models structural/procedure-pointer calls, not object-oriented receiver chains; those calls have separate integration coverage. |
| `decoratedFieldType`    | N/A            | The COBOL provider models structural/procedure-pointer calls, not object-oriented receiver chains; those calls have separate integration coverage. |

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
