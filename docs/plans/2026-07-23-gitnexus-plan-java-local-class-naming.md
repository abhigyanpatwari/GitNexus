# GitNexus Engineering Plan

> Task: Model Java method/constructor-local classes with JLS 13.1 binary identities and the issue-required shared local/anonymous ordinal.
> Evidence verified at commit 6cb3bff629c795cb0db6f6503a4cb8cba26eb141; GitNexus index not used (no `.gitnexus/run.cjs`, installed dependencies, or current index; source-weighted fallback mode).
> Evidence provenance schema 2; global dirty digest 0a9c85780067d9afcd0764f307b60891e3cee927ee11eaeb5ec7826d10fd82cd; cited-path manifest 11 sorted entries; exact generated plan path excluded.

## 1. Objective

Implement collision-free binary identities such as `Outer$1Local` for Java classes declared inside method/constructor bodies, preserve lexical lookup through the source simple name, share the enclosing-type source-order ordinal with anonymous/enum-body shapes as required by #2562, and invalidate persisted identities in lockstep.

## 2. Current Behaviour

- [verified] `synthesizeJavaAnonymousClassName` only accepts object-creation and enum-constant anonymous bodies, derives the immediate host, scans anonymous candidates, and memoizes `$N` names (`gitnexus/src/core/ingestion/utils/ast-helpers.ts:407-534`).
- [verified] Named `class_declaration` captures keep their source identifier in both structure extraction and scope definitions; therefore method-local `Local` classes retain simple identity and can collide (`gitnexus/src/core/ingestion/class-extractors/configs/jvm.ts:11-55`, `gitnexus/src/core/ingestion/languages/java/captures.ts:99-119`).
- [verified] The owner walk special-cases only anonymous shapes before generic class-container handling, so methods in a local class are attributed to `Local` (`gitnexus/src/core/ingestion/utils/ast-helpers.ts:600-617`).
- [verified] Scope definitions use `@declaration.name` for both `DefId` and lexical binding keys (`gitnexus/src/core/ingestion/scope-extractor.ts:487-557,560-611,706-719`).

## 3. Relevant Architecture

The Java structure query materializes graph nodes through `javaClassConfig`; the Java scope-capture emitter feeds the registry-primary scope pipeline; `findEnclosingClassInfo` independently keys member ownership. These layers must call one naming authority so Class ids, scope DefIds, and HAS_METHOD ownership remain identical. Lexical source references still spell `Local`, requiring a distinct binding alias while the definition identity uses `Outer$NLocal`.

## 4. GitNexus Findings

GitNexus graph tools were unavailable in the fresh clone, so all findings are source-derived fallback evidence.

- [verified] Source search found direct naming-authority consumers in Java class extraction, Java scope declaration synthesis, JVM type extraction, and enclosing-owner attribution; changing its accepted shapes is MEDIUM risk.
- [verified] `javaClassConfig.extractName` is the structure-side identity hook and currently delegates only anonymous/enum nodes (`gitnexus/src/core/ingestion/class-extractors/configs/jvm.ts:35-54`).
- [verified] `emitJavaScopeCaptures` already performs Java-local capture rewrites before returning deterministic matches, making it the narrow location to replace a local class's canonical declaration name while retaining an alias (`gitnexus/src/core/ingestion/languages/java/captures.ts:99-283`).
- [verified] Existing integration coverage pins anonymous node identity, owned method ids, dispatch, and source-order numbering (`gitnexus/test/integration/resolvers/java.test.ts:2798-2886`).

## 5. Statement-Level PDG Findings

No PDG layer was available. Source control/data constraints are: local-shape detection must stop at the first enclosing type; name synthesis must derive the host before enumerating only directly hosted candidates; memo entries must be populated for every candidate before return; scope declaration rewriting must happen before the match is appended; owner resolution must prefer synthesized local identity before generic container logic.

## 6. Proposed Changes

1. **`gitnexus/src/core/ingestion/utils/ast-helpers.ts` — `synthesizeJavaAnonymousClassName`, `nearestJavaEnclosingType`, `findEnclosingClassInfo`:** recognize method/constructor-local class declarations; recursively compute enclosing binary host names; enumerate local and anonymous shapes in source order under their immediate host; format local candidates as `$N<SimpleName>` and anonymous candidates as `$N`; memoize both; return the synthesized local identity during owner attribution.
2. **`gitnexus/src/core/ingestion/class-extractors/configs/jvm.ts` — `javaClassConfig.extractName`:** ask the same authority for local `class_declaration` identities while allowing non-local declarations to fall back unchanged.
3. **`gitnexus/src/core/ingestion/languages/java/captures.ts` — `emitJavaScopeCaptures`:** for a local class declaration, preserve its source identifier as `@declaration.binding-name` and replace `@declaration.name` with the binary identity.
4. **`gitnexus/src/core/ingestion/scope-extractor.ts` — `deriveDeclarationName`:** prefer optional `@declaration.binding-name` solely for lexical binding keys; keep canonical DefId/qualifiedName construction on `@declaration.name`.
5. **Fixture/tests:** add one Java fixture covering two same-simple-name local classes in different methods, anonymous/local ordinal interleaving, member attribution, `new Local().inner()` dispatch, and an anonymous class nested in a local class; assert binary Class ids and HAS_METHOD/CALLS targets.
6. **Compatibility pins:** increment `INCREMENTAL_SCHEMA_VERSION` 12→13 with rationale, `SCHEMA_BUMP` 20→21, update the exact U-C5 assertion, and regenerate the Java scope-capture fingerprint once after the fixture/capture behavior is final.

## 7. Implementation Sequence

1. Add the fixture and failing integration assertions to pin required identities, ownership, dispatch, collisions, and ordinal sharing.
2. Generalize the single Java naming authority and owner attribution; run the focused resolver test.
3. Wire structure extraction plus canonical-name/simple-binding capture behavior; add a focused low-level capture assertion if integration diagnostics need it.
4. Bump incremental/parse-cache schema gates and the U-C5 pin.
5. Run the scope-capture benchmark, update only the Java fingerprint and provenance note, then run targeted tests and typecheck.
6. Run change detection, secret scanning, and final code/security review before completion.

## 8. Test Strategy

- `cd gitnexus && npx vitest run test/unit/scope-resolution/java/java-captures.test.ts test/integration/resolvers/java.test.ts test/unit/call-summary-schema-version.test.ts`
- `cd gitnexus && node --import tsx bench/scope-capture/measure.mjs --check` (first run intentionally reports Java drift; capture the emitted Java fingerprint, update only that baseline, rerun).
- `cd gitnexus && npx tsc --noEmit`.
- Manual pipeline assertions: classes include each expected binary name and exclude simple `Local`; HAS_METHOD owner/target ids agree; `new Local().inner()` targets the correct method in each method; anonymous identities reflect the required shared source-order ordinal.

## 9. Risk and Impact Analysis

- **MEDIUM:** the exported naming authority has four direct source consumers and affects graph identity, ownership, receiver binding, and captures.
- Persisted old Class/Method ids cannot be mixed with new ids; both incremental repository reuse and parsed-file caches must cold-invalidate.
- Recursive host naming must remain bounded by the existing ancestor guard and tree-scoped memo to avoid regressions on anonymous-heavy Java.
- A local class's canonical name cannot replace its lexical key without an alias or source references such as `new Local()` stop resolving.
- The issue explicitly requires a shared ordinal. A local javac 17 probe used separate anonymous and per-simple-local sequences; implementation follows the issue acceptance contract and records this discrepancy rather than silently substituting javac 17 behavior.

## 10. Files Expected to Change

| File | Symbols | Reason |
| --- | --- | --- |
| `gitnexus/src/core/ingestion/utils/ast-helpers.ts` | Java naming/owner helpers | Local binary identity and shared ordinal |
| `gitnexus/src/core/ingestion/class-extractors/configs/jvm.ts` | `javaClassConfig` | Structure node identity |
| `gitnexus/src/core/ingestion/languages/java/captures.ts` | `emitJavaScopeCaptures` | Canonical scope def plus simple alias |
| `gitnexus/src/core/ingestion/scope-extractor.ts` | `deriveDeclarationName` | Generic optional lexical alias |
| `gitnexus/test/integration/resolvers/java.test.ts` | Java resolver scenarios | End-to-end regression coverage |
| `gitnexus/test/fixtures/lang-resolution/java-local-class-naming/src/Outer.java` | fixture | Local/anonymous identity scenarios |
| `gitnexus/src/storage/repo-manager.ts` | `INCREMENTAL_SCHEMA_VERSION` | Full reanalysis gate |
| `gitnexus/src/storage/parse-cache.ts` | `SCHEMA_BUMP` | Parsed identity invalidation |
| `gitnexus/test/unit/call-summary-schema-version.test.ts` | U-C5 pin | Exact schema assertion |
| `gitnexus/bench/scope-capture/baselines.json` | Java fingerprint | Intentional capture/fixture drift |

## 11. Reusable Implementation Context

```yaml
implementation_context:
  task_summary: "Give Java method/constructor-local classes JLS-shaped binary identities with issue-required shared local/anonymous ordinals."
  acceptance_criteria:
    - "Local Class nodes and owned Method ids use Host$NLocal identities."
    - "Same-simple-name locals in different methods do not collide."
    - "Local and anonymous candidates use one immediate-host source-order ordinal."
    - "Lexical `Local` references and member dispatch still resolve."
    - "Incremental, parse-cache, U-C5, and Java fingerprint pins move in lockstep."
  evidence_provenance:
    schema_version: 2
    head_commit: "6cb3bff629c795cb0db6f6503a4cb8cba26eb141"
    generated_plan_path: "docs/plans/2026-07-23-gitnexus-plan-java-local-class-naming.md"
    global_dirty_digest:
      algorithm: "sha256"
      canonicalization: "gitnexus-evidence-provenance-v2 NUL-framed UTF-8 records"
      value: "0a9c85780067d9afcd0764f307b60891e3cee927ee11eaeb5ec7826d10fd82cd"
    cited_path_manifest:
      - { path: "gitnexus/bench/scope-capture/baselines.json", state: clean, head_digest: "sha256:4bc480802da888134a248a58440234b5df4871017a07295c4ce68f03e3d007ff" }
      - { path: "gitnexus/package.json", state: clean, head_digest: "sha256:042dbb0ab76844382c5c5f175a20d172014801eed5f4001a821f2150a45eb1b7" }
      - { path: "gitnexus/src/core/ingestion/class-extractors/configs/jvm.ts", state: clean, head_digest: "sha256:5bdbf18a50617178d583f912258c89918b779f1573d55bda76e5fc966c58d359" }
      - { path: "gitnexus/src/core/ingestion/languages/java/captures.ts", state: clean, head_digest: "sha256:d41a87eaff77c3960396519f64866d9c6c8d245e0383139f83f386b9216df9a2" }
      - { path: "gitnexus/src/core/ingestion/scope-extractor.ts", state: clean, head_digest: "sha256:3a35e0177cdad750e10c2cddda81f09adbbd513e2452b92d53c9fb50c5cd385d" }
      - { path: "gitnexus/src/core/ingestion/utils/ast-helpers.ts", state: clean, head_digest: "sha256:e9c524b22afca81fa005c8d84c4b6b2a6ae8a7632c9e7fb25fce890d9fee4a99" }
      - { path: "gitnexus/src/storage/parse-cache.ts", state: clean, head_digest: "sha256:b8fb5fe3e8d9e40f34cf6e94b4a380e707ad5b88e2e36159bb691e028122266e" }
      - { path: "gitnexus/src/storage/repo-manager.ts", state: clean, head_digest: "sha256:ea3a8a328cc9a10dd75b2ff58e89f2894ca3136167023298c4a3f50f47b4e1aa" }
      - { path: "gitnexus/test/fixtures/lang-resolution/java-local-class-naming/src/Outer.java", state: absent, head_digest: absent }
      - { path: "gitnexus/test/integration/resolvers/java.test.ts", state: clean, head_digest: "sha256:dfb6e99412b735f36b76de93d895bb38bec3ab36f8c5dbd66db8db65e0480075" }
      - { path: "gitnexus/test/unit/call-summary-schema-version.test.ts", state: clean, head_digest: "sha256:a41c53ca956bac8d03be72e0355135d44538c0b9083a6927c601d1e542357880" }
  primary_symbols:
    - { symbol: synthesizeJavaAnonymousClassName, file: "gitnexus/src/core/ingestion/utils/ast-helpers.ts", lines: "407-534", role: "single Java synthetic binary-name authority" }
    - { symbol: emitJavaScopeCaptures, file: "gitnexus/src/core/ingestion/languages/java/captures.ts", lines: "83-298", role: "scope declaration canonicalization" }
    - { symbol: findEnclosingClassInfo, file: "gitnexus/src/core/ingestion/utils/ast-helpers.ts", lines: "536-640", role: "member owner identity" }
  related_symbols:
    - { symbol: javaClassConfig.extractName, relationship: CALLS, relevance: "structure node identity" }
    - { symbol: deriveDeclarationName, relationship: DATA_FLOW, relevance: "simple lexical alias" }
    - { symbol: INCREMENTAL_SCHEMA_VERSION, relationship: PERSISTENCE_GATE, relevance: "old graph ids invalidate" }
    - { symbol: SCHEMA_BUMP, relationship: CACHE_GATE, relevance: "old ParsedFiles invalidate" }
  execution_path:
    - "Parse Java and identify scopes/declarations."
    - "Synthesize local binary name from immediate host and direct candidate ordinal."
    - "Use binary name for graph/scope definition ids and source simple name for binding lookup."
    - "Attribute methods and resolve receivers against the same canonical definition."
  pdg_constraints: []
  architectural_patterns:
    - { pattern: "single naming authority across extraction layers", example_location: "gitnexus/src/core/ingestion/utils/ast-helpers.ts:synthesizeJavaAnonymousClassName", usage_guidance: "all identity consumers delegate; do not duplicate ordinal logic" }
  files_to_modify:
    - { file: "gitnexus/src/core/ingestion/utils/ast-helpers.ts", symbols: [synthesizeJavaAnonymousClassName, findEnclosingClassInfo], intended_change: "model local candidates and owners" }
    - { file: "gitnexus/src/core/ingestion/languages/java/captures.ts", symbols: [emitJavaScopeCaptures], intended_change: "canonical name plus lexical alias" }
    - { file: "gitnexus/src/core/ingestion/class-extractors/configs/jvm.ts", symbols: [javaClassConfig], intended_change: "canonical Class node name" }
    - { file: "gitnexus/src/core/ingestion/scope-extractor.ts", symbols: [deriveDeclarationName], intended_change: "optional binding-name precedence" }
    - { file: "gitnexus/src/storage/repo-manager.ts", symbols: [INCREMENTAL_SCHEMA_VERSION], intended_change: "bump to 13" }
    - { file: "gitnexus/src/storage/parse-cache.ts", symbols: [SCHEMA_BUMP], intended_change: "bump to 21" }
  tests:
    - file: "gitnexus/test/integration/resolvers/java.test.ts"
      scenarios: ["same-name locals → distinct Class/Method ids", "mixed local+anonymous → shared ordinals", "new Local().inner() → matching binary method", "anonymous inside local → local-host chain"]
  verification_commands:
    - "cd gitnexus && npx vitest run test/unit/scope-resolution/java/java-captures.test.ts test/integration/resolvers/java.test.ts test/unit/call-summary-schema-version.test.ts"
    - "cd gitnexus && node --import tsx bench/scope-capture/measure.mjs --check"
    - "cd gitnexus && npx tsc --noEmit"
  risks:
    - "Identity mismatch across structure, scope, and owner layers."
    - "Loss of lexical simple-name lookup."
    - "Stale persisted ids without both schema bumps."
  assumptions:
    - "The issue's explicit shared-ordinal requirement is authoritative despite javac 17's observed separate sequences; verify against review expectations."
  open_questions: []
  avoid:
    - "Do not add Java-specific branches to shared ingestion beyond the generic optional binding-name capture contract."
    - "Do not alter member/top-level named class identities."
    - "Do not rebaseline non-Java fingerprints."
```

## 12. Assumptions and Open Questions

- [assumed] The issue's shared source-order ordinal is the acceptance contract. A javac 17 probe generated separate anonymous and per-simple-local sequences; no implementation decision should silently override the stated issue requirement.
- GitNexus/PDG evidence is unavailable because this fresh clone lacks an index and installed analyzer dependencies; execution must re-run impact/change detection after dependencies are installed.
- Explicitly deferred: initializer-block local classes and language-general binary naming are outside the issue's method/constructor ancestor shape.

## 13. Definition of Done

- Focused tests demonstrate `Outer$NLocal` Class identities, collision-free methods/ownership, retained local construction/member dispatch, nested host chains, and shared local/anonymous ordinals.
- Non-local Java class and existing anonymous/enum behavior remains passing.
- Incremental schema is 13, parse cache schema is 21, U-C5 pins 13, and only Java's intentional fingerprint changes.
- Targeted Vitest, benchmark check, TypeScript typecheck, change detection, secret scan, code review, and CodeQL validation pass or have explicitly reported environmental limitations.
