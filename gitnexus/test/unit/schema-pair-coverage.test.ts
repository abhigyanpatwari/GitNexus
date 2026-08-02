import { describe, it, expect } from 'vitest';
import type { NodeLabel } from 'gitnexus-shared';
import { NODE_TABLES } from 'gitnexus-shared';
import { RELATION_SCHEMA } from '../../src/core/lbug/schema.js';
import { parseRelationSchemaPairs } from '../../src/core/lbug/rel-pair-routing.js';
import { LINKABLE_LABELS } from '../../src/core/ingestion/scope-resolution/graph-bridge/node-lookup.js';
import { CALLER_ANCHOR_LABELS } from '../../src/core/ingestion/scope-resolution/graph-bridge/ids.js';
import { CALL_TARGET_TYPES } from '../../src/core/ingestion/model/symbol-table.js';

/**
 * The scope-resolution graph bridge's whole FROM/TO surface, derived from the
 * label sets that DEFINE it rather than from a hand-list (#2792).
 *
 * `buildGraphNodeLookup` registers exactly `LINKABLE_LABELS`, so every id
 * `resolveDefGraphId` can return wears one of those labels; `resolveCallerGraphId`
 * adds the `File` fallback for a module-level call site. Targets pick up
 * `CALL_TARGET_TYPES` on top, because `tryEmitEdgeWithExplicitTargetId` skips the
 * lookup and emits a callable def's own node id.
 *
 * A pair drawn from these sets and absent from `RELATION_SCHEMA` does not
 * degrade — `assertDeclaredPair` throws and `analyze` dies mid-phase on whichever
 * codebase first produces it (`Const→Method` on Vue/JS in #2781, `Class→Variable`
 * on Java in #2792). Failing here means adding the pairs, not the assertion.
 */
const requiredPairs = (): readonly string[] => {
  const sources: NodeLabel[] = ['File', ...LINKABLE_LABELS];
  const targets = new Set<NodeLabel>([...LINKABLE_LABELS, ...CALL_TARGET_TYPES]);
  return sources.flatMap((from) => [...targets].map((to) => `${from}|${to}`));
};

describe('RELATION_SCHEMA pair coverage', () => {
  const declared = parseRelationSchemaPairs(RELATION_SCHEMA);

  it('declares every pair the scope-resolution bridge can emit', () => {
    const missing = requiredPairs()
      .filter((pair) => !declared.has(pair))
      .sort();
    expect(missing).toEqual([]);
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
    // out every `analyze` rather than one codebase's edge shape.
    const lines = [
      ...RELATION_SCHEMA.matchAll(
        /\bFROM\s+`?[A-Za-z][A-Za-z0-9_]*`?\s+TO\s+`?[A-Za-z][A-Za-z0-9_]*`?/g,
      ),
    ];
    expect(lines).toHaveLength(declared.size);
  });

  it('declares the pairs from the reported analyze crashes', () => {
    // Java static/field initializer referencing a Variable (#2792) and a Vue/JS
    // `const obj = { method() {} }` receiver (#2781).
    expect([...['Class|Variable', 'Const|Method'].filter((pair) => !declared.has(pair))]).toEqual(
      [],
    );
  });
});
