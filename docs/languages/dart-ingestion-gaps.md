# Dart Ingestion Gaps

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

| Shape                   | Recorded state | Expression or exclusion                 |
| ----------------------- | -------------- | --------------------------------------- |
| `plainChain`            | RESOLVES       | `svc.getUser().save();`                 |
| `plainDeepChain`        | RESOLVES       | `svc.getUser().address.save();`         |
| `optionalChain`         | RESOLVES       | `svc.getUser().address?.save();`        |
| `nonNullAssert`         | VISIBLE-GAP    | `svc.getUser().address!.save();`        |
| `awaitParen`            | WRONG-TARGET   | `(await svc.getUserAsync()).save();`    |
| `explicitTypeArgs`      | VISIBLE-GAP    | `svc.getTyped<User>().save();`          |
| `indexElement`          | INVISIBLE-GAP  | `repos[0].save();`                      |
| `fieldReceiverCall`     | RESOLVES       | `this.repo.save();`                     |
| `decoratedReceiverBase` | N/A            | Dart `this` carries no type decoration. |
| `decoratedFieldType`    | RESOLVES       | `this.repo?.save();`                    |

Typed plain, deep, optional and field chains resolve. The awaited case is WRONG-TARGET: `getUserAsync()` declares `Future<User>`, but the call reaches `Address.save` instead of `User.save`. The previous member-name-only gate incorrectly labeled this RESOLVES. The failing assertion spelling is `svc.getUser().address!.save()`; indexed access uses `List<User> repos`. The recorded statuses identify missing behavior but do not by themselves establish a root cause.

## Planning candidates

| ID      | Evidence              | Gap or boundary                                                                                  | Next planning step and acceptance                                                                                                                                                      |
| ------- | --------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DART-01 | Measured gap          | `indexElement` is INVISIBLE-GAP: neither a call edge nor a receiver drop is recorded.            | Trace reference-site capture, chain extraction and element typing separately. Add both a diagnostic assertion and an exact target assertion before selecting the implementation slice. |
| DART-02 | Measured gap          | `nonNullAssert` is VISIBLE-GAP.                                                                  | Trace the postfix assertion through the typed field chain. Preserve working optional access and nullable-field controls; track awaited-call ownership separately in DART-04.           |
| DART-03 | Recorded boundary     | Callable-return/tear-off invocation is a separate roadmap follow-up.                             | Create a positive case for the primary tear-off expression and an ambiguous callable negative; fixture-local direct calls alone do not prove support.                                  |
| DART-04 | Measured wrong target | `(await svc.getUserAsync()).save()` reaches Address.save instead of User.save.                   | Trace awaited return ownership before increasing recall. Assert the full User.save ID and reject the Address.save decoy; the baseline now exposes this precision defect.               |
| DART-05 | Measured gap          | `svc.getTyped<User>().save()` is VISIBLE-GAP even when getTyped declares a concrete User return. | Trace explicit type-argument call capture and receiver folding. This fixture tests the call spelling, not substitution of a generic return type.                                       |

## Code and regression entry points

- [Language provider directory](../../gitnexus/src/core/ingestion/languages/dart/).
- [Scope resolver](../../gitnexus/src/core/ingestion/languages/dart/scope-resolver.ts).
- [dart-coverage.test.ts](../../gitnexus/test/integration/resolvers/dart-coverage.test.ts).
- [dart.test.ts](../../gitnexus/test/integration/resolvers/dart.test.ts).
- [dart-type-extractor.test.ts](../../gitnexus/test/unit/dart-type-extractor.test.ts).

Evidence details: [receiver baseline notes](../../gitnexus/bench/receiver-resolution/BASELINE.md) and
[current roadmap](../../type-resolution-roadmap.md#current-backlog).

Dart permits explicit method type arguments; inference does not make this shape N/A.
See the [Dart type-system reference](https://dart.dev/language/type-system#type-argument-inference).
