/**
 * Characterisation of the rows the rename tool hands the planner. The indexed `isExported` flag
 * is carried into each node's properties when the column holds a boolean (a provider whose export
 * refinement lives outside the indexed sources reads it), and every other property keeps exactly
 * the shape it had: a node of a table without the column, or with a null, gains no key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { lbugMocks, planner } = vi.hoisted(() => ({
  lbugMocks: {
    initLbug: vi.fn().mockResolvedValue(undefined),
    executeQuery: vi.fn().mockResolvedValue([]),
    executeParameterized: vi.fn().mockResolvedValue([]),
    ensureVectorExtension: vi.fn().mockResolvedValue(true),
    closeLbug: vi.fn().mockResolvedValue(undefined),
    isLbugReady: vi.fn().mockReturnValue(true),
  },
  planner: { renameSymbol: vi.fn() },
}));

vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/lbug/pool-adapter.js')>()),
  ...lbugMocks,
}));
vi.mock('../../src/mcp/core/lbug-adapter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/mcp/core/lbug-adapter.js')>()),
  ...lbugMocks,
}));
vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/storage/repo-manager.js')>()),
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../src/core/git-staleness.js', () => ({
  checkStaleness: vi.fn().mockReturnValue({ isStale: false, commitsBehind: 0 }),
  checkStalenessAsync: vi.fn().mockResolvedValue({ isStale: false, commitsBehind: 0 }),
  checkCwdMatch: vi.fn().mockResolvedValue({ match: 'none' }),
}));
vi.mock('../../src/mcp/local/rename/rename-plan.js', () => planner);

import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';

const NAME = 'rename-export-flag';
const symbol = {
  id: 'Function:a.R:f',
  name: 'f',
  type: 'Function',
  filePath: 'a.R',
  startLine: 0,
  endLine: 0,
};

describe('rename graph rows: the isExported flag', () => {
  let root: string;
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'gnx-rename-flag-'));
    const storage = path.join(root, 'index');
    await fs.mkdir(path.join(storage, 'lbug'), { recursive: true });
    await fs.writeFile(
      path.join(storage, 'gitnexus.json'),
      JSON.stringify({ contentRetention: 'full', indexedAt: '2024-06-01T12:00:00Z' }),
    );
    vi.mocked(listRegisteredRepos).mockResolvedValue([
      {
        name: NAME,
        path: root,
        storagePath: storage,
        indexedAt: '2024-06-01T12:00:00Z',
        lastCommit: 'abc123',
      } as Awaited<ReturnType<typeof listRegisteredRepos>>[number],
    ]);
    lbugMocks.executeParameterized.mockImplementation(async (_db, query) =>
      query.includes('MATCH (n {id: $uid})') ? [symbol] : [],
    );
    planner.renameSymbol.mockResolvedValue({ status: 'success' });
    backend = new LocalBackend();
  });

  afterEach(async () => {
    await backend.disconnect();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('copies a boolean flag and adds no key for a null, absent or non-boolean one', async () => {
    const row = { name: 'n', filePath: 'a.R', startLine: 1, endLine: 2 };
    lbugMocks.executeQuery.mockResolvedValue([
      { id: 'Function:a.R:yes', ...row, isExported: true },
      { id: 'Function:a.R:no', ...row, isExported: false },
      { id: 'Class:a.R:null', ...row, isExported: null },
      { id: 'Folder:a.R:absent', name: 'n', filePath: 'a.R' },
      { id: 'Function:a.R:text', ...row, isExported: 'true' },
    ]);
    await backend.callTool('rename', { repo: NAME, symbol_uid: symbol.id, new_name: 'g' });
    expect(planner.renameSymbol).toHaveBeenCalledTimes(1);
    const nodes = planner.renameSymbol.mock.calls[0][3] as {
      id: string;
      label: string;
      properties: Record<string, unknown>;
    }[];
    const byId = new Map(nodes.map((node) => [node.id, node]));
    expect(byId.get('Function:a.R:yes')?.properties).toEqual({
      name: 'n',
      filePath: 'a.R',
      startLine: 1,
      endLine: 2,
      isExported: true,
    });
    expect(byId.get('Function:a.R:no')?.properties.isExported).toBe(false);
    // Every other node keeps exactly the four keys it always had.
    for (const id of ['Class:a.R:null', 'Folder:a.R:absent', 'Function:a.R:text']) {
      expect(Object.keys(byId.get(id)?.properties ?? {}).sort(), id).toEqual([
        'endLine',
        'filePath',
        'name',
        'startLine',
      ]);
    }
    expect(byId.get('Function:a.R:yes')?.label).toBe('Function');
  });
});
