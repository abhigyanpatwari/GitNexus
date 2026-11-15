# C# Ingestion Gaps

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

| Shape                   | Recorded state | Expression or exclusion               |
| ----------------------- | -------------- | ------------------------------------- |
| `plainChain`            | RESOLVES       | `svc.GetUser().Save();`               |
| `plainDeepChain`        | RESOLVES       | `svc.GetUser().Address.Save();`       |
| `optionalChain`         | RESOLVES       | `svc?.GetUser().Save();`              |
| `nonNullAssert`         | RESOLVES       | `svc!.GetUser().Save();`              |
| `awaitParen`            | RESOLVES       | `(await svc.GetUserAsync()).Save();`  |
| `explicitTypeArgs`      | RESOLVES       | `svc.GetTyped<User>().Save();`        |
| `indexElement`          | VISIBLE-GAP    | `repos[0].Save();`                    |
| `fieldReceiverCall`     | RESOLVES       | `this.repo.Save();`                   |
| `decoratedReceiverBase` | N/A            | C# `this` carries no type decoration. |
| `decoratedFieldType`    | RESOLVES       | `this.repo.Save();`                   |

The matrix resolves local nullable fields and the tested chain wrappers. It still loses `repos[0].Save()` with a `User[]` parameter. The resolver already registers an `elementTypeOf` hook, so this gap needs a full capture-to-resolution trace, not an assumption that the hook is absent.

## Planning candidates

| ID        | Evidence            | Gap or boundary                                                                                                 | Next planning step and acceptance                                                                                                                                       |
| --------- | ------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CSHARP-01 | Measured gap        | `indexElement` remains VISIBLE-GAP for a typed array.                                                           | Locate the lost array/type-owner evidence, then assert the exact User.Save target with a same-name decoy and an untyped/unsupported negative.                           |
| CSHARP-02 | Documented boundary | Qualified nullable fields, including `Custom.List<User>?`, are refused until their written owner can be proven. | Establish namespace-aware ownership before adding support. Keep wrapper types distinct from element types and preserve external and workspace-tail collision negatives. |

## Code and regression entry points

- [Language provider directory](../../gitnexus/src/core/ingestion/languages/csharp/).
- [Scope resolver](../../gitnexus/src/core/ingestion/languages/csharp/scope-resolver.ts).
- [csharp-nullable-field-isolated-ownership.test.ts](../../gitnexus/test/integration/csharp-nullable-field-isolated-ownership.test.ts).
- [csharp-nullable-field-generic-arguments.test.ts](../../gitnexus/test/integration/csharp-nullable-field-generic-arguments.test.ts).
- [csharp-namespace-precedence-boundaries.test.ts](../../gitnexus/test/integration/csharp-namespace-precedence-boundaries.test.ts).

Evidence details: [receiver baseline notes](../../gitnexus/bench/receiver-resolution/BASELINE.md) and
[current roadmap](../../type-resolution-roadmap.md#current-backlog).
