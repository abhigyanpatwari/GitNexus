# TypeScript Ingestion Gaps

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
| `indexElement`          | RESOLVES       | `repos[0].save();`                                                                                          |
| `fourHopChain`          | RESOLVES       | `root.getSvc().getUser().address.getCity().save();`                                                         |
| `fieldReceiverCall`     | RESOLVES       | `this.repo.save();`                                                                                         |
| `decoratedReceiverBase` | N/A            | TypeScript `this` carries no type decoration — there is no pointer/reference spelling on a method receiver. |
| `decoratedFieldType`    | RESOLVES       | `this.repo!.save();`                                                                                        |

Every applicable shape resolves, including four-hop chains, indexed receivers and explicit type arguments. These are fixed examples, not a complete type-checker contract. The roadmap still lists type predicates, positional destructuring and discriminated-union narrowing as historical candidates requiring current reproductions.

## Planning candidates

| ID            | Evidence           | Gap or boundary                                                                            | Next planning step and acceptance                                                                                                                                |
| ------------- | ------------------ | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TYPESCRIPT-01 | Historical reports | The deferred narrowing/destructuring items are not marked complete by the receiver series. | Audit each against current tests and pin a failing example before planning code. Define what metadata crosses extraction, ParsedFile and scope resolution.       |
| TYPESCRIPT-02 | Coverage audit     | Passing fixed shapes do not prove complete generic substitution or callable ownership.     | Retain type-parameter, callable-alternative and workspace-package boundaries. Require full target identities and ambiguous/shadowed negatives for new inference. |
| TYPESCRIPT-03 | Resolved in #4217  | Enums (plain, `const`, `declare`, namespaced and in Vue `<script>` blocks) and their identifier-named members are `Enum` and `Property` nodes. Direct, namespace-import, barrel and aliased re-export (`export { Color as Hue }`) reads link to the member. A value typed as the enum (`op.startsWith()`) and Vue's unique-name property fallback do not. Still open: namespace-chain reads (`Theme.Shade.Dark`), quoted members (`'Valid' = 1`), a bare sibling read in an initializer (`Down = Up + 1`), members used as types (`c: Color.Red`), a read through a local alias of the enum object (`const E = Color; E.Red`), an enum merged with a namespace (`Color.parse()`, and `Color.Red` read in the declaring file), and same-named enums in sibling namespaces, functions or merged blocks, which share one node as same-named classes do. | Namespace-chain reads need namespace-qualified receiver resolution, the same gap as `Tools.Helper.run()`. Separate nodes for same-named enums need ids that include the enclosing namespace or function, as #4084 adds for namespaces. Flip the KNOWN GAP rows in [typescript-enums.test.ts](../../gitnexus/test/integration/resolvers/typescript-enums.test.ts) when either lands. |

## Code and regression entry points

- [Language provider directory](../../gitnexus/src/core/ingestion/languages/typescript/).
- [Scope resolver](../../gitnexus/src/core/ingestion/languages/typescript/scope-resolver.ts).
- [typescript-type-parameters.test.ts](../../gitnexus/test/integration/resolvers/typescript-type-parameters.test.ts).
- [typescript-callable-alternatives.test.ts](../../gitnexus/test/integration/resolvers/typescript-callable-alternatives.test.ts).
- [typescript-workspace-packages.test.ts](../../gitnexus/test/integration/resolvers/typescript-workspace-packages.test.ts).
- [typescript-enums.test.ts](../../gitnexus/test/integration/resolvers/typescript-enums.test.ts).

Evidence details: [receiver baseline notes](../../gitnexus/bench/receiver-resolution/BASELINE.md) and
[current roadmap](../../type-resolution-roadmap.md#current-backlog).
