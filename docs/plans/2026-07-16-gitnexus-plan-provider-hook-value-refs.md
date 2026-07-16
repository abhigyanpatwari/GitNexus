# GitNexus Engineering Plan

> Task: Model functions referenced as object-literal property values (provider hooks): reference-class USES edge at the registration site + field-based synthesized CALLS at the real dispatch sites (#2437).
> Evidence verified at commit 8292b2bee (worktree `fix/2437-provider-hook-impact`); GitNexus index: /workspace index used for navigation; refresh skipped: all cited files byte-identical to the pin (`cmp`-verified). No PDG layer in the index. Deepened twice 2026-07-16 (same session): pass 1 = depth escalation; pass 2 = design revision after external prior-art research (user gate).

## 1. Objective

`impact({target: "emitCppScopeCaptures", direction: "upstream"})` must report the true dependents instead of 0/LOW. Two coordinated halves, matching industry practice:
- **Registration** (`{ emitScopeCaptures: emitCppScopeCaptures }`) → a reference-class **USES** edge (visible in `context`, which already traverses USES).
- **Dispatch** (`provider.emitScopeCaptures(...)`) → field-based synthesized **CALLS** from member-call sites to every function registered under that property name (fixes `impact` with the *true* caller, `extractParsedFile`, and its execution flows).

## 2. Current Behaviour

- Baseline [graph, reproduced]: `impact(emitCppScopeCaptures, upstream)` = 0 / LOW / `epistemic:"exact"`. Cypher: no edge of any type from `c-cpp.ts` (hook assignments lines 407, 495); **zero CALLS edges targeting any symbol named `emitScopeCaptures`** — the dispatch site (`scope-extractor-bridge.ts:52`) is fully dark [verified].
- TS query (`languages/typescript/query.ts:940–1046`) and JS query (`languages/javascript/query.ts:424–478`) capture references only at call sites, member reads/writes, JSX — no value-position capture [verified].
- Interface dispatch already exists for classes: `emitInterfaceDispatchFor` (receiver-bound-calls.ts:215–252) fans member calls out to implementors with reason `interface-dispatch` and discounted confidence — but object literals never get IMPLEMENTS edges, so provider objects don't participate [verified].

## 3. Relevant Architecture

Capture → site → resolution → edge, generic over reference kind (details, all [verified]): per-language queries emit `@reference.*` captures; shared `pass5CollectReferences`/`referenceKindFromAnchor` (`scope-extractor.ts:987–1071`) builds `ReferenceSite`s; `resolveReferenceSites`/`lookupForSite` (`resolve-references.ts`) routes kind → registry; `emitReferencesViaLookup` (`references-to-edges.ts`) emits via `mapReferenceKindToEdgeType` (`graph-bridge/edges.ts`); `resolveCallerGraphId` falls back to the File node at module scope. Parallel emit path `emit-references.ts` has its own exhaustive `mapKindToType`. `tryEmitEdge` (`graph-bridge/edges.ts:74`) is the shared precise-emission helper used by dispatch passes (dedup, caller resolution, calleeIdSink).

**Prior art grounding the design** (web research, 2026-07-16): no mainstream tool emits CALLS at a registration site. Kythe: plain `ref` vs `ref/call` (call ⊂ reference); Joern CPG: dedicated `METHOD_REF` node distinct from `CALL`; TypeScript LS keeps references out of call hierarchy (TS#55966, closed). Tools that close the dispatch gap propagate the value to real call sites: Feldthaus et al. ICSE'13 field-based call graphs (property-name-keyed, 99% precision / 91% recall, shipped in WALA), CodeQL `impliedReceiverStep`, EdgeMiner-style "model the dispatcher, synthesize edges". GitNexus's own `interface-dispatch` is the in-repo precedent for synthesized discounted-confidence CALLS.

## 4. GitNexus Findings

- `impact` default traversal = CALLS/IMPORTS/EXTENDS/IMPLEMENTS; USES is filterable but deliberately NOT default (would drag in every type annotation) [verified, mcp/tools.ts:459,537 + local-backend comment ~275–287]. `context` categorized refs DO include USES and ACCESSES [verified, local-backend.ts:3092] — so USES registration edges surface in `context` with zero traversal changes, and the `impact` fix must come from the dispatch CALLS.
- `impact mapReferenceKindToEdgeType upstream` = HIGH; d=1 = `tryEmitEdge`, `tryEmitEdgeWithExplicitTargetId`, `emitReferencesViaLookup` [graph]. Additive-case change; accounting in §9.
- Graph/source discrepancy (source wins): impact reports 0 upstream for `emitReferencesViaLookup`/`resolveReferenceSites` despite direct calls from `runScopeResolution` (run.ts:35,71) [verified]. Same bug family; do not trust LOW here.
- `receiver-bound-calls.ts:265` skips kinds ∉ {call, read, write}; CFG visitors match only `@reference.call.*` — new kind/tag inert in existing passes [verified].
- Tests located [verified]: `test/integration/resolvers/typescript.test.ts` harness (`runPipelineFromRepo`, temp fixture repos); `test/unit/scope-resolution/typescript/typescript-captures.test.ts`; `test/integration/grammar-literal-validation.test.ts` (#1920 node-name gate).
- Grammar node names verified in both grammars' `node-types.json`: `pair`, `property_identifier` keys, `shorthand_property_identifier`; destructuring uses distinct `shorthand_property_identifier_pattern` [verified].

## 5. Statement-Level PDG Findings

No PDG layer in the current index (0 CDG edges). The change is additive edge emission; no statement-level ambiguity constrains it.

## 6. Proposed Changes

New `ReferenceKind` `'value-ref'` (registration) + shared `property-dispatch` pass (invocation).

**Half B — registration → USES**
1. `gitnexus-shared/src/scope-resolution/reference-site.ts` — add `'value-ref'` to `ReferenceKind`; add optional `propertyKey?: string` to `ReferenceSite` (the object-literal key under which the value is registered; shorthand: key = name).
2. `gitnexus-shared/src/scope-resolution/types.ts` — add `'value-ref'` to `Reference['kind']`; add optional `propertyKey?: string` passthrough on `Reference`.
3. `gitnexus/src/core/ingestion/languages/typescript/query.ts` — two separate patterns (0.21 alternation hazard):
   `(pair key: (property_identifier) @reference.property-key value: (identifier) @reference.name @reference.value-ref)` and
   `(object (shorthand_property_identifier) @reference.name @reference.property-key @reference.value-ref)`.
4. `gitnexus/src/core/ingestion/languages/javascript/query.ts` — mirror both patterns.
5. `gitnexus/src/core/ingestion/scope-extractor.ts` — `referenceKindFromAnchor`: `case 'value-ref'`; extract `@reference.property-key` into `site.propertyKey`; add the tag to the non-anchor list.
6. `gitnexus/src/core/ingestion/resolve-references.ts` — `lookupForSite`: `case 'value-ref': methodRegistry.lookup(site.name, site.inScope)` (callable gate); `buildReference` passes `propertyKey` through.
7. `gitnexus/src/core/ingestion/scope-resolution/graph-bridge/edges.ts` — `mapReferenceKindToEdgeType`: `'value-ref' → 'USES'` (reference-class edge; Kythe `ref` / Joern `METHOD_REF` precedent — NOT CALLS).
8. `gitnexus/src/core/ingestion/emit-references.ts` — `mapKindToType`: `'value-ref' → 'USES'`.
9. `gitnexus/src/core/ingestion/scope-resolution/graph-bridge/references-to-edges.ts` — calleeIdSink gate also requires `ref.kind === 'call'` (defensive; value-ref no longer maps to CALLS, keep anyway).

**Half C — dispatch → synthesized CALLS**
10. New `gitnexus/src/core/ingestion/scope-resolution/passes/property-dispatch.ts` — `emitPropertyDispatchCalls(graph, scopes, parsedFiles, nodeLookup, referenceIndex, seen, calleeIdSink?)`:
    - Build `propertyKey → Set<SymbolDefinition>` from resolved `value-ref` references (already callable-gated).
    - Fan-out cap per key (named constant, ~8) — controls the ACG property-name-collision failure mode; log/skip capped keys.
    - For each member-call site (`site.kind === 'call' && site.callForm === 'member'`) whose `site.name` is a registered key: `tryEmitEdge(...)` to each registered def with reason `'property-dispatch'`, confidence 0.7 (below the 0.85 resolved-call baseline, mirroring `interface-dispatch`); calleeIdSink participates (these ARE call sites).
    - Language-neutral: keys off value-ref references only; no language names (AGENTS.md).
11. `gitnexus/src/core/ingestion/scope-resolution/pipeline/run.ts` — invoke the pass after `emitReferencesViaLookup`, sharing the emit-phase `seen` set is NOT possible (bridge uses a local set) — pass its own set; dedup against duplicates via tryEmitEdge keying.
12. `gitnexus/src/storage/parse-cache.ts` — `SCHEMA_BUMP` 13 → 14 (new sites + `propertyKey` field).

## 7. Implementation Sequence

1. Shared types (changes 1–2); tsc enumerates exhaustive consumers (6, 7, 8).
2. Extractor: kind case + property-key extraction (change 5).
3. TS + JS query patterns (changes 3–4); grammar gate + captures unit tests.
4. Resolution + USES emission (changes 6–9).
5. Property-dispatch pass + run.ts wiring (changes 10–11).
6. SCHEMA_BUMP (change 12).
7. Tests (§8), full suites.
   Per-step: `impact` before each symbol edit (HIGH on `mapReferenceKindToEdgeType` already surfaced); `detect_changes` before each commit.

## 8. Test Strategy

`gitnexus/test/integration/resolvers/typescript-value-refs.test.ts` (harness as in `typescript.test.ts`):
1. Same-file longhand `{ emitScopeCaptures: emitHook }` → **USES** `provider.ts → emitHook`, reason `scope-resolution: value-ref`.
2. Cross-file import + longhand → USES from importing File node (c-cpp.ts shape); aliased import resolves to original def.
3. Shorthand `{ emitHook }` → USES.
4. Negative: `{ port: DEFAULT_PORT }` → no USES/CALLS to `DEFAULT_PORT`; destructuring shorthand emits nothing.
5. Factory value `{ cfgVisitor: createVisitor() }` → unchanged single call-site CALLS.
6. **Dispatch**: `bridge.ts` does `provider.emitScopeCaptures()` → CALLS `bridge fn → emitHook`, reason `property-dispatch`, confidence 0.7; works cross-file; shorthand-registered hooks dispatch too.
7. Dispatch negative: member call with unregistered name → no synthetic CALLS; fan-out cap respected (key registered >cap times emits nothing).
8. JS twins: longhand + shorthand registration USES; one dispatch CALLS.
9. Const-arrow handler `{ onEvent: handler }` → pins labeling behavior (USES expected).
Unit (`typescript-captures.test.ts`): value-position identifier → `@reference.value-ref` + `@reference.property-key` captures (longhand key text = key; shorthand key text = name); no capture for destructuring or call values.
Commands [verified]: `cd gitnexus && npm run test:unit` / `npm run test:integration` (pre-hook builds dist — required: integration extraction may run from built output) / `npm run build`.
Existing suites may gain USES/CALLS edges — review diffs; regenerate goldens deliberately.

## 9. Risk and Impact Analysis

- `mapReferenceKindToEdgeType` HIGH [graph]: d=1 `tryEmitEdge`/`tryEmitEdgeWithExplicitTargetId`/`emitReferencesViaLookup` — additive case; existing kinds byte-identical.
- Property-dispatch false positives (ACG's documented mode: property-name collisions across unrelated objects — measured ~99% precision in literature): mitigated by callable gate, fan-out cap, 0.7 confidence, distinct reason string for auditability.
- Fan-out volume on common keys (`handler`, `callback`): the cap bounds it; capped keys are skipped, not truncated silently.
- calleeIdSink: dispatch CALLS participate (real call sites, mirrors interface-dispatch); value-ref USES never enter (kind gate).
- SCHEMA_BUMP mandatory (new site field + sites) — skipping poisons warm caches.
- Graph fan-in claims in this subsystem under-report (§4) — don't let LOW impact results justify skipping coverage.

## 10. Files Expected to Change

| File | Symbols | Reason |
|---|---|---|
| gitnexus-shared/src/scope-resolution/reference-site.ts | ReferenceKind, ReferenceSite | 'value-ref' + propertyKey |
| gitnexus-shared/src/scope-resolution/types.ts | Reference | kind union + propertyKey passthrough |
| gitnexus/src/core/ingestion/languages/typescript/query.ts | TYPESCRIPT_SCOPE_QUERY | pair + shorthand patterns w/ key capture |
| gitnexus/src/core/ingestion/languages/javascript/query.ts | JS scope query | same two patterns |
| gitnexus/src/core/ingestion/scope-extractor.ts | referenceKindFromAnchor, pass5CollectReferences | kind case + propertyKey extraction |
| gitnexus/src/core/ingestion/resolve-references.ts | lookupForSite, buildReference | callable-gated route + passthrough |
| gitnexus/src/core/ingestion/scope-resolution/graph-bridge/edges.ts | mapReferenceKindToEdgeType | value-ref → USES |
| gitnexus/src/core/ingestion/emit-references.ts | mapKindToType | value-ref → USES |
| gitnexus/src/core/ingestion/scope-resolution/graph-bridge/references-to-edges.ts | emitReferencesViaLookup | calleeIdSink kind gate (defensive) |
| gitnexus/src/core/ingestion/scope-resolution/passes/property-dispatch.ts | new | field-based dispatch CALLS |
| gitnexus/src/core/ingestion/scope-resolution/pipeline/run.ts | runScopeResolution | wire the pass |
| gitnexus/src/storage/parse-cache.ts | SCHEMA_BUMP | 13 → 14 |
| gitnexus/test/integration/resolvers/typescript-value-refs.test.ts | new | §8 scenarios |
| gitnexus/test/unit/scope-resolution/typescript/typescript-captures.test.ts | extend | capture shape |

## 11. Reusable Implementation Context

```yaml
implementation_context:
  task_summary: "value-ref reference kind: TS/JS capture object-literal property values (with key), resolve callable-gated, emit USES at registration; new shared property-dispatch pass synthesizes CALLS (reason property-dispatch, conf 0.7, fan-out cap) from member-call sites to functions registered under the same property name (#2437, field-based/ACG)."
  acceptance_criteria:
    - "After re-analyze: impact(emitCppScopeCaptures, upstream) ≥1 dependent with extractParsedFile (true caller) reachable via property-dispatch CALLS"
    - "context(emitCppScopeCaptures) shows the c-cpp.ts registration as an incoming USES ref"
    - "Non-callable values emit nothing; unregistered member calls gain no synthetic CALLS"
    - "No regressions; SCHEMA_BUMP = 14"
  primary_symbols:
    - { symbol: TYPESCRIPT_SCOPE_QUERY, file: gitnexus/src/core/ingestion/languages/typescript/query.ts, lines: "81, 940-1046", role: "capture vocabulary + insertion point" }
    - { symbol: "JS scope query", file: gitnexus/src/core/ingestion/languages/javascript/query.ts, lines: "424-478", role: "mirror patterns" }
    - { symbol: pass5CollectReferences, file: gitnexus/src/core/ingestion/scope-extractor.ts, lines: "987-1071", role: "site build; add propertyKey; non-anchor tag list at ~1156" }
    - { symbol: lookupForSite, file: gitnexus/src/core/ingestion/resolve-references.ts, lines: "190-238", role: "kind → registry; MethodRegistry = callable gate" }
    - { symbol: mapReferenceKindToEdgeType, file: gitnexus/src/core/ingestion/scope-resolution/graph-bridge/edges.ts, lines: "40-63", role: "value-ref → USES" }
    - { symbol: tryEmitEdge, file: gitnexus/src/core/ingestion/scope-resolution/graph-bridge/edges.ts, lines: "74-133", role: "dispatch-pass emission helper (dedup, caller resolution, calleeIdSink)" }
    - { symbol: emitInterfaceDispatchFor, file: gitnexus/src/core/ingestion/scope-resolution/passes/receiver-bound-calls.ts, lines: "215-252", role: "ARCHITECTURAL TEMPLATE for property-dispatch (reason vocab, confidence discount, fan-out shape)" }
    - { symbol: runScopeResolution, file: gitnexus/src/core/ingestion/scope-resolution/pipeline/run.ts, lines: "721-791", role: "emit-phase ordering; wire new pass after emitReferencesViaLookup" }
  related_symbols:
    - { symbol: ReferenceKind/ReferenceSite, relationship: "type contract", relevance: "gitnexus-shared reference-site.ts:34-107" }
    - { symbol: Reference, relationship: "type contract", relevance: "gitnexus-shared types.ts:449-458" }
    - { symbol: mapKindToType, relationship: "parallel emit path", relevance: "emit-references.ts:280 exhaustive" }
    - { symbol: resolveCallerGraphId, relationship: "CALLS/USES source", relevance: "File-node fallback at module scope (ids.ts)" }
    - { symbol: SCHEMA_BUMP, relationship: "cache invalidation", relevance: "parse-cache.ts:58" }
  execution_path:
    - "query captures @reference.value-ref (+ @reference.property-key) on value-position identifiers"
    - "pass5 builds ReferenceSite kind value-ref with propertyKey"
    - "lookupForSite → methodRegistry (callable gate) → Reference (propertyKey passthrough)"
    - "emitReferencesViaLookup → USES, reason 'scope-resolution: value-ref'"
    - "emitPropertyDispatchCalls: key→defs index from value-ref refs; member-call sites with matching name → tryEmitEdge CALLS, reason 'property-dispatch', conf 0.7, cap per key"
  pdg_constraints: []
  architectural_patterns:
    - { pattern: "interface-dispatch fan-out", example_location: "gitnexus/src/core/ingestion/scope-resolution/passes/receiver-bound-calls.ts:215 (emitInterfaceDispatchFor)", usage_guidance: "mirror its reason-string + discounted-confidence + tryEmitEdge shape for property-dispatch" }
    - { pattern: "kind-tag routing, no language names in shared code", example_location: "gitnexus/src/core/ingestion/scope-extractor.ts:1046", usage_guidance: "dispatch pass keys off value-ref refs only" }
    - { pattern: "separate tree-sitter patterns per form", example_location: "gitnexus/src/core/ingestion/languages/typescript/query.ts:940-996", usage_guidance: "no [...] alternation with predicates (0.21)" }
  files_to_modify:
    - { file: gitnexus-shared/src/scope-resolution/reference-site.ts, symbols: [ReferenceKind, ReferenceSite], intended_change: "'value-ref' member; optional propertyKey" }
    - { file: gitnexus-shared/src/scope-resolution/types.ts, symbols: [Reference], intended_change: "'value-ref' in kind union; optional propertyKey" }
    - { file: gitnexus/src/core/ingestion/languages/typescript/query.ts, symbols: [TYPESCRIPT_SCOPE_QUERY], intended_change: "pair pattern with key: (property_identifier) @reference.property-key; shorthand pattern with name+key on same node" }
    - { file: gitnexus/src/core/ingestion/languages/javascript/query.ts, symbols: ["JS scope query"], intended_change: "mirror both patterns" }
    - { file: gitnexus/src/core/ingestion/scope-extractor.ts, symbols: [referenceKindFromAnchor, pass5CollectReferences], intended_change: "case 'value-ref'; site.propertyKey from '@reference.property-key'; tag added to NON_ANCHOR_TAGS" }
    - { file: gitnexus/src/core/ingestion/resolve-references.ts, symbols: [lookupForSite, buildReference], intended_change: "case 'value-ref' → methodRegistry; propertyKey passthrough" }
    - { file: gitnexus/src/core/ingestion/scope-resolution/graph-bridge/edges.ts, symbols: [mapReferenceKindToEdgeType], intended_change: "case 'value-ref': return 'USES'" }
    - { file: gitnexus/src/core/ingestion/emit-references.ts, symbols: [mapKindToType], intended_change: "case 'value-ref': return 'USES'" }
    - { file: gitnexus/src/core/ingestion/scope-resolution/graph-bridge/references-to-edges.ts, symbols: [emitReferencesViaLookup], intended_change: "calleeIdSink gate ref.kind === 'call' (defensive)" }
    - { file: gitnexus/src/core/ingestion/scope-resolution/passes/property-dispatch.ts, symbols: [emitPropertyDispatchCalls], intended_change: "new shared pass per §6.10" }
    - { file: gitnexus/src/core/ingestion/scope-resolution/pipeline/run.ts, symbols: [runScopeResolution], intended_change: "invoke pass after emitReferencesViaLookup, thread calleeIdAccumulator" }
    - { file: gitnexus/src/storage/parse-cache.ts, symbols: [SCHEMA_BUMP], intended_change: "13 → 14" }
  tests:
    - file: gitnexus/test/integration/resolvers/typescript-value-refs.test.ts
      scenarios:
        - "longhand registration → USES provider.ts→emitHook reason scope-resolution: value-ref"
        - "cross-file + aliased import → USES to original def"
        - "shorthand → USES"
        - "{ port: DEFAULT_PORT } → no USES/CALLS; destructuring → nothing"
        - "{ cfgVisitor: createVisitor() } → single call-site CALLS unchanged"
        - "provider.emitScopeCaptures() in another file → CALLS caller→emitHook reason property-dispatch conf 0.7"
        - "unregistered member call → no synthetic CALLS; over-cap key → nothing"
        - "JS twins (registration USES + one dispatch CALLS)"
        - "const-arrow handler pins labeling"
    - file: gitnexus/test/unit/scope-resolution/typescript/typescript-captures.test.ts
      scenarios:
        - "longhand: @reference.value-ref + @reference.name(value id) + @reference.property-key(key id)"
        - "shorthand: name and key captures on same identifier"
        - "no captures for destructuring / call values"
  verification_commands:
    - "cd gitnexus && npm run test:unit"
    - "cd gitnexus && npm run test:integration"
    - "cd gitnexus && npm run build"
  risks:
    - "Property-name collisions (ACG failure mode) → callable gate + fan-out cap + 0.7 confidence + distinct reason"
    - "Integration harness may extract via built dist — rebuild before integration runs (pretest does this)"
    - "Golden/snapshot suites gain USES/CALLS edges — review, regenerate deliberately"
    - "Skipping SCHEMA_BUMP poisons warm caches"
  assumptions:
    - "const-arrow declarators are Function-labeled (pin via test; if Variable, document miss)"
    - "member-call ReferenceSites carry the property name in site.name for callForm 'member' (verify in pass implementation)"
  open_questions:
    - "Fan-out cap value (start 8; adjust on fixture evidence)"
  avoid:
    - "Do not emit CALLS at the registration site (unattested in prior art; user-rejected)"
    - "Do not add USES to impact's default traversal (drags in all type-references)"
    - "Do not name languages in the shared dispatch pass (AGENTS.md)"
    - "No [...] pattern alternation with predicates (tree-sitter 0.21)"
    - "Do not repeat repository discovery; touch points enumerated"
```

## 12. Assumptions and Open Questions

See §11. Deferred follow-ups: other languages adopting the tag; other value positions (call arguments, `export default fn`, array elements, `as`-cast values, string-literal keys `{ 'hook': fn }`, computed keys); receiver-type-aware narrowing of property-dispatch (only dispatch through objects whose type/known registrations match — v2 precision work); investigating the §4 false-0 upstream discrepancy for pipeline functions (separate bug candidate).

## 13. Definition of Done

- All §8 tests pass; `npm run test:unit`, `npm run test:integration`, `npm run build` green; tsc clean; grammar gate green.
- SCHEMA_BUMP = 14.
- End-to-end on this repo after re-analyze: `impact(emitCppScopeCaptures, upstream)` reports the bridge caller (`extractParsedFile`) via `property-dispatch` CALLS; `context(emitCppScopeCaptures)` shows the `c-cpp.ts` USES registration.
- No unreviewed regressions in existing resolver suites.
