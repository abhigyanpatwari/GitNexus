/**
 * #3747: a member edge must never name an owner node the file did not emit.
 * Both fixtures are the reporter's repro; before the fix each produced one
 * HAS_METHOD edge that LadybugDB's COPY rejected with
 * "Unable to find primary key value".
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  closeLbug,
  executeQuery,
  initLbug,
  loadGraphToLbug,
} from '../../src/core/lbug/lbug-adapter.js';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { createTempDir } from '../helpers/test-db.js';
import { parseFilesWithWorkers } from '../helpers/worker-parse.js';
import { findDanglingEdges } from './resolvers/helpers.js';

const CHAINED_CONST = `import { z } from 'zod';

const KEY = 'BRANCH';
const Branch = z.string();

const Context = z
  .object({
    REF: z.string(),
    [KEY]: Branch,
    REPO: z.string().refine((value) => value.split('/').every((p) => p !== '..')),
  })
  .refine((context) => context.REF === \`refs/heads/\${context[KEY]}\`, {
    message: 'REF must be the branch head',
  });

export function run(env) {
  const context = Context.parse(env);
  return context;
}
`;

const AMBIENT_MODULE = `declare module 'somelib' {
  export function connect(opts: { user: string }): Promise<void>;
  const lib: { connect: typeof connect };
  export default lib;
}
`;

const OBJECT_LITERAL_CONTROL = `export const service = {
  load() { return 1; },
  save: () => 2,
};
`;

describe('#3747 member edges only name emitted owners', () => {
  it('leaves no dangling member edge and keeps every member reachable from its file', async () => {
    const { graph } = await parseFilesWithWorkers([
      { path: 'ctx.mjs', content: CHAINED_CONST },
      { path: 'types/lib.d.ts', content: AMBIENT_MODULE },
    ]);
    expect(findDanglingEdges({ graph } as never, ['HAS_METHOD', 'HAS_PROPERTY'])).toEqual([]);

    const definedFromFile = (file: string): string[] =>
      graph.relationships
        .filter((edge) => edge.type === 'DEFINES' && edge.sourceId === `File:${file}`)
        .map((edge) => edge.targetId);
    const repo = graph.nodes.find(
      (n) => n.properties.filePath === 'ctx.mjs' && n.properties.name === 'REPO',
    );
    const connect = graph.nodes.find(
      (n) => n.properties.filePath === 'types/lib.d.ts' && n.properties.name === 'connect',
    );
    expect(repo).toBeDefined();
    expect(connect).toBeDefined();
    expect(definedFromFile('ctx.mjs')).toContain(repo?.id);
    expect(definedFromFile('types/lib.d.ts')).toContain(connect?.id);
  });

  it('keeps object-literal members owned by their emitted binding', async () => {
    const { graph } = await parseFilesWithWorkers([
      { path: 'service.ts', content: OBJECT_LITERAL_CONTROL },
    ]);
    const owner = graph.nodes.find(
      (n) => n.properties.filePath === 'service.ts' && n.properties.name === 'service',
    );
    expect(owner).toBeDefined();
    const members = graph.relationships
      .filter((edge) => edge.type === 'HAS_METHOD' && edge.sourceId === owner?.id)
      .map((edge) => graph.getNode(edge.targetId)?.properties.name)
      .sort();
    expect(members).toEqual(['load', 'save']);
  });

  it('persists every relationship through native COPY', async () => {
    const temp = await createTempDir();
    try {
      await fs.mkdir(path.join(temp.dbPath, 'types'), { recursive: true });
      await fs.writeFile(path.join(temp.dbPath, 'ctx.mjs'), CHAINED_CONST);
      await fs.writeFile(path.join(temp.dbPath, 'types', 'lib.d.ts'), AMBIENT_MODULE);
      const result = await runPipelineFromRepo(temp.dbPath, () => {}, { workerPoolSize: 1 });
      expect(result.usedWorkerPool).toBe(true);
      expect(findDanglingEdges(result)).toEqual([]);

      await initLbug(path.join(temp.dbPath, 'lbug'), { skipFts: true });
      await loadGraphToLbug(result.graph, temp.dbPath, path.join(temp.dbPath, 'storage'));
      const [row] = await executeQuery('MATCH ()-[r:CodeRelation]->() RETURN count(r) AS edges');
      expect(Number(row.edges)).toBe(result.graph.relationships.length);
    } finally {
      await closeLbug();
      await temp.cleanup();
    }
  });
});
