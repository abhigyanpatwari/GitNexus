import { describe, expect, it } from 'vitest';
import { useFixture } from './helpers.js';

describe('JavaScript literal method keys', () => {
  const result = useFixture(
    'js-literal-method-keys',
    {
      'methods.mjs': String.raw`
const key = 'dynamic';
class C {
  plain(arg) { return arg; }
  ['run'](arg) { return this.plain(arg); }
  ['es\u0063aped'](arg) { return this.plain(arg); }
  'quoted'(arg) { return this.plain(arg); }
  [key](arg) { return arg; }
}
export function direct() { const c = new C(); return c.run(1); }
export function escaped() { const c = new C(); return c['es\u0063aped'](2); }
export function quoted() { const c = new C(); return c.quoted(3); }
export function dynamic() { const c = new C(); return c[key](4); }
`,
    },
    { skipDerivedGraphPhases: true, workerPoolSize: 1 },
  );

  it('uses decoded static names consistently for definitions, callers and targets', () => {
    const { graph } = result();
    const method = (name: string) => `Method:methods.mjs:C.${name}#1`;
    expect(
      graph.nodes
        .filter((node) => node.label === 'Method')
        .map((node) => node.id)
        .sort(),
    ).toEqual(['escaped', 'plain', 'quoted', 'run'].map(method));
    const calls = [...graph.iterRelationshipsByType('CALLS')].filter((edge) =>
      edge.targetId.startsWith('Method:'),
    );
    expect(calls.map((edge) => [edge.sourceId, edge.targetId]).sort()).toEqual([
      ['Function:methods.mjs:direct', method('run')],
      ['Function:methods.mjs:escaped', method('escaped')],
      ['Function:methods.mjs:quoted', method('quoted')],
      [method('escaped'), method('plain')],
      [method('quoted'), method('plain')],
      [method('run'), method('plain')],
    ]);
  });
});
