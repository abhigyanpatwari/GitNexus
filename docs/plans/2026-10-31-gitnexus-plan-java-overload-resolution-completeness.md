# GitNexus Engineering Plan

> Task: Fix issue #3789: JLS-compatible Java overload selection and honest impact completeness.
> Depth: deep; full plan; upstream impact depth 3. Evidence pinned at `f641342d1fcbfdcb764c5e478db0f69e6cea899a`.
> Index matches that HEAD, but was produced by published GitNexus 1.6.12 rather than a verified build of this source. **Stale analyzer provenance — source-weighted limitation.** No refresh/build performed; PDG unavailable.
> Evidence provenance schema 2; global dirty digest fe1372d37f6331330609555663d0401e220db674133dd476415f0e50bc74003c; cited-path manifest 47 sorted entries; exact generated plan path excluded.

## 1. Objective

Fix [issue #3789](https://github.com/abhigyanpatwari/GitNexus/issues/3789) without inventing call edges. The original five-file example must produce direct caller counts `find(Collection<Long>)=3`, `find(Long)=1`, `resolve(String)=1`, `resolve(Long)=1`, `count(Req)=2`, and `count(Long,Req)=1`. Preserve those graph facts through worker execution, warm caches, index persistence, and reopened impact queries.

When available evidence cannot establish Java's selected declaration, retain a terminal unresolved outcome with candidate identities. Impact and context must disclose the resulting incompleteness, including omissions encountered through an impact traversal. Full Java compiler inference is outside this change; unsupported cases must remain explicitly unknown.

## 2. Current Behaviour

- [verified] `languages/java/captures.ts:381–411,817–910` captures literal argument hints, then fills identifier hints from file-global local/field maps that exclude formal parameters. Adding parameter names to those maps would mix unrelated method scopes.
- [verified] `captures.ts:935` ignores integer/floating suffixes and does not type nested method invocations. `java/query.ts:117` already captures formal parameter annotations.
- [verified] `passes/overload-narrowing.ts:151` tries exact string matches before conversion ranking. This cannot implement Java's phased invocation rules. `java/interpret.ts:74` strips qualification and unwraps containers for receiver inference; reuse for overload arguments would lose necessary information.
- [verified] `receiver-bound-calls.ts:2252,2770` offers a provider hook before walking owners. Its subsequent generic walks stop at the first owner with a match. A selector applied after that walk cannot recover inherited overloads. `free-call-fallback.ts:1418–1454` similarly considers own declarations before ancestors.
- [verified] Shared paths have singleton and empty-result shortcuts; implicit-self ambiguity can become `undefined` and resume fallback (`receiver-bound-calls.ts:3644–3690`; `free-call-fallback.ts:381,497–544,1375`).
- [verified] Suppressed outcomes retain candidate IDs, but `unresolved-receivers.ts:97–105` intentionally excludes overload suppressions. `run-analyze.ts:5362` persists only the receiver summary; `local-backend.ts:903–948,982–1014` consequently has no overload boundary to report.
- [verified] `_runImpactBFS` starts the existing completeness probe for the original target before BFS (`local-backend.ts:8481–8519`) and awaits it at result assembly (`:9358`). A target-only overload probe would miss omitted callers of reached intermediate methods.

## 3. Relevant Architecture

[verified] `ARCHITECTURE.md:284–313,351–399` separates capture facts, `ParsedFile`, the semantic model, and provider-directed resolution. Shared ingestion must remain language-neutral. Use existing provider boundaries; do not add a parallel parser or Java cases to shared code.

[verified] `ScopeResolver.resolveReceiverMember` (`contract/scope-resolver.ts:1651`) receives owner, call site, scopes and model before generic MRO lookup. `ReceiverMemberResolution` (`:320`) currently distinguishes resolved/ambiguous, with `undefined` declining handling. Reuse this receiver entry point. Add a narrowly scoped optional unqualified-call entry point before implicit-this owner pruning, sharing the Java inventory/selection implementation. Do not retrofit Java into the generic exact-match/conversion-score algorithm.

[verified] `ParsedFile.captureSideChannel` is opaque provider data (`gitnexus-shared/src/scope-resolution/parsed-file.ts:89–110`). Java already collects/restores it (`java.ts:229`; `java/capture-side-channel.ts:156–263`; `java/scope-resolver.ts:55,77`). Workers attach it before storage (`workers/parse-worker.ts:1766–1782`); the actual store writes the whole ParsedFile through V8 envelopes (`storage/parsedfile-store.ts:198–240`), despite older JSON-oriented comments. Keep new facts plain serializable data and clear per-workspace/per-file state.

[verified] Outcomes already pass through `pipeline/run.ts:766–778,2178`, `pipeline/phase.ts:506–507,685–691`, and `ingestion/pipeline.ts:450–502`. Persist completeness in metadata beside existing receipts; no graph DDL or new CALLS relation semantics is required.

## 4. GitNexus Findings

Calls used explicit `repo: /workspace`. Graph findings are navigation evidence, not verified complete dependency inventories. Deep-plan context, cluster and process resources were read; the scope-resolution cluster is relevant. No exploration of unrelated modules is required during execution.

| Query | Result and implication |
| --- | --- |
| `impact(narrowOverloadCandidates, upstream, maxDepth:3)` | [graph] **CRITICAL**; 12 direct dependents, 447 total, 161 processes, 20 modules. The final design bypasses this helper through provider entry points; leave its ranking unchanged. |
| `impact(emitJavaScopeCaptures, upstream)` | [graph] **CRITICAL**; d1 includes `extractParsedFile`, Java provider file and an anonymous row. Higher-depth enrichment was partial. Fresh impact is mandatory before edits. |
| `impact(resolveVarTypeBindings/inferArgType, upstream, maxDepth:1)` | [graph] LOW; each has `emitJavaScopeCaptures` as direct caller. Change only the argument-evidence responsibility, preserving receiver behavior. |
| `impact(computeEpistemicBoundary, upstream, maxDepth:3)` | [graph] **HIGH**; d1 `_contextImpl`, `_runImpactBFS`; 11 affected symbols, 3 modules. Cover both query surfaces. |
| `impact(epistemicFrom, upstream)` | [graph] **CRITICAL**; named d1 `computeEpistemicBoundary` plus an anonymous row; 120 processes/20 modules in bounded retry. Source finds its calls inside boundary computation; the anonymous row remains unresolved. |
| `impact(_runImpactBFS, upstream, maxDepth:1)` | [graph] LOW with existing lower-bound receiver warning; d1 `_impactImpl` and `impactByUid`. Cover name and UID requests. |
| `impact(runFullAnalysis/runFullAnalysisInner/javaScopeResolver/collectJavaCaptureSideChannel/applyJavaCaptureSideChannel, upstream)` | [graph] UNKNOWN/not found. [verified] Source confirms analyzer wrapper→inner, Java registry registration, provider hooks and Spring/JVM consumers. Zero is not evidence of safety. |
| `impact(summarizeUnresolvedReceivers, upstream)` | [graph] CRITICAL with anonymous d1. [verified] Actual producer call is `runFullAnalysisInner`. Leave this summary's receiver-specific meaning unchanged. |

The selector's 12 d1 rows are accounted for: C++ `chooseOverload`; PHP `phpEmitUnresolvedReceiverEdges` and `resolveReceiverMember`; shared `emitFreeCallFallback`, `pickImplicitThisOverload`, `pickUniqueImplicitThisCandidate`, `pickUniqueGlobalCallable`, `emitReceiverBoundCalls`, `pickOverload`, `pickFirstNonStaticOnly`, `recordReceiverOverloadSuppression`; and one anonymous row. The generic selector remains unchanged. Shared integration changes still need other-provider regression tests, and the unidentified row requires a current graph/source callsite audit before editing its path.

## 5. Statement-Level PDG Findings

[graph] `pdg_query(mode: controls, target: narrowOverloadCandidates)` returned **"no PDG layer"**. No statement-level edges are claimed. Refresh was skipped because analyzer provenance is not verified against this source and planning cannot build output. Execution must build the current analyzer before an index refresh and request `--pdg`; if that fails, disclose the limitation and retain source-backed control-flow verification.

[verified] Source constraints: provider dispatch must precede owner pruning, singleton/exact-match selection and first-match fallback; definitive suppression must mark the site handled; capture facts must cross worker/store boundaries before resolution; suppression summaries must describe final site outcomes, not stale pre-replay failures.

## 6. Proposed Changes

### Java evidence and JLS selection

1. In `languages/java/captures.ts`, separate overload evidence from the receiver-oriented global maps. Build lexical, position-aware facts from formal parameters, fields, locals and supported expressions. Preserve qualified identity, concrete generic arguments, array dimensions, casts, null versus unknown, and numeric suffixes. Field/parameter and inner-block shadowing must obey source scope. Existing receiver unwrapping remains intact.
2. Add Java-local argument evidence and overload selection modules (new files). Facts distinguish known primitive/reference/array types, null, supported poly factory expressions, and unknown with reason. Use `TypeRef.declaredSpelling` (`shared/types.ts:627`) where appropriate, but do not turn receiver `rawName` into argument semantics. Canonicalize identities from lexical/import/package bindings; a missing hierarchy link is unknown, not proof of incompatibility.
3. Extend `JavaCaptureSideChannel` and collect/apply/clear lifecycle for those facts. The payload is scoped by file and stable call-site range, with explicit format validation. Missing or malformed payload clears stale facts and yields unknown. Use the existing worker and durable store transport; no AST or native parser object crosses the boundary.
4. Reuse `resolveReceiverMember` for Java's **complete compile-time receiver inventory**: owner plus applicable ancestors, accessibility, static/instance eligibility, and override-equivalent deduplication. Do not deduplicate by name/arity or stop at the nearest declaring class. Prefer declared receiver type over constructor-inferred subtype. Unproven inventory completeness prevents an exact choice.
5. Add the optional unqualified-call provider entry point in `ScopeResolver`, forward it through `pipeline/run.ts` and `emitFreeCallFallback`, and invoke it before implicit-this lookup. Java uses the same inventory/selection helper. Preserve lexical/import precedence; unsupported static-import or enclosing-class inventories must yield explicit unknown rather than a generic guess.
6. Extend the language-neutral result contract to distinguish resolved, ambiguous, unknown and inapplicable. Hook absence/explicit decline retains existing behavior for other providers. Once Java claims a method call, every result is terminal, including a singleton that is inapplicable. Read/write member lookup must retain its prior behavior. Audit explicit receiver, implicit-this, `this`, `super`, chain receiver and static paths; an unsupported path must retain uncertainty rather than bypass the Java decision.
7. Evaluate strict invocation, then loose invocation, then variable arity; stop at the first provably applicable phase. Unknown applicability in an earlier phase blocks a later exact choice. Within a phase use pairwise JLS specificity across all parameters, preserving generics. Do not sum conversion ranks. Treat varargs declarations as arrays in fixed phases, then expand only in variable-arity phase.
8. Include small Java-owned summaries for proven `java.util.Arrays.asList`, `java.util.Collections.singletonList`, `List`→`Collection`, and the platform type relationships required by supported conversions. Nested factories retain element constraints and explicit type arguments; check compatibility against each candidate's target type. A declared `List<Long>` is invariant, whereas a nested factory may infer `T=Number`. Shadowed classes, values, nested types or type parameters must not acquire JDK behavior by spelling. No full JDK classpath subsystem is introduced.

The provider result selects a **compile-time declaration/signature**, not the complete runtime dispatch set. Preserve existing implementation/virtual dispatch fan-out, generic-instantiation filtering and selected-signature return typing after selection. [verified] The current resolved-hook branch at `receiver-bound-calls.ts:2777–2831` emits and continues, so activating it broadly requires an explicit audit of the post-selection path. Add interface-overload and Base-typed/Sub-overriding fixtures; fan-out must use only the selected signature and chained expression typing must use its compile-time return type.

### Persisted uncertainty

9. Extend `ResolutionOutcome` additively with the identities required for call completeness: actual enclosing caller, candidate declarations and declaring owners, stable site identity, and whether the candidate inventory is complete. Emit one authoritative decision and reuse it for graph emission and diagnostics. Include existing overload/member ambiguity reasons and new unknown/inapplicable reasons as appropriate; an invalid call must not manufacture an edge. Distinguish proven no-applicable from missing evidence in boundary text.
10. Add `scope-resolution/unresolved-overloads.ts`. Summarize final unresolved call sites separately from receiver typing, indexed by candidate/caller/declaring-owner IDs. Deduplicate by site identity, not candidate count; reconcile resolved-after-suppressed replay. Use bounded, prototype-safe storage with explicit complete-empty, complete-nonempty and partial states, plus versioned coverage receipt. Missing/legacy/malformed metadata is unverified, never measured zero. Partial candidate inventories or caps cannot certify absent keys as clean.
11. Add the summary/receipt to `RepoMeta` and persist it from `runFullAnalysisInner` beside the receiver summary. Recompute/replace it coherently on every successful analysis, including warm/incremental runs and file deletion; do not merge obsolete candidate IDs indefinitely. Existing outcome transport remains unchanged apart from additive fields.
12. Add `causes.overloadResolution` and boundary text to the backend/tool contract. Count unique affected unresolved call sites; identify counts as lower bounds if capped/unverified. Direct context uses candidate/caller identities for its corresponding incoming/outgoing views. For impact, union overload boundaries over the **actually expanded** BFS frontier and structural seeds before pagination, using one in-memory metadata aggregation. Do not probe the database once per node. Terminal nodes beyond requested `maxDepth` do not alone imply omissions within that bound.
13. For class/interface seeds, use candidate declaring-owner identities: existing structural seeds include constructors and an owning-file route, not all ordinary methods. Do not attribute every unresolved method in that file to every class. Upstream probes use candidate keys; downstream probes use caller keys. Preserve all existing causes through normal return, heritage-boundary and heritage-error paths. Pagination, UID/name variants and summary-only views must agree on completeness.

**Normative references.** [JLS SE 26 §15.12.2](https://docs.oracle.com/javase/specs/jls/se26/html/jls-15.html#jls-15.12.2) defines phases and specificity; [§5.3](https://docs.oracle.com/javase/specs/jls/se26/html/jls-5.html#jls-5.3) defines invocation conversions; [§4.10](https://docs.oracle.com/javase/specs/jls/se26/html/jls-4.html#jls-4.10) defines subtyping; [§8.4.2](https://docs.oracle.com/javase/specs/jls/se26/html/jls-8.html#jls-8.4.2) constrains signatures; [§18.5.2](https://docs.oracle.com/javase/specs/jls/se26/html/jls-18.html#jls-18.5.2) covers target-dependent inference. The [Arrays](https://docs.oracle.com/en/java/javase/26/docs/api/java.base/java/util/Arrays.html#asList(T...)), [Collections](https://docs.oracle.com/en/java/javase/26/docs/api/java.base/java/util/Collections.html#singletonList(T)) and [List](https://docs.oracle.com/en/java/javase/26/docs/api/java.base/java/util/List.html) APIs support the bounded library summaries. These rules were researched independently; implementation choices above are [inferred] from those rules and verified repository boundaries.

## 7. Implementation Sequence

1. **Anchor execution.** After the LFG gate, create an isolated topic checkout from freshly fetched `origin/main`; do not reuse or alter the current unrelated CI branch/untracked files. Re-anchor this plan's schema-2 evidence against that checkout. Local `origin/main` is newer and changes Java tests, worker owner guards and metadata-adjacent code; reread changed cited ranges before moving the pin. Structural drift routes back to Deepen. Build the current analyzer, refresh the index, and rerun impact for each edited symbol. HIGH/CRITICAL warnings require the maintainer's proceed authorization.
2. **Facts and selector.** Add scoped Java evidence and side-channel round-trip tests, plus a standalone selector tested against JLS examples. Keep provider activation off until terminal result handling is in place. This commit may include tests for the new component without claiming the issue fixed.
3. **Provider integration and outcomes.** Wire the receiver and unqualified boundaries, complete inherited candidate inventory, authoritative results and suppression identity fields. Add the original fixture and positive/negative resolver regressions together. Verify existing non-Java behavior. A follow-up metadata step is still required before claiming complete repair.
4. **Completeness persistence and queries.** Add summary/receipt, analyzer persistence, BFS/context aggregation and additive API documentation/tests. Include persisted multi-hop, class-owner, downstream, clean-clear and missing-receipt cases.
5. **Production validation and review.** Run compiler oracle, real cold/warm indexing, full affected-package tests and type checks. Regenerate any affected golden once at the end only after explaining changed facts. Run `detect_changes` before each commit and the final GitNexus review. Use Java/JLS correctness, shared API/correctness and adversarial regression reviewers; independent execution workers may own Java internals versus metadata/backend once shared contracts are agreed. Resolve in-scope findings and re-review under LFG rules.

## 8. Test Strategy

The original fixture is mandatory, including injected-field receivers and the unqualified `find(Collections.singletonList(id))` self-call. Assert target UIDs and absence of wrong edges, not just total edge counts. Validate node survival and unique caller counts as well as call-site diagnostics.

| Scenario | Expected result |
| --- | --- |
| `m(long)` / `m(Integer)`, argument `int` | `long` wins in strict phase. |
| `m(Object)` / `m(int)`, argument `Integer` | `Object` wins in strict phase. |
| `m(long)`, argument `Integer` | Unboxing plus widening is applicable. |
| Sole `m(Long)`, argument `int`; sole `m(byte)`, literal `1` | No applicable target; no widening-then-boxing or constant narrowing. |
| `m(int,Object)` / `m(long,String)`, `(int,String)` | Incomparable signatures; ambiguous. |
| `m(String)` / `m(Object)`, null; `m(String)` / `m(Long)`, null | First chooses String; second stays ambiguous. Unknown is not null. |
| `m(Object)` / `m(String...)`, string then `String[]` | Object for string; varargs declaration in fixed-array form for array. |
| `m(Integer)` / `m(int...)`, `1` | Boxing phase beats variable arity. |
| `List<Long>` variable to `Collection<Long>`; `List<Integer>` to `Collection<Long>` | First applicable, second incompatible; no erasure-only matching. |
| Nested `singletonList(Long)` with `Collection<Number>` / Object | Candidate-specific inference allows collection overload. |
| `List<Number>` / `Collection<Integer>` with `singletonList(1)` | Ambiguous; raw List specificity cannot erase incompatible arguments. Check explicit type-argument variant too. |
| `asList(long[])` | Not `List<Long>`; unsupported inference stays unknown. |
| `String[]`, `int[]`, `int[][]` | Preserve reference covariance, primitive-array distinctions and dimensions; e.g. `int[][]` can widen to `Object[]`, `int[]` cannot. |
| Base `f(Number)`, Sub `f(Integer)` | Sub receiver with Number retains Base overload; declared Base receiver excludes subclass-only overloads; actual same-signature override does not create ambiguity. |
| Duplicate variable names across methods; block/field/type/import shadowing | Use correct declaration and qualified type identity. |
| Unknown argument/hierarchy/generic constraints, lambda/method reference | Terminal unknown with candidate-aware boundary, no guessed CALLS. |

Add new Java selector/argument-fact unit tests and an exact issue fixture under `test/fixtures/lang-resolution/java-overload-types/`. Extend existing `test/integration/resolvers/java.test.ts`, `test/unit/scope-resolution/java/java-captures.test.ts`, and shared implicit-this tests. Keep `overload-narrowing.test.ts` and C++ ranking tests as regression guards. Use the existing compiler-test pattern in `java-javac-local-types.test.ts`; new `java-javac-overloads.test.ts` must actually run with a provisioned JDK and compare selected method descriptors or deterministic markers, plus expected compiler rejection for ambiguous/inapplicable cases. A conditional skip is not completion evidence.

New summary tests cover duplicate sites, two owners sharing a name, complete-empty/legacy/malformed/capped receipts, incomplete candidate inventory, prototype-shaped keys, replay reconciliation and deletion. Extend `impact-epistemic-lower-bound.test.ts` and `mcp-response-filter.test.ts`; add `java-overload-impact-persistence.test.ts` using real analysis and reopened metadata/backend. Assert zero and nonzero known callers both retain boundaries; multi-hop ambiguity; two reached candidates sharing one site count once; class versus unrelated same-file class; downstream root/reached caller; depth limits, pagination and summary-only; heritage probe failure preserving overload causes.

Cache validation must use a built current worker, show a real cold parse, warm worker-result reuse and durable ParsedFile reuse, and assert identical edges/uncertainty after reopening. `parsedfile-store.test.ts` provides side-channel round-trip coverage; `parse-cache-identity-lifecycle.test.ts:256–267` demonstrates cold/warm fact assertions. Test long-lived process clearing and corrected/deleted source removing old boundaries.

Commands (from `gitnexus/`; new paths become runnable when added):

```sh
npm run build
npm test -- test/unit/scope-resolution/java test/unit/scope-resolution/overload-narrowing.test.ts test/unit/scope-resolution/pick-implicit-this-overload.test.ts test/unit/scope-resolution/cpp/cpp-overload-ranking.test.ts test/unit/parsedfile-store.test.ts
npm test -- test/integration/resolvers/java.test.ts test/integration/resolvers/java-javac-overloads.test.ts test/integration/impact-epistemic-lower-bound.test.ts test/integration/java-overload-impact-persistence.test.ts
npm test -- test/unit/parse-cache-identity.test.ts test/unit/parse-cache-input-coverage.test.ts test/unit/mcp-response-filter.test.ts
npm test
npx tsc --noEmit
npm run typecheck:tests
```

Use the verified package scripts and required build prerequisites; target lbug test configuration according to current conventions. Run focused ESLint/Prettier on changed files. Do not expand tests repeatedly after a clean full run unless changes or failures justify it. Before each commit use `detect_changes(scope: all)` with a current graph; partial/truncated results are not clean. Final review compares against the freshly fetched main merge base and separately labels remaining local changes.

## 9. Risk and Impact Analysis

- **Shared integration risk:** `emitJavaScopeCaptures` and `epistemicFrom` have CRITICAL graph warnings; `computeEpistemicBoundary` is HIGH. The generic selector also has CRITICAL fan-out but is intentionally left unchanged. Fresh impacts and source audits are required before edits, particularly for UNKNOWN/anonymous rows.
- **Correctness risk:** early owner/arity pruning, singleton bypasses, constructor-inferred receiver types, erased generics and scalar ranking each can select wrong Java methods. Dedicated negative assertions and compiler fixtures address them.
- **API risk:** additive cause fields and unknown-coverage receipts must survive filtering and every result branch. Existing lower-bound causes retain their meanings. Old indexes may now correctly report unverified overload coverage and request reindexing.
- **Persistence risk:** missing facts, stale suppressed outcomes, warm-cache loss or incomplete publication can falsely restore exactness. No schema migration is planned; metadata coverage has explicit version/partial semantics and reload tests.
- **Performance risk:** bound AST fact extraction to one provider pass, memoize canonical type/member inventories within a workspace, and aggregate metadata once per impact request. Avoid whole-workspace scans per call, global inheritance closure per candidate, or per-node database completeness probes. Exercise a fixture with repeated calls/overloads to verify cache reuse and bounded summaries.
- **Scope:** CLI/core Java provider, necessary shared contracts/emission and metadata/backend, tests and behavior documentation only. No CI/release/security configuration, dependencies, unrelated languages, UI redesign or production publication. Preserve other work. The generic summary can record existing overload suppressions across providers without changing their resolution rules.

## 10. Files Expected to Change

Paths below are relative to `gitnexus/` unless stated otherwise. New files are proposals, not claims that symbols already exist.

| File(s) | Responsibility |
| --- | --- |
| `src/core/ingestion/languages/java/captures.ts`, `capture-side-channel.ts`, `scope-resolver.ts` | Scoped facts, lifecycle and provider integration. Change `java.ts`/`query.ts` only if extraction wiring needs it. |
| New `src/core/ingestion/languages/java/overload-resolution.ts`, `overload-argument-facts.ts` | Java types, candidate inventory, bounded library inference and phased selection. |
| `src/core/ingestion/scope-resolution/contract/scope-resolver.ts` | Explicit terminal result variants and unqualified-call entry point. |
| `src/core/ingestion/scope-resolution/passes/receiver-bound-calls.ts`, `free-call-fallback.ts`, `pipeline/run.ts` | Early hook invocation, terminal handling and outcome metadata. |
| `src/core/ingestion/scope-resolution/resolution-outcome.ts`, new `unresolved-overloads.ts` | Additive suppression facts and final-site completeness summary. |
| `src/storage/repo-meta.ts`, `src/core/run-analyze.ts` | Versioned metadata coverage and coherent persistence. |
| `src/mcp/local/local-backend.ts`, `src/mcp/tools.ts` | Traversal/context boundaries, cause units and reindex guidance. |
| Existing/new tests and original fixture named in §8 | JLS, regression, persistence, cache and API validation. |
| `../ARCHITECTURE.md` | Document provider selection and completeness ownership after implementation. |

Leave `overload-narrowing.ts`, receiver type normalization, generic worker serialization and graph DDL unchanged unless execution establishes a concrete necessity and reruns impact first.

## 11. Reusable Implementation Context

```json
{
  "implementation_context": {
    "task_summary": "Resolve Java same-arity overloads according to supported JLS semantics and persist honest candidate/caller/owner-aware impact completeness for issue #3789.",
    "acceptance_criteria": [
      "Original five-file fixture direct counts find(Collection<Long>)3, find(Long)1, resolve(String)1, resolve(Long)1, count(Req)2, count(Long,Req)1 in real persisted queries.",
      "Exact selection agrees with compiler for supported cases; unknown/ambiguous/inapplicable results never fall through to guessed calls.",
      "Preserve selected-signature runtime/interface fan-out and compile-time return typing.",
      "Overload omissions survive cold/warm/durable caches and reopened metadata; report boundaries across bounded BFS/class seeds/context/downstream without double counting.",
      "Current build, full core tests/type checks, compiler oracle, graph change analysis, independent reviews pass."
    ],
    "evidence_provenance": {
      "schema_version": 2,
      "head_commit": "f641342d1fcbfdcb764c5e478db0f69e6cea899a",
      "generated_plan_path": "docs/plans/2026-10-31-gitnexus-plan-java-overload-resolution-completeness.md",
      "global_dirty_digest": {
        "algorithm": "sha256",
        "canonicalization": "gitnexus-evidence-provenance-v2 NUL-framed UTF-8 records",
        "value": "fe1372d37f6331330609555663d0401e220db674133dd476415f0e50bc74003c"
      },
      "cited_path_manifest": [
        {
          "path": "AGENTS.md",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:6525593affddf3aff06d2e7e9d855505a5f5135dd8cb6d5f67a552e1ac5cf912",
          "index_digest": "sha256:6525593affddf3aff06d2e7e9d855505a5f5135dd8cb6d5f67a552e1ac5cf912",
          "worktree_digest": "sha256:6525593affddf3aff06d2e7e9d855505a5f5135dd8cb6d5f67a552e1ac5cf912",
          "untracked_digest": "absent"
        },
        {
          "path": "ARCHITECTURE.md",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:0e8030ecca2252d1b00d120e7ff0ef0fe7451be26e07831f0e865662e7c8120b",
          "index_digest": "sha256:0e8030ecca2252d1b00d120e7ff0ef0fe7451be26e07831f0e865662e7c8120b",
          "worktree_digest": "sha256:0e8030ecca2252d1b00d120e7ff0ef0fe7451be26e07831f0e865662e7c8120b",
          "untracked_digest": "absent"
        },
        {
          "path": "CONTRIBUTING.md",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:c149877030512c90bc2e8a9557c40d03ec8df0cb62f9a6c28a8e8c4f52de3265",
          "index_digest": "sha256:c149877030512c90bc2e8a9557c40d03ec8df0cb62f9a6c28a8e8c4f52de3265",
          "worktree_digest": "sha256:c149877030512c90bc2e8a9557c40d03ec8df0cb62f9a6c28a8e8c4f52de3265",
          "untracked_digest": "absent"
        },
        {
          "path": "GUARDRAILS.md",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:e04523426887f8597b28c7796f3fc7deb188e74653e9b5b377b75cdb7ed3d472",
          "index_digest": "sha256:e04523426887f8597b28c7796f3fc7deb188e74653e9b5b377b75cdb7ed3d472",
          "worktree_digest": "sha256:e04523426887f8597b28c7796f3fc7deb188e74653e9b5b377b75cdb7ed3d472",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus-shared/src/scope-resolution/parsed-file.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:888fd0ba7f061ebf4b678ff1468b7f40e12f7f493ba4e8af15ac9b3bc60ec680",
          "index_digest": "sha256:888fd0ba7f061ebf4b678ff1468b7f40e12f7f493ba4e8af15ac9b3bc60ec680",
          "worktree_digest": "sha256:888fd0ba7f061ebf4b678ff1468b7f40e12f7f493ba4e8af15ac9b3bc60ec680",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus-shared/src/scope-resolution/types.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:8cff742defa5b7a68d3e2a3cd0450bd26880509b74f4c2b90689238028e0a31f",
          "index_digest": "sha256:8cff742defa5b7a68d3e2a3cd0450bd26880509b74f4c2b90689238028e0a31f",
          "worktree_digest": "sha256:8cff742defa5b7a68d3e2a3cd0450bd26880509b74f4c2b90689238028e0a31f",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/package.json",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:397c5d4c8566655d42b89d138a6d9f705e33014b348868631f4746df7a06edcf",
          "index_digest": "sha256:397c5d4c8566655d42b89d138a6d9f705e33014b348868631f4746df7a06edcf",
          "worktree_digest": "sha256:397c5d4c8566655d42b89d138a6d9f705e33014b348868631f4746df7a06edcf",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/scripts/build.js",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:285013e6a1df8033a6a99f9dde813b7508f6396cc9c527c465a875c46fcd8113",
          "index_digest": "sha256:285013e6a1df8033a6a99f9dde813b7508f6396cc9c527c465a875c46fcd8113",
          "worktree_digest": "sha256:285013e6a1df8033a6a99f9dde813b7508f6396cc9c527c465a875c46fcd8113",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/ingestion/languages/java.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:f7d4cd50bb4ad2a3f4569cf56fd3fb71e131766a1042fa46df6d56020d44f231",
          "index_digest": "sha256:f7d4cd50bb4ad2a3f4569cf56fd3fb71e131766a1042fa46df6d56020d44f231",
          "worktree_digest": "sha256:f7d4cd50bb4ad2a3f4569cf56fd3fb71e131766a1042fa46df6d56020d44f231",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/ingestion/languages/java/arity-metadata.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:2dbbefd5b33b2b147bccccfdd9b974e689c82b32d6c11891b8d487d171c20e1f",
          "index_digest": "sha256:2dbbefd5b33b2b147bccccfdd9b974e689c82b32d6c11891b8d487d171c20e1f",
          "worktree_digest": "sha256:2dbbefd5b33b2b147bccccfdd9b974e689c82b32d6c11891b8d487d171c20e1f",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/ingestion/languages/java/capture-side-channel.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:bda486e73d63df1cc3a14a5b468a4f2723c8257e68ea44679807e98e279558ef",
          "index_digest": "sha256:bda486e73d63df1cc3a14a5b468a4f2723c8257e68ea44679807e98e279558ef",
          "worktree_digest": "sha256:bda486e73d63df1cc3a14a5b468a4f2723c8257e68ea44679807e98e279558ef",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/ingestion/languages/java/captures.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:65de2cb32515fb12ebf6f3c3f780ca08fc264c93af4ee3f53d0931eb994a17de",
          "index_digest": "sha256:65de2cb32515fb12ebf6f3c3f780ca08fc264c93af4ee3f53d0931eb994a17de",
          "worktree_digest": "sha256:65de2cb32515fb12ebf6f3c3f780ca08fc264c93af4ee3f53d0931eb994a17de",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/ingestion/languages/java/interpret.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:921ef2e2393350466b43a30c03d48a182fc2db36ef11dcb6f628db22c760b65d",
          "index_digest": "sha256:921ef2e2393350466b43a30c03d48a182fc2db36ef11dcb6f628db22c760b65d",
          "worktree_digest": "sha256:921ef2e2393350466b43a30c03d48a182fc2db36ef11dcb6f628db22c760b65d",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/ingestion/languages/java/query.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:c334cc73c0e9fa244b98ed8959509ea54e30dc60d8a5eb185b01f362899d147a",
          "index_digest": "sha256:c334cc73c0e9fa244b98ed8959509ea54e30dc60d8a5eb185b01f362899d147a",
          "worktree_digest": "sha256:c334cc73c0e9fa244b98ed8959509ea54e30dc60d8a5eb185b01f362899d147a",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/ingestion/languages/java/scope-resolver.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:e7a424a680b11b4899192a970b826b408a36fec8a1a2136ff82a171bfbfdaa69",
          "index_digest": "sha256:e7a424a680b11b4899192a970b826b408a36fec8a1a2136ff82a171bfbfdaa69",
          "worktree_digest": "sha256:e7a424a680b11b4899192a970b826b408a36fec8a1a2136ff82a171bfbfdaa69",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/ingestion/method-extractors/configs/jvm.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:63a0a275857b20461cd2db3b370b808d199c23791031c1b54f5f6824ad66b7ac",
          "index_digest": "sha256:63a0a275857b20461cd2db3b370b808d199c23791031c1b54f5f6824ad66b7ac",
          "worktree_digest": "sha256:63a0a275857b20461cd2db3b370b808d199c23791031c1b54f5f6824ad66b7ac",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/ingestion/pipeline.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:fecf8d7769794325c8c26a8d1eb3742897c48008f9a1631f564900aa0b7baa2d",
          "index_digest": "sha256:fecf8d7769794325c8c26a8d1eb3742897c48008f9a1631f564900aa0b7baa2d",
          "worktree_digest": "sha256:fecf8d7769794325c8c26a8d1eb3742897c48008f9a1631f564900aa0b7baa2d",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/ingestion/scope-resolution/contract/scope-resolver.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:52bcb5c04fa0d089e014b2d343d298ae9dd467cf66530395e02b02771b68816b",
          "index_digest": "sha256:52bcb5c04fa0d089e014b2d343d298ae9dd467cf66530395e02b02771b68816b",
          "worktree_digest": "sha256:52bcb5c04fa0d089e014b2d343d298ae9dd467cf66530395e02b02771b68816b",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/ingestion/scope-resolution/passes/free-call-fallback.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:9cedffc9fa82c7ad647d93f53d763670395bad4f8df0475b4ad7651e5e9904b7",
          "index_digest": "sha256:9cedffc9fa82c7ad647d93f53d763670395bad4f8df0475b4ad7651e5e9904b7",
          "worktree_digest": "sha256:9cedffc9fa82c7ad647d93f53d763670395bad4f8df0475b4ad7651e5e9904b7",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/ingestion/scope-resolution/passes/overload-narrowing.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:ac2b872830362071134eae7f4d728a9517df03de86b95a18f785732421f60064",
          "index_digest": "sha256:ac2b872830362071134eae7f4d728a9517df03de86b95a18f785732421f60064",
          "worktree_digest": "sha256:ac2b872830362071134eae7f4d728a9517df03de86b95a18f785732421f60064",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/ingestion/scope-resolution/passes/receiver-bound-calls.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:cdab44f78d60a6fc059f38621c4eb17097be60ab432610a8437c347d13e6bb69",
          "index_digest": "sha256:cdab44f78d60a6fc059f38621c4eb17097be60ab432610a8437c347d13e6bb69",
          "worktree_digest": "sha256:cdab44f78d60a6fc059f38621c4eb17097be60ab432610a8437c347d13e6bb69",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/ingestion/scope-resolution/pipeline/phase.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:b88eb799691907a59ddebf4d00161e7e40eb2ce1cda7b3a9fa19adeb5964c758",
          "index_digest": "sha256:b88eb799691907a59ddebf4d00161e7e40eb2ce1cda7b3a9fa19adeb5964c758",
          "worktree_digest": "sha256:b88eb799691907a59ddebf4d00161e7e40eb2ce1cda7b3a9fa19adeb5964c758",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/ingestion/scope-resolution/pipeline/registry.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:94e7b03e3a961885bd4b733b92b94c4b5bcb95ceaf7145344b62d7fc232bfe20",
          "index_digest": "sha256:94e7b03e3a961885bd4b733b92b94c4b5bcb95ceaf7145344b62d7fc232bfe20",
          "worktree_digest": "sha256:94e7b03e3a961885bd4b733b92b94c4b5bcb95ceaf7145344b62d7fc232bfe20",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/ingestion/scope-resolution/pipeline/run.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:fcb21753c21bd3be519525a8afdd364ca7dec68edad9856df624c54afcbd4c12",
          "index_digest": "sha256:fcb21753c21bd3be519525a8afdd364ca7dec68edad9856df624c54afcbd4c12",
          "worktree_digest": "sha256:fcb21753c21bd3be519525a8afdd364ca7dec68edad9856df624c54afcbd4c12",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/ingestion/scope-resolution/resolution-outcome.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:de9c230c9a23b2f917c0096ccd06f21307ff6d6dd919d3666a28a931c437bfd7",
          "index_digest": "sha256:de9c230c9a23b2f917c0096ccd06f21307ff6d6dd919d3666a28a931c437bfd7",
          "worktree_digest": "sha256:de9c230c9a23b2f917c0096ccd06f21307ff6d6dd919d3666a28a931c437bfd7",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/ingestion/scope-resolution/unresolved-receivers.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:811ea3e6da418fb2700df5bf2185c2d828b1979482dbe2c6769293f3835061f6",
          "index_digest": "sha256:811ea3e6da418fb2700df5bf2185c2d828b1979482dbe2c6769293f3835061f6",
          "worktree_digest": "sha256:811ea3e6da418fb2700df5bf2185c2d828b1979482dbe2c6769293f3835061f6",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/ingestion/workers/parse-worker.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:91eb409fe02f56d4bdd76a5ff2667454f13bbf30e79ac896ca784d41ddc5b40b",
          "index_digest": "sha256:91eb409fe02f56d4bdd76a5ff2667454f13bbf30e79ac896ca784d41ddc5b40b",
          "worktree_digest": "sha256:91eb409fe02f56d4bdd76a5ff2667454f13bbf30e79ac896ca784d41ddc5b40b",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/core/run-analyze.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:b755a7ec51a8a487fd4a5dfd1c1e6b8743b95a871f1d2473338b4f8f6ea90dd5",
          "index_digest": "sha256:b755a7ec51a8a487fd4a5dfd1c1e6b8743b95a871f1d2473338b4f8f6ea90dd5",
          "worktree_digest": "sha256:b755a7ec51a8a487fd4a5dfd1c1e6b8743b95a871f1d2473338b4f8f6ea90dd5",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/mcp/local/local-backend.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:8aa5c739428a672d22e39a4fe0fd72be9abd35fc3833f19bf8b2c6e2a2b36dcb",
          "index_digest": "sha256:8aa5c739428a672d22e39a4fe0fd72be9abd35fc3833f19bf8b2c6e2a2b36dcb",
          "worktree_digest": "sha256:8aa5c739428a672d22e39a4fe0fd72be9abd35fc3833f19bf8b2c6e2a2b36dcb",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/mcp/tools.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:25255bd5221b8d3ed83d5506dbc55d77abb9a0283e54b4375f565925761f0d35",
          "index_digest": "sha256:25255bd5221b8d3ed83d5506dbc55d77abb9a0283e54b4375f565925761f0d35",
          "worktree_digest": "sha256:25255bd5221b8d3ed83d5506dbc55d77abb9a0283e54b4375f565925761f0d35",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/storage/parsedfile-store.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:e5c6c53ac659a771578ea3b41320037ae36c7e6b886730441cb031d642b83870",
          "index_digest": "sha256:e5c6c53ac659a771578ea3b41320037ae36c7e6b886730441cb031d642b83870",
          "worktree_digest": "sha256:e5c6c53ac659a771578ea3b41320037ae36c7e6b886730441cb031d642b83870",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/src/storage/repo-meta.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:1fd29de696da92b0379341d1825de7b946c20ed4e20b341f2368f19213b46e78",
          "index_digest": "sha256:1fd29de696da92b0379341d1825de7b946c20ed4e20b341f2368f19213b46e78",
          "worktree_digest": "sha256:1fd29de696da92b0379341d1825de7b946c20ed4e20b341f2368f19213b46e78",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/integration/impact-epistemic-lower-bound.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:1e200d5c4669ae825a97de765243077b34c40e5a8663a487e71745f389a2dcb1",
          "index_digest": "sha256:1e200d5c4669ae825a97de765243077b34c40e5a8663a487e71745f389a2dcb1",
          "worktree_digest": "sha256:1e200d5c4669ae825a97de765243077b34c40e5a8663a487e71745f389a2dcb1",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/integration/impact-scope-omission-persistence.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:e1500790b0598f09ad41b50443cc9d3e41f7c2d2c09fe84fd3a97a08df3a2bb1",
          "index_digest": "sha256:e1500790b0598f09ad41b50443cc9d3e41f7c2d2c09fe84fd3a97a08df3a2bb1",
          "worktree_digest": "sha256:e1500790b0598f09ad41b50443cc9d3e41f7c2d2c09fe84fd3a97a08df3a2bb1",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/integration/parse-cache-identity-lifecycle.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:bc0b2ab005e785dd7d2dfcbe7f273d3aedc2e123e249142a00bf141f68d370f4",
          "index_digest": "sha256:bc0b2ab005e785dd7d2dfcbe7f273d3aedc2e123e249142a00bf141f68d370f4",
          "worktree_digest": "sha256:bc0b2ab005e785dd7d2dfcbe7f273d3aedc2e123e249142a00bf141f68d370f4",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/integration/resolvers/java-javac-local-types.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:de36107fabfd3275a3d0ef938d7f4afa7017d06595c71ec27b9b472ede2a8f22",
          "index_digest": "sha256:de36107fabfd3275a3d0ef938d7f4afa7017d06595c71ec27b9b472ede2a8f22",
          "worktree_digest": "sha256:de36107fabfd3275a3d0ef938d7f4afa7017d06595c71ec27b9b472ede2a8f22",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/integration/resolvers/java.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:97b6113b6295559c9004b744043db8e678240edfc24af1815904090451e23785",
          "index_digest": "sha256:97b6113b6295559c9004b744043db8e678240edfc24af1815904090451e23785",
          "worktree_digest": "sha256:97b6113b6295559c9004b744043db8e678240edfc24af1815904090451e23785",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/unit/mcp-response-filter.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:0bb27bc93b52f24395f9148003da7ab00aed2c161e4bf0866897acc71723ad96",
          "index_digest": "sha256:0bb27bc93b52f24395f9148003da7ab00aed2c161e4bf0866897acc71723ad96",
          "worktree_digest": "sha256:0bb27bc93b52f24395f9148003da7ab00aed2c161e4bf0866897acc71723ad96",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/unit/parse-cache-identity.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:9257ef0d3131ca308fa760bda467066e47e1c48f272fd279dfe695a369e16247",
          "index_digest": "sha256:9257ef0d3131ca308fa760bda467066e47e1c48f272fd279dfe695a369e16247",
          "worktree_digest": "sha256:9257ef0d3131ca308fa760bda467066e47e1c48f272fd279dfe695a369e16247",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/unit/parse-cache-input-coverage.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:e3271f023bdfa7c7311fc4dac1fc0a514debe3190fb4f2014bc534666e2ba995",
          "index_digest": "sha256:e3271f023bdfa7c7311fc4dac1fc0a514debe3190fb4f2014bc534666e2ba995",
          "worktree_digest": "sha256:e3271f023bdfa7c7311fc4dac1fc0a514debe3190fb4f2014bc534666e2ba995",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/unit/parsedfile-store.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:a2714354b2afe14e0d4733c628fe25df753f697d8ced99f2eea405681224aaaf",
          "index_digest": "sha256:a2714354b2afe14e0d4733c628fe25df753f697d8ced99f2eea405681224aaaf",
          "worktree_digest": "sha256:a2714354b2afe14e0d4733c628fe25df753f697d8ced99f2eea405681224aaaf",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/unit/scope-resolution/cpp/cpp-overload-ranking.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:ee8616560767b3bcf1dae89f877bfbf2a27a54c5555dedcdf63d767182688cf8",
          "index_digest": "sha256:ee8616560767b3bcf1dae89f877bfbf2a27a54c5555dedcdf63d767182688cf8",
          "worktree_digest": "sha256:ee8616560767b3bcf1dae89f877bfbf2a27a54c5555dedcdf63d767182688cf8",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/unit/scope-resolution/java/java-captures.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:8251e35386219170baf7bb8ce144b7cf72a4f8ea594a58da8ecfdcf3788fddd1",
          "index_digest": "sha256:8251e35386219170baf7bb8ce144b7cf72a4f8ea594a58da8ecfdcf3788fddd1",
          "worktree_digest": "sha256:8251e35386219170baf7bb8ce144b7cf72a4f8ea594a58da8ecfdcf3788fddd1",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/unit/scope-resolution/overload-narrowing.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:224b0fdaf608bbcaa60be82bb1f01804eafbe2770820f34305c7b9a909350444",
          "index_digest": "sha256:224b0fdaf608bbcaa60be82bb1f01804eafbe2770820f34305c7b9a909350444",
          "worktree_digest": "sha256:224b0fdaf608bbcaa60be82bb1f01804eafbe2770820f34305c7b9a909350444",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/unit/scope-resolution/pick-implicit-this-overload.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:6356fdfc2172884ef44c89a2d20bec2f8f7e541097e50910495c8265f59d7ee5",
          "index_digest": "sha256:6356fdfc2172884ef44c89a2d20bec2f8f7e541097e50910495c8265f59d7ee5",
          "worktree_digest": "sha256:6356fdfc2172884ef44c89a2d20bec2f8f7e541097e50910495c8265f59d7ee5",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/test/unit/scope-resolution/unresolved-receivers.test.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:71bb2a40ca4dc9fe47c804c088aa6d4d2b46f248907e3778710308f0c5f21e12",
          "index_digest": "sha256:71bb2a40ca4dc9fe47c804c088aa6d4d2b46f248907e3778710308f0c5f21e12",
          "worktree_digest": "sha256:71bb2a40ca4dc9fe47c804c088aa6d4d2b46f248907e3778710308f0c5f21e12",
          "untracked_digest": "absent"
        },
        {
          "path": "gitnexus/vitest.config.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:875f66754aff2e0caf6387952554bee097ce4ee16e39eefb6aeb0b3ec169a194",
          "index_digest": "sha256:875f66754aff2e0caf6387952554bee097ce4ee16e39eefb6aeb0b3ec169a194",
          "worktree_digest": "sha256:875f66754aff2e0caf6387952554bee097ce4ee16e39eefb6aeb0b3ec169a194",
          "untracked_digest": "absent"
        }
      ]
    },
    "primary_symbols": [
      {
        "symbol": "emitJavaScopeCaptures",
        "file": "gitnexus/src/core/ingestion/languages/java/captures.ts",
        "lines": "381-411,817-910,935+",
        "role": "capture scoped Java argument evidence; current receiver maps must not become overload semantics"
      },
      {
        "symbol": "ScopeResolver.resolveReceiverMember",
        "file": "gitnexus/src/core/ingestion/scope-resolution/contract/scope-resolver.ts",
        "lines": "320-322,1651-1668",
        "role": "existing pre-MRO provider boundary and additive terminal result contract"
      },
      {
        "symbol": "emitFreeCallFallback",
        "file": "gitnexus/src/core/ingestion/scope-resolution/passes/free-call-fallback.ts",
        "lines": "381,497-544,1375-1454",
        "role": "invoke Java unqualified selection before own/ancestor pruning and first-match fallback"
      },
      {
        "symbol": "computeEpistemicBoundary",
        "file": "gitnexus/src/mcp/local/local-backend.ts",
        "lines": "8214-8390",
        "role": "merge direct context/target causes across normal/error paths"
      },
      {
        "symbol": "_runImpactBFS",
        "file": "gitnexus/src/mcp/local/local-backend.ts",
        "lines": "8481-8519,8580-8634,8703,8750-8756,8849-8868,9358",
        "role": "aggregate overload omissions for actually expanded identities and structural owner seeds before pagination"
      }
    ],
    "related_symbols": [
      {
        "symbol": "resolveVarTypeBindings",
        "relationship": "CALLS",
        "relevance": "capture-time global map excludes formal parameters; preserve receiver responsibilities"
      },
      {
        "symbol": "inferArgType",
        "relationship": "CALLS",
        "relevance": "suffix and unsupported-expression handling"
      },
      {
        "symbol": "javaScopeResolver",
        "relationship": "registration",
        "relevance": "provider hook ownership; source registry confirms use despite UNKNOWN graph"
      },
      {
        "symbol": "JavaCaptureSideChannel",
        "relationship": "serialization",
        "relevance": "plain provider-private call evidence"
      },
      {
        "symbol": "collectJavaCaptureSideChannel",
        "relationship": "provider-hook",
        "relevance": "worker snapshot; UNKNOWN graph requires source audit"
      },
      {
        "symbol": "applyJavaCaptureSideChannel",
        "relationship": "provider-hook",
        "relevance": "restore/validate per-file evidence without AST"
      },
      {
        "symbol": "clearJavaClassAnnotationFacts",
        "relationship": "lifecycle",
        "relevance": "clear new fact maps with existing workspace facts"
      },
      {
        "symbol": "emitReceiverBoundCalls",
        "relationship": "CALLS",
        "relevance": "consume terminal result and preserve post-selection dispatch"
      },
      {
        "symbol": "pickImplicitThisOverload",
        "relationship": "CALLS",
        "relevance": "existing per-owner behavior cannot represent Java inventory"
      },
      {
        "symbol": "narrowOverloadCandidates",
        "relationship": "related implementation",
        "relevance": "leave unchanged; CRITICAL existing fan-out"
      },
      {
        "symbol": "recordReceiverOverloadSuppression",
        "relationship": "diagnostics",
        "relevance": "existing candidate metadata; reuse authoritative result rather than recompute"
      },
      {
        "symbol": "ResolutionOutcome",
        "relationship": "transport",
        "relevance": "add caller/owner/inventory coverage and final-site reconciliation"
      },
      {
        "symbol": "runFullAnalysisInner",
        "relationship": "persistence",
        "relevance": "stamp overload summary alongside receiver summary; UNKNOWN graph"
      },
      {
        "symbol": "RepoMeta",
        "relationship": "persisted contract",
        "relevance": "versioned complete/partial/missing receipt"
      },
      {
        "symbol": "epistemicFrom",
        "relationship": "CALLS",
        "relevance": "additive cause must survive all aggregation paths; CRITICAL"
      },
      {
        "symbol": "_contextImpl",
        "relationship": "CALLS",
        "relevance": "incoming/outgoing completeness integration"
      },
      {
        "symbol": "_impactImpl",
        "relationship": "CALLS",
        "relevance": "name lookup caller of BFS"
      },
      {
        "symbol": "impactByUid",
        "relationship": "CALLS",
        "relevance": "UID caller of BFS"
      },
      {
        "symbol": "persistParsedFileShardSync",
        "relationship": "cache transport",
        "relevance": "already persists entire side-channel; no serializer changes expected"
      }
    ],
    "execution_path": [
      "Java provider emits scoped argument and expression evidence once during capture.",
      "Existing captureSideChannel transports plain facts across workers/durable ParsedFile caches, then Java provider restores them.",
      "Provider determines compile-time owner and full eligible overload inventory before generic owner pruning.",
      "Java performs strict/loose/varargs applicability and pairwise specificity with bounded candidate-specific factory inference.",
      "Shared emission honors all handled outcomes, preserves selected-signature dispatch/return typing, and records final suppression identities.",
      "Analyzer summarizes unresolved sites into versioned candidate/caller/owner metadata; publish with graph generation.",
      "Backend merges matching unresolved sites for direct context and expanded impact frontier, preserving partial/legacy coverage and existing causes."
    ],
    "pdg_constraints": [],
    "architectural_patterns": [
      {
        "pattern": "Language-owned semantics behind ScopeResolver/LanguageProvider",
        "example_location": "gitnexus/src/core/ingestion/scope-resolution/contract/scope-resolver.ts:1651",
        "usage_guidance": "Reuse pre-MRO receiver hook and add minimal unqualified counterpart; no Java names in shared ingestion."
      },
      {
        "pattern": "Opaque provider capture side-channel",
        "example_location": "gitnexus-shared/src/scope-resolution/parsed-file.ts:89",
        "usage_guidance": "Plain serializable facts; collect/apply/clear lifecycle; preserve generic store."
      },
      {
        "pattern": "Explicit completeness metadata receipt",
        "example_location": "gitnexus/src/storage/repo-meta.ts:352",
        "usage_guidance": "Separate overload omissions from receiverTyping; absent is unverified, not clean."
      }
    ],
    "files_to_modify": [
      {
        "file": "gitnexus/src/core/ingestion/languages/java/captures.ts",
        "symbols": [
          "emitJavaScopeCaptures",
          "resolveVarTypeBindings",
          "inferArgType"
        ],
        "intended_change": "Lossless lexically scoped overload facts; preserve receiver inference."
      },
      {
        "file": "gitnexus/src/core/ingestion/languages/java/capture-side-channel.ts",
        "symbols": [
          "JavaCaptureSideChannel",
          "collectJavaCaptureSideChannel",
          "applyJavaCaptureSideChannel",
          "clearJavaClassAnnotationFacts"
        ],
        "intended_change": "Transport and reset bounded per-site evidence."
      },
      {
        "file": "gitnexus/src/core/ingestion/languages/java/scope-resolver.ts",
        "symbols": [
          "javaScopeResolver"
        ],
        "intended_change": "Register Java receiver/unqualified overload decisions."
      },
      {
        "file": "gitnexus/src/core/ingestion/languages/java/overload-resolution.ts",
        "symbols": [
          "new Java-private selector"
        ],
        "intended_change": "Complete eligible inventory, JLS phases/specificity and conservative unknowns."
      },
      {
        "file": "gitnexus/src/core/ingestion/languages/java/overload-argument-facts.ts",
        "symbols": [
          "new Java-private argument evidence"
        ],
        "intended_change": "Canonical types, lexical bindings and supported poly factory descriptors."
      },
      {
        "file": "gitnexus/src/core/ingestion/scope-resolution/contract/scope-resolver.ts",
        "symbols": [
          "ScopeResolver",
          "ReceiverMemberResolution"
        ],
        "intended_change": "Terminal outcome variants and optional early unqualified hook."
      },
      {
        "file": "gitnexus/src/core/ingestion/scope-resolution/passes/receiver-bound-calls.ts",
        "symbols": [
          "emitReceiverBoundCalls",
          "recordReceiverOverloadSuppression"
        ],
        "intended_change": "Terminal provider result, precise diagnostic identities, preserved post-selection dispatch."
      },
      {
        "file": "gitnexus/src/core/ingestion/scope-resolution/passes/free-call-fallback.ts",
        "symbols": [
          "emitFreeCallFallback",
          "pickImplicitThisOverload"
        ],
        "intended_change": "Run provider boundary before legacy owner pruning; do not lose unknown/ambiguous outcomes."
      },
      {
        "file": "gitnexus/src/core/ingestion/scope-resolution/pipeline/run.ts",
        "symbols": [
          "runScopeResolution"
        ],
        "intended_change": "Forward optional hook and required context; preserve replay reconciliation."
      },
      {
        "file": "gitnexus/src/core/ingestion/scope-resolution/resolution-outcome.ts",
        "symbols": [
          "ResolutionOutcome",
          "ResolutionSuppressionReason"
        ],
        "intended_change": "Add callsite/caller/owner/coverage facts as needed."
      },
      {
        "file": "gitnexus/src/core/ingestion/scope-resolution/unresolved-overloads.ts",
        "symbols": [
          "new final-site summarizer"
        ],
        "intended_change": "Bounded unique-site candidate/caller/owner indexes and explicit coverage receipt."
      },
      {
        "file": "gitnexus/src/storage/repo-meta.ts",
        "symbols": [
          "RepoMeta"
        ],
        "intended_change": "Versioned overload completeness metadata."
      },
      {
        "file": "gitnexus/src/core/run-analyze.ts",
        "symbols": [
          "runFullAnalysisInner"
        ],
        "intended_change": "Recompute and coherently persist overload coverage."
      },
      {
        "file": "gitnexus/src/mcp/local/local-backend.ts",
        "symbols": [
          "EpistemicCauses",
          "epistemicFrom",
          "computeEpistemicBoundary",
          "_runImpactBFS"
        ],
        "intended_change": "Add cause, direct context matching, bounded-frontier aggregation and owner-aware class handling."
      },
      {
        "file": "gitnexus/src/mcp/tools.ts",
        "symbols": [
          "impact/context descriptions"
        ],
        "intended_change": "Document cause units, unknown coverage and reindex remedy."
      },
      {
        "file": "ARCHITECTURE.md",
        "symbols": [],
        "intended_change": "Document final provider selection and uncertainty ownership."
      }
    ],
    "tests": [
      {
        "file": "gitnexus/test/fixtures/lang-resolution/java-overload-types/",
        "scenarios": [
          "New original five-file issue fixture; exact6 overload/control counts."
        ]
      },
      {
        "file": "gitnexus/test/unit/scope-resolution/java/java-overload-resolution.test.ts",
        "scenarios": [
          "New JLS phase/specificity/null/array/generic/unknown tests; new selector not existing symbol."
        ]
      },
      {
        "file": "gitnexus/test/unit/scope-resolution/java/java-captures.test.ts",
        "scenarios": [
          "Parameters, scope shadowing, suffixes, preserved generic/qualified/array types, poly factories."
        ]
      },
      {
        "file": "gitnexus/test/integration/resolvers/java.test.ts",
        "scenarios": [
          "Original counts/UIDs, worker path, inherited inventory, declared receiver, interface signature fan-out and chain return type."
        ]
      },
      {
        "file": "gitnexus/test/integration/resolvers/java-javac-overloads.test.ts",
        "scenarios": [
          "New real compiler oracle: selected descriptors/markers; ambiguity and inapplicability errors; actual run required."
        ]
      },
      {
        "file": "gitnexus/test/unit/scope-resolution/unresolved-overloads.test.ts",
        "scenarios": [
          "New final-site dedup/replay; candidate/caller/owner identity; all receipt states/caps/malformed inputs."
        ]
      },
      {
        "file": "gitnexus/test/integration/impact-epistemic-lower-bound.test.ts",
        "scenarios": [
          "Unique omission counts, multi-hop upstream, downstream, class ownership, depth/pagination/summary-only/error branches."
        ]
      },
      {
        "file": "gitnexus/test/integration/java-overload-impact-persistence.test.ts",
        "scenarios": [
          "New real analyze/reopen; original counts; cold/warm worker/durable parity; correction/deletion clears stale boundaries."
        ]
      },
      {
        "file": "gitnexus/test/unit/parsedfile-store.test.ts",
        "scenarios": [
          "Java argument side-channel round-trip and malformed/missing reset tests where appropriate."
        ]
      },
      {
        "file": "gitnexus/test/unit/mcp-response-filter.test.ts",
        "scenarios": [
          "Preserve additive cause and unknown coverage information."
        ]
      },
      {
        "file": "gitnexus/test/unit/scope-resolution/overload-narrowing.test.ts",
        "scenarios": [
          "Unchanged generic ranking regression guard."
        ]
      },
      {
        "file": "gitnexus/test/unit/scope-resolution/pick-implicit-this-overload.test.ts",
        "scenarios": [
          "Preserve non-Java behavior and terminal provider boundary."
        ]
      },
      {
        "file": "gitnexus/test/unit/scope-resolution/cpp/cpp-overload-ranking.test.ts",
        "scenarios": [
          "Other-provider regression guard."
        ]
      },
      {
        "file": "gitnexus/test/unit/parse-cache-identity.test.ts",
        "scenarios": [
          "Required parser input identity guard."
        ]
      },
      {
        "file": "gitnexus/test/unit/parse-cache-input-coverage.test.ts",
        "scenarios": [
          "Required new-import/input ownership guard."
        ]
      }
    ],
    "verification_commands": [
      "cd gitnexus && npm run build",
      "cd gitnexus && npm test -- test/unit/scope-resolution/java test/unit/scope-resolution/overload-narrowing.test.ts test/unit/scope-resolution/pick-implicit-this-overload.test.ts test/unit/scope-resolution/cpp/cpp-overload-ranking.test.ts test/unit/parsedfile-store.test.ts",
      "cd gitnexus && npm test -- test/integration/resolvers/java.test.ts test/integration/resolvers/java-javac-overloads.test.ts test/integration/impact-epistemic-lower-bound.test.ts test/integration/java-overload-impact-persistence.test.ts",
      "cd gitnexus && npm test -- test/unit/parse-cache-identity.test.ts test/unit/parse-cache-input-coverage.test.ts test/unit/mcp-response-filter.test.ts",
      "cd gitnexus && npm test",
      "cd gitnexus && npx tsc --noEmit",
      "cd gitnexus && npm run typecheck:tests",
      "Run impact before each edited function/class; detect_changes(scope:all) before every commit; reject partial/truncated receipt.",
      "Final GitNexus review on isolated branch against fetched origin/main merge base, plus separately labeled local changes if any."
    ],
    "risks": [
      "CRITICAL emitJavaScopeCaptures and epistemicFrom; HIGH computeEpistemicBoundary; current graph UNKNOWN/anonymous rows unresolved. Generic narrowOverloadCandidates CRITICAL is deliberately not modified.",
      "JLS correctness depends on complete compile-time inventory before filtering and preserving generic arguments/phase ordering.",
      "New provider resolved path must preserve existing interface/virtual expansion and return typing.",
      "Metadata and cached argument evidence can silently lose coverage; explicit receipts and lifecycle tests required.",
      "Budget metadata, memoize type/inventory lookups and use one in-memory BFS completeness aggregation."
    ],
    "assumptions": [
      "Reproduce issue on a built current analyzer before edits; planning did not run baseline tests.",
      "Re-anchor evidence in isolated topic checkout from freshly fetched main; reread changed cited ranges and preserve root untracked work.",
      "Provision JDK and record/run javac oracle; absent PATH compiler is a verified current limitation.",
      "Verify existing analyzer publication atomically associates additive metadata with graph generation using real reload tests.",
      "Verify declared receiver identity and inherited inventory with Base/Sub fixtures; otherwise preserve unknown."
    ],
    "open_questions": [
      "Executor must rebuild/reindex: npm analyzer provenance is unverified, no PDG exists, and anonymous graph dependencies cannot establish complete blast radius.",
      "Audit compound/this/super/static-import call routing for bypasses before claiming Java outcomes authoritative.",
      "Confirm bounded source-generic substitution support; unsupported generic/capture/inference paths remain unknown with boundaries."
    ],
    "avoid": [
      "Do not repeat full repository discovery; use cited evidence and drift checks.",
      "Do not edit root unrelated CI work or untracked .serena/.headroom marker.",
      "Do not add Java names or JDK rules to shared ingestion.",
      "Do not implement Java selection with exact-string/aggregate scores or first-match fallback.",
      "Do not use receiver-unwrapped rawName as overload argument type.",
      "Do not freeze nested poly factories to List<Long> independent of candidate target.",
      "Do not add speculative ordinary CALLS to all candidates.",
      "Do not treat absent/partial metadata, empty graph caller sets or unavailable PDG as complete evidence.",
      "Do not change generic selector, graph DDL, worker serializer, dependencies, CI or release configuration without demonstrated necessity.",
      "Do not claim compiler validation from a skipped javac test."
    ]
  }
}
```

## 12. Assumptions and Open Questions

- [assumed] The issue remains reproducible on the current built analyzer; verify the exact fixture before implementation. The issue report is evidence of observed 1.6.12 behavior, not a baseline test run in this planning session.
- [verified] No JDK is on this environment's PATH. Provision a JDK during execution, record its version and run the oracle. No tests or compiler checks have been run during planning.
- [verified] Root is on unrelated `fix/ci-timing-download-retries` with untracked `.claude/.headroom_wrap_marker.json` and `.serena/`. Preserve these; use an isolated topic checkout. Fetch/re-anchor belongs to execution, not this planning run.
- [assumed] Existing metadata publication can carry the additive summary atomically with graph generation. Verify clean, incremental and reopen paths before relying on it. Any cap or unsupported/missing identity must produce partial coverage.
- [assumed] Receiver type facts can recover declared compile-time identity; test Base-typed/Sub-initialized receivers and use provider-owned declared evidence. If proof is unavailable, record unknown rather than select from a runtime-subtype guess.
- Open execution check: existing hooks do not cover every compound/super/static-import path. Audit those paths against the centralized Java result. Extend neutral hook routing only where required; never silently resume legacy first-match selection for an authoritative unknown.
- Open graph limitation: npm analyzer provenance, no PDG and anonymous/missing graph identities prevent a complete planning-time blast-radius claim. Build/reindex/recheck during work; do not downgrade UNKNOWN to LOW.
- Explicitly deferred: arbitrary generic method inference, wildcard capture/unchecked conversion, arbitrary external classpaths, lambdas/method references, mixed/empty/null factory inference outside proven support, and the reporter's separate enhanced-for receiver issue. Such inputs remain unresolved with an honest boundary. None of the original five-file fixture is deferred.
- No dependency, CI or release changes are assumed. No publication/push is part of the LFG pipeline itself.

## 13. Definition of Done

- Original fixture's six expected caller counts and exact target identities pass in resolver and persisted impact tests; control behavior is unchanged.
- Supported cases agree with a JDK compiler oracle; ambiguity/inapplicability/unknown never becomes an ordinary guessed call edge.
- Type/import/variable shadowing, inherited overloads, declared receiver type and target-typed factories have positive and negative regression coverage.
- Candidate/caller/owner-scoped omissions survive cold/warm/durable cache and reopen; multi-hop/class/downstream queries, pagination and depth bounds report coherent completeness.
- Missing/legacy/partial metadata never masquerades as measured-clean coverage; corrected/deleted source clears obsolete boundaries.
- Other providers retain behavior; current build, full core tests, type checks, focused cache guards and graph change analysis pass, with any environment limitation explicitly reported.
- Independent Java/JLS and shared-contract/adversarial review findings are addressed; final GitNexus review reports its exact SHA and verdict. No production-quality claim while mandatory checks or material findings remain open.
