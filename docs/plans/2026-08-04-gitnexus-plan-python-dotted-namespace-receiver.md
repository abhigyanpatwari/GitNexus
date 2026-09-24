# GitNexus Engineering Plan

> Task: Emit the missing `CALLS` edge for Python's unaliased multi-segment namespace import (`import pkg.db` + `pkg.db.session_scope()`), issue #2826.
> Evidence verified at commit b2cd1c2ad637657125248c0dd2046de71ceea965; GitNexus index 13 commits behind HEAD, refresh skipped: every cited path is byte-identical between the index commit (1ef6447e) and the pinned commit — verified by blob-id comparison, so no graph claim here rests on drifted content. PDG layer absent from this index (`MATCH ()-[r:CodeRelation {type:'CDG'}]->() RETURN count(r)` → 0); `--pdg` upgrade skipped, source reads substitute at higher evidence strength.
> Evidence provenance schema 2; global dirty digest 0912a3ee3219cb75c82aefbf9f010e8dbe313150d6553768fd55d22af87a135c; cited-path manifest 13 sorted entries; exact generated plan path excluded.

## 1. Objective

`import pkg.db` followed by `pkg.db.session_scope()` must emit a `CALLS` edge from the caller to `session_scope`, matching the three sibling import spellings that already resolve (`from pkg.db import session_scope`, `import pkg.db as pdb`, `from pkg import db`). Two same-package imports in one file (`import pkg.a` + `import pkg.b`) must not cross-resolve, and no shared file under `gitnexus/src/core/ingestion/` may name a language (AGENTS.md §42).

## 2. Current Behaviour

The failure is a **key/lookup mismatch inside one map**, not a missing resolution path.

For `import pkg.db`, `splitImportStmt` emits one match with `@import.source` = the whole `dotted_name` text `"pkg.db"` `[verified]` (`gitnexus/src/core/ingestion/languages/python/import-decomposer.ts:46-54`). `interpretPythonImport`'s `'plain'` arm then splits it `[verified]` (`gitnexus/src/core/ingestion/languages/python/interpret.ts:33-42`):

```ts
    case 'plain': {
      // `import numpy`
      if (sourceCap === undefined) return null;
      return {
        kind: 'namespace',
        localName: sourceCap.text.split('.')[0]!, // `import a.b.c` exposes `a`
        importedName: sourceCap.text,
        targetRaw: sourceCap.text,
      };
    }
```

`finalizeImportEdges` carries both halves onto the edge: `localName` verbatim, and `targetExportedName = parsed.importedName` for `kind === 'namespace'` `[verified]` (`gitnexus-shared/src/scope-resolution/finalize-algorithm.ts:398-406, 434-447`). So the finalized `ImportEdge` is `{ localName: 'pkg', targetExportedName: 'pkg.db', targetFile: 'pkg/db.py', kind: 'namespace' }`.

`collectNamespaceTargets` keys **only on `localName`** `[verified]` (`gitnexus/src/core/ingestion/scope-resolution/scope/namespace-targets.ts:44-57`), producing `{'pkg' → ['pkg/db.py']}`.

At the call site, Python's query binds the attribute's `object` field with a wildcard — `object: (_) @reference.receiver` `[verified]` (`gitnexus/src/core/ingestion/languages/python/query.ts:267-270`) — so for `pkg.db.session_scope()` the receiver node is the inner `attribute`, and `extractExplicitReceiver` takes its raw text `[verified]` (`gitnexus/src/core/ingestion/scope-extractor.ts:1235-1239`): `receiverName === 'pkg.db'`.

`emitReceiverBoundCalls` then walks its cases `[verified]` (`gitnexus/src/core/ingestion/scope-resolution/passes/receiver-bound-calls.ts:404-421, 546-655, 831-848`):

- **Case 0 (compound receiver)** fires because `receiverName.includes('.')` (line 563-567). It asks `resolveCompoundReceiverClass` for a **class**; `pkg.db` names a module, so it returns `undefined`, sets `compoundReceiverUnresolved = true`, and — critically — does **not** `handledSites.add`, so control falls through (lines 577, 622-655).
- **Case 1 (namespace receiver)** runs `namespaceTargets.get('pkg.db')` (line 832). The map holds `'pkg'`. Miss.
- **Case 1.5** needs `provider.resolveQualifiedReceiverMember`, implemented only by the C++ provider `[verified]` (`gitnexus/src/core/ingestion/languages/cpp/scope-resolver.ts:399-406`; `context` on that symbol shows one outgoing call to `resolveCppQualifiedNamespaceMember` and no other implementer). Python leaves it undefined, so the case is skipped.

No later case types a module receiver, so the site drops. Reproduced on both `origin/main` and PR #2810's head; PR #2810 changes Python receiver *typing* (`languages/python/receiver-binding.ts`) and does not touch this path `[verified]` by running the repro against both trees.

The three sibling spellings resolve because each binds a **single-segment** local name: `pdb` (alias arm), `session_scope` (named binding, not a receiver at all), and `db` (reclassified to `kind: 'namespace'` by #2770's `isNamespaceImport` hook, keying the map on `'db'`).

## 3. Relevant Architecture

`collectNamespaceTargets` is the shared, language-neutral bridge between finalized import edges and receiver resolution. Its contract note already states that `ImportEdge.kind === 'namespace'` is authoritative and that providers may reclassify into it — that reclassification hook (`isNamespaceImport`) is #2770's extension point `[verified]` (`gitnexus-shared/src/scope-resolution/finalize-algorithm.ts:99-107`).

Its output feeds three consumers, all per-file (`fileCompoundOpts`, `receiver-bound-calls.ts:405-406`):

1. `emitReceiverBoundCalls` Case 1 — namespace-receiver member calls (`receiver-bound-calls.ts:832`);
2. `resolveConstructionExpressionClass` — namespace-qualified construction `pkg.db.Model()` (`compound-receiver.ts:245-260`);
3. `resolveCompoundReceiverClass`'s namespace-qualified-constructor disambiguation `options.namespaceTargets?.has(objExpr)` (`compound-receiver.ts:759-766`).

AGENTS.md line 42 is the binding constraint: *"Shared code in `gitnexus/src/core/ingestion/` must not name languages — plug language behavior in via `LanguageProvider` / `ScopeResolver` hooks."* `[verified]`

## 4. GitNexus Findings

- `context({name: 'collectNamespaceTargets', repo: 'GitNexus'})` — `epistemic: "exact"`; incoming calls are exactly two: `emitReceiverBoundCalls` (`.../passes/receiver-bound-calls.ts`) and a test-local `build` in `test/unit/scope-resolution/python/python-module-namespace-construction.test.ts`. `[graph]` These are the d=1 dependents; the two `compound-receiver.ts` consumers reach the map by parameter rather than by call, so they do not appear here and were found by source grep `[verified]`.
- `context({name: 'resolveQualifiedReceiverMember', repo: 'GitNexus'})` — resolves to a single definition at `languages/cpp/scope-resolver.ts:399`, `outgoing.calls: [resolveCppQualifiedNamespaceMember]`, no incoming. `[graph]` Confirms the Case-1.5 hook is C++-only, matching the issue reporter's read of the published bundle.
- `cypher({statement: "MATCH ()-[r:CodeRelation {type: 'CDG'}]->() RETURN count(r)"})` — `| cdg_rows | 0 |`. `[graph]` The index carries no PDG layer; §5 is therefore empty by fact, not by omission.
- Related tests located by directory listing `[verified]`: `test/fixtures/lang-resolution/` already holds `python-module-import`, `python-bare-import`, `python-plain-import-alias`, `python-multi-segment-ancestor-import`, `python-function-local-namespace-import`, `python-class-body-namespace-import`, and #2770's `python-from-module-alias`. `test/integration/resolvers/python.test.ts` is the convention-matching home for the new assertions (#2770 added its coverage there, +38 lines).

## 5. Statement-Level PDG Findings

Empty by fact: the current index has zero `CDG` rows, so no statement-level slice exists to build. A `--pdg` re-index was deliberately not run — it is the largest fixed cost available to this session, the analyzer holds no writer lock against a live MCP server (#2658), and every constraint the slice would supply (which case gates the namespace lookup, whether Case 0's failure falls through) was read directly from source at higher evidence strength in §2.

## 6. Proposed Changes

### 6.1 `collectNamespaceTargets` — also key on the dotted access path

- **File:** `gitnexus/src/core/ingestion/scope-resolution/scope/namespace-targets.ts`
- **Symbol:** `collectNamespaceTargets` (source-verified)
- **Responsibility:** map every receiver spelling that names an imported module to that module's file(s).
- **Change:** inside the existing edge loop, after recording `edge.localName`, also record `edge.targetExportedName` **when it contains a dot and its first dot-separated segment equals `edge.localName`**. Same array-dedupe as the existing key.
- **Why this is language-neutral (AGENTS.md §42):** the condition names no language. It encodes one structural fact — *a namespace binding whose exported module name is a dotted path rooted at the local name is also reachable under that whole path.* Verified against every other namespace-emitting provider at the pinned commit `[verified]`:
  - TypeScript `import * as X from './y'` → `localName 'X'`, `importedName './y'`; first segment `''` ≠ `'X'` → no key (`languages/typescript/interpret.ts:77-81, 118-122`).
  - C# `using System.Collections.Generic` → `localName 'Generic'` (last segment), `importedName 'System.Collections.Generic'`; first segment `'System'` ≠ `'Generic'` → no key (`languages/csharp/interpret.ts:33-37, 62-66`).
  - Go / Rust / Ruby → `localName === importedName`, no dot → no key (`languages/{go,rust,ruby}/interpret.ts`).
  - Python `import pkg.db` → `'pkg' === 'pkg.db'.split('.')[0]` → key `'pkg.db'` added. This is the only provider the predicate admits today.
- **Constraint:** additive only. The existing `localName` key must keep its current value and ordering so no currently-resolving site changes target.
- **Two-package safety:** `import pkg.a` + `import pkg.b` in one file yields `{'pkg' → ['pkg/a.py','pkg/b.py'], 'pkg.a' → ['pkg/a.py'], 'pkg.b' → ['pkg/b.py']}`. Receiver `pkg.a` hits exactly one file; the ambiguous `'pkg'` bucket is only reachable by a receiver literally spelled `pkg`, which is unchanged from today. `[inferred]` — pinned by a test in §8.

### 6.2 `isNamespaceNameShadowed` — test the root segment, not the dotted path

- **File:** `gitnexus/src/core/ingestion/scope-resolution/passes/compound-receiver.ts`
- **Symbol:** `isNamespaceNameShadowed` (source-verified, lines 152-183) and its one call site at line 250.
- **Defect this fix activates:** the guard walks the scope chain looking for a binding, type binding, lexical name, or owned def **named exactly `namespaceName`**. With 6.1 in place, `namespaceName` can be `'pkg.db'`, but Python binds only `pkg` — so a local `pkg = something` that genuinely shadows the import would fail to suppress the namespace interpretation, and the "verified namespace is authoritative" branch (line 249-259) would return a wrong class instead of declining.
- **Change:** shadow-test the first dot-separated segment of `namespaceName` (identical behaviour for the single-segment names it sees today, since root === whole name).
- **Not scope creep:** 6.1 is what first routes a dotted name into this guard; shipping 6.1 without it introduces the false positive.

### 6.3 No change required in `receiver-bound-calls.ts`

Case 1's lookup already uses the full dotted `receiverName` and Case 0's failure already falls through to it (`receiver-bound-calls.ts:577, 622-655, 832`) `[verified]`. Recorded here so the executor does not "fix" a path that is already correct.

## 7. Implementation Sequence

1. **Add the failing fixture and assertions first.** Create `gitnexus/test/fixtures/lang-resolution/python-dotted-namespace-import/` (files in §8) and a `describe` block in `gitnexus/test/integration/resolvers/python.test.ts` following the file's existing `writeFixtureRepo` + `mkdtempSync` convention. Confirm the dotted row fails and all three control rows pass. Delete the scratch `gitnexus/test/integration/resolvers/repro-2826-python-dotted-import.test.ts` in this step — its content is superseded by the fixture-backed tests.
2. **Implement 6.1** in `namespace-targets.ts`, and update its header contract note to state that a namespace edge may be keyed both by its local name and by a dotted access path rooted at that name. Re-run the step-1 tests: the dotted row must flip to passing with the controls still green.
3. **Implement 6.2** in `compound-receiver.ts` with the shadowing test from §8 (a local `pkg = Decoy()` must suppress, not misresolve).
4. **Run the regression surface**: full resolver + scope-resolution integration suites, both packages' `tsc --noEmit`.
5. **Regenerate recorded baselines once, last.** Run each `--check` gate; regenerate only the baselines that actually moved (`bench/receiver-resolution/baseline.json` is the expected one — this change adds resolved edges). Per plan-template §7, this is deliberately the final step so intermediate commits do not churn and re-drift the artifacts.

## 8. Test Strategy

**New fixture** `gitnexus/test/fixtures/lang-resolution/python-dotted-namespace-import/`:

| file | contents |
| --- | --- |
| `pkg/__init__.py` | empty |
| `pkg/db.py` | `def session_scope(): ...` |
| `pkg/cache.py` | `def session_scope(): ...` — the decoy that makes cross-resolution detectable |
| `caller_dotted.py` | `import pkg.db` + `def uses_dotted(): return pkg.db.session_scope()` |
| `caller_from.py`, `caller_alias.py`, `caller_frommod.py` | the three sibling controls from the issue |
| `caller_two_pkgs.py` | `import pkg.db` **and** `import pkg.cache`, one function calling each |
| `caller_deep.py` | `import pkg.sub.deep` + `pkg.sub.deep.f()` (3-segment) |
| `caller_shadowed.py` | module-level `import pkg.db`, then a function with a local `pkg = Decoy()` before `pkg.db.session_scope()` |

**Scenarios** (input → action → expected):

1. `caller_dotted.py` → run pipeline → `CALLS` edge `uses_dotted` → `pkg/db.py:session_scope`, `reason: 'import-resolved'`. **This is the issue's acceptance row.**
2. The three sibling callers → same run → all three still resolve to `pkg/db.py:session_scope`. Regression control: a run where the controls also broke would prove nothing about row 1.
3. `caller_two_pkgs.py` → `pkg.db.session_scope()` resolves **only** to `pkg/db.py` and `pkg.cache.session_scope()` **only** to `pkg/cache.py`; assert the absence of the crossed pair explicitly, not just the presence of the right one.
4. `caller_deep.py` → 3-segment receiver resolves — proves the predicate is not hard-coded to two segments.
5. `caller_shadowed.py` → **no** edge from the shadowed function to `pkg/db.py` (6.2's guard). Fails loudly if 6.2 regresses.
6. Cross-language non-regression: the existing TypeScript / C# / Go namespace-import resolver tests must stay green unchanged — that is the executable proof the new key is not minted for them.

**Tests to update:** `gitnexus/test/integration/resolvers/python.test.ts` (add the describe block). `gitnexus/test/unit/scope-resolution/python/python-module-namespace-construction.test.ts` is a direct `collectNamespaceTargets` caller — re-run it; extend it only if its expectations enumerate map keys exhaustively.

**Verification commands** (each verified to exist in `gitnexus/package.json` / `.github/workflows/ci-tests.yml` at the pinned commit):

```bash
# from gitnexus/ — pretest:integration runs scripts/build.js, so the parse worker exists
GITNEXUS_WORKER_READY_TIMEOUT_MS=60000 npm run test:integration -- test/integration/resolvers/python.test.ts
GITNEXUS_WORKER_READY_TIMEOUT_MS=60000 npm run test:integration -- test/integration/resolvers
npm run test:unit -- test/unit/scope-resolution
npx tsc --noEmit                     # and the same in ../gitnexus-shared
node --import tsx bench/receiver-resolution/measure.mjs --check
node --import tsx bench/python-scope/measure.mjs --check
node --import tsx bench/python-scope/import-target-fingerprint.mjs --check
node --import tsx bench/scope-capture/measure.mjs --check
```

`GITNEXUS_WORKER_READY_TIMEOUT_MS=60000` is required on this host: the default 5000 ms worker-ready deadline fails as a crash-loop here (observed while reproducing the issue), which is environmental, not a code fault.

## 9. Risk and Impact Analysis

Accounting for every direct (d=1) dependent of the changed map:

| d=1 dependent | risk | mitigation |
| --- | --- | --- |
| `emitReceiverBoundCalls` Case 1 (`receiver-bound-calls.ts:832`) | New keys make previously-dropped sites resolve. A wrong target would be a *new* false edge. | The predicate admits only Python's `import a.b` shape; each new key maps to exactly one file per import statement. §8 scenario 3 pins non-crossing. |
| `resolveConstructionExpressionClass` (`compound-receiver.ts:245-260`) | `pkg.db.Model()` now takes the "verified namespace is authoritative" branch, which deliberately does **not** fall through on a miss or ambiguity — so a wrong key would convert a working heuristic resolution into a silent decline. | The branch requires `namespaceFiles.length > 0`, i.e. the import genuinely resolved. Ambiguity still returns `undefined` (`namespaceMatches.length === 1` guard). Shadowing is fixed by 6.2. |
| `resolveCompoundReceiverClass` namespace-constructor disambiguation (`compound-receiver.ts:759-766`) | `namespaceTargets.has(objExpr)` now true for dotted namespaces, routing `pkg.db.Model(x).run()` into the construction interpretation. | Correct by intent — that branch exists precisely to make a namespace-qualified bare constructor safe. Behaviour change, so §8 should include a construction row if the fixture's cost is low. |
| `test/unit/scope-resolution/python/python-module-namespace-construction.test.ts:build` | May assert exact map contents. | Re-run in step 4; extend rather than weaken if it enumerates keys. |
| C++ provider | Case 1 is skipped entirely for C++ (`provider.resolveQualifiedReceiverMember !== undefined`), but the two `compound-receiver.ts` consumers are **not** provider-gated. | C++ `#include` does not produce a `kind: 'namespace'` edge with a dotted `targetExportedName` rooted at its local name; the predicate declines. Covered by the existing C++ suites plus `bench/cpp-qualified-ns/measure.mjs --check`. |

**Recorded-artifact risk:** `bench/receiver-resolution/measure.mjs --check` gates both a shape matrix and a drop-count arm; new resolved edges are expected to move the count arm and the gate fails on drift. Regenerating in step 5 only (per §7) keeps intermediate commits clean. `bench/python-scope/*` and `bench/scope-capture/*` fingerprint captures and import-target resolution — neither is touched by this change, so a movement there is a signal to stop and investigate, not to regenerate.

**Performance:** one extra `Map.set` per multi-segment namespace import per file; the loop is already O(module import edges). No new traversal.

**No schema/version impact:** this changes what the resolver produces, not how it is stored. Existing indexes need a re-analyze to show the new edges — matching the note PR #2810 carried for the same reason.

## 10. Files Expected to Change

| File | Symbols | Reason |
| ---- | ------- | ------ |
| `gitnexus/src/core/ingestion/scope-resolution/scope/namespace-targets.ts` | `collectNamespaceTargets` | Add the dotted-access-path key (§6.1) and update the contract note |
| `gitnexus/src/core/ingestion/scope-resolution/passes/compound-receiver.ts` | `isNamespaceNameShadowed` | Shadow-test the root segment (§6.2) |
| `gitnexus/test/integration/resolvers/python.test.ts` | new `describe` block | Issue acceptance row + controls + regression rows |
| `gitnexus/test/fixtures/lang-resolution/python-dotted-namespace-import/**` | — | New fixture (§8) |
| `gitnexus/test/integration/resolvers/repro-2826-python-dotted-import.test.ts` | — | Delete; superseded by the fixture-backed tests |
| `gitnexus/bench/receiver-resolution/baseline.json` | — | Regenerate once, final step, only if `--check` moves |

## 11. Reusable Implementation Context

```yaml
implementation_context:
  task_summary: >
    Python `import pkg.db` + `pkg.db.session_scope()` emits no CALLS edge (#2826).
    Root cause: collectNamespaceTargets keys its map only on ImportEdge.localName
    ('pkg'), while the receiver text is the full dotted path ('pkg.db'). Fix by
    additionally keying on ImportEdge.targetExportedName when it is dotted and
    rooted at localName — a predicate no other provider satisfies — plus a
    root-segment fix to the shadow guard the new key first exposes.
  acceptance_criteria:
    - 'CALLS edge uses_dotted -> pkg/db.py:session_scope with reason import-resolved'
    - 'The three sibling spellings (from-import, alias, from-module-attr) still resolve'
    - 'import pkg.a + import pkg.b in one file do not cross-resolve'
    - 'A local binding shadowing the package root suppresses the namespace interpretation'
    - 'No shared file under gitnexus/src/core/ingestion/ names a language (AGENTS.md §42)'

  evidence_provenance:
    schema_version: 2
    head_commit: 'b2cd1c2ad637657125248c0dd2046de71ceea965'
    generated_plan_path: 'docs/plans/2026-08-04-gitnexus-plan-python-dotted-namespace-receiver.md'
    global_dirty_digest:
      algorithm: 'sha256'
      canonicalization: 'gitnexus-evidence-provenance-v2 NUL-framed UTF-8 records'
      value: '0912a3ee3219cb75c82aefbf9f010e8dbe313150d6553768fd55d22af87a135c'
    cited_path_manifest:
      - path: '.github/workflows/ci-tests.yml'
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:0f1fba71be1e2b026d1ca2d35934ffe197b26bd4d31d5e5025d1e797e89754ff'
        index_digest: 'sha256:0f1fba71be1e2b026d1ca2d35934ffe197b26bd4d31d5e5025d1e797e89754ff'
        worktree_digest: 'sha256:0f1fba71be1e2b026d1ca2d35934ffe197b26bd4d31d5e5025d1e797e89754ff'
        untracked_digest: 'absent'
      - path: 'AGENTS.md'
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:797b9d58a9c3dbed5af048904b3d3ba55ba6a2256a442fd15d35eb8b568cd1dd'
        index_digest: 'sha256:797b9d58a9c3dbed5af048904b3d3ba55ba6a2256a442fd15d35eb8b568cd1dd'
        worktree_digest: 'sha256:797b9d58a9c3dbed5af048904b3d3ba55ba6a2256a442fd15d35eb8b568cd1dd'
        untracked_digest: 'absent'
      - path: 'gitnexus-shared/src/scope-resolution/finalize-algorithm.ts'
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:9c3656484d8b5bd49394918446ab91c73db722e3fe2314fc08c9c284541c415b'
        index_digest: 'sha256:9c3656484d8b5bd49394918446ab91c73db722e3fe2314fc08c9c284541c415b'
        worktree_digest: 'sha256:9c3656484d8b5bd49394918446ab91c73db722e3fe2314fc08c9c284541c415b'
        untracked_digest: 'absent'
      - path: 'gitnexus-shared/src/scope-resolution/types.ts'
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:d9b0e9e0d47c10a71392ad8d0de31b08327c6268915488f1153c04cdc39fbdfc'
        index_digest: 'sha256:d9b0e9e0d47c10a71392ad8d0de31b08327c6268915488f1153c04cdc39fbdfc'
        worktree_digest: 'sha256:d9b0e9e0d47c10a71392ad8d0de31b08327c6268915488f1153c04cdc39fbdfc'
        untracked_digest: 'absent'
      - path: 'gitnexus/src/core/ingestion/languages/python/import-decomposer.ts'
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:97e28381e7d3f6040e5368d043d086ab2d3df24aad5e2bcb0c3da866a455a23e'
        index_digest: 'sha256:97e28381e7d3f6040e5368d043d086ab2d3df24aad5e2bcb0c3da866a455a23e'
        worktree_digest: 'sha256:97e28381e7d3f6040e5368d043d086ab2d3df24aad5e2bcb0c3da866a455a23e'
        untracked_digest: 'absent'
      - path: 'gitnexus/src/core/ingestion/languages/python/interpret.ts'
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:65ca96b207b89a86f44772f8f8ff8030acf06774214ddee67ef031db3d770419'
        index_digest: 'sha256:65ca96b207b89a86f44772f8f8ff8030acf06774214ddee67ef031db3d770419'
        worktree_digest: 'sha256:65ca96b207b89a86f44772f8f8ff8030acf06774214ddee67ef031db3d770419'
        untracked_digest: 'absent'
      - path: 'gitnexus/src/core/ingestion/languages/python/query.ts'
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:f9e145114aba978e34525c1ccb553ba37feea4152f882dc0e105dc8b21230d78'
        index_digest: 'sha256:f9e145114aba978e34525c1ccb553ba37feea4152f882dc0e105dc8b21230d78'
        worktree_digest: 'sha256:f9e145114aba978e34525c1ccb553ba37feea4152f882dc0e105dc8b21230d78'
        untracked_digest: 'absent'
      - path: 'gitnexus/src/core/ingestion/scope-extractor.ts'
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:34089a212075f16d8c270240c64985b0a666864547ed414449a59747e4922d80'
        index_digest: 'sha256:34089a212075f16d8c270240c64985b0a666864547ed414449a59747e4922d80'
        worktree_digest: 'sha256:34089a212075f16d8c270240c64985b0a666864547ed414449a59747e4922d80'
        untracked_digest: 'absent'
      - path: 'gitnexus/src/core/ingestion/scope-resolution/passes/compound-receiver.ts'
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:88a083a625449187fe770e992c580ec84d70ddb9f395f54949c1b85a29838f97'
        index_digest: 'sha256:88a083a625449187fe770e992c580ec84d70ddb9f395f54949c1b85a29838f97'
        worktree_digest: 'sha256:88a083a625449187fe770e992c580ec84d70ddb9f395f54949c1b85a29838f97'
        untracked_digest: 'absent'
      - path: 'gitnexus/src/core/ingestion/scope-resolution/passes/receiver-bound-calls.ts'
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:1873a19be4235b6882aab63422a0bc632192ac30407e60e7d5648aa70e5759c3'
        index_digest: 'sha256:1873a19be4235b6882aab63422a0bc632192ac30407e60e7d5648aa70e5759c3'
        worktree_digest: 'sha256:1873a19be4235b6882aab63422a0bc632192ac30407e60e7d5648aa70e5759c3'
        untracked_digest: 'absent'
      - path: 'gitnexus/src/core/ingestion/scope-resolution/scope/namespace-targets.ts'
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:54062a70276ec1761a94b6548499d265c91fd3b648422a8567a21e06d800e09d'
        index_digest: 'sha256:54062a70276ec1761a94b6548499d265c91fd3b648422a8567a21e06d800e09d'
        worktree_digest: 'sha256:54062a70276ec1761a94b6548499d265c91fd3b648422a8567a21e06d800e09d'
        untracked_digest: 'absent'
      - path: 'gitnexus/test/integration/resolvers/python.test.ts'
        object_kind: { head: regular, index: regular, worktree: regular, untracked: absent }
        state: 'clean'
        rename_from: null
        rename_to: null
        head_digest: 'sha256:4c0f55a923f51d736476b5bcb276d293637d90fecc10ab5e08624a4b541fe999'
        index_digest: 'sha256:4c0f55a923f51d736476b5bcb276d293637d90fecc10ab5e08624a4b541fe999'
        worktree_digest: 'sha256:4c0f55a923f51d736476b5bcb276d293637d90fecc10ab5e08624a4b541fe999'
        untracked_digest: 'absent'
      - path: 'gitnexus/test/integration/resolvers/repro-2826-python-dotted-import.test.ts'
        object_kind: { head: absent, index: absent, worktree: absent, untracked: regular }
        state: 'untracked'
        rename_from: null
        rename_to: null
        head_digest: 'absent'
        index_digest: 'absent'
        worktree_digest: 'absent'
        untracked_digest: 'sha256:6fe3a74a69db12a1a0aeceef2b32eb0c04d5e4880fc93b7b840348118e70078c'

  primary_symbols:
    - symbol: 'collectNamespaceTargets'
      file: 'gitnexus/src/core/ingestion/scope-resolution/scope/namespace-targets.ts'
      lines: '39-57'
      role: 'The defect site — builds the receiver-name → target-file map keyed only on localName'
    - symbol: 'interpretPythonImport'
      file: 'gitnexus/src/core/ingestion/languages/python/interpret.ts'
      lines: '33-42'
      role: 'Splits `import a.b` into localName "a" / importedName "a.b"; source of both halves'
    - symbol: 'emitReceiverBoundCalls'
      file: 'gitnexus/src/core/ingestion/scope-resolution/passes/receiver-bound-calls.ts'
      lines: '404-421, 546-655, 831-848'
      role: 'Case 0 declines on a module receiver and falls through; Case 1 does the failing map lookup'
    - symbol: 'isNamespaceNameShadowed'
      file: 'gitnexus/src/core/ingestion/scope-resolution/passes/compound-receiver.ts'
      lines: '152-183'
      role: 'Shadow guard that must test the root segment once dotted keys exist'
    - symbol: 'finalizeImportEdges'
      file: 'gitnexus-shared/src/scope-resolution/finalize-algorithm.ts'
      lines: '398-406, 434-447'
      role: 'Carries importedName onto ImportEdge.targetExportedName for namespace edges'

  related_symbols:
    - symbol: 'resolveQualifiedReceiverMember'
      relationship: 'ScopeResolver hook, C++-only implementer'
      relevance: 'Case 1.5 — deliberately NOT the fix path; implementing it for Python would duplicate what Case 1 already does'
    - symbol: 'resolveConstructionExpressionClass'
      relationship: 'consumes namespaceTargets by parameter'
      relevance: 'Second consumer of the map; gains correct pkg.db.Model() resolution'
    - symbol: 'resolveCompoundReceiverClass'
      relationship: 'consumes namespaceTargets by parameter (compound-receiver.ts:759-766)'
      relevance: 'Third consumer; has() now true for dotted namespaces'
    - symbol: 'isNamespaceImport'
      relationship: 'finalize hook added by #2770'
      relevance: 'Prior art — how the from-pkg-import-db sibling was made to resolve'
    - symbol: 'build'
      relationship: 'test-of collectNamespaceTargets'
      relevance: 'test/unit/scope-resolution/python/python-module-namespace-construction.test.ts — re-run after the change'

  execution_path:
    - 'splitImportStatement emits one match per imported name; @import.source = full dotted_name text'
    - 'interpretPythonImport plain arm → ParsedImport{kind:namespace, localName:first-segment, importedName:full-dotted}'
    - 'finalizeImportEdges → ImportEdge{localName, targetExportedName=importedName, targetFile, kind:namespace}'
    - 'collectNamespaceTargets builds Map keyed on localName only  ← DEFECT'
    - 'scope-extractor extractExplicitReceiver takes raw text of the attribute object → "pkg.db"'
    - 'emitReceiverBoundCalls Case 0 declines (module, not class), falls through without marking handled'
    - 'Case 1 map lookup on "pkg.db" misses; Case 1.5 skipped (no Python hook); site drops silently'

  pdg_constraints: []   # index has zero CDG rows; no --pdg layer to slice

  architectural_patterns:
    - pattern: 'Provider reclassification at finalize instead of shared-code special-casing'
      example_location: 'gitnexus-shared/src/scope-resolution/finalize-algorithm.ts:99-107 (isNamespaceImport, #2770)'
      usage_guidance: 'Considered and rejected here: the information needed is already on the finalized edge, so no new hook is warranted'
    - pattern: 'Verified namespace is authoritative — do not fall through to workspace-wide simple-name heuristics'
      example_location: 'gitnexus/src/core/ingestion/scope-resolution/passes/compound-receiver.ts:245-259'
      usage_guidance: 'Because that branch declines rather than guessing, a wrong key costs a lost edge, not a wrong one — but the shadow guard must be right'
    - pattern: 'Fixture + assertions in test/integration/resolvers/python.test.ts'
      example_location: 'gitnexus/test/integration/resolvers/python.test.ts:562-600 (vendored-django guard)'
      usage_guidance: 'mkdtempSync + writeFixtureRepo + afterAll rmSync; assert both presence of the right edge and absence of the wrong one'

  files_to_modify:
    - file: 'gitnexus/src/core/ingestion/scope-resolution/scope/namespace-targets.ts'
      symbols: ['collectNamespaceTargets']
      intended_change: 'Additionally key the map on edge.targetExportedName when it contains a dot and its first segment equals edge.localName; keep the existing localName key unchanged; update the header contract note'
    - file: 'gitnexus/src/core/ingestion/scope-resolution/passes/compound-receiver.ts'
      symbols: ['isNamespaceNameShadowed']
      intended_change: 'Shadow-test the first dot-separated segment of namespaceName (no-op for single-segment names)'
    - file: 'gitnexus/test/integration/resolvers/python.test.ts'
      symbols: []
      intended_change: 'Add a describe block covering the six §8 scenarios'
    - file: 'gitnexus/test/fixtures/lang-resolution/python-dotted-namespace-import/'
      symbols: []
      intended_change: 'New fixture per the §8 table'
    - file: 'gitnexus/test/integration/resolvers/repro-2826-python-dotted-import.test.ts'
      symbols: []
      intended_change: 'Delete — superseded by the fixture-backed tests'

  tests:
    - file: 'gitnexus/test/integration/resolvers/python.test.ts'
      scenarios:
        - 'import pkg.db + pkg.db.session_scope() → run pipeline → CALLS uses_dotted → pkg/db.py:session_scope, reason import-resolved'
        - 'three sibling spellings in the same repo → run pipeline → all still resolve to pkg/db.py:session_scope (control)'
        - 'import pkg.db AND import pkg.cache in one file, both defining session_scope → each call resolves only to its own module; assert the crossed pair is ABSENT'
        - 'import pkg.sub.deep + pkg.sub.deep.f() → 3-segment receiver resolves'
        - 'module-level import pkg.db shadowed by a function-local pkg = Decoy() → NO edge to pkg/db.py'
        - 'existing TypeScript/C#/Go namespace-import resolver tests → unchanged green (no key minted for them)'
    - file: 'gitnexus/test/unit/scope-resolution/python/python-module-namespace-construction.test.ts'
      scenarios:
        - 'Re-run unchanged; extend only if it enumerates map keys exhaustively'

  verification_commands:
    - 'cd gitnexus && GITNEXUS_WORKER_READY_TIMEOUT_MS=60000 npm run test:integration -- test/integration/resolvers/python.test.ts'
    - 'cd gitnexus && GITNEXUS_WORKER_READY_TIMEOUT_MS=60000 npm run test:integration -- test/integration/resolvers'
    - 'cd gitnexus && npm run test:unit -- test/unit/scope-resolution'
    - 'cd gitnexus && npx tsc --noEmit'
    - 'cd gitnexus-shared && npx tsc --noEmit'
    - 'cd gitnexus && node --import tsx bench/receiver-resolution/measure.mjs --check'
    - 'cd gitnexus && node --import tsx bench/python-scope/measure.mjs --check'
    - 'cd gitnexus && node --import tsx bench/python-scope/import-target-fingerprint.mjs --check'
    - 'cd gitnexus && node --import tsx bench/scope-capture/measure.mjs --check'

  risks:
    - 'New map keys reach three consumers, two of them by parameter rather than by call — the graph d=1 list alone under-reports them'
    - 'compound-receiver treats a verified namespace as authoritative and declines instead of falling through, so a bad key loses edges silently'
    - 'bench/receiver-resolution/baseline.json is expected to move; regenerate ONCE in the final step'
    - 'Default 5000 ms worker-ready timeout crash-loops on this host; export GITNEXUS_WORKER_READY_TIMEOUT_MS=60000'

  assumptions:
    - 'Every non-Python provider fails the dotted-rooted-at-localName predicate. CHECK: grep "kind: .namespace." across gitnexus/src/core/ingestion/languages/*/interpret.ts and confirm localName is never the first segment of a dotted importedName. Verified at b2cd1c2ad for typescript, csharp, go, rust, ruby.'
    - 'python.test.ts is no longer gated behind REGISTRY_PRIMARY_PYTHON. CHECK: grep REGISTRY_PRIMARY in that file — zero hits at b2cd1c2ad, so it runs unconditionally.'
    - 'The GitNexus index is 13 commits behind but byte-identical on every cited path. CHECK: git rev-parse 1ef6447e:<path> vs b2cd1c2ad:<path>.'

  open_questions:
    - 'Should the misleading localName-only key for a dotted import (pkg → pkg/db.py) be removed? It can produce a false positive today: pkg.helper() resolves into pkg/db.py if db.py happens to define helper. Deferred — a separate behaviour change needing its own regression pass.'
    - 'Python`s `import a.b.c` also makes `a.b` reachable. The proposed predicate keys only the exact imported path, so `a.b.f()` under `import a.b.c` alone stays unresolved. Deferred as a narrower follow-up.'
    - 'C# `using System.Collections.Generic` + `System.Collections.Generic.List` is the same class of gap and is deliberately NOT addressed here (its localName is the last segment, so the predicate declines). Worth its own issue.'

  avoid:
    - 'Do not repeat full repository discovery'
    - 'Do not replace established patterns without evidence'
    - 'Do not implement resolveQualifiedReceiverMember for Python — Case 1 already does this job; a second path would double-resolve'
    - 'Do not change ImportEdge.localName for dotted imports (interpret.ts:38) — it is the deliberate `import a.b.c exposes a` semantics and other consumers depend on it'
    - 'Do not name a language in gitnexus/src/core/ingestion/ shared code (AGENTS.md §42)'
    - 'Do not regenerate bench baselines per step — only once, in the final step'
    - 'Do not weaken an existing test to accommodate the new keys; extend it instead'
```

## 12. Assumptions and Open Questions

**Assumptions** (each re-checkable cheaply by the executor):

1. Every non-Python namespace-emitting provider fails the `dotted && first segment === localName` predicate. Verified at `b2cd1c2ad` for TypeScript, C#, Go, Rust and Ruby by reading each `interpret.ts`; JavaScript, Java and PHP emit no `kind: 'namespace'` import there. **Re-check:** grep `kind: 'namespace'` across `gitnexus/src/core/ingestion/languages/*/interpret.ts`.
2. `python.test.ts` runs unconditionally — no `REGISTRY_PRIMARY_PYTHON` gate remains at the pinned commit (zero grep hits). An older parity-leg convention no longer applies.
3. The index's 13-commit lag is harmless here because every cited path is byte-identical at the index commit and the pinned commit.

**Open questions / explicitly deferred:**

- **The bogus first-segment key.** For `import pkg.db`, the map still holds `'pkg' → ['pkg/db.py']`, so `pkg.helper()` would resolve into `pkg/db.py` if that file happens to define `helper` — a pre-existing false positive this plan does **not** fix. Removing it is a separate behaviour change with its own regression surface (`python-multi-segment-ancestor-import`, `python-bare-import`). Worth pinning the current behaviour in a test so it is visible rather than silent.
- **`import a.b.c` also binds `a.b`.** Python makes intermediate packages reachable; the proposed predicate keys only the exact imported path, so `a.b.f()` under `import a.b.c` alone stays unresolved. Narrower follow-up.
- **C# has the mirror-image gap.** `using System.Collections.Generic` + `System.Collections.Generic.List` fails the predicate because C# sets `localName` to the *last* segment. Deliberately out of scope; deserves its own issue.
- **Construction coverage.** §8 does not currently include a `pkg.db.Model()` row. Add one if the fixture cost is trivial — that path (`compound-receiver.ts:245-260`) changes behaviour and is otherwise untested by this plan.

## 13. Definition of Done

1. `CALLS` edge `uses_dotted` → `pkg/db.py:session_scope` (`reason: 'import-resolved'`) is emitted, asserted by a fixture-backed test in `python.test.ts`.
2. All three sibling control rows still resolve in the same run.
3. `import pkg.a` + `import pkg.b` in one file resolve only to their own modules; the crossed pair is asserted **absent**.
4. A 3-segment receiver resolves; a package root shadowed by a local binding does **not**.
5. The scratch `repro-2826-python-dotted-import.test.ts` is deleted.
6. No file under `gitnexus/src/core/ingestion/` names a language.
7. `npm run test:integration -- test/integration/resolvers` and `npm run test:unit -- test/unit/scope-resolution` pass; `tsc --noEmit` clean in both packages.
8. Every bench `--check` in §8 passes, with `bench/receiver-resolution/baseline.json` regenerated exactly once in the final commit if and only if it moved — and any movement in `python-scope`/`scope-capture` investigated rather than regenerated.
