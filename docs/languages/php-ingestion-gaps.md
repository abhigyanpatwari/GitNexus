# PHP Ingestion Gaps

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

| Shape                   | Recorded state | Expression or exclusion                                      |
| ----------------------- | -------------- | ------------------------------------------------------------ |
| `arrowCallChain`        | VISIBLE-GAP    | `$svc->getUser()->save();` (intentional untyped control)     |
| `arrowPropertyPath`     | RESOLVES       | `$this->repo->save();`                                       |
| `plainChain`            | RESOLVES       | `$svc->getUserTyped()->save();`                              |
| `plainDeepChain`        | RESOLVES       | `$svc->getUserTyped()->address->save();`                     |
| `optionalChain`         | RESOLVES       | `$svc?->getUserTyped()->save();`                             |
| `nonNullAssert`         | N/A            | PHP has no non-null assertion operator.                      |
| `awaitParen`            | N/A            | PHP has no await expression in the core language.            |
| `explicitTypeArgs`      | N/A            | PHP has no generic type-argument syntax at a call site.      |
| `indexElement`          | VISIBLE-GAP    | `$repos[0]->save();`                                         |
| `fieldReceiverCall`     | RESOLVES       | `$this->repo->save();`                                       |
| `decoratedReceiverBase` | N/A            | PHP `$this` carries no type decoration on a method receiver. |
| `decoratedFieldType`    | RESOLVES       | `$this->repo->save();`                                       |

Typed return annotations make the plain/deep/nullsafe chains resolve. `indexElement` stays visible: PHPDoc `User[]` is normalized to `User`, losing container evidence, and PHP has no `elementTypeOf` hook. `arrowCallChain` deliberately calls an unannotated producer and remains a negative control.

## Planning candidates

| ID     | Evidence            | Gap or boundary                                                                                                                                                             | Next planning step and acceptance                                                                                                                              |
| ------ | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PHP-01 | Measured gap        | `$repos[0]->save()` cannot use the PHPDoc element type.                                                                                                                     | Preserve both the container and its element type, then add provider-owned element resolution. Check the exact target plus untyped arrays and same-name decoys. |
| PHP-02 | Documented boundary | Functions in multi-namespace files remain ambiguity evidence but are refused as qualified call targets, function imports and factory producers while ownership is unproven. | Capture declaration-local namespace ownership before increasing recall. Preserve single-namespace positives and cross-namespace collision negatives.           |
| PHP-03 | Negative control    | `arrowCallChain` is VISIBLE-GAP for an unannotated return.                                                                                                                  | Keep this control unresolved; a member-name match is not evidence of a receiver type.                                                                          |

## Code and regression entry points

- [Language provider directory](../../gitnexus/src/core/ingestion/languages/php/).
- [Scope resolver](../../gitnexus/src/core/ingestion/languages/php/scope-resolver.ts).
- [php-qualified-factory-review.test.ts](../../gitnexus/test/integration/php-qualified-factory-review.test.ts).
- [php-coverage.test.ts](../../gitnexus/test/integration/resolvers/php-coverage.test.ts).
- [php-scope-capture-tripwire.test.ts](../../gitnexus/test/integration/php-scope-capture-tripwire.test.ts).

Evidence details: [receiver baseline notes](../../gitnexus/bench/receiver-resolution/BASELINE.md) and
[current roadmap](../../type-resolution-roadmap.md#current-backlog).
