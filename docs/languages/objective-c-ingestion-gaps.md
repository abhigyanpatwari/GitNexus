# Objective-C Ingestion Gaps

Reviewed on 2026-10-23 against source `bbbc1b49e`. This inventory uses
checked-in evidence; no new ingestion or benchmark run was performed for this update.
See the [inventory guide](README.md) for evidence definitions, the source pin and
planning requirements. Broader ingestion coverage remains unassessed unless noted.

## Receiver shape snapshot

States below come from [baseline.json](../../gitnexus/bench/receiver-resolution/baseline.json).
The [harness](../../gitnexus/bench/receiver-resolution/measure.mjs) defines each
spelling and its N/A reason. RESOLVES checks caller/member names, not exact owners.

No row exists in the checked-in receiver shape arm. Add a measurement contract before comparing this language with measured rows.

Objective-C is registered but has no row in this receiver benchmark. Its dedicated [provider guide](objective-c-provider.md#current-implementation-coverage) documents implemented static message sends, selectors, imports, categories and incremental checks. Runtime dispatch remains deliberately conservative.

## Planning candidates

| ID             | Evidence            | Gap or boundary                                                                                                  | Next planning step and acceptance                                                                                                                                                                  |
| -------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OBJECTIVE-C-01 | Coverage gap        | No shape-arm measurements exist for Objective-C.                                                                 | Define message-send cases for typed locals, self/super, class methods and protocol receivers. Assert full selectors and owners; include category collisions and unknown id receivers as negatives. |
| OBJECTIVE-C-02 | Documented boundary | Objective-C++ `.mm` uses the Objective-C grammar path; deep C++ semantics are outside the MVP.                   | Inventory a minimal mixed-language example before choosing a provider contract. Preserve shared `.h` classification and incremental/full-rebuild parity.                                           |
| OBJECTIVE-C-03 | Deliberate limit    | Swizzling, dynamic selectors, arbitrary macro expansion and id-flow inference are not resolved as certain calls. | Keep unresolved/candidate evidence explicit. Any future slice needs a statically justified target rather than a guessed runtime winner.                                                            |

## Code and regression entry points

- [Language provider directory](../../gitnexus/src/core/ingestion/languages/objective-c/).
- [Scope resolver](../../gitnexus/src/core/ingestion/languages/objective-c/scope-resolver.ts).
- [objective-c-provider.test.ts](../../gitnexus/test/integration/objective-c-provider.test.ts).
- [objective-c-provider.test.ts](../../gitnexus/test/unit/objective-c-provider.test.ts).
- [objective-c-pipeline-benchmark.test.ts](../../gitnexus/test/integration/objective-c-pipeline-benchmark.test.ts).

Evidence details: [receiver baseline notes](../../gitnexus/bench/receiver-resolution/BASELINE.md) and
[current roadmap](../../type-resolution-roadmap.md#current-backlog).
