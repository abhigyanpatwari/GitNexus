# JavaScript Ingestion Gaps

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
| `plainDeepChain`        | RESOLVES       |
| `optionalChain`         | RESOLVES       |
| `nonNullAssert`         | N/A            |
| `awaitParen`            | RESOLVES       |
| `explicitTypeArgs`      | N/A            |
| `indexElement`          | VISIBLE-GAP    |
| `fieldReceiverCall`     | RESOLVES       |
| `decoratedReceiverBase` | N/A            |
| `decoratedFieldType`    | N/A            |

JSDoc supplies the types in the passing plain, deep, optional and awaited chains. `indexElement` remains a visible gap with `@param {User[]} repos`; JavaScript has no `ScopeResolver.elementTypeOf` hook. `untypedChain` is an intentional negative control, not a request to guess a target from its method name.

## Planning candidates

| ID            | Evidence         | Gap or boundary                                                           | Next planning step and acceptance                                                                                                                                             |
| ------------- | ---------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JAVASCRIPT-01 | Measured gap     | A typed array does not establish the receiver type for `repos[0].save()`. | Preserve the container/element distinction and add a provider-owned element route. Require the exact User.save target, a same-name decoy and unsupported-container negatives. |
| JAVASCRIPT-02 | Negative control | `untypedChain` remains VISIBLE-GAP by design.                             | Keep the untyped receiver unresolved while adding typed coverage; resolving a same-named method elsewhere is a precision regression.                                          |

## Code and regression entry points

- [Language provider directory](../../gitnexus/src/core/ingestion/languages/javascript/).
- [Scope resolver](../../gitnexus/src/core/ingestion/languages/javascript/scope-resolver.ts).
- [javascript.test.ts](../../gitnexus/test/integration/resolvers/javascript.test.ts).
- [javascript-object-properties.test.ts](../../gitnexus/test/integration/resolvers/javascript-object-properties.test.ts).
- [javascript-captures.test.ts](../../gitnexus/test/unit/scope-resolution/javascript/javascript-captures.test.ts).

Evidence details: [receiver baseline notes](../../gitnexus/bench/receiver-resolution/BASELINE.md) and
[current roadmap](../../type-resolution-roadmap.md#current-backlog).
