import { describe, expect, it } from 'vitest';
import {
  createGroupedImportVisibility,
  isSelectableImport,
  type ImportEntry,
  type ImportVisibility,
  type ScopeId,
} from 'gitnexus-shared';
import {
  edgesOfStatement,
  expectedVisibility,
  generatedRelations,
  namedRelations,
  observeVisibility,
  type ImportRelation,
  type ImportStatement,
} from '../../helpers/import-visibility-contract.js';

/** A nameless wildcard whose every target resolved is stored as one group over the statement's own list. */
const groups = (statement: ImportStatement): boolean =>
  !isSelectableImport({ ...statement.edge, targetFile: null }) && !statement.targets.includes(null);

function grouped(relation: ImportRelation): ImportVisibility {
  return createGroupedImportVisibility(
    new Map(
      relation.scopes.map((scope): [ScopeId, readonly ImportEntry[]] => [
        scope.id,
        scope.statements.flatMap((statement): ImportEntry[] =>
          groups(statement)
            ? [
                {
                  via: { ...statement.edge, targetFile: null },
                  targetFiles: statement.targets as readonly string[],
                },
              ]
            : edgesOfStatement(statement),
        ),
      ]),
    ),
  );
}

describe('ImportVisibility contract: shared import groups', () => {
  it.each([...namedRelations, ...generatedRelations])('$name', (relation) => {
    expect(observeVisibility(relation, grouped(relation))).toEqual(expectedVisibility(relation));
  });

  it('stores a grouped statement once, whatever the size of its list', () => {
    const relation = namedRelations.find((r) => r.name === 'the same wildcard written twice')!;
    const visibility = grouped(relation);
    expect(visibility.edgesAt(relation.scopes[0]!.id)).toEqual([]);
  });

  it('refuses a group a reader could select by name', () => {
    expect(() =>
      createGroupedImportVisibility(
        new Map([
          [
            'm' as ScopeId,
            [
              {
                via: {
                  localName: 'Named',
                  targetExportedName: 'Named',
                  kind: 'wildcard-expanded',
                  targetFile: null,
                },
                targetFiles: ['a.ts'],
              },
            ],
          ],
        ]),
      ),
    ).toThrow('Import group must be a nameless wildcard');
  });

  it('exercises groups in the generated relations', () => {
    const statements = generatedRelations.flatMap((relation) =>
      relation.scopes.flatMap((scope) => scope.statements),
    );
    expect(statements.filter(groups).length).toBeGreaterThan(50);
    expect(statements.filter((statement) => !groups(statement)).length).toBeGreaterThan(50);
  });
});
