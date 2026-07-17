# GitNexus Engineering Plan

> Task: Resolve the two actionable review items on PR #2522, then extend call-site resolution from property-key registration to callable values assigned to variables, copied through pointer/reference forms, and propagated through function or method arguments. C and C++ are the strict reference implementations; every production language provider must either adopt the normalized model with fixtures or record a verified syntax limitation.
>
> Evidence pin: PR head 05540a9674b81bf985c61fffe0ed156470d16434 on branch pr-2522 in /workspace/.worktrees/pr-2522. The branch is 6 commits ahead of and 1 commit behind current origin/main; merge base e8fdc2e2abf9561d6629c5ec6add77c84ea2cfb7. [verified]
>
> GitNexus evidence: a worktree-local index was refreshed this session with gitnexus analyze --index-only --pdg using the installed 1.6.9 analyzer: 1,790 files, 213,781 nodes, 454,559 edges, 1,855 communities, and 300 processes at the exact source commit. The analyzer binary was not rebuilt from this branch because package-local compiler dependencies are absent; graph shape is current to the source tree, while analyzer-build parity is explicitly downgraded. Exact source inspection is authoritative where graph and source disagree. [verified]
>
> Planning method: full/strict gitnexus-plan workflow from the skill family developed in PR #2431, including source verification, upstream impact analysis, statement-level PDG slices, a current-indexer reproduction, and a reusable implementation context. [verified]

## 1. Objective

Deliver one reviewable workstream in three mergeable units:

1. Unit A, on PR #2522: close the exact review comment by updating the measured TypeScript and JavaScript scope-capture fingerprints and surfacing capped property-dispatch loss at warning level with language, skipped-key count, and cap context. [verified]
2. Unit B, as a stacked follow-up: add a language-neutral callable-value-flow substrate and implement C/C++ completely, plus TypeScript/JavaScript/Vue as the first non-C-family proof. Calls through assigned values, aliases, pointer/reference forms, and actual-to-formal argument flow must emit CALLS at the real invocation site. [inferred]
3. Unit C, as one or more stacked provider-adoption follow-ups: cover every remaining production provider with an assign → pass → invoke fixture or an explicit, source-verified language limitation. [inferred]

The work is complete only when normal indexing and --pdg indexing resolve the same CALLS targets, PDG callee IDs remain attached to the real invocation positions, common-name collisions cannot create a false global-function edge, and bounded ambiguity is visible rather than silently dropped. [inferred]

Review sources:

- PR #2522: https://github.com/abhigyanpatwari/GitNexus/pull/2522
- Actionable review comment: https://github.com/abhigyanpatwari/GitNexus/pull/2522#issuecomment-4996706603
- Planning-skill PR #2431: https://github.com/abhigyanpatwari/GitNexus/pull/2431

## 2. Current Behaviour

### 2.1 PR #2522 review state

- The review comment reports scope-capture fingerprint drift for TypeScript and JavaScript and asks that the new fingerprints be accepted only after validating the scaling ratios. [verified]
- The latest authoritative PR CI measurement reports TypeScript fingerprint 25de86fd3377132c4e35d3d98f4f94a58e0cfeb7c22948a8ea3be4e793be74fd at ratio 0.987, and JavaScript fingerprint 5567dd47e7ba29821a518c4a9852adc3b774e25ef3e7a6e2b3ecb7b59ddab73c at ratio 1.031. Both remain below the 1.5 budget. [verified]
- gitnexus/bench/scope-capture/baselines.json still contains the prior TypeScript and JavaScript fingerprints, so CI remains red even though scaling is linear. [verified]
- emitPropertyDispatchCalls returns skippedKeys when a property key has more than MAX_PROPERTY_DISPATCH_FANOUT = 32 callable registrations. runScopeResolution currently reports that loss only through logger.debug and omits the cap from the diagnostic. [verified]

### 2.2 Why property dispatch does not solve callable aliases

PR #2522 models two facts:

1. A callable stored as an object-literal property value emits USES at the registration site. [verified]
2. A member call with the same property name fans out to registered functions and emits property-dispatch CALLS. [verified]

That pass is intentionally field-name based. It does not represent:

- function designator or address assignment to a C function pointer;
- C pointer copies, dereference calls, or pointer-to-pointer load/store;
- C++ function pointers, function references, references to pointer variables, or member-function pointers;
- a callable copied between local variables;
- a callable passed as an argument and invoked through a formal parameter;
- multiple wrapper hops; or
- language-specific callable objects, delegates, method references, closures, or tear-offs. [verified]

Stretching property-dispatch into this job would mix property-name approximation with lexical/interprocedural value flow and would retain its common-key false-positive mode. It must remain a separate conservative fallback. [inferred]

### 2.3 Reproduced gap at the pinned commit

A temporary C/C++ corpus was indexed with --pdg and exercised:

- C: implicit and explicit function-pointer assignment, pointer copy, direct pointer call, explicit dereference call, pointer-to-pointer, and wrapper arguments;
- C++: function pointer, function reference, pointer reference, copies, pointer-to-pointer, wrapper arguments, and pointer-to-member invocation. [verified]

Only three syntactically direct wrapper calls were emitted:

- c_entry → c_invoke
- cpp_entry → cpp_invoke_pointer
- cpp_entry → cpp_invoke_reference

No indirect invocation resolved to its callable target. [verified]

This is not a PDG-only gap: cfgSideChannel contains useful def/use/formal/argument records, but it exists only under --pdg. Normal CALLS resolution therefore needs an always-on, compact extraction artifact. [verified]

## 3. Relevant Architecture

### 3.1 Existing pipeline

The load-bearing path is:

    provider query/capture hooks
      → scope-extractor capture partition and five passes
      → ParsedFile persisted across worker/cache boundaries
      → finalize registries and ScopeResolutionIndexes
      → receiver-bound calls
      → free-call fallback
      → lookup references
      → property dispatch
      → optional CFG/PDG join

[verified]

ParsedFile is the single per-file semantic boundary. A new always-on flow artifact belongs there as plain JSON-serializable data; a second parse representation or a dependency on cfgSideChannel would violate the existing architecture. [verified]

All 16 providers already have an emitScopeCaptures hook. Provider query patterns and capture emitters can produce a new shared capture vocabulary without widening LanguageProvider, whose upstream impact is CRITICAL. [graph]

Shared code under gitnexus/src/core/ingestion must remain language-neutral. Syntax-specific recognition belongs in each language query/capture module; the shared pass consumes normalized facts only. [verified]

### 3.2 Normalized callable-flow facts

Add gitnexus-shared/src/scope-resolution/callable-flow-site.ts with JSON-safe discriminated unions. The exact field names may be adjusted during implementation, but the semantic contract is fixed: [inferred]

- Operand: lexical binding name, ScopeId, source Range, and optional normalized callable shape. It must not contain tree-sitter nodes or provider-private objects.
- seed: a callable definition/designator/method reference flows into a binding or abstract cell; it may carry an expected callable signature for overload selection.
- copy: one-way value inclusion from source binding to destination binding.
- alias: two-way identity for true reference bindings or equivalent language constructs.
- address: an abstract location is taken.
- store: a callable target set flows into the abstract cell reached by a pointer/reference operand.
- load: a binding receives the target set stored in an abstract cell.
- formal: maps a callable definition and parameter index to its lexical parameter binding and passing mode.
- argument: maps a real call-site position and argument index to a source operand.
- invoke: identifies the real invocation-site position and the callable operand; member-pointer/callable-object forms may additionally carry a receiver operand and normalized dispatch shape. Its site key must match an existing call ReferenceSite so edge emission reuses the canonical caller scope and range.

Providers emit invoke facts only for syntactically indirect callee operands: variables, parameters, pointer/reference dereferences, delegates/callable objects, and equivalent forms. A direct named call remains owned by the existing direct passes and must not enter deferredIndirectSites. [inferred]

The extractor routes @callable-flow.* matches to a new pass6CollectCallableFlows after Pass 5. Pass 5 remains byte-identical. Each provider reuses its existing raw query nodes and emitScopeCaptures hook to synthesize the facts without a second AST walk. [inferred]

### 3.3 Solver semantics

Add a language-neutral, inclusion-based fixed-point solver in scope-resolution/passes/callable-value-flow.ts: [inferred]

1. Build stable lexical binding keys from file, ScopeId, binding name, and abstract indirection cell.
2. Seed binding target sets from callable references resolved through existing registries and overload/type indexes.
3. Apply copy, alias, address, load, and store constraints until no target set grows.
4. Use direct-call targets already recorded at a call-site position to map each actual argument to each resolved callee's formal binding.
5. When an indirect invoke acquires targets, emit CALLS at that invocation site, record those callee IDs, and use the newly known callee set to propagate that invoke's arguments. Continue to a fixed point so multi-hop wrappers and recursion converge.
6. Emit every bounded candidate. Never choose an arbitrary first candidate.

The solver is deliberately flow-insensitive and conservative: reassignment produces a union of possible targets. Singleton target sets use reason callable-value-flow with confidence 0.8; multi-target sets use the same reason with confidence 0.7. These confidence values distinguish inferred flow from exact syntactic calls and remain auditable. [assumed]

Cap each binding/cell target set at 32. A set that exceeds the cap is marked ambiguous, emits no partial/truncated CALLS, and produces one structured warning containing language, binding/site context, candidate count, and cap. [inferred]

### 3.4 Direct-resolution ordering and collision safety

Known indirect invocation sites must not pass through free-name lookup first. Otherwise code such as a formal parameter named callback can incorrectly resolve to an unrelated global function named callback before callable flow sees the passed target. [inferred]

Do not pre-seed handledSites: that set means a precise pass actually handled a site. Instead:

- derive deferredIndirectSites from invoke facts;
- pass it as an explicit skip set to emitFreeCallFallback and emitReferencesViaLookup;
- let receiver/direct-call resolution run and seed real call targets;
- run callable-value-flow to own the deferred sites;
- leave property-dispatch after the precise callable solver as a separate fallback. [inferred]

The CalleeIdAccumulator already stores a multi-target set by exact file/line/column and records targets before edge dedup. Allocate it when input.pdg is true OR any ParsedFile has callableFlowSites. Direct emitters seed it; callable flow consumes and updates it; the existing CFG join remains gated by input.pdg. Update its comments to reflect the broader producer lifetime without changing its narrow sink/view interfaces. [verified]

### 3.5 C language contract

C has function designators and pointers, not C++-style references. The required C model follows N1570:

- a function designator converts to a pointer except where unary & suppresses that conversion;
- unary * on a function pointer yields a function designator, so fp() and (*fp)() have the same target set;
- passing an argument assigns its value to the corresponding parameter;
- pointer-to-pointer load/store must preserve the target set across &fp, *slot, and reassignment. [verified]

Source: https://www.open-std.org/jtc1/sc22/wg14/www/docs/n1570.pdf, especially 6.3.2.1, 6.5.3.2, and 6.5.2.2.

The C provider must recognize at least:

- void (*fp)(void) = target and = &target;
- fp2 = fp;
- fp() and (*fp)();
- void (**slot)(void) = &fp; (*slot)();
- formal parameters declared as function pointers;
- arguments target, &target, fp, and *slot;
- compatible typedef forms;
- null/incompatible assignments as negative cases. [inferred]

### 3.6 C++ language contract

C++ adds true references, overload context, and pointers to members:

- function lvalues can convert to function pointers;
- a reference aliases its initializer rather than copying a new object;
- each parameter is initialized from its argument, including reference parameters;
- .* and ->* produce receiver-bound member-function invocations;
- taking an overloaded function's address must use the contextual target signature and must never select the first name match;
- virtual calls through a member-function pointer must expand through the existing MRO/MethodDispatchIndex rather than emitting only the statically named base definition. [verified]

Sources:

- https://eel.is/c++draft/conv.func
- https://eel.is/c++draft/dcl.ref
- https://eel.is/c++draft/expr.call
- https://eel.is/c++draft/expr.mptr.oper

The C++ provider must recognize at least:

- void (*fp)() = target and &target;
- void (&fr)() = target;
- void (*&fpr)() = fp;
- auto/copy aliases and pointer-to-pointer forms;
- pointer and reference formal parameters;
- overloaded address selection from the declared pointer/reference signature;
- void (Base::*pm)() = &Base::method with (obj.*pm)() and (ptr->*pm)();
- virtual override expansion for pointer-to-member invocation;
- null, incompatible, and unresolved-overload negatives. [inferred]

### 3.7 Cross-language adoption contract

The shared solver models value flow, but syntax and invocation semantics remain provider-owned. Unit C must use this matrix: [inferred]

| Provider | Required syntax/semantics | Minimum fixture |
|---|---|---|
| TypeScript | function/arrow/method values, variable copies, arguments, direct invocation | const a = target; pass(a); formal() |
| JavaScript | function values, closures, bound/member values where statically recoverable | same assign/pass/invoke chain |
| Vue | TypeScript/JavaScript script blocks through existing TS capture adapter | SFC script chain with stable offsets |
| Python | functions and bound methods are callable objects; preserve binding through assignment/argument and invoke | a = target; invoke(a); cb() |
| Ruby | Method/Proc values and call/yield forms; direct local-variable invocation is not assumed | method(:target) or proc → argument → .call |
| PHP | closures, first-class callable syntax, callable variables, statically recoverable method callables | $cb = target(...); invoke($cb); $cb() |
| Go | function values, method values/expressions, arguments, direct invocation | f := target; invoke(f); cb() |
| Rust | function-item coercion, fn pointers, closures/Fn-family values where statically named, references/deref | let f: fn() = target; invoke(f); cb() |
| Kotlin | first-class function values and ::function/bound references, invoke/operator-call | val f = ::target; invoke(f); cb() |
| Swift | function/closure values and bound method references | let f = target; invoke(f); cb() |
| Dart | function tear-offs, closures, and callable objects through call when statically recoverable | final f = target; invoke(f); cb() |
| C# | method groups converted to delegates, delegate copy/argument, d() and Invoke | Action a = Target; Invoke(a); a() |
| Java | lambdas/method references become functional-interface values; invocation occurs through the SAM method | Runnable r = this::target; invoke(r); r.run() |
| COBOL | dialect-dependent procedure-pointer syntax | verified procedure-pointer fixture, or documented exclusion after grammar audit |

The matrix is exhaustive over registered production providers. A provider cannot be silently skipped because its syntax differs from C-family direct invocation. [inferred]

## 4. GitNexus Findings

### 4.1 Freshness and change scope

- list_repos after worktree-local analysis reports exact commit 05540a9674b8, branch pr-2522, 1,790 files, and no commit staleness for /workspace/.worktrees/pr-2522. [graph]
- gitnexus://repo/GitNexus/context resolves an older sibling worktree, so every graph query used repo=/workspace/.worktrees/pr-2522; named repository resources are not used for branch claims. [verified]
- detect_changes with scope=compare and base_ref=e8fdc2e2abf9561d6629c5ec6add77c84ea2cfb7 isolates #2522 at 15 files, 21 changed symbols, 5 affected processes, and MEDIUM risk. [graph]
- The PR delta is currently 842 additions and 5 deletions. Adding cross-language points-to behavior directly to #2522 would make the review boundary materially less safe. [verified]

### 4.2 Symbol context and impact

| Symbol | Impact result | Direct dependents / consequence |
|---|---|---|
| runScopeResolution | LOW, 3 direct / 4 total at depth 3 [graph] | phase.execute, the CFG emitWith test helper, and run-progress tests; ordering and aggregates need focused coverage |
| emitPropertyDispatchCalls | one production caller [verified] | runScopeResolution; keep semantics intact and only improve diagnostics in Unit A |
| extract | CRITICAL, 2 direct / 31 total across 9 modules [graph] | extractParsedFile and scope-extractor.test.ts; requires maintainer sign-off before Unit B |
| partitionByTopic | CRITICAL, 1 direct / 20 total [graph] | extract; add one topic without changing existing routing |
| topicOf | LOW, 1 direct / 4 total [graph] | partitionByTopic |
| pass5CollectReferences | CRITICAL, 1 direct / 20 total [graph] | extract plus run/processFileGroup flows transitively; do not edit |
| LanguageProvider | CRITICAL, 30 direct / 437 total [graph] | every provider and provider-facing tests; do not widen the interface |
| ParsedFile | LOW in graph [graph] | source shows worker, store, cache, and test construction boundaries; cache bump and round-trip tests are mandatory |
| emitFreeCallFallback | LOW in graph, production caller omitted [graph][verified] | source-verified caller runScopeResolution; add an explicit skip-set parameter |
| emitReferencesViaLookup | HIGH, 2 direct / 6 total [graph] | runScopeResolution and pdg-callee-id-capture.test.ts; skip-set and callee capture need focused regression coverage |
| createCalleeIdAccumulator | LOW [graph] | allocation gate broadens; sink/view behavior remains unchanged |
| emitCScopeCaptures | MEDIUM, 5 direct [graph] | C capture helpers/tests and benchmark coverage |
| emitCppScopeCaptures | MEDIUM, 8 direct / 10 total [graph] | C++ capture helpers/tests and benchmark coverage |
| emitTsScopeCaptures | HIGH, 15 direct / 24 total [graph] | Vue emitter, TS CFG harness, JS parsing-coverage helpers, TS capture anchors/helpers/files, import helper, and hook tests |

Provider rollout impact summary: Python, C#, and Swift emitters are also MEDIUM; JavaScript, Java, Kotlin, Go, Rust, PHP, Ruby, Dart, Vue, and COBOL emitters are LOW in the current graph. Re-run impact at the synchronized implementation commit because provider adoption itself changes this graph. [graph]

### 4.3 Source-grounded seams

- ReferenceKind has call/read/write/type/inherits/import-use/value-ref/macro; value-ref alone carries propertyKey. [verified]
- resolveReferenceSites intentionally skips value-ref; emitPropertyDispatchCalls owns it. [verified]
- emitReferencesViaLookup feeds CalleeIdSink only for CALLS. [verified]
- runScopeResolution allocates CalleeIdAccumulator only for --pdg today and runs receiver → free fallback → lookup → property dispatch. [verified]
- existing C and C++ query/type bindings retain pointer/reference type shape for overload and ADL work, but no artifact carries the callable target identity across assignment or parameters. [verified]
- all providers export emit*ScopeCaptures and can synthesize extra capture metadata through the existing hook. [verified]
- ParsedFile scope stripping in run.ts uses object spread, so an added non-scope callableFlowSites field survives the disk-seal boundary. [verified]
- SCHEMA_BUMP is 14 on this branch; the new ParsedFile semantic field requires 15. [verified]

## 5. Statement-Level PDG Findings

The worktree index includes PDG layers. These slices constrain implementation order: [graph]

### 5.1 runScopeResolution

Query focus: controls/flows for calleeIdAccumulator and propertyDispatch, plus statement impact at the skippedKeys guard near line 799. [graph]

- calleeIdAccumulator is defined in the Phase 4 linking block, flows into all call emitters, and is consumed by the CFG join around line 959. [graph]
- propertyDispatch flows only into the positive skipped-key guard, the debug log, and aggregate edge totals. [graph]
- Implication: broaden accumulator allocation before direct emitters, preserve exact site positions, insert callable flow after direct target seeding, and leave the CFG consumer gated by --pdg. [inferred]

### 5.2 emitPropertyDispatchCalls

Query focus: controls/flows for registrations and skippedKeys. [graph]

- value-ref guards build a property-key map of callable definitions. [graph]
- defs.size > 32 deletes the entire key and increments skippedKeys; only surviving keys drive member-call emission. [graph]
- Implication: Unit A must report dropped coverage with cap context. The pass should not become the alias solver. [inferred]

### 5.3 pass5CollectReferences

Query focus: controls and flows into the ReferenceSite object. [graph]

- anchor, reference-kind, and scope guards control one site construction and push. [graph]
- Implication: changing Pass 5 would combine two semantic models in a CRITICAL symbol. Add a new @callable-flow topic and Pass 6 instead. [inferred]

## 6. Proposed Changes

### Unit 0 — synchronize and re-establish evidence

Before implementation:

1. Fetch origin and synchronize the PR branch with origin/main using the maintainer-approved merge/rebase convention. Do not rewrite the remote branch without explicit authorization. [assumed]
2. Rebuild the branch analyzer from gitnexus when package-local dependencies are present, then run node .gitnexus/run.cjs analyze --index-only --pdg from the worktree root. [inferred]
3. Re-run context and upstream impact for every existing symbol listed in §4.2. Warn again and obtain maintainer sign-off for CRITICAL extractor work. [verified]
4. Re-run detect_changes against the new merge base before any implementation commit. [verified]

### Unit A — close PR #2522 review feedback

1. gitnexus/bench/scope-capture/baselines.json
   - Replace only the TypeScript and JavaScript fingerprints with the measured values in §2.1.
   - Preserve all scaling thresholds.
   - Append an audit note with the prior and new hashes, CI run/job identity, measured ratios, and the reason: intentional value-ref captures.
   - Do not update any other language baseline without a fresh measurement. [verified]
2. gitnexus/src/core/ingestion/scope-resolution/pipeline/run.ts
   - Import MAX_PROPERTY_DISPATCH_FANOUT with emitPropertyDispatchCalls.
   - Change the positive skippedKeys diagnostic from debug to warn.
   - Include lang, skippedKeys, and fanoutCap in the structured object.
   - Keep RunScopeResolutionStats and public phase stats unchanged; widening those surfaces for one loss diagnostic would add avoidable blast radius. [inferred]
3. gitnexus/test/integration/resolvers/typescript-value-refs.test.ts
   - Wrap the existing over-cap fixture with the logger capture helper.
   - Assert one warning with the exact language, skipped-key count, and fan-out cap.
   - Preserve the existing assertion that capped keys emit no partial CALLS. [verified]

Unit A is the only implementation that belongs directly in #2522. [inferred]

### Unit B — shared callable-flow substrate and strict C/C++ support

#### B1. Shared artifact

1. Add gitnexus-shared/src/scope-resolution/callable-flow-site.ts with the normalized facts from §3.2 and export them from gitnexus-shared/src/index.ts. [inferred]
2. Add readonly callableFlowSites?: readonly CallableFlowSite[] to ParsedFile. ScopeExtractor omits it when empty; all consumers normalize undefined to an empty collection. The optional shape avoids mechanical churn in hand-built ParsedFile fixtures, while SCHEMA_BUMP still prevents a real warm cache from masquerading as newly extracted source. Pin both populated and omitted cases in tests. [inferred]
3. Bump SCHEMA_BUMP from 14 to 15 with a comment that old ParsedFiles lack always-on callable-flow facts. [verified]
4. Extend worker/cache round-trip tests so facts preserve discriminant, ScopeId, Range, index, passing mode, indirection, expected signature, and invoke position. [inferred]

#### B2. Extraction without a provider-contract change

1. Extend the capture-topic union, topicOf, and partitionByTopic for callable-flow. [inferred]
2. Add pass6CollectCallableFlows and call it after pass5CollectReferences. Do not edit pass5CollectReferences. [inferred]
3. Define capture-tag groups for seed/copy/alias/address/load/store/formal/argument/invoke; malformed or incomplete groups are ignored with the same defensive style as existing capture passes. [inferred]
4. Add unit tests for topic routing, every fact shape, malformed captures, stable positions, and JSON serialization. [inferred]

#### B3. Resolution pass

1. Add scope-resolution/passes/callable-value-flow.ts.
2. Build a finite worklist over binding/cell target sets; deduplicate each target by graph node ID.
3. Resolve seeds through finalized lexical registries. Use normalized expected callable shape and existing overload/type indexes where a name denotes multiple functions; unresolved ambiguity emits no arbitrary target.
4. Resolve actual → formal using call-site callee IDs and formal facts. Re-enqueue indirect calls whose target set grows, enabling multi-hop and recursive propagation.
5. Expand member-pointer/receiver-bound targets through existing MethodDispatchIndex/MRO machinery. Shared code must not branch on a language name.
6. Emit with tryEmitEdge at the invoke ReferenceSite/Range, reason callable-value-flow, bounded confidence from §3.3, and the shared seen set semantics.
7. Record every emitted target in CalleeIdSink before edge dedup, matching existing direct passes.
8. Enforce the cap and warn once per ambiguous binding/site with language and cap context. [inferred]

#### B4. Pipeline integration

1. Derive deferredIndirectSites only from callable invoke facts whose operand is explicitly indirect, and validate that each key joins to the canonical call ReferenceSite before call-edge emission. [inferred]
2. Add an explicit optional skipSites parameter to emitFreeCallFallback and emitReferencesViaLookup; leave handledSites ownership unchanged. [inferred]
3. Allocate CalleeIdAccumulator for PDG OR callable-flow files. Update its documentation from “PDG only” to “direct-target index plus optional PDG join.” [inferred]
4. Preserve receiver/direct-call passes first so their exact targets seed actual → formal.
5. Run callable-value-flow after direct free/lookup emission and before property-dispatch.
6. Preserve the CFG join and deletion behavior only when input.pdg is true. [inferred]

#### B5. C and C++ providers

1. Extend c/query.ts and c/captures.ts for every C form in §3.5.
2. Extend cpp/query.ts and cpp/captures.ts for every C++ form in §3.6.
3. Reuse declarator/type interpretation to emit normalized indirection, passing mode, and expected callable signature. Do not copy C++ syntax tests into C or imply that C has references.
4. Route virtual member-pointer invocation through MethodDispatchIndex and assert derived overrides.
5. Keep existing free-call, overload, ADL, receiver, and property-dispatch behavior byte-identical outside deferred indirect sites. [inferred]

#### B6. First non-C-family proof

1. Extend TypeScript and JavaScript query/capture modules for assignment/copy/formal/argument/invoke facts.
2. Verify arrow functions, named functions, and statically recoverable method values.
3. Exercise Vue through its existing TypeScript capture adapter and pin SFC source positions.
4. Re-measure scope-capture fingerprints and scaling for every changed provider; accept hashes only after ratios remain below 1.5. [inferred]

### Unit C — exhaustive provider adoption

Implement the §3.7 matrix in small provider clusters:

1. Typed direct-callable values: Go, Rust, Kotlin, Swift, Dart.
2. Dynamic callable objects: Python, Ruby, PHP.
3. Delegate/SAM models: C# and Java.
4. Experimental provider: audit COBOL and either implement procedure pointers or add a documented, tested syntax limitation.

Add an exhaustive resolver governance test keyed by the registered provider/language set. Each provider entry must name:

- supported callable syntaxes;
- an assign/copy fixture;
- an actual-to-formal fixture;
- an invocation fixture;
- expected CALLS target/reason/site;
- a negative/ambiguity fixture; or
- an explicit source-backed exclusion. [inferred]

The governance test prevents a newly registered provider from bypassing the callable-flow contract silently. [inferred]

## 7. Implementation Sequence

1. Unit 0: synchronize, rebuild/re-index, rerun impact, and obtain the CRITICAL extractor gate.
2. Unit A: baseline hashes, warning, focused test, benchmark check, full PR checks.
3. Merge or update #2522 before starting the substrate so its review delta stays focused.
4. Unit B1: shared facts, ParsedFile, cache bump, serialization tests.
5. Unit B2: capture topic and Pass 6, extractor unit tests.
6. Unit B3: solver with synthetic unit fixtures for each constraint and fixed-point behavior.
7. Unit B4: pipeline skip-set/accumulator integration and collision regression.
8. Unit B5: C implementation and fixtures, then C++ pointer/reference/member-pointer implementation and fixtures.
9. Unit B6: TypeScript/JavaScript/Vue proof and benchmark updates.
10. Run full validation and detect_changes before each commit; land Unit B as one coherent stacked PR.
11. Unit C provider clusters, each independently benchmarked and reviewed.
12. Re-index the completed branch with --pdg and query real CALLS/callee IDs for representative C, C++, TS, dynamic, delegate, and SAM fixtures. [inferred]

## 8. Test Strategy

### 8.1 Unit A focused checks

    cd gitnexus
    npm test -- test/integration/resolvers/typescript-value-refs.test.ts test/unit/scope-resolution/typescript/typescript-captures.test.ts
    node --import tsx bench/scope-capture/measure.mjs --check
    npm test
    npx tsc --noEmit

[verified]

### 8.2 Solver unit tests

Add gitnexus/test/unit/scope-resolution/callable-value-flow.test.ts with:

- seed → invoke;
- seed → copy → invoke;
- true alias equality;
- address → store/load → invoke;
- one actual → one formal;
- one actual → reference formal;
- two wrapper hops;
- recursive wrapper convergence;
- one site with two valid targets;
- overload disambiguation from expected signature;
- unresolved overload emits no arbitrary edge;
- target cap deletes the whole ambiguous result and warns once;
- duplicate facts and cycles terminate;
- edge target and CalleeIdSink position are identical. [inferred]

### 8.3 C integration fixtures

Extend the C resolver fixture area and gitnexus/test/integration/resolvers/c.test.ts:

- implicit decay: fp = target;
- explicit address: fp = &target;
- pointer copy: fp2 = fp;
- invoke: fp() and (*fp)();
- pointer-to-pointer: slot = &fp; (*slot)();
- typedef function pointer;
- wrapper: invoke(target), invoke(&target), invoke(fp), invoke(*slot);
- two wrappers: outer(target) → inner(formal) → formal();
- reassignment produces a bounded union;
- null/incompatible assignment produces no CALLS;
- collision: global callback plus formal parameter callback passed desired; callback() resolves only to desired. [inferred]

### 8.4 C++ integration fixtures

Extend the C++ resolver fixture area and gitnexus/test/integration/resolvers/cpp.test.ts:

- function pointer and explicit address;
- function reference;
- reference to a pointer variable;
- auto/copy chains;
- pointer-to-pointer;
- pointer and reference formal parameters;
- multiple wrapper hops;
- overloaded function address resolved by contextual pointer/reference signature;
- unresolved overload negative;
- pointer-to-member through .* and ->*;
- virtual pointer-to-member invocation reaches the derived override through MRO/MethodDispatchIndex;
- null/incompatible/collision negatives. [inferred]

### 8.5 Pipeline regressions

Extend:

- scope-extractor.test.ts for Pass 6 and unchanged Pass 5 output;
- worker-roundtrip.test.ts for persisted facts;
- pdg-callee-id-capture.test.ts for normal/PDG target parity and real invocation positions;
- free-call-fallback tests for skipSites and the global-name collision;
- run-progress/stat tests to prove no progress/aggregate regression;
- typescript-value-refs.test.ts to prove property-dispatch behavior remains separate. [inferred]

### 8.6 Provider matrix

For each §3.7 provider, assert:

1. definition/reference assigned to a variable;
2. at least one copy or native reference/delegate equivalent;
3. value passed to a function/method;
4. formal invoked using the language's actual syntax;
5. CALLS originates at the invocation, not assignment or argument;
6. expected target set and callable-value-flow reason;
7. no false global fallback;
8. normal and --pdg CALLS parity. [inferred]

### 8.7 Full validation

    cd gitnexus
    npm run test:unit
    npm run test:integration
    npm test
    npx tsc --noEmit
    node --import tsx bench/scope-capture/measure.mjs --check
    npx eslint .

Then re-index with --pdg and run detect_changes with scope=compare against current origin/main before every commit. LadybugDB file-lock failures in containers must be identified as the documented environment issue, never silently treated as a product pass. [verified]

## 9. Risk and Impact Analysis

### 9.1 CRITICAL/HIGH gates

- CRITICAL extractor path: extract and partitionByTopic participate in parse/run/processFileGroup flows. Unit B needs explicit maintainer acknowledgement after impact is refreshed at the synchronized commit. [graph]
- CRITICAL LanguageProvider: do not modify it. If implementation discovers that the existing hook cannot express a required fact, stop and run a fresh impact analysis before proposing a contract change. [graph]
- HIGH emitReferencesViaLookup: direct dependents runScopeResolution and pdg-callee-id-capture.test.ts must both be changed/tested together. [graph]
- HIGH emitTsScopeCaptures: verify Vue, TS CFG harness, JavaScript parsing coverage, TS capture anchor/helper/file suites, imports, and provider-hook tests; benchmark TS and JS after capture changes. [graph]

### 9.2 Correctness risks

| Risk | Mitigation |
|---|---|
| Wrong global function wins at an indirect site | deferredIndirectSites skips free/lookup resolution; collision fixtures pin the behavior |
| Flow-insensitive over-approximation | bounded union, lower confidence, distinct reason, negative fixtures |
| Silent target loss | whole-set cap policy plus warning with language/site/count/cap |
| Arbitrary overloaded function selection | contextual callable signature; emit nothing when unresolved |
| C/C++ semantics conflated | separate provider patterns and fixtures; C has no true references |
| Virtual member pointer targets only base method | expand through existing MRO/MethodDispatchIndex |
| PDG-only behavior leaks into normal indexing | callableFlowSites is always-on; parity tests run both modes |
| Callee IDs land on assignment rather than invocation | use invoke Range and existing exact position encoding |
| Interprocedural cycles do not terminate | monotone finite worklist and capped target sets |
| Cache serves ParsedFiles without facts | SCHEMA_BUMP 14 → 15 plus worker/cache round-trip tests |
| Capture query growth regresses scaling | per-provider fingerprint audit and <1.5 ratio gate |
| Cross-language rollout becomes one unreviewable PR | staged provider clusters and exhaustive governance test |

### 9.3 Graph limitations

The refreshed graph under-reports some production callers that exact source contains, including runScopeResolution callers of free/lookup passes. Treat graph impact as a lower bound and source-verify every direct caller before editing. [verified]

## 10. Files Expected to Change

### Unit A

| File | Symbols/area | Change |
|---|---|---|
| gitnexus/bench/scope-capture/baselines.json | TypeScript/JavaScript baselines | measured hashes and audit note |
| gitnexus/src/core/ingestion/scope-resolution/pipeline/run.ts | runScopeResolution imports/diagnostic | warning with language, count, cap |
| gitnexus/test/integration/resolvers/typescript-value-refs.test.ts | fan-out cap fixture | warning assertion |

### Unit B shared/core

| File | Symbols/area | Change |
|---|---|---|
| gitnexus-shared/src/scope-resolution/callable-flow-site.ts | new types | normalized JSON-safe fact contract |
| gitnexus-shared/src/scope-resolution/parsed-file.ts | ParsedFile | callableFlowSites |
| gitnexus-shared/src/index.ts | exports | export shared facts |
| gitnexus/src/storage/parse-cache.ts | SCHEMA_BUMP | 14 → 15 |
| gitnexus/src/core/ingestion/scope-extractor.ts | Topic, partitionByTopic, topicOf, extract, new Pass 6 | route/build facts; leave Pass 5 unchanged |
| gitnexus/src/core/ingestion/scope-resolution/passes/callable-value-flow.ts | new | fixed-point solver and edge emission |
| gitnexus/src/core/ingestion/scope-resolution/passes/free-call-fallback.ts | emitFreeCallFallback | explicit skipSites |
| gitnexus/src/core/ingestion/scope-resolution/graph-bridge/references-to-edges.ts | emitReferencesViaLookup | explicit skipSites |
| gitnexus/src/core/ingestion/scope-resolution/graph-bridge/callee-id-sink.ts | docs, existing interfaces | describe direct-target index use |
| gitnexus/src/core/ingestion/scope-resolution/pipeline/run.ts | runScopeResolution | ordering, allocation, solver wiring |

### Unit B providers/tests

| File group | Change |
|---|---|
| gitnexus/src/core/ingestion/languages/c/query.ts and captures.ts | C facts |
| gitnexus/src/core/ingestion/languages/cpp/query.ts and captures.ts | C++ facts |
| gitnexus/src/core/ingestion/languages/typescript/query.ts and captures.ts | TS facts |
| gitnexus/src/core/ingestion/languages/javascript/query.ts and captures.ts | JS facts |
| gitnexus/test/unit/scope-resolution/scope-extractor.test.ts | Pass 6 |
| gitnexus/test/unit/scope-resolution/callable-value-flow.test.ts | new solver suite |
| gitnexus/test/integration/cfg/worker-roundtrip.test.ts | serialization |
| gitnexus/test/unit/pdg-callee-id-capture.test.ts | callee ID parity |
| gitnexus/test/integration/resolvers/c.test.ts and C fixtures | C acceptance matrix |
| gitnexus/test/integration/resolvers/cpp.test.ts and C++ fixtures | C++ acceptance matrix |
| TypeScript/JavaScript/Vue resolver and capture tests | non-C-family proof |
| gitnexus/bench/scope-capture/baselines.json | only measured changed-provider fingerprints |

### Unit C providers/tests

Provider query/capture modules under languages/python, ruby, php, go, rust, kotlin, swift, dart, csharp, java, and cobol; their existing resolver/capture suites; representative fixtures; and a new exhaustive callable-value-flow provider matrix test. Exact paths must be confirmed with rg --files before each provider cluster. [verified]

## 11. Reusable Implementation Context

    implementation_context:
      task_summary: >
        Close PR #2522 review feedback, then add an always-on, language-neutral
        callable-value-flow analysis that emits CALLS at real indirect invocation
        sites after assignments, pointer/reference aliases, and actual-to-formal
        argument propagation. C/C++ are strict; all production providers require
        support fixtures or a verified exclusion.
      verified_at_commit: "05540a9674b81bf985c61fffe0ed156470d16434"
      evidence_quality:
        source: "exact PR HEAD"
        graph: "worktree-local --index-only --pdg, installed analyzer 1.6.9"
        caveat: "analyzer was not rebuilt from branch source; exact source wins on disagreement"
      acceptance_criteria:
        - "Unit A accepts only measured TS/JS hashes; scaling ratios stay below 1.5"
        - "Property fan-out loss emits one structured warning with lang, skippedKeys, fanoutCap"
        - "C function designator/pointer/copy/deref/pointer-to-pointer/argument chains resolve"
        - "C++ pointer/function-reference/pointer-reference/overload/member-pointer chains resolve"
        - "Multi-hop actual-to-formal propagation reaches the real invocation target"
        - "No global same-name fallback edge survives at a known indirect site"
        - "Normal and --pdg CALLS targets match; callee IDs use invocation positions"
        - "Every production provider has support fixtures or an explicit verified limitation"
      primary_symbols:
        - symbol: runScopeResolution
          file: gitnexus/src/core/ingestion/scope-resolution/pipeline/run.ts
          role: "load-bearing pass ordering, direct target accumulator, warnings"
          impact: "LOW graph result; 3 direct/4 total; source orchestration risk is higher"
        - symbol: extract
          file: gitnexus/src/core/ingestion/scope-extractor.ts
          role: "invoke new Pass 6"
          impact: "CRITICAL; 2 direct/31 total across 9 modules"
        - symbol: partitionByTopic
          file: gitnexus/src/core/ingestion/scope-extractor.ts
          role: "new callable-flow topic"
          impact: "CRITICAL; 1 direct/20 total"
        - symbol: pass5CollectReferences
          file: gitnexus/src/core/ingestion/scope-extractor.ts
          role: "protected existing reference extraction"
          impact: "CRITICAL; DO NOT EDIT"
        - symbol: emitFreeCallFallback
          file: gitnexus/src/core/ingestion/scope-resolution/passes/free-call-fallback.ts
          role: "skip known indirect sites"
          impact: "LOW graph result; run.ts production caller source-verified"
        - symbol: emitReferencesViaLookup
          file: gitnexus/src/core/ingestion/scope-resolution/graph-bridge/references-to-edges.ts
          role: "skip known indirect sites, seed direct targets"
          impact: "HIGH; direct runScopeResolution + pdg-callee-id-capture.test.ts"
        - symbol: emitCScopeCaptures
          file: gitnexus/src/core/ingestion/languages/c/captures.ts
          role: "C normalized facts"
          impact: "MEDIUM; 5 direct"
        - symbol: emitCppScopeCaptures
          file: gitnexus/src/core/ingestion/languages/cpp/captures.ts
          role: "C++ normalized facts"
          impact: "MEDIUM; 8 direct/10 total"
        - symbol: emitTsScopeCaptures
          file: gitnexus/src/core/ingestion/languages/typescript/captures.ts
          role: "first cross-language proof"
          impact: "HIGH; 15 direct/24 total"
      related_symbols:
        - symbol: emitPropertyDispatchCalls
          relationship: "separate field-key fallback; Unit A warning only"
        - symbol: createCalleeIdAccumulator
          relationship: "existing exact-position multi-target index"
        - symbol: MethodDispatchIndex
          relationship: "virtual member-pointer target expansion"
        - symbol: ParsedFile
          relationship: "worker/cache semantic boundary"
        - symbol: SCHEMA_BUMP
          relationship: "invalidate old ParsedFiles"
      execution_path:
        - "provider emits @callable-flow captures"
        - "Pass 6 builds JSON-safe callableFlowSites"
        - "ParsedFile round-trips through worker/store/cache"
        - "finalized registries resolve seed definitions and direct calls"
        - "free/lookup passes skip deferred indirect sites but seed direct callee IDs"
        - "callable-value-flow fixed point applies local and actual→formal constraints"
        - "tryEmitEdge emits CALLS at invoke positions and records callee IDs"
        - "property-dispatch remains a later, separate fallback"
        - "optional CFG join consumes the same callee IDs under --pdg"
      pdg_constraints:
        - "Accumulator definition must dominate all direct and indirect target producers"
        - "Callable solver runs after direct call target seeding"
        - "CFG join remains conditional on input.pdg"
        - "Property skippedKeys only controls warning/aggregate; do not reuse it for flow"
        - "Pass 5 site construction remains unchanged; Pass 6 owns callable facts"
      architectural_patterns:
        - pattern: "provider-owned syntax, generic normalized pass"
          example_location: "language emitScopeCaptures hooks → shared scope extractor"
          usage_guidance: "never name languages in shared ingestion code"
        - pattern: "real-site edge emission"
          example_location: "tryEmitEdge + CalleeIdSink"
          usage_guidance: "record target before dedup at invoke Range"
        - pattern: "conservative bounded fan-out"
          example_location: "property-dispatch.ts MAX_PROPERTY_DISPATCH_FANOUT"
          usage_guidance: "skip whole ambiguous set and warn; never truncate"
      files_to_modify:
        - file: gitnexus/bench/scope-capture/baselines.json
          intended_change: "Unit A TS/JS hashes; later only measured provider hashes"
        - file: gitnexus-shared/src/scope-resolution/callable-flow-site.ts
          intended_change: "new normalized fact types"
        - file: gitnexus-shared/src/scope-resolution/parsed-file.ts
          intended_change: "callableFlowSites"
        - file: gitnexus/src/core/ingestion/scope-extractor.ts
          intended_change: "topic + Pass 6; no Pass 5 edit"
        - file: gitnexus/src/core/ingestion/scope-resolution/passes/callable-value-flow.ts
          intended_change: "new fixed-point solver"
        - file: gitnexus/src/core/ingestion/scope-resolution/pipeline/run.ts
          intended_change: "warning, skip set, accumulator allocation, solver order"
        - file: gitnexus/src/core/ingestion/scope-resolution/passes/free-call-fallback.ts
          intended_change: "explicit skipSites"
        - file: gitnexus/src/core/ingestion/scope-resolution/graph-bridge/references-to-edges.ts
          intended_change: "explicit skipSites"
        - file: gitnexus/src/storage/parse-cache.ts
          intended_change: "SCHEMA_BUMP 14→15"
        - file: "C/C++/TS/JS provider query + capture modules"
          intended_change: "normalized syntax facts"
      tests:
        - file: gitnexus/test/integration/resolvers/typescript-value-refs.test.ts
          scenarios: ["cap warning context", "existing property dispatch unchanged"]
        - file: gitnexus/test/unit/scope-resolution/callable-value-flow.test.ts
          scenarios: ["all constraints", "fixed point", "cap", "position", "overload"]
        - file: gitnexus/test/integration/resolvers/c.test.ts
          scenarios: ["C strict matrix from §8.3"]
        - file: gitnexus/test/integration/resolvers/cpp.test.ts
          scenarios: ["C++ strict matrix from §8.4"]
        - file: gitnexus/test/integration/cfg/worker-roundtrip.test.ts
          scenarios: ["callableFlowSites serialization"]
        - file: gitnexus/test/unit/pdg-callee-id-capture.test.ts
          scenarios: ["normal/PDG parity and real-site IDs"]
      verification_commands:
        - "cd gitnexus && npm test -- test/integration/resolvers/typescript-value-refs.test.ts test/unit/scope-resolution/typescript/typescript-captures.test.ts"
        - "cd gitnexus && node --import tsx bench/scope-capture/measure.mjs --check"
        - "cd gitnexus && npm run test:unit"
        - "cd gitnexus && npm run test:integration"
        - "cd gitnexus && npm test"
        - "cd gitnexus && npx tsc --noEmit"
        - "cd gitnexus && npx eslint ."
        - "node .gitnexus/run.cjs analyze --index-only --pdg"
        - "detect_changes(scope=compare, base_ref=origin/main) before commit"
      risks:
        - "CRITICAL extractor and LanguageProvider blast radii"
        - "wrong global fallback at indirect sites"
        - "flow-insensitive false positives"
        - "overload/member-pointer semantic mistakes"
        - "worker/cache schema drift"
        - "scope-capture scaling regression"
        - "provider-specific callable syntax hidden behind a generic claim"
      assumptions:
        - "flow-insensitive bounded union is acceptable for the first series"
        - "32 is the initial target-set cap, matching current property dispatch"
        - "reflection, native callback registration, returned callables, and arbitrary heap aggregates are out of first-series scope unless expressible with existing normalized facts"
        - "maintainers accept a stacked PR series rather than expanding #2522"
      open_questions:
        - "Does the current COBOL grammar expose procedure-pointer declaration, assignment, and indirect CALL constructs?"
        - "Should callable-object protocol targets such as Python __call__ beyond named/bound functions land in the first provider cluster or a follow-up?"
        - "Which repo-approved merge/rebase convention should synchronize pr-2522 with origin/main?"
      avoid:
        - "Do not edit a symbol before refreshed upstream impact analysis"
        - "Do not ignore HIGH or CRITICAL impact"
        - "Do not change LanguageProvider for this design"
        - "Do not edit pass5CollectReferences"
        - "Do not name languages in shared ingestion code"
        - "Do not use cfgSideChannel as the normal-mode substrate"
        - "Do not turn property-dispatch into points-to analysis"
        - "Do not pre-seed handledSites"
        - "Do not let free/global lookup own known indirect sites"
        - "Do not choose the first overload or truncate a target set"
        - "Do not update a benchmark hash without reviewing its ratio"
        - "Do not commit without detect_changes"
        - "Do not repeat broad discovery; start from this context pack and verify only drift"

## 12. Assumptions and Open Questions

### Assumptions

- This turn produces the plan only; no implementation source or test code is changed. [verified]
- Callable flow is conservative and flow-insensitive for the first series. A variable assigned A and later B may resolve to both A and B. [assumed]
- Reflection, native/framework callback registration, returned callables, and arbitrary heap/aggregate aliasing are outside the first series unless the normalized facts already express them without shared-language special cases. [assumed]
- The maintainers prefer Unit A on #2522 and the broader work as stacked follow-ups because #2522 already has a substantial reviewed delta. [assumed]
- The cap begins at 32 to match property dispatch; measurements may justify a distinct named constant later, but not an unbounded set. [assumed]

### Open questions requiring maintainer/domain confirmation

1. Synchronization policy: merge origin/main or rebase the PR branch before Unit A?
2. COBOL: does the vendored grammar expose procedure-pointer declaration, assignment, and indirect call constructs robustly enough for production support?
3. Dynamic callable objects: should first-cluster support include arbitrary Python __call__, Dart call, and equivalent protocol objects, or begin with named/bound functions and add protocol objects in a focused follow-up?
4. Rollout packaging: one Unit C PR per provider cluster, or combine low-risk providers after the governance test exists?

None of these questions blocks Unit A or the C/C++ substrate design. They gate only synchronization mechanics and the tail of provider adoption. [inferred]

## 13. Definition of Done

### PR #2522 / Unit A

- TypeScript baseline equals 25de86fd3377132c4e35d3d98f4f94a58e0cfeb7c22948a8ea3be4e793be74fd and measured ratio remains 0.987 or a newly measured value below 1.5. [verified]
- JavaScript baseline equals 5567dd47e7ba29821a518c4a9852adc3b774e25ef3e7a6e2b3ecb7b59ddab73c and measured ratio remains 1.031 or a newly measured value below 1.5. [verified]
- Capped property keys emit no partial CALLS and exactly one warning with language, skipped count, and cap. [inferred]
- Focused tests, full npm test, typecheck, benchmark check, and detect_changes pass. [inferred]

### Callable-flow substrate / Unit B

- Every C and C++ scenario in §8 resolves the exact expected target set at the real invocation line/column. [inferred]
- C has no fictitious reference semantics; C++ true aliases, overload context, and member pointers are covered separately. [inferred]
- Pointer-to-pointer, function-reference, pointer-reference, actual-to-formal, and multi-hop wrapper flows converge. [inferred]
- Same-name global collision tests prove free/lookup fallback cannot preempt a deferred indirect site. [inferred]
- Normal and --pdg CALLS sets are identical; --pdg BasicBlock.calleeIds contain every indirect target at the invocation position. [inferred]
- Pass 5 and LanguageProvider remain unchanged; shared ingestion code contains no language names. [inferred]
- Parse cache is bumped to 15 and worker/store round trips preserve every fact. [inferred]
- TypeScript, JavaScript, and Vue prove the substrate is not C-family-specific. [inferred]
- All changed capture benchmarks remain below 1.5 and hashes are updated only with an audit trail. [inferred]

### Cross-language rollout / Unit C

- Every registered production provider appears in the exhaustive governance matrix. [inferred]
- Every applicable provider has assign/copy, argument propagation, invocation, target, site, and negative fixtures using its native callable semantics. [inferred]
- Any unsupported syntax is explicitly documented with a grammar/source limitation and a test that prevents an accidental support claim. [inferred]
- Full tests, typecheck, lint, benchmark checks, refreshed --pdg index validation, and detect_changes pass for each stacked PR. [inferred]
