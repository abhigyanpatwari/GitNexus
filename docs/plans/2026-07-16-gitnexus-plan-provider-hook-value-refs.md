# GitNexus Engineering Plan

> Task: Emit call-graph edges for functions referenced as object-literal property values (provider hooks), fixing false-0 upstream impact (#2437).
> Evidence verified at commit 8292b2bee (worktree `fix/2437-provider-hook-impact`); GitNexus index: /workspace index (same-day state) used for navigation; refresh skipped: every file cited below is byte-identical between the indexed checkout and 8292b2bee (verified by `cmp` across all 12 files), so graph claims transfer to the pin. No PDG layer in the index (0 CDG edges). Deepened 2026-07-16 (same session; depth: deep, impact_depth 3 posture).

## 1. Objective

`impact({target: "emitCppScopeCaptures", direction: "upstream"})` must report the provider file(s) that consume the hook instead of 0 impacted / LOW. Fix: capture identifier-in-property-value references in TypeScript **and JavaScript**, resolve them against function-like symbols only, and emit CALLS edges — so every provider-hook implementation (`emitScopeCaptures`, `preprocessSource`, …) gains its real upstream dependents.

## 2. Current Behaviour

- Baseline reproduced [graph, `impact emitCppScopeCaptures upstream d2`]: 0 impacted / LOW / `epistemic:"exact"`.
- Cypher on incoming edges [graph, quoted]: only CALLS from bench/test callers (reason `import-resolved`; filtered by `includeTests:false`) plus `DEFINES` — **no edge of any type from `gitnexus/src/core/ingestion/languages/c-cpp.ts`**, whose hook assignments are longhand pair values at module scope (`emitScopeCaptures: emitCScopeCaptures` line 407; `emitCppScopeCaptures` line 495) [verified].
- The TS scope query (`languages/typescript/query.ts:940–1046`) captures references only at call sites, member writes/reads, and JSX-as-call; the JS query (`languages/javascript/query.ts:424–478`) has the identical vocabulary and the identical gap [verified]. A bare identifier in property-value position yields no `ReferenceSite` → no `Reference` → no edge.
- `context` on hook implementations under-reports for the same reason; both tools traverse the same edges.

## 3. Relevant Architecture

Capture → site → resolution → edge, every stage generic over reference kind [all verified]:

1. Per-language tree-sitter query emits `@reference.<kind>[.<subtag>]` captures (TS base query is shared by the TSX compilation — TSX = `TYPESCRIPT_SCOPE_QUERY + TSX_JSX_QUERY_SUFFIX`, query.ts:1087–1092; JS has its own `query.ts`).
2. Shared extractor `pass5CollectReferences` / `referenceKindFromAnchor` (`scope-extractor.ts:987–1071`) turns anchors into `ReferenceSite`s — tag-driven, no language names.
3. `resolveReferenceSites` / `lookupForSite` (`resolve-references.ts:90–238`) routes kind → registry; `read`/`write` already falls through to MethodRegistry ("bare-name reads of a function (`cb = save`)", lines 209–221).
4. `emitReferencesViaLookup` (`graph-bridge/references-to-edges.ts:38–113`) emits via `mapReferenceKindToEdgeType` (`graph-bridge/edges.ts:40–63`); reason = `scope-resolution: <kind>`; `resolveCallerGraphId` falls back to the **File node** at module scope (`graph-bridge/ids.ts:7–10`) — the exact shape provider objects need.
5. Parallel emit path `emit-references.ts` has its own exhaustive `mapKindToType` (line 280).

## 4. GitNexus Findings

- ACCESSES is excluded from `impact`'s default `relationTypes` [tool schema]; a plain `read` capture would not fix the issue — the edge must be CALLS.
- `impact mapReferenceKindToEdgeType upstream d2` [graph, quoted]: **HIGH risk**, d=1 = `tryEmitEdge`, `tryEmitEdgeWithExplicitTargetId`, `emitReferencesViaLookup`; d=2 = `emitReceiverBoundCalls`, `emitInterfaceDispatchFor`, `runScopeResolution`. Accounting in §9.
- Graph/source discrepancy (recorded, source wins): `impact` reports 0 upstream for `emitReferencesViaLookup` and `resolveReferenceSites`, yet `runScopeResolution` imports and calls both (`pipeline/run.ts:35,71` + pipeline doc) [verified]. Same under-reporting family as #2437 — treat graph fan-in claims in this area as lower bounds.
- `receiver-bound-calls.ts:265` skips kinds ∉ {call, read, write}; CFG visitors match only `@reference.call.*` tags — a new kind/tag is inert in every existing pass [verified].
- Related tests located [verified]: integration harness `test/integration/resolvers/typescript.test.ts` (`runPipelineFromRepo`, temp fixture repos, `edgeSet`); unit `test/unit/scope-resolution/typescript/typescript-captures.test.ts`; guard `test/integration/grammar-literal-validation.test.ts` (#1920) validates query node-type literals against the grammars.

## 5. Statement-Level PDG Findings

No PDG layer in the current index (0 CDG edges — cypher count). Not refreshed: the change is additive edge-emission across small, source-verified touch points; no statement-level ambiguity constrains the design.

## 6. Proposed Changes

New `ReferenceKind` `'value-ref'`: an identifier in object-literal property-value position, resolved only to callables, emitted as CALLS.

1. `gitnexus-shared/src/scope-resolution/reference-site.ts` — add `'value-ref'` to `ReferenceKind` (lines 34–45) with doc: value-position identifier; MethodRegistry-only resolution; #2437.
2. `gitnexus-shared/src/scope-resolution/types.ts` — add `'value-ref'` to `Reference['kind']` (line ~456; unions kept in sync by contract).
3. `gitnexus/src/core/ingestion/languages/typescript/query.ts` — in the reference section (~line 940), two separate patterns (never `[...]` alternation — tree-sitter 0.21 predicate hazard): `(pair value: (identifier) @reference.name @reference.value-ref)` and `(object (shorthand_property_identifier) @reference.name @reference.value-ref)`. Anchor on the identifier (precise `atRange`/`inScope`); patterns in the shared base cover TS and TSX.
4. `gitnexus/src/core/ingestion/languages/javascript/query.ts` — mirror the same two patterns in its reference section (~line 424). Grammar nodes verified in both grammars' `node-types.json` (`pair`, `shorthand_property_identifier`); destructuring uses the distinct `shorthand_property_identifier_pattern`, so `const { a } = o` cannot match.
5. `gitnexus/src/core/ingestion/scope-extractor.ts` — `referenceKindFromAnchor` (line 1046): `case 'value-ref'` (dot-split head already yields `value-ref`).
6. `gitnexus/src/core/ingestion/resolve-references.ts` — `lookupForSite` (line 197): `case 'value-ref': return methodRegistry.lookup(site.name, site.inScope)` — METHOD_KINDS-only is the function-like gate; `{port: DEFAULT_PORT}` fails resolution and drops. No arity, no receiver.
7. `gitnexus/src/core/ingestion/scope-resolution/graph-bridge/edges.ts` — `mapReferenceKindToEdgeType` (line 40): `'value-ref' → 'CALLS'`.
8. `gitnexus/src/core/ingestion/scope-resolution/graph-bridge/references-to-edges.ts` — tighten the calleeIdSink gate (line 93) to also require `ref.kind === 'call'` so value-refs never enter the PDG resolved-callee-id table (#2227 U2 contract).
9. `gitnexus/src/core/ingestion/emit-references.ts` — `mapKindToType` (line 280): `case 'value-ref': return 'CALLS'` (tsc's exhaustiveness will demand it).
10. `gitnexus/src/storage/parse-cache.ts` — `SCHEMA_BUMP` 13 → 14 (line 58): ParsedFile gains new reference sites; warm caches must invalidate in lockstep.

## 7. Implementation Sequence

1. Shared unions (changes 1–2); run tsc — it enumerates every exhaustive consumer (known: changes 6, 7, 9).
2. Extractor case (change 5).
3. TS + JS query patterns (changes 3–4); run `grammar-literal-validation` + captures unit tests to validate node names and site shape.
4. Resolution + emission (changes 6–9).
5. SCHEMA_BUMP (change 10).
6. Tests (§8), then full suites.
   Per-step note (repo mandate): run `impact` on each symbol before editing (expect the §9 HIGH on `mapReferenceKindToEdgeType`; already surfaced) and `detect_changes()` before each commit.

## 8. Test Strategy

New `gitnexus/test/integration/resolvers/typescript-value-refs.test.ts` (harness: `runPipelineFromRepo` + `writeFixtureRepo`, as in `typescript.test.ts`):
1. Same-file longhand: `function emitHook(){}` + `export const provider = { emitScopeCaptures: emitHook }` → CALLS `provider.ts → emitHook` (File-node caller).
2. Cross-file: hook imported then referenced longhand → CALLS from the importing File node (mirrors c-cpp.ts exactly).
3. Aliased import: `import { emitHook as hookImpl }` + `{ emitScopeCaptures: hookImpl }` → CALLS to the original def.
4. Shorthand: `{ emitHook }` → CALLS.
5. Const-arrow: `const handler = () => {}` + `{ onX: handler }` — pins whether declarator-named arrows are Function defs (expected CALLS; if the def is Variable-labeled, document the miss in §12 instead of forcing it).
6. Negative: `{ port: DEFAULT_PORT }` (const) → no CALLS to `DEFAULT_PORT`.
7. Unchanged: `{ cfgVisitor: createVisitor() }` → single CALLS to `createVisitor` via the call capture, no value-ref duplicate.
8. JS twin: scenarios 1, 4, 6 in a `.js` fixture (JS query mirror).
Unit: extend `typescript-captures.test.ts` — value-position identifier yields a `kind: 'value-ref'` site (name, range, inScope); destructuring shorthand yields none.
Existing suites to watch: resolver integration suites may legitimately gain CALLS edges — review diffs; regenerate goldens deliberately (`UPDATE_GOLDEN=1` harness convention), never blind.
Commands (verified in `gitnexus/package.json`): `npm run test:unit`, `npm run test:integration` (pre-hook builds dist), `npm run build`.

## 9. Risk and Impact Analysis

- `mapReferenceKindToEdgeType` upstream = HIGH [graph]. d=1 accounting: `tryEmitEdge` and `tryEmitEdgeWithExplicitTargetId` pass site kinds that only ever come from existing call/read/write sites — the new case is unreachable from them today; `emitReferencesViaLookup` reaches the new case only for sites the new captures produce. Additive branch; existing kinds' behavior byte-identical.
- Consumers of CALLS semantics: the PDG callee-id sink records CALLS sites — mitigated by change 8 (gate on `ref.kind === 'call'`). `detect_changes`, processes, and community detection see more CALLS edges — intended (that's the fix).
- Edge-count growth: every `key: identifier` site is attempted; only MethodRegistry hits emit. Watch integration snapshot diffs for unexpected volume.
- Warm-cache poisoning without SCHEMA_BUMP: stale ParsedFiles would lack the new sites on incremental runs — change 10 is mandatory, not optional.
- Graph fan-in claims in this subsystem under-report (§4 discrepancy) — the work lane must not treat a LOW `impact` on these files as permission to skip test coverage.

## 10. Files Expected to Change

| File | Symbols | Reason |
|---|---|---|
| gitnexus-shared/src/scope-resolution/reference-site.ts | ReferenceKind | new 'value-ref' member |
| gitnexus-shared/src/scope-resolution/types.ts | Reference | kind union sync |
| gitnexus/src/core/ingestion/languages/typescript/query.ts | TYPESCRIPT_SCOPE_QUERY | pair + shorthand capture patterns |
| gitnexus/src/core/ingestion/languages/javascript/query.ts | JS scope query | same two patterns |
| gitnexus/src/core/ingestion/scope-extractor.ts | referenceKindFromAnchor | new case |
| gitnexus/src/core/ingestion/resolve-references.ts | lookupForSite | MethodRegistry-only route |
| gitnexus/src/core/ingestion/scope-resolution/graph-bridge/edges.ts | mapReferenceKindToEdgeType | value-ref → CALLS |
| gitnexus/src/core/ingestion/scope-resolution/graph-bridge/references-to-edges.ts | emitReferencesViaLookup | calleeIdSink kind gate |
| gitnexus/src/core/ingestion/emit-references.ts | mapKindToType | value-ref → CALLS (parallel path) |
| gitnexus/src/storage/parse-cache.ts | SCHEMA_BUMP | 13 → 14 |
| gitnexus/test/integration/resolvers/typescript-value-refs.test.ts | new | §8 scenarios |
| gitnexus/test/unit/scope-resolution/typescript/typescript-captures.test.ts | extend | value-ref site shape |

## 11. Reusable Implementation Context

```yaml
implementation_context:
  task_summary: "Add ReferenceKind 'value-ref': TS+JS queries capture identifiers in object-literal value position, resolved via MethodRegistry only (function-like gate), emitted as CALLS — provider-hook impls gain upstream dependents (#2437)."
  acceptance_criteria:
    - "impact(emitCppScopeCaptures, upstream) ≥1 dependent incl. c-cpp.ts File node at d=1 after re-analyze"
    - "Generalizes to all provider hook implementations referenced as pair values or shorthand"
    - "Non-callable values ({port: DEFAULT_PORT}) emit nothing"
    - "No regressions; SCHEMA_BUMP bumped"
  primary_symbols:
    - { symbol: TYPESCRIPT_SCOPE_QUERY, file: gitnexus/src/core/ingestion/languages/typescript/query.ts, lines: "81, 940-1046", role: "capture vocabulary; insertion point for new patterns" }
    - { symbol: "JS scope query", file: gitnexus/src/core/ingestion/languages/javascript/query.ts, lines: "424-478", role: "same vocabulary, same gap — mirror patterns" }
    - { symbol: referenceKindFromAnchor, file: gitnexus/src/core/ingestion/scope-extractor.ts, lines: "1046-1071", role: "tag → kind; add case" }
    - { symbol: lookupForSite, file: gitnexus/src/core/ingestion/resolve-references.ts, lines: "190-238", role: "kind → registry; MethodRegistry-only = callable gate" }
    - { symbol: mapReferenceKindToEdgeType, file: gitnexus/src/core/ingestion/scope-resolution/graph-bridge/edges.ts, lines: "40-63", role: "kind → edge type; value-ref → CALLS" }
    - { symbol: emitReferencesViaLookup, file: gitnexus/src/core/ingestion/scope-resolution/graph-bridge/references-to-edges.ts, lines: "38-113", role: "generic emitter; calleeIdSink gate at line 93" }
  related_symbols:
    - { symbol: ReferenceKind, relationship: "type contract", relevance: "gitnexus-shared/src/scope-resolution/reference-site.ts:34-45" }
    - { symbol: Reference, relationship: "type contract", relevance: "gitnexus-shared/src/scope-resolution/types.ts:449-458 (kind union in sync)" }
    - { symbol: mapKindToType, relationship: "parallel emit path", relevance: "gitnexus/src/core/ingestion/emit-references.ts:280 exhaustive switch" }
    - { symbol: resolveCallerGraphId, relationship: "CALLS source resolution", relevance: "File-node fallback at module scope (ids.ts) — provider objects emit from File" }
    - { symbol: SCHEMA_BUMP, relationship: "cache invalidation", relevance: "gitnexus/src/storage/parse-cache.ts:58, currently 13" }
    - { symbol: emitReceiverBoundCalls, relationship: "kind filter", relevance: "receiver-bound-calls.ts:265 skips unknown kinds — inert" }
    - { symbol: grammar-literal-validation.test.ts, relationship: "guard", relevance: "validates query node-type literals (#1920) — catches pattern typos" }
  execution_path:
    - "query captures @reference.value-ref on value-position identifier"
    - "pass5CollectReferences builds ReferenceSite kind 'value-ref' (no callForm/arity)"
    - "lookupForSite → methodRegistry.lookup; non-callables unresolved → dropped"
    - "emitReferencesViaLookup → mapReferenceKindToEdgeType → CALLS, reason 'scope-resolution: value-ref'; module-scope caller = File node"
  pdg_constraints: []   # no PDG layer in index (0 CDG edges); change is statement-level-unambiguous
  architectural_patterns:
    - { pattern: "kind-tag routing, no language names in shared code", example_location: "gitnexus/src/core/ingestion/scope-extractor.ts:1046", usage_guidance: "new behavior enters via tag + kind case, never a language switch (AGENTS.md)" }
    - { pattern: "separate tree-sitter patterns per form", example_location: "gitnexus/src/core/ingestion/languages/typescript/query.ts:940-996", usage_guidance: "no [...] alternation with predicates (0.21 hazard)" }
  files_to_modify:
    - { file: gitnexus-shared/src/scope-resolution/reference-site.ts, symbols: [ReferenceKind], intended_change: "add 'value-ref' + doc" }
    - { file: gitnexus-shared/src/scope-resolution/types.ts, symbols: [Reference], intended_change: "add 'value-ref' to kind union (~line 456)" }
    - { file: gitnexus/src/core/ingestion/languages/typescript/query.ts, symbols: [TYPESCRIPT_SCOPE_QUERY], intended_change: "two patterns near line 940: (pair value: (identifier) @reference.name @reference.value-ref) and (object (shorthand_property_identifier) @reference.name @reference.value-ref)" }
    - { file: gitnexus/src/core/ingestion/languages/javascript/query.ts, symbols: ["JS scope query"], intended_change: "mirror the same two patterns near line 424" }
    - { file: gitnexus/src/core/ingestion/scope-extractor.ts, symbols: [referenceKindFromAnchor], intended_change: "case 'value-ref': return 'value-ref'" }
    - { file: gitnexus/src/core/ingestion/resolve-references.ts, symbols: [lookupForSite], intended_change: "case 'value-ref': methodRegistry.lookup(site.name, site.inScope)" }
    - { file: gitnexus/src/core/ingestion/scope-resolution/graph-bridge/edges.ts, symbols: [mapReferenceKindToEdgeType], intended_change: "case 'value-ref': return 'CALLS'" }
    - { file: gitnexus/src/core/ingestion/scope-resolution/graph-bridge/references-to-edges.ts, symbols: [emitReferencesViaLookup], intended_change: "calleeIdSink add requires ref.kind === 'call' && edgeType === 'CALLS'" }
    - { file: gitnexus/src/core/ingestion/emit-references.ts, symbols: [mapKindToType], intended_change: "case 'value-ref': return 'CALLS'" }
    - { file: gitnexus/src/storage/parse-cache.ts, symbols: [SCHEMA_BUMP], intended_change: "13 → 14 + one-line reason" }
  tests:
    - file: gitnexus/test/integration/resolvers/typescript-value-refs.test.ts
      scenarios:
        - "same-file longhand { emitScopeCaptures: emitHook } → CALLS provider.ts→emitHook"
        - "cross-file import + longhand → CALLS from importing File node"
        - "aliased import { emitHook as hookImpl } → CALLS to original def"
        - "shorthand { emitHook } → CALLS"
        - "const handler = () => {}; { onX: handler } → pin behavior (expected CALLS if Function-labeled)"
        - "{ port: DEFAULT_PORT } → no CALLS"
        - "{ cfgVisitor: createVisitor() } → single CALLS to createVisitor, no duplicate"
        - "JS fixture twins for longhand / shorthand / negative"
    - file: gitnexus/test/unit/scope-resolution/typescript/typescript-captures.test.ts
      scenarios:
        - "value-position identifier → referenceSites entry kind 'value-ref' (name/range/inScope)"
        - "destructuring shorthand ({ a } = o) → no value-ref site"
  verification_commands:
    - "cd gitnexus && npm run test:unit"
    - "cd gitnexus && npm run test:integration"
    - "cd gitnexus && npm run build"
  risks:
    - "HIGH impact on mapReferenceKindToEdgeType (d=1: tryEmitEdge, tryEmitEdgeWithExplicitTargetId, emitReferencesViaLookup) — additive case; verify no existing kind's path changes"
    - "Golden/snapshot suites gain CALLS edges — review diffs, regenerate deliberately (UPDATE_GOLDEN=1), never blind"
    - "Skipping SCHEMA_BUMP poisons warm caches on incremental runs"
    - "calleeIdSink pollution if the kind gate (change 8) is skipped"
  assumptions:
    - "const-arrow declarators are Function-labeled defs — pin via §8 scenario 5; if Variable-labeled, document the miss instead of forcing"
  open_questions:
    - "Should value-ref CALLS carry lower confidence than call sites? Default: keep Resolution confidence (parity with read/write); revisit only if noise appears"
  avoid:
    - "Do not reuse kind 'call' — arity/dispatch semantics and the callable gate both break"
    - "Do not emit ACCESSES — impact excludes it by default; issue stays unfixed"
    - "Do not add value-ref to CALL_TAGS in typescript/captures.ts (no arity capture)"
    - "Do not use [...] pattern alternation with predicates (tree-sitter 0.21 drops siblings)"
    - "Do not treat LOW impact results in this subsystem as reliable (§4 discrepancy) — graph fan-in under-reports here"
    - "Do not repeat repository discovery; all touch points enumerated"
```

## 12. Assumptions and Open Questions

Assumptions and open questions: condensed faithfully in §11. Explicitly deferred follow-ups (adjacent work #2437 did not ask for):
- Other languages with the same pattern (Python dict values, Go map literals, C# object initializers) — same tag + kind now exist for them to adopt.
- Other TS/JS value positions: call arguments (callbacks), `export default fn`, array elements, `as`-cast pair values (`{hook: fn as T}` — known miss).
- Modeling dynamic dispatch `provider.emitScopeCaptures(...)` → concrete implementations (per-impl `IMPLEMENTS_HOOK`-style edges).
- Factory-produced hooks (`cfgVisitor: createCCfgVisitor()`) get no value-ref edge; the factory's existing CALLS edge carries their impact story.
- Investigate the §4 discrepancy (false-0 upstream for `emitReferencesViaLookup`/`resolveReferenceSites` despite direct calls from `runScopeResolution`) — separate under-reporting bug candidate.

## 13. Definition of Done

- All §8 tests pass; `npm run test:unit`, `npm run test:integration`, `npm run build` green in `gitnexus/`; tsc clean; `grammar-literal-validation.test.ts` green.
- SCHEMA_BUMP = 14.
- End-to-end: re-analyze this repo, `impact({target: "emitCppScopeCaptures", direction: "upstream"})` reports ≥1 dependent including the `c-cpp.ts` File node at d=1 (likewise `emitCScopeCaptures`; `context` shows the incoming reference).
- No unreviewed regressions in existing resolver suites (edge additions reviewed, goldens regenerated deliberately).
