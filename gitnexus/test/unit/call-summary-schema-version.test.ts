/**
 * PDG FU-C (U-C1 / U-C5) — CALL_SUMMARY relation-type posture + the v3→4
 * incremental reuse gate.
 *
 * CALL_SUMMARY is an INTERNAL PDG-engine edge: like the taint substrate edges
 * (TAINTED / TAINT_PATH / CDG / REACHING_DEF / CFG) it must stay OUT of
 * `VALID_RELATION_TYPES` so it never enters impact-style symbol-space traversal,
 * and the impact relType allowlists (local-backend.ts ~:4373 / ~:5674) that gate
 * on `VALID_RELATION_TYPES` therefore never surface it. The v4 bump forces a
 * full re-analyze on a pre-v4 index (which has no CALL_SUMMARY edges, so an
 * incremental top-up would silently under-report return-value ascent).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  VALID_RELATION_TYPES,
  EPISTEMIC_HERITAGE_RELATION_TYPES,
  EPISTEMIC_CONSUMER_RELATION_TYPES,
} from '../../src/mcp/local/local-backend.js';
import { INCREMENTAL_SCHEMA_VERSION } from '../../src/storage/repo-manager.js';
import { SCHEMA_FINGERPRINT } from '../../src/core/lbug/schema.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

describe('CALL_SUMMARY relation-type exclusion (U-C1)', () => {
  it('is NOT in VALID_RELATION_TYPES (never enters impact symbol-space traversal)', () => {
    expect(VALID_RELATION_TYPES.has('CALL_SUMMARY')).toBe(false);
  });

  it('shares the internal-PDG-edge exclusion posture with the taint substrate edges', () => {
    // The whole PDG/taint substrate stays out of the impact allowlist.
    expect(VALID_RELATION_TYPES.has('TAINT_PATH')).toBe(false);
    expect(VALID_RELATION_TYPES.has('TAINTED')).toBe(false);
    expect(VALID_RELATION_TYPES.has('REACHING_DEF')).toBe(false);
    expect(VALID_RELATION_TYPES.has('CFG')).toBe(false);
    expect(VALID_RELATION_TYPES.has('CDG')).toBe(false);
    // Sanity floor: the public callgraph edges ARE in the allowlist.
    expect(VALID_RELATION_TYPES.has('CALLS')).toBe(true);
  });

  it('is absent from the epistemic-boundary relation sets', () => {
    expect(EPISTEMIC_HERITAGE_RELATION_TYPES).not.toContain('CALL_SUMMARY');
    expect(EPISTEMIC_CONSUMER_RELATION_TYPES).not.toContain('CALL_SUMMARY');
  });

  it('is absent from the impact relType default allowlists in local-backend (the ~:4373/~:5674 filters)', () => {
    // The two impact relType filters first intersect with VALID_RELATION_TYPES
    // (above) and otherwise fall back to a hardcoded public-edge default list.
    // Assert CALL_SUMMARY appears in NEITHER default list's source text, so it
    // can never be the relType an impact traversal walks.
    const src = readFileSync(
      path.join(repoRoot, 'src', 'mcp', 'local', 'local-backend.ts'),
      'utf8',
    );
    // Every default relType array literal in the impact filters.
    const defaultLists = src.match(/\[\s*\n\s*'CALLS',[\s\S]*?\]/g) ?? [];
    expect(defaultLists.length).toBeGreaterThan(0);
    for (const list of defaultLists) {
      expect(list).not.toContain('CALL_SUMMARY');
    }
  });

  it('the /api/graph relationship projection does not special-case (allow OR block) CALL_SUMMARY', () => {
    // The /api/graph relationship query (api.ts GRAPH_RELATIONSHIP_QUERY) is an
    // unfiltered MATCH used for visualization, not an impact surface — it must
    // not name CALL_SUMMARY in either direction (no bespoke allow/deny clause).
    const api = readFileSync(path.join(repoRoot, 'src', 'server', 'api.ts'), 'utf8');
    expect(api).not.toContain('CALL_SUMMARY');
  });
});

describe('CALL_SUMMARY incremental reuse gate (U-C5)', () => {
  it('INCREMENTAL_SCHEMA_VERSION is bumped to 35 (receiver-chain wire format v2, then the full scope-resolution relation cross product #2792)', () => {
    // Moves with every bump BY DESIGN — that is the point of pinning it. A
    // change that alters emitted ids or edges without bumping would otherwise
    // ship silently, and an existing index would keep serving the old graph
    // through the reuse gate below.
    expect(INCREMENTAL_SCHEMA_VERSION).toBe(35);
  });

  it('a pre-current stamp fails the `=== INCREMENTAL_SCHEMA_VERSION` reuse gate → forces full re-analyze', () => {
    // The reuse gate at run-analyze.ts:920 is exactly this strict equality on
    // the persisted `existingMeta.schemaVersion` (a plain number, possibly
    // absent on a legacy stamp). Replicate it as a typed predicate.
    // Since #2798 the gate is TWO strict equalities, not one: the hand-picked
    // version AND the derived DDL fingerprint. The fingerprint defaults to the
    // current build's so every version case below still reads as before.
    const passesReuseGate = (
      stampedSchemaVersion: number | undefined,
      stampedFingerprint: string | undefined = SCHEMA_FINGERPRINT,
    ): boolean =>
      stampedSchemaVersion === INCREMENTAL_SCHEMA_VERSION &&
      stampedFingerprint === SCHEMA_FINGERPRINT;
    // A pre-v4 (v3) index has no CALL_SUMMARY edges → must NOT reuse.
    expect(passesReuseGate(3)).toBe(false);
    // A pre-v5 (v4) index predates the multi-verb Route identity change → its
    // persisted Route nodes use the old url-only ids, so an incremental top-up
    // would strand them → must NOT reuse.
    expect(passesReuseGate(4)).toBe(false);
    // A legacy stamp with no schemaVersion at all is likewise rejected.
    expect(passesReuseGate(undefined)).toBe(false);
    // A pre-v6 (v5) index predates the uniform 0-based line-storage flip → its
    // COBOL/JCL/markdown/scope rows are still 1-based, so an incremental top-up
    // would mix bases → must NOT reuse.
    expect(passesReuseGate(5)).toBe(false);
    // A pre-v7 (v6) index predates the callable-value-flow edges (#2437/#2522)
    // — new edges between unchanged files would never enter the incremental
    // write set → must NOT reuse.
    expect(passesReuseGate(6)).toBe(false);
    // A pre-v8 (v7) index predates the Java anonymous-class instance model
    // (#2550) — `Worker.run`-keyed Method nodes would be stranded alongside
    // the re-keyed `Worker$N.run` ones on unchanged files → must NOT reuse.
    expect(passesReuseGate(7)).toBe(false);
    // A pre-v9 (v8) index predates enum constant bodies + JLS 13.1
    // immediate-host naming (#2555) — `E.hook`-keyed Method nodes and
    // topmost-anchored `EnumWrap$1`-style ids would be stranded alongside
    // the re-keyed ones on unchanged files → must NOT reuse.
    expect(passesReuseGate(8)).toBe(false);
    // A pre-v10 (v9) index predates the Java record container-node fix
    // (#2564) — a record's methods would keep being ownerless Method nodes
    // with no HAS_METHOD edge on unchanged files → must NOT reuse.
    expect(passesReuseGate(9)).toBe(false);
    // A pre-v11 (v10) index predates the Rust dyn-trait-object dispatch fix
    // (#2604) — abstract trait methods would keep being uncaptured (no
    // ownerId/CALLS resolution) on unchanged Rust trait files → must NOT reuse.
    expect(passesReuseGate(10)).toBe(false);
    // A pre-v12 (v11) index predates the #2514 Rust range-binding fix — the
    // ambiguity latch removes spurious cross-file CALLS edges and the
    // import-disambiguated resolution adds new ones on unchanged Rust files,
    // neither of which reach an incremental write set → must NOT reuse.
    expect(passesReuseGate(11)).toBe(false);
    // A pre-v13 (v12) index predates javac-compatible Java local-type
    // identities and lexical visibility scopes (#2562), so unchanged
    // simple-name-keyed type/member ids must not survive.
    expect(passesReuseGate(12)).toBe(false);
    // A pre-v14 (v13) index predates the C#/Kotlin instance-ownership gate,
    // so unchanged files may retain spurious same-file CALLS edges.
    expect(passesReuseGate(13)).toBe(false);
    // A pre-v15 (v14) index predates the #2687 const-arrow twin removal — an
    // edgeless `Const:<file>:X` twin survives beside its `Function` node on
    // every unchanged TS/JS file, and the incremental write set never touches
    // those files → must NOT reuse.
    expect(passesReuseGate(14)).toBe(false);
    // A pre-v16 (v15) index predates #2693: calls through a closure-valued
    // binding do not resolve in Kotlin/Swift/Dart, and the incremental write
    // set never revisits unchanged files, so those symbols would keep reporting
    // a zero blast radius → must NOT reuse.
    expect(passesReuseGate(15)).toBe(false);
    // A pre-v17 (v16) index predates #2701: `this` inside an ordinary JS/TS
    // `function` still resolves to the enclosing class, so every unchanged
    // TS/JS file keeps its fabricated `this` edges → must NOT reuse.
    expect(passesReuseGate(16)).toBe(false);
    // A pre-v18 (v17) index predates #2699: a function-local callable still
    // shares a node id with a same-named file-level one, and the incremental
    // write set would mix old and new ids → must NOT reuse.
    expect(passesReuseGate(17)).toBe(false);
    // A pre-v19 (v18) index holds the WRONG Java anonymous-class ids — v18 bounded the
    // enclosing-callable walk on class DECLARATIONS only, so `Worker$1.run` was re-keyed
    // as `Worker.makeHandler.run@7:12`. Reusing it would keep those on unchanged files.
    expect(passesReuseGate(18)).toBe(false);
    // A pre-v20 (v19) index holds the false CALLS/ACCESSES a NAMED explicit receiver
    // used to mint through the lexical chain (`options.baseUrl` → a function-local
    // `const baseUrl`) — 709 of them on a 762-file corpus. Reusing it would keep
    // every one on unchanged files.
    expect(passesReuseGate(19)).toBe(false);
    // A pre-v21 (v20) index predates closure bindings becoming call SOURCES in
    // PHP/Rust/Kotlin/Ruby/Dart, the Rust graph node for `let f = || …`, the Dart
    // closure scope + enclosing-callable identity, and position-qualified
    // function-local VALUES. All of those change emitted ids and edges on files
    // that did not themselves change, so reusing a v20 index keeps serving the
    // old attribution — including the Dart case where two same-named closures
    // collapsed onto one node and asserted a CALLS edge present nowhere in the
    // source.
    expect(passesReuseGate(20)).toBe(false);
    // A pre-v22 (v21) index predates CommonJS export indexing (#2723): every
    // unchanged CJS file would keep its pre-fix graph → must NOT reuse.
    expect(passesReuseGate(21)).toBe(false);
    // A pre-v23 (v22) index predates Rust module-qualified call resolution
    // (#2730): every unchanged Rust file would keep the same-name self-loop and
    // keep reporting the real callee as unreached → must NOT reuse.
    expect(passesReuseGate(22)).toBe(false);
    // A pre-v24 (v23) index predates the #2708 inline-constructor receivers.
    expect(passesReuseGate(23)).toBe(false);
    // A pre-v25 (v24) index predates `unresolvedReceiverMembers` (#2744). An
    // absent summary is indistinguishable from "nothing was dropped", so a
    // top-up would keep reporting `epistemic: 'exact'` for exactly the symbols
    // whose callers were dropped → must NOT reuse.
    expect(passesReuseGate(24)).toBe(false);
    // A pre-v26 (v25) index typed receivers from source TEXT, so `svc?.m().n()`,
    // `svc!.m().n()` and `svc.m<T>().n()` emitted no CALLS edge — and two of the
    // three recorded no drop either, so the count still claimed `exact`. A
    // changed-files top-up keeps both the missing edge and the false confidence
    // for every unchanged file → must NOT reuse.
    expect(passesReuseGate(25)).toBe(false);
    // A pre-v27 (v26) index was stamped by an intermediate build of this same
    // series: structural typing was TypeScript-only at that point, and the fold
    // still typed a bare identifier that merely shadowed a class name as that
    // class — so such an index carries both pre-rollout edges for 13 languages
    // and fabricated ones. The gate is a strict `===`, so it must NOT reuse.
    expect(passesReuseGate(26)).toBe(false);
    // A pre-v31 index predates the receiver-chain wire format v2, so its
    // persisted chains carry the v1 prefix a v2 decoder refuses by design.
    // Original note: a pre-v28 (v27) index was stamped mid-series: TypeScript-only structural
    // typing, and the fold still typed a local that merely shadowed a class name
    // as that class — so it carries pre-rollout edges AND fabricated ones.
    expect(passesReuseGate(27)).toBe(false);
    // A pre-v29 (v28) index lacks Class→CodeElement relation schema support,
    // so Spring @Bean injection edges (#2413) would be dropped during
    // persistence → must NOT reuse.
    expect(passesReuseGate(28)).toBe(false);
    // A pre-v30 (v29) index keeps wrapper-line startLines for multi-line closure
    // bindings (#2735), so the graph-to-scope join still drops the CALLS edge.
    expect(passesReuseGate(29)).toBe(false);
    // A pre-v31 (v30) index treats `from pkg import models` as a named package
    // import, so unchanged files retain the old missing qualified CALLS edges.
    expect(passesReuseGate(30)).toBe(false);
    // A pre-v32 (v31) index predates the Rust impl/trait, JS/TS object-literal
    // and Swift member-containment relation pairs (#2769), so an incremental
    // top-up emitting one of those edges would fail the bulk COPY (or silently
    // drop it on the streamed path) → must NOT reuse.
    expect(passesReuseGate(31)).toBe(false);
    // A pre-v33 (v32) index predates the Spring AOP Interface→CodeElement
    // relation pair (#2416), so it cannot persist all evidence edges.
    expect(passesReuseGate(32)).toBe(false);
    // A pre-v34 (v33) index carries `receiverChain` strings in wire format v1,
    // which the v2 decoder refuses by design (#2766) — an incremental top-up
    // would silently fall back to the text cascade for every chain-carrying
    // site → must NOT reuse.
    expect(passesReuseGate(33)).toBe(false);
    // A pre-v35 (v34) index was created against a relation DDL missing 99 of the
    // scope-resolution FROM/TO pairs (#2792) — LadybugDB fixes endpoint pairs at
    // CREATE time, so those edges cannot be written into it at all.
    expect(passesReuseGate(34)).toBe(false);
    // The current stamp passes the gate (incremental top-up eligible).
    expect(passesReuseGate(35)).toBe(true);
  });

  it('the DDL fingerprint decides when the version alone cannot (#2798)', () => {
    const passesReuseGate = (
      stampedSchemaVersion: number | undefined,
      stampedFingerprint: string | undefined,
    ): boolean =>
      stampedSchemaVersion === INCREMENTAL_SCHEMA_VERSION &&
      stampedFingerprint === SCHEMA_FINGERPRINT;

    // Both halves agree → reuse.
    expect(passesReuseGate(INCREMENTAL_SCHEMA_VERSION, SCHEMA_FINGERPRINT)).toBe(true);

    // THE #2798 CASE. Two branches allocated the same version over different
    // DDL — the exact clash that has already happened twice. The version test
    // alone reads this index as current; the fingerprint is what rejects it.
    expect(passesReuseGate(INCREMENTAL_SCHEMA_VERSION, 'a0b1c2d3e4f5')).toBe(false);

    // Every index built before this field existed. Absence must NOT be
    // grandfathered: reusing it would stamp a fresh fingerprint onto a database
    // whose DDL was never verified, permanently certifying a wrong-shaped index.
    expect(passesReuseGate(INCREMENTAL_SCHEMA_VERSION, undefined)).toBe(false);

    // The fingerprint does not REPLACE the version. Most ladder entries (v25,
    // v26, v30, v31, v34) change emitted ids/edges/wire formats with the DDL
    // byte-identical, so a semantic bump must still force on its own.
    expect(passesReuseGate(INCREMENTAL_SCHEMA_VERSION - 1, SCHEMA_FINGERPRINT)).toBe(false);
  });
});
