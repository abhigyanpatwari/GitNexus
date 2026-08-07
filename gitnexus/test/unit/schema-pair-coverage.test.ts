import { describe, it, expect } from 'vitest';
import type { NodeLabel, NodeTableName } from 'gitnexus-shared';
import { NODE_TABLES } from 'gitnexus-shared';
import { RELATION_SCHEMA, STRUCTURAL_PAIR_DDL } from '../../src/core/lbug/schema.js';
import {
  createRelationPairMatcher,
  parseRelationSchemaPairs,
} from '../../src/core/lbug/rel-pair-routing.js';
import { LINKABLE_LABELS } from '../../src/core/ingestion/scope-resolution/graph-bridge/node-lookup.js';
import { CALLER_ANCHOR_LABELS } from '../../src/core/ingestion/scope-resolution/graph-bridge/ids.js';
import { CALL_TARGET_TYPES } from '../../src/core/ingestion/model/symbol-table.js';

/**
 * `RELATION_SCHEMA` is generated from two cross products plus one hand-written
 * block. This file guards the generated half; a pair drawn from either rule and
 * absent from the DDL does not degrade — `assertDeclaredPair` throws and
 * `analyze` dies mid-phase on whichever codebase first produces it. Failing
 * here means fixing the rule, not the assertion.
 *
 * WHAT SCHEMA.TS NO LONGER RISKS. The DDL used to carry hand-copied twins of
 * `LINKABLE_LABELS` / `CALL_TARGET_TYPES`. Those are deleted — schema.ts now
 * imports the originals — so two whole failure modes are structurally
 * impossible rather than merely asserted: a label present only in the twin, and
 * a label removed from the original while the DDL keeps its pairs. Neither was
 * catchable before (a twin-only `Class|Record` left every assertion green).
 *
 * WHAT STILL NEEDS ASSERTING, and is:
 *  - the rules themselves — the constants below are a deliberate PIN of
 *    schema.ts's two rules, recomputed here from `LINKABLE_LABELS`,
 *    `CALL_TARGET_TYPES` and `NODE_TABLES`. Widening a rule in schema.ts alone
 *    fails `generated region matches …`, so the widening has to be stated
 *    twice, on purpose.
 *  - the generated region for EXACT equality, not containment — so a pair
 *    hand-added to the generated half (the reflex that produced #2781, #2792
 *    and #2793) fails just as loudly as a missing one.
 *  - `STRUCTURAL_PAIR_DDL` carrying nothing a rule already generates. Every
 *    other assertion here subtracts `structural` from BOTH sides, so a
 *    redundant hand-declaration was invisible to all of them; `no hand-declared
 *    pair …` below is the one that sees it.
 *
 * WHAT THIS FILE CANNOT SEE: a pair hand-added to {@link STRUCTURAL_PAIR_DDL}
 * that NEITHER rule covers — the ~72 containment/inheritance/import pairs
 * between two definition labels. That surface has no predicate, so it is
 * bounded by a corpus instead, in
 * `test/integration/structural-pair-coverage.test.ts`.
 */

/** Rule 1 — the scope-resolution graph bridge (#2792). */
const scopeBridgePairs = (): readonly string[] => {
  const sources: NodeLabel[] = ['File', ...LINKABLE_LABELS];
  const targets = new Set<NodeLabel>([...LINKABLE_LABELS, ...CALL_TARGET_TYPES]);
  return sources.flatMap((from) => [...targets].map((to) => `${from}|${to}`));
};

/**
 * Pin of `NON_DEFINITION_LABELS` — the node tables schema.ts refuses as an
 * attachment anchor. `Route` / `Tool` are here despite sourcing `ENTRY_POINT_OF`
 * to a `Process`: that emitter names both labels as literals, so those two pairs
 * are hand-declared rather than generated.
 */
const NON_DEFINITION_LABELS: readonly NodeTableName[] = [
  'Community',
  'Process',
  'Route',
  'Tool',
  'Folder',
  'BasicBlock',
];

/**
 * Pin of `ATTACHMENT_TARGET_LABELS` — labels minted outside the bridge by a
 * phase/framework emitter and hung off whichever definition node that emitter
 * resolved. For most of them the anchor is a lookup result, so its label is
 * unconstrained. `Community` and `Route` are the exceptions and over-declare on
 * purpose (their anchors are label-gated today — see schema.ts); keeping them in
 * the cross product is deliberate headroom, so do NOT narrow this pin to make an
 * assertion smaller.
 */
const ATTACHMENT_TARGET_LABELS: readonly NodeTableName[] = [
  'Annotation',
  'Community',
  'Process',
  'Route',
  'Tool',
  'File',
  'Record',
];

/** Rule 2 — phase/framework overlays hung off a resolved anchor (#2793). */
const attachmentPairs = (): readonly string[] => {
  const anchors = NODE_TABLES.filter((label) => !NON_DEFINITION_LABELS.includes(label));
  return anchors.flatMap((from) => ATTACHMENT_TARGET_LABELS.map((to) => `${from}|${to}`));
};

describe('RELATION_SCHEMA pair coverage', () => {
  const declared = parseRelationSchemaPairs(RELATION_SCHEMA);
  const structural = parseRelationSchemaPairs(STRUCTURAL_PAIR_DDL);

  it('declares every pair the scope-resolution bridge can emit', () => {
    const missing = scopeBridgePairs()
      .filter((pair) => !declared.has(pair))
      .sort();
    expect(missing).toEqual([]);
  });

  it('declares every pair a phase/framework overlay can attach', () => {
    // `Method|Annotation` (Spring @Bean + @ConditionalOnMissingBean),
    // `Method|File` (Vue Options-API handler), `Namespace|Record` (COBOL
    // DECLARATIVES) and `Class|Tool` (@mcp.tool() on a class) were all live
    // aborts at PR #2793's head, from three different emitters.
    const missing = attachmentPairs()
      .filter((pair) => !declared.has(pair))
      .sort();
    expect(missing).toEqual([]);
  });

  it('declares no hand-declared pair that a rule already generates', () => {
    // The guard against the exact failure mode this PR exists to eliminate, and
    // the ONLY one that can see it. `generatedPairDdl` skips any pair
    // already in STRUCTURAL_PAIR_DDL, so a redundant hand-declaration is not an
    // inert duplicate — it SUPPRESSES generation. Narrowing a rule later would
    // then silently keep that pair alive, and every other assertion in this file
    // subtracts `structural` from both sides, so none of them would notice.
    // (The integration corpus only checks emitted ⊆ declared — blind to an
    // EXCESS declaration by construction.) 164 such lines now live in the
    // generated half: 161 moved when this guard went in, plus the three Record
    // member pairs moved when Record became linkable (#2801). Failing here means
    // deleting the line, not widening this.
    const allRulePairs = new Set([...scopeBridgePairs(), ...attachmentPairs()]);
    expect([...structural].filter((pair) => allRulePairs.has(pair))).toEqual([]);
  });

  it('generated region matches the two rules exactly, with nothing extra', () => {
    // Equality, not containment: a pair hand-added to the generated half would
    // pass a subset check while quietly re-establishing the hand-list this PR
    // replaced. Both directions are load-bearing.
    const generated = [...declared].filter((pair) => !structural.has(pair)).sort();
    const expected = [...new Set([...scopeBridgePairs(), ...attachmentPairs()])]
      .filter((pair) => !structural.has(pair))
      .sort();
    expect(generated).toEqual(expected);
  });

  it('keeps caller anchors a subset of linkable labels', () => {
    // A caller anchor outside the lookup's label set can never resolve to an
    // id, so `resolveCallerGraphId` would silently climb past it to the File
    // fallback and attribute the call to the module.
    const unlinkable = [...CALLER_ANCHOR_LABELS].filter((label) => !LINKABLE_LABELS.has(label));
    expect(unlinkable).toEqual([]);
  });

  it('names only real node tables on both endpoints', () => {
    const tables = new Set<string>(NODE_TABLES);
    const unknown = [...declared]
      .flatMap((pair) => pair.split('|'))
      .filter((label) => !tables.has(label))
      .sort();
    expect(unknown).toEqual([]);
  });

  it('declares each pair exactly once', () => {
    // LadybugDB rejects a duplicated FROM/TO pair in the DDL, which would take
    // out every `analyze` rather than one codebase's edge shape. Counts raw
    // occurrences with the SAME matcher `parseRelationSchemaPairs` dedups
    // through — re-inlining a copy of that regex would let any widening of it
    // degrade this into the tautology `declared.size === declared.size`.
    const occurrences = [...RELATION_SCHEMA.matchAll(createRelationPairMatcher())].length;
    expect(occurrences).toBe(declared.size);
  });

  it('declares the pairs from the reported analyze crashes', () => {
    // Java static/field initializer referencing a Variable (#2792); Vue/JS
    // `const obj = { method() {} }` receiver (#2781); then the four #2793
    // aborts, each reproduced on the default `analyze` path against its own
    // fixture under `test/fixtures/lang-resolution/`.
    const reported = [
      'Class|Variable',
      'Const|Method',
      'Method|Annotation',
      'Method|File',
      'Namespace|Record',
      'Class|Tool',
    ];
    expect(reported.filter((pair) => !declared.has(pair))).toEqual([]);
  });

  it('declares the non-bridge structural pairs (#2789)', () => {
    // COBOL containment/call/access. Every pair listed here is outside BOTH
    // rules above, so no derived requirement can reach it and it must stay
    // hand-declared in STRUCTURAL_PAIR_DDL;
    // `test/integration/structural-pair-coverage.test.ts` guards them from a
    // corpus. Pinned here too so deleting a fixture there cannot silently drop
    // the guard, and so the cheap check does not need a build.
    //
    // #2789's original list also named `CodeElement|Record`, `Function|File`,
    // `Module|Record` and `Record|Record`. Those are rule-2 pairs — `Record`
    // and `File` are both in ATTACHMENT_TARGET_LABELS — so `declares every pair
    // a phase/framework overlay can attach` already covers them, and repeating
    // them here would have asserted the opposite of what the comment claims.
    const nonBridge = [
      'CodeElement|CodeElement',
      'CodeElement|Module',
      'CodeElement|Property',
      'Module|CodeElement',
      'Module|Namespace',
      'Namespace|Function',
    ];
    const allRulePairs = new Set([...scopeBridgePairs(), ...attachmentPairs()]);
    expect(nonBridge.filter((pair) => allRulePairs.has(pair))).toEqual([]);
    expect(nonBridge.filter((pair) => !structural.has(pair))).toEqual([]);
  });
});
