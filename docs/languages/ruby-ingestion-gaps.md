# Ruby Ingestion Gaps

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

| Shape                   | Recorded state | Expression or exclusion                                                             |
| ----------------------- | -------------- | ----------------------------------------------------------------------------------- |
| `plainChain`            | RESOLVES       | `plain_svc.get_user.save`                                                           |
| `untypedChain`          | VISIBLE-GAP    | `untyped_svc.get_user.save` (intentional untyped control)                           |
| `plainDeepChain`        | VISIBLE-GAP    | `deep_svc.get_user.address.save`                                                    |
| `optionalChain`         | RESOLVES       | `opt_svc&.get_user.save`                                                            |
| `nonNullAssert`         | N/A            | Ruby has no non-null assertion operator.                                            |
| `awaitParen`            | N/A            | Ruby has no await expression in the core language.                                  |
| `explicitTypeArgs`      | N/A            | Ruby has no type-argument syntax.                                                   |
| `indexElement`          | VISIBLE-GAP    | `idx_repos[0].save`                                                                 |
| `fieldReceiverCall`     | RESOLVES       | `@repo.save`                                                                        |
| `decoratedReceiverBase` | N/A            | Ruby method receivers carry no type decoration.                                     |
| `decoratedFieldType`    | N/A            | Ruby instance variables carry no declared type, so there is no decoration to strip. |

The typed plain and safe-navigation chains resolve. The baseline records YARD parameter bindings landing on Module scope: a typed sibling can lend its type to an untyped parameter with the same name, in either declaration order. The benchmark avoids the collision with distinct parameter names; that workaround does not fix the product. Fresh probes using the same `svc` parameter reproduced the wrong `User.save` edge from the untyped sibling in both declaration orders; see the audit receipt.

## Planning candidates

| ID      | Evidence     | Gap or boundary                                                                                           | Next planning step and acceptance                                                                                                                                                                         |
| ------- | ------------ | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RUBY-01 | Recorded gap | YARD parameter types can leak between sibling functions.                                                  | Bind annotations to the declaring function. Test typed/untyped siblings with the same parameter name in both orders; the typed call must hit its exact owner and the untyped call must remain unresolved. |
| RUBY-02 | Measured gap | `plainDeepChain` reaches an attr_reader property whose type is unavailable.                               | Reproduce the property-type loss before choosing a propagation rule. Preserve accessor dispatch and same-name owner boundaries.                                                                           |
| RUBY-03 | Measured gap | `indexElement` is visible after the walker learned element_reference, but there is no elementTypeOf hook. | Carry YARD Array<User> element evidence into a provider route. Keep unsupported arrays and the intentional untypedChain control unresolved.                                                               |

## Code and regression entry points

- [Language provider directory](../../gitnexus/src/core/ingestion/languages/ruby/).
- [Scope resolver](../../gitnexus/src/core/ingestion/languages/ruby/scope-resolver.ts).
- [ruby-accessor-dispatch.test.ts](../../gitnexus/test/integration/resolvers/ruby-accessor-dispatch.test.ts).
- [ruby-scope.test.ts](../../gitnexus/test/integration/resolvers/ruby-scope.test.ts).
- [ruby-captures-golden.test.ts](../../gitnexus/test/unit/scope-resolution/ruby/ruby-captures-golden.test.ts).

Evidence details: [receiver baseline notes](../../gitnexus/bench/receiver-resolution/BASELINE.md) and
[current roadmap](../../type-resolution-roadmap.md#current-backlog).
