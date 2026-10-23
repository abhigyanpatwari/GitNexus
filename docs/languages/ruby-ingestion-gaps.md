# Ruby Ingestion Gaps

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
| `untypedChain`          | VISIBLE-GAP    |
| `plainDeepChain`        | VISIBLE-GAP    |
| `optionalChain`         | RESOLVES       |
| `nonNullAssert`         | N/A            |
| `awaitParen`            | N/A            |
| `explicitTypeArgs`      | N/A            |
| `indexElement`          | VISIBLE-GAP    |
| `fieldReceiverCall`     | RESOLVES       |
| `decoratedReceiverBase` | N/A            |
| `decoratedFieldType`    | N/A            |

The typed plain and safe-navigation chains resolve. The baseline records YARD parameter bindings landing on Module scope: a typed sibling can lend its type to an untyped parameter with the same name, in either declaration order. The benchmark avoids the collision with distinct parameter names; that workaround does not fix the product.

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
