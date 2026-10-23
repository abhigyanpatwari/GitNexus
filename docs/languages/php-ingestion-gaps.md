# PHP Ingestion Gaps

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
| `arrowCallChain`        | VISIBLE-GAP    |
| `arrowPropertyPath`     | RESOLVES       |
| `plainChain`            | RESOLVES       |
| `plainDeepChain`        | RESOLVES       |
| `optionalChain`         | RESOLVES       |
| `nonNullAssert`         | N/A            |
| `awaitParen`            | N/A            |
| `explicitTypeArgs`      | N/A            |
| `indexElement`          | VISIBLE-GAP    |
| `fieldReceiverCall`     | N/A            |
| `decoratedReceiverBase` | N/A            |
| `decoratedFieldType`    | RESOLVES       |

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
