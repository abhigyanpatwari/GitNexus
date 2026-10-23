# TypeScript Ingestion Gaps

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
| `optionalChain`         | RESOLVES       |
| `nonNullAssert`         | RESOLVES       |
| `awaitParen`            | RESOLVES       |
| `explicitTypeArgs`      | RESOLVES       |
| `indexElement`          | RESOLVES       |
| `fourHopChain`          | RESOLVES       |
| `fieldReceiverCall`     | RESOLVES       |
| `decoratedReceiverBase` | N/A            |
| `decoratedFieldType`    | RESOLVES       |

Every applicable shape resolves, including four-hop chains, indexed receivers and explicit type arguments. These are fixed examples, not a complete type-checker contract. The roadmap still lists type predicates, positional destructuring and discriminated-union narrowing as historical candidates requiring current reproductions.

## Planning candidates

| ID            | Evidence           | Gap or boundary                                                                            | Next planning step and acceptance                                                                                                                                |
| ------------- | ------------------ | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TYPESCRIPT-01 | Historical reports | The deferred narrowing/destructuring items are not marked complete by the receiver series. | Audit each against current tests and pin a failing example before planning code. Define what metadata crosses extraction, ParsedFile and scope resolution.       |
| TYPESCRIPT-02 | Coverage audit     | A passing member-name matrix does not prove complete generic or callable ownership.        | Retain type-parameter, callable-alternative and workspace-package boundaries. Require full target identities and ambiguous/shadowed negatives for new inference. |

## Code and regression entry points

- [Language provider directory](../../gitnexus/src/core/ingestion/languages/typescript/).
- [Scope resolver](../../gitnexus/src/core/ingestion/languages/typescript/scope-resolver.ts).
- [typescript-type-parameters.test.ts](../../gitnexus/test/integration/resolvers/typescript-type-parameters.test.ts).
- [typescript-callable-alternatives.test.ts](../../gitnexus/test/integration/resolvers/typescript-callable-alternatives.test.ts).
- [typescript-workspace-packages.test.ts](../../gitnexus/test/integration/resolvers/typescript-workspace-packages.test.ts).

Evidence details: [receiver baseline notes](../../gitnexus/bench/receiver-resolution/BASELINE.md) and
[current roadmap](../../type-resolution-roadmap.md#current-backlog).
