import { describe, expect, it } from 'vitest';
import { createEagerImportVisibility } from 'gitnexus-shared';
import {
  edgeMapOf,
  expectedVisibility,
  generatedRelations,
  namedRelations,
  observeVisibility,
} from '../../helpers/import-visibility-contract.js';

/**
 * Contract of `ImportVisibility`, checked against a description of each import
 * relation rather than against any implementation's storage. An implementation
 * that stores imports differently runs the same relations and must give the
 * same answers.
 */
describe('ImportVisibility contract: one edge per imported file', () => {
  it.each([...namedRelations, ...generatedRelations])('$name', (relation) => {
    const visibility = createEagerImportVisibility(edgeMapOf(relation));
    expect(observeVisibility(relation, visibility)).toEqual(expectedVisibility(relation));
  });

  it('hands back the stored edge list itself, and undefined for a scope it never saw', () => {
    const relation = namedRelations[2]!;
    const edges = edgeMapOf(relation);
    const visibility = createEagerImportVisibility(edges);
    const scope = relation.scopes[0]!.id;
    expect(visibility.edgesAt(scope)).toBe(edges.get(scope));
    expect(visibility.edgesAt('absent')).toBeUndefined();
  });

  it('returns the same membership view each time a scope is asked', () => {
    const relation = namedRelations[2]!;
    const visibility = createEagerImportVisibility(edgeMapOf(relation));
    const scope = relation.scopes[0]!.id;
    expect(visibility.membership(scope)).toBe(visibility.membership(scope));
  });

  it('answers from its own edge map: a later finalize result gets a fresh view', () => {
    const relation = namedRelations[2]!;
    const scope = relation.scopes[0]!.id;
    const first = createEagerImportVisibility(edgeMapOf(relation));
    const later = createEagerImportVisibility(new Map([[scope, []]]));
    expect(first.membership(scope).has('src/a/One.java')).toBe(true);
    expect(later.membership(scope).has('src/a/One.java')).toBe(false);
    expect(later.membership(scope)).not.toBe(first.membership(scope));
  });

  it('covers duplicates, overlaps, self-targets, unresolved targets and empty lists', () => {
    const statements = generatedRelations.flatMap((relation) =>
      relation.scopes.flatMap((scope) => scope.statements),
    );
    const targetLists = statements.map((statement) => statement.targets);
    expect(targetLists.some((targets) => targets.length === 0)).toBe(true);
    expect(targetLists.some((targets) => targets.includes(null))).toBe(true);
    expect(
      targetLists.some((targets) => targets.some((target) => /^Self/.test(target ?? ''))),
    ).toBe(true);
    // The same target list written twice in one scope, compared by content.
    expect(
      generatedRelations.some((relation) =>
        relation.scopes.some(
          (scope) =>
            new Set(scope.statements.map((statement) => JSON.stringify(statement.targets))).size <
            scope.statements.length,
        ),
      ),
    ).toBe(true);
  });
});
