# Dart Ingestion Gaps

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
| `nonNullAssert`         | VISIBLE-GAP    |
| `awaitParen`            | RESOLVES       |
| `explicitTypeArgs`      | N/A            |
| `indexElement`          | INVISIBLE-GAP  |
| `fieldReceiverCall`     | RESOLVES       |
| `decoratedReceiverBase` | N/A            |
| `decoratedFieldType`    | RESOLVES       |

Typed plain, deep, optional, awaited and field chains resolve in the snapshot. The failing assertion spelling is `svc.getUser().address!.save()`; indexed access uses `List<User> repos`. The recorded statuses identify missing behavior but do not by themselves establish a root cause.

## Planning candidates

| ID      | Evidence          | Gap or boundary                                                                       | Next planning step and acceptance                                                                                                                                                      |
| ------- | ----------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DART-01 | Measured gap      | `indexElement` is INVISIBLE-GAP: neither a call edge nor a receiver drop is recorded. | Trace reference-site capture, chain extraction and element typing separately. Add both a diagnostic assertion and an exact target assertion before selecting the implementation slice. |
| DART-02 | Measured gap      | `nonNullAssert` is VISIBLE-GAP.                                                       | Trace the postfix assertion through the typed field chain. Preserve working optional access, await and nullable-field controls.                                                        |
| DART-03 | Recorded boundary | Callable-return/tear-off invocation is a separate roadmap follow-up.                  | Create a positive case for the primary tear-off expression and an ambiguous callable negative; fixture-local direct calls alone do not prove support.                                  |

## Code and regression entry points

- [Language provider directory](../../gitnexus/src/core/ingestion/languages/dart/).
- [Scope resolver](../../gitnexus/src/core/ingestion/languages/dart/scope-resolver.ts).
- [dart-coverage.test.ts](../../gitnexus/test/integration/resolvers/dart-coverage.test.ts).
- [dart.test.ts](../../gitnexus/test/integration/resolvers/dart.test.ts).
- [dart-type-extractor.test.ts](../../gitnexus/test/unit/dart-type-extractor.test.ts).

Evidence details: [receiver baseline notes](../../gitnexus/bench/receiver-resolution/BASELINE.md) and
[current roadmap](../../type-resolution-roadmap.md#current-backlog).
