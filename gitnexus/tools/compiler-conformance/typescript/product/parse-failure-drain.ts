import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, it, mock } from 'node:test';
import { expect } from 'expect';
import * as workerPool from '../../../../dist/core/ingestion/workers/worker-pool.js';
import { createKnowledgeGraph } from '../../../../dist/core/graph/graph.js';
const dispatch = mock.fn(async () => {
  throw undefined;
});
const terminate = mock.fn(async () => {
  throw new Error('drain failed');
});
const poolMock = mock.module(
  new URL('../../../../dist/core/ingestion/workers/worker-pool.js', import.meta.url).href,
  {
    namedExports: {
      ...workerPool,
      createWorkerPool: () => ({ size: 1, dispatch, dispatchGroups: dispatch, terminate }),
    },
  },
);
after(() => poolMock.restore());
const { runChunkedParseAndResolve } =
  await import('../../../../dist/core/ingestion/pipeline-phases/parse-impl.js');
it('preserves an undefined parse rejection alongside a native drain failure', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-parse-drain-'));
  const source = 'export function example() { return 1; }';
  try {
    await fs.writeFile(path.join(root, 'a.ts'), source);
    const run = runChunkedParseAndResolve(
      createKnowledgeGraph(),
      [{ path: 'a.ts', size: source.length }],
      ['a.ts'],
      1,
      root,
      Date.now(),
      () => {},
      { workerPoolSize: 1 },
    );
    await expect(run).rejects.toMatchObject({ errors: [undefined, new Error('drain failed')] });
    await expect(run).rejects.toThrow('undefined');
    expect(terminate.mock.callCount()).toBe(1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
