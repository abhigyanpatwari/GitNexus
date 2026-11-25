# JavaScript Ingestion Gaps

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

| Shape                   | Recorded state | Expression or exclusion                                                       |
| ----------------------- | -------------- | ----------------------------------------------------------------------------- |
| `plainChain`            | RESOLVES       | `svc.getUser().save();`                                                       |
| `untypedChain`          | VISIBLE-GAP    | `svc.getUser().save();` (intentional untyped control)                         |
| `plainDeepChain`        | RESOLVES       | `svc.getUser().address.save();`                                               |
| `optionalChain`         | RESOLVES       | `svc?.getUser().save();`                                                      |
| `nonNullAssert`         | N/A            | JavaScript has no non-null assertion operator.                                |
| `awaitParen`            | RESOLVES       | `(await svc.getUserAsync()).save();`                                          |
| `explicitTypeArgs`      | N/A            | JavaScript has no type-argument syntax.                                       |
| `indexElement`          | RESOLVES       | `repos[0].save();`                                                            |
| `fieldReceiverCall`     | RESOLVES       | `this.repo.save();`                                                           |
| `decoratedReceiverBase` | N/A            | JavaScript method receivers carry no type decoration.                         |
| `decoratedFieldType`    | N/A            | JavaScript fields carry no declared type, so there is no decoration to strip. |

JSDoc supplies the types in the passing plain, deep, optional, awaited and indexed chains. `indexElement` resolves with `@param {User[]} repos` through the same `indexOnlyElementType` hook TypeScript uses. `untypedChain` is an intentional negative control, not a request to guess a target from its method name.

## Planning candidates

| ID            | Evidence         | Gap or boundary                                                           | Next planning step and acceptance                                                                                                                                             |
| ------------- | ---------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JAVASCRIPT-01 | Fixed            | A typed array did not establish the receiver type for `repos[0].save()`. | The provider now answers the index route with `indexOnlyElementType`. [The typed-array fixture](../../gitnexus/test/fixtures/lang-resolution/javascript-typed-array-index/) requires the exact `User.save` for `{User[]}`, `{Array<User>}` and `@type` locals, `Decoy.save` for a `Decoy[]` decoy, and no target for a partial `User[][]` index or an untyped receiver. |
| JAVASCRIPT-02 | Negative control | `untypedChain` remains VISIBLE-GAP by design.                             | Keep the untyped receiver unresolved while adding typed coverage; resolving a same-named method elsewhere is a precision regression.                                          |

## Code and regression entry points

- [Language provider directory](../../gitnexus/src/core/ingestion/languages/javascript/).
- [Scope resolver](../../gitnexus/src/core/ingestion/languages/javascript/scope-resolver.ts).
- [javascript.test.ts](../../gitnexus/test/integration/resolvers/javascript.test.ts).
- [javascript-object-properties.test.ts](../../gitnexus/test/integration/resolvers/javascript-object-properties.test.ts).
- [javascript-captures.test.ts](../../gitnexus/test/unit/scope-resolution/javascript/javascript-captures.test.ts).

Evidence details: [receiver baseline notes](../../gitnexus/bench/receiver-resolution/BASELINE.md) and
[current roadmap](../../type-resolution-roadmap.md#current-backlog).
