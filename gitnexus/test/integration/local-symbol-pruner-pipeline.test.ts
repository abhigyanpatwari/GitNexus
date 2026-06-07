import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { DIST_WORKER_URL, distWorkerExists } from '../helpers/worker-parse.js';

const describeIfWorkerBuilt = distWorkerExists() ? describe : describe.skip;

let tmpDirs: string[] = [];

const makeRepo = (source: string, filename = 'sample.ts'): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-local-prune-'));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, filename), source, 'utf-8');
  return dir;
};

const findNode = (
  result: Awaited<ReturnType<typeof runPipelineFromRepo>>,
  label: string,
  name: string,
) => result.graph.nodes.find((node) => node.label === label && node.properties.name === name);

afterEach(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

describeIfWorkerBuilt('local value symbol pruning pipeline', () => {
  it('prunes inert locals inside exported functions without losing resolved calls', async () => {
    const repo = makeRepo(`
const MODULE_CONST = 1;
export const exportedHandler = () => MODULE_CONST;

export function run() {
  const boring = 1;
  const handler = () => boring;
  const client = new Client();
  client.send();
  return handler();
}

class Client {
  send() {}
}
`);

    const result = await runPipelineFromRepo(repo, () => {}, {
      skipGraphPhases: true,
      workerPoolSize: 1,
      workerUrlForTest: DIST_WORKER_URL,
    });

    expect(findNode(result, 'Const', 'boring')).toBeUndefined();
    expect(findNode(result, 'Const', 'client')).toBeUndefined();
    expect(findNode(result, 'Const', 'handler')).toBeUndefined();

    expect(findNode(result, 'Const', 'MODULE_CONST')).toBeDefined();
    expect(findNode(result, 'Const', 'exportedHandler')).toBeDefined();
    expect(findNode(result, 'Function', 'handler')).toBeDefined();

    const keepsResolvedClientCall = result.graph.relationships.some((rel) => {
      if (rel.type !== 'CALLS') return false;
      const source = result.graph.getNode(rel.sourceId);
      const target = result.graph.getNode(rel.targetId);
      return source?.properties.name === 'run' && target?.properties.name === 'send';
    });
    expect(keepsResolvedClientCall).toBe(true);
  });

  it('keeps Python class-level constants while pruning function-locals', async () => {
    // Regression: tree-sitter-python models the class body as a `block` node, so
    // `determineScope` classified an untyped class attribute as block-scope. Python
    // emits such assignments as `Variable` (the `@definition.variable` capture), and
    // value labels get no owner edge (needsOwner excludes them) — only File->DEFINES.
    // The prune pass would therefore silently delete unreferenced class attributes.
    // A class-level symbol is NOT a function-local and must survive.
    const repo = makeRepo(
      `MODULE_CONST = 1


class Settings:
    MAX_SIZE = 100


def run():
    boring = 1
    return boring
`,
      'sample.py',
    );

    const result = await runPipelineFromRepo(repo, () => {}, {
      skipGraphPhases: true,
      workerPoolSize: 1,
      workerUrlForTest: DIST_WORKER_URL,
    });

    // Unreferenced class-level attribute must survive the prune.
    expect(findNode(result, 'Variable', 'MAX_SIZE')).toBeDefined();
    // Module-level symbol is preserved as before.
    expect(findNode(result, 'Variable', 'MODULE_CONST')).toBeDefined();
    // Genuine function-local is still pruned.
    expect(findNode(result, 'Variable', 'boring')).toBeUndefined();
  });
});
