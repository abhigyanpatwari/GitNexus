# Language Ingestion Gap Inventories

These inventories are the starting point for language-specific plans. There is one
`<language>-ingestion-gaps.md` file for each of the 18 languages in
[SCOPE_RESOLVERS](../../gitnexus/src/core/ingestion/scope-resolution/pipeline/registry.ts).
Names match provider directories; `jvm` is shared infrastructure, not another language.

Reviewed on 2026-10-23 against
[`bbbc1b49e`](https://github.com/abhigyanpatwari/GitNexus/commit/bbbc1b49e3427c467b8ac83a112f7793109e279b).
The receiver snapshots transcribe the checked-in
[baseline](../../gitnexus/bench/receiver-resolution/baseline.json) at that revision;
this documentation update did not rerun ingestion. These files seed a broader audit,
not an exhaustive language feature matrix. Parsing, symbol extraction, imports,
visibility, inheritance, reference resolution and incremental behavior need separate
evidence; receiver results alone say nothing about CFG/PDG or rename completeness.

## Inventories

| Language                                     | First planning candidate                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------ |
| [C](c-ingestion-gaps.md)                     | Reproduce header ownership separately from pointer dispatch.             |
| [COBOL](cobol-ingestion-gaps.md)             | Measure procedure-pointer and structural-call paths separately.          |
| [C++](cpp-ingestion-gaps.md)                 | Substitute explicit template arguments into proven return types.         |
| [C#](csharp-ingestion-gaps.md)               | Trace typed array receivers and qualified nullable fields.               |
| [Dart](dart-ingestion-gaps.md)               | Expose indexed-receiver drops and trace non-null assertions.             |
| [Go](go-ingestion-gaps.md)                   | Expand ownership coverage beyond the passing receiver matrix.            |
| [Java](java-ingestion-gaps.md)               | Trace array-element receiver typing.                                     |
| [JavaScript](javascript-ingestion-gaps.md)   | Preserve JSDoc container evidence for indexed receivers.                 |
| [Kotlin](kotlin-ingestion-gaps.md)           | Inventory companion and inherited-receiver limits.                       |
| [Objective-C](objective-c-ingestion-gaps.md) | Add receiver measurements without weakening dynamic-dispatch boundaries. |
| [PHP](php-ingestion-gaps.md)                 | Retain PHPDoc container types and establish namespace owners.            |
| [Python](python-ingestion-gaps.md)           | Audit constructor-field and module ownership coverage.                   |
| [Ruby](ruby-ingestion-gaps.md)               | Isolate YARD parameter bindings before adding recall.                    |
| [Rust](rust-ingestion-gaps.md)               | Measure conservative smart-pointer limits before widening them.          |
| [Swift](swift-ingestion-gaps.md)             | Type indexed receivers, then revalidate historical reports.              |
| [TypeScript](typescript-ingestion-gaps.md)   | Revalidate deferred narrowing contracts.                                 |
| [Vue](vue-ingestion-gaps.md)                 | Measure receivers through actual SFC script blocks.                      |
| [Zig](zig-ingestion-gaps.md)                 | Add matrix coverage for the delivered receiver forms.                    |

## Reading the evidence

| Label                               | Meaning                                                                                                           |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Measured gap                        | A checked-in receiver cell lacks its call edge. Reproduce on the chosen base before fixing it.                    |
| Recorded gap / boundary             | The baseline notes, source contract or dedicated tests describe a limitation; it may be outside the shape matrix. |
| Negative control / deliberate limit | An unresolved result protects precision. Do not make it resolve without new evidence of the exact target.         |
| Coverage gap / audit                | A measurement is absent or coverage needs inventory. This does not establish a product bug.                       |
| Historical reports                  | Older claims still need current positive and negative reproductions.                                              |

The receiver harness has separate states:

- **RESOLVES:** a caller/member-name match exists. Add exact-owner assertions before treating it as proof of correct resolution.
- **VISIBLE-GAP:** no matching edge, with a recorded receiver-unresolved drop. Some cells intentionally represent untyped negative controls.
- **INVISIBLE-GAP:** neither the edge nor the receiver drop is recorded; drop counts cannot reveal this loss.
- **N/A:** the harness declares this spelling inapplicable to its measurement. Read its reason before interpreting language support.
- **GRAMMAR-UNAVAILABLE:** the parser did not load. No behavior was measured; this is not a product-gap verdict.

An all-N/A row (C, COBOL or Vue) does not mean complete ingestion. Zig and
Objective-C have dedicated tests but no row in this shape arm. A fully resolving
row also proves only its fixed examples. The baseline's count arm includes
external and unknown receivers, so total drops are not an actionable bug count.

## Turning an inventory into a plan

1. Select a stable gap ID and pin the implementation base. Record a minimal source
   example, expected full target identity, observed edge/drop and relevant tests.
2. Add a meaningful negative: a same-name decoy, unknown type, shadowed import or
   ambiguous owner. Keep intentional untyped controls unresolved.
3. Locate the missing fact: parsing/capture, type extraction, declaration ownership,
   import binding, receiver folding or dispatch. Keep language rules in providers
   and shared resolution algorithms language-agnostic.
4. Write the plan under `docs/plans/`, linking back to the gap ID. Define the smallest
   contract change, affected tests and corpus/benchmark comparisons. Follow the
   repository's impact-analysis and pre-commit change-analysis requirements.
5. Run focused regressions and the receiver check before updating expectations.
   The [harness](../../gitnexus/bench/receiver-resolution/measure.mjs) documents build
   and cache requirements. Record grammar skips and measurement limits explicitly.
6. Update the inventory with the merged PR, verified source revision and evidence.
   Close the specific item without marking the whole language complete.

Keep historical reports separate from measured gaps. When adding a registered
language, add its inventory here; when refreshing a snapshot, update its source pin
and explain intended baseline changes. Do not copy old green results as fresh runs.

## Related documentation

- [Type Resolution System](../../type-resolution-system.md): active layers and lifecycle.
- [Type Resolution Roadmap](../../type-resolution-roadmap.md): shared priorities and delivered work.
- [Architecture](../../ARCHITECTURE.md#scope-resolution-pipeline-rfc-909-ring-3): provider contract and shared pipeline.
- [Objective-C provider guide](objective-c-provider.md): supported static behavior and runtime limits.
- [Local import scoping](local-import-scoping.md) and [Jupyter notebooks](jupyter-notebook.md).
