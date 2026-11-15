import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { runChunkedParseAndResolve } from '../../src/core/ingestion/pipeline-phases/parse-impl.js';

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(async () => {
    throw undefined;
  }),
  terminate: vi.fn(async () => {
    throw new Error('drain failed');
  }),
}));
vi.mock('../../src/core/ingestion/workers/worker-pool.js', async (original) => ({
  ...(await original<typeof import('../../src/core/ingestion/workers/worker-pool.js')>()),
  createWorkerPool: () => ({
    size: 1,
    dispatch: mocks.dispatch,
    dispatchGroups: mocks.dispatch,
    terminate: mocks.terminate,
  }),
}));

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
    expect(mocks.terminate).toHaveBeenCalledOnce();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
