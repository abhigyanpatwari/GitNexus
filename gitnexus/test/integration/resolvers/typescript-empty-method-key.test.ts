import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executeQuery, loadGraphToLbug } from '../../../src/core/lbug/lbug-adapter.js';
import { withTestLbugDB } from '../../helpers/test-indexed-db.js';
import { useFixture } from './helpers.js';

describe('TypeScript empty literal method key', () => {
  const result = useFixture(
    'empty-method-key',
    {
      'app.ts': [
        'const key = "dynamic";',
        'class C {',
        '  [""](arg: string): string { return this.named(arg); }',
        '  named(arg: string): string { return arg; }',
        '  [(key)](arg: string): string { return arg; }',
        '}',
        'export function call() { const c = new C(); return c[""]("ok"); }',
        'export function dynamic() { const c = new C(); return c[(key)]("ok"); }',
      ].join('\n'),
    },
    { skipDerivedGraphPhases: true, workerPoolSize: 1 },
  );

  it('retains the signature and links calls to and from the same declaration', () => {
    const { graph } = result();
    const empty = 'Method:app.ts:C.#1';
    const named = 'Method:app.ts:C.named#1';
    expect(
      graph.nodes
        .filter((node) => node.label === 'Method')
        .map((node) => node.id)
        .sort(),
    ).toEqual([empty, named]);
    expect(graph.getNode(empty)?.properties).toMatchObject({
      name: '',
      parameterCount: 1,
      parameterTypes: ['string'],
      returnType: 'string',
      visibility: 'public',
    });
    const calls = [...graph.iterRelationshipsByType('CALLS')].filter(
      (rel) => rel.targetId === empty || rel.sourceId === empty,
    );
    expect(calls.map((rel) => [rel.sourceId, rel.targetId]).sort()).toEqual([
      ['Function:app.ts:call', empty],
      [empty, named],
    ]);
  });

  withTestLbugDB('empty-method-name', (handle) => {
    it('persists the empty key as a string', async () => {
      const { graph, repoPath } = result();
      await loadGraphToLbug(graph, repoPath, dirname(handle.dbPath));
      const rows = await executeQuery(
        "MATCH (m:Method {id: 'Method:app.ts:C.#1'}) RETURN m.name AS name, m.description AS description",
      );
      expect(rows).toEqual([{ name: '', description: null }]);
    });
  });
});
