/**
 * TypeScript object-literal method exports — real-parse coverage.
 *
 * Relocated from `test/unit/parsing-worker-fallback.test.ts` when the
 * sequential parser was removed: this asserts on real parse output (a `Const`
 * for the exported object plus its shorthand `Method`s and `HAS_METHOD` edges),
 * so it must run through a real worker pool rather than the deleted in-process
 * parser. Lives in the integration tier where the dist worker is built.
 */
import { describe, expect, it } from 'vitest';
import { parseFilesWithWorkers } from '../helpers/worker-parse.js';

describe('TypeScript object literal method exports', () => {
  it('links exported object literal shorthand methods back to the exported object', async () => {
    const { graph } = await parseFilesWithWorkers([
      {
        path: 'src/foo.ts',
        content: `export const fooService = {
  async getUser(id: string) {
    return findUser(id);
  },
  saveUser(user: User) {
    return persist(user);
  },
};
`,
      },
    ]);

    const service = graph.nodes.find(
      (node) => node.label === 'Const' && node.properties.name === 'fooService',
    );
    expect(service, 'exported object literal should be captured as a Const').toBeDefined();

    const methodNames = new Set(
      graph.nodes.filter((node) => node.label === 'Method').map((node) => node.properties.name),
    );
    expect(methodNames).toEqual(new Set(['getUser', 'saveUser']));

    const linkedMethodNames = graph.relationships
      .filter((rel) => rel.type === 'HAS_METHOD' && rel.sourceId === service!.id)
      .map((rel) => graph.getNode(rel.targetId)?.properties.name)
      .sort();

    expect(linkedMethodNames).toEqual(['getUser', 'saveUser']);
  });
});
