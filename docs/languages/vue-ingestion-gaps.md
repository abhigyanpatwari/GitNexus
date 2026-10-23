# Vue Ingestion Gaps

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
| `plainChain`            | N/A            |
| `plainDeepChain`        | N/A            |
| `optionalChain`         | N/A            |
| `nonNullAssert`         | N/A            |
| `awaitParen`            | N/A            |
| `explicitTypeArgs`      | N/A            |
| `indexElement`          | N/A            |
| `fieldReceiverCall`     | N/A            |
| `decoratedReceiverBase` | N/A            |
| `decoratedFieldType`    | N/A            |

The benchmark declares the Vue row N/A because it does not mint a receiver chain for the .vue file itself. The provider delegates script capture to TypeScript/JavaScript machinery and has separate SFC integration tests. The N/A row is not evidence that script-block receivers work or fail.

## Planning candidates

| ID     | Evidence       | Gap or boundary                                                           | Next planning step and acceptance                                                                                                                 |
| ------ | -------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| VUE-01 | Coverage gap   | The receiver shape matrix does not exercise a real single-file component. | Add typed script and script-setup fixtures that import a method owner, then assert exact call targets and source locations after SFC extraction.  |
| VUE-02 | Coverage audit | Script, template and cross-file import behavior need distinct evidence.   | Inventory existing SFC tests before adding cases; keep same-named component imports and compiler macros separate from real callable declarations. |

## Code and regression entry points

- [Language provider directory](../../gitnexus/src/core/ingestion/languages/vue/).
- [Scope resolver](../../gitnexus/src/core/ingestion/languages/vue/scope-resolver.ts).
- [vue-scope.test.ts](../../gitnexus/test/integration/resolvers/vue-scope.test.ts).
- [vue-pipeline-benchmark.test.ts](../../gitnexus/test/integration/vue-pipeline-benchmark.test.ts).
- [vue-sfc-extractor.test.ts](../../gitnexus/test/unit/vue-sfc-extractor.test.ts).

Evidence details: [receiver baseline notes](../../gitnexus/bench/receiver-resolution/BASELINE.md) and
[current roadmap](../../type-resolution-roadmap.md#current-backlog).
