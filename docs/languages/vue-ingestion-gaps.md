# Vue Ingestion Gaps

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

| Shape                   | Recorded state | Expression or exclusion                                                                                     |
| ----------------------- | -------------- | ----------------------------------------------------------------------------------------------------------- |
| `plainChain`            | RESOLVES       | `svc.getUser().save();`                                                                                     |
| `plainDeepChain`        | RESOLVES       | `svc.getUser().address.save();`                                                                             |
| `optionalChain`         | RESOLVES       | `svc?.getUser().save();`                                                                                    |
| `nonNullAssert`         | RESOLVES       | `svc!.getUser().save();`                                                                                    |
| `awaitParen`            | RESOLVES       | `(await svc.getUserAsync()).save();`                                                                        |
| `explicitTypeArgs`      | RESOLVES       | `svc.getTyped<User>().save();`                                                                              |
| `indexElement`          | VISIBLE-GAP    | `repos[0].save();`                                                                                          |
| `fourHopChain`          | RESOLVES       | `root.getSvc().getUser().address.getCity().save();`                                                         |
| `fieldReceiverCall`     | RESOLVES       | `this.repo.save();`                                                                                         |
| `decoratedReceiverBase` | N/A            | TypeScript `this` carries no type decoration — there is no pointer/reference spelling on a method receiver. |
| `decoratedFieldType`    | RESOLVES       | `this.repo!.save();`                                                                                        |

The row now runs a real `<script lang="ts">` SFC against the same typed declarations used by TypeScript. Nine shapes reach their exact expected owners. `repos[0].save()` is VISIBLE-GAP even though the corresponding TypeScript fixture resolves. The former all-N/A row hid both working behavior and this gap. Template expressions and `<script setup>` remain separate coverage surfaces.

## Planning candidates

| ID     | Evidence       | Gap or boundary                                                         | Next planning step and acceptance                                                                                                                           |
| ------ | -------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VUE-01 | Measured gap   | Typed SFC `repos[0].save()` remains VISIBLE-GAP.                        | Compare SFC capture/type bindings and element folding with the resolving TypeScript control. Assert User.save and preserve same-name and untyped negatives. |
| VUE-02 | Coverage audit | Script, template and cross-file import behavior need distinct evidence. | Inventory existing SFC tests before adding cases; keep same-named component imports and compiler macros separate from real callable declarations.           |

## Code and regression entry points

- [Language provider directory](../../gitnexus/src/core/ingestion/languages/vue/).
- [Scope resolver](../../gitnexus/src/core/ingestion/languages/vue/scope-resolver.ts).
- [vue-scope.test.ts](../../gitnexus/test/integration/resolvers/vue-scope.test.ts).
- [vue-pipeline-benchmark.test.ts](../../gitnexus/test/integration/vue-pipeline-benchmark.test.ts).
- [vue-sfc-extractor.test.ts](../../gitnexus/test/unit/vue-sfc-extractor.test.ts).

Evidence details: [receiver baseline notes](../../gitnexus/bench/receiver-resolution/BASELINE.md) and
[current roadmap](../../type-resolution-roadmap.md#current-backlog).
