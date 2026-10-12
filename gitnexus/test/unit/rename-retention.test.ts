/** Exercise rename dispatch and source policy with real metadata and semantic plans. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { lbugMocks } = vi.hoisted(() => ({
  lbugMocks: {
    initLbug: vi.fn().mockResolvedValue(undefined),
    executeQuery: vi.fn().mockResolvedValue([]),
    executeParameterized: vi.fn().mockResolvedValue([]),
    ensureVectorExtension: vi.fn().mockResolvedValue(true),
    closeLbug: vi.fn().mockResolvedValue(undefined),
    isLbugReady: vi.fn().mockReturnValue(true),
  },
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

import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';

const NAME = 'rename-source-policy';
const INDEXED_AT = '2024-06-01T12:00:00Z';
const FILE = 'target.ts';
const UID = `Function:${FILE}:target`;
const SOURCE = 'function target() { return "retention-private-body"; }\ntarget();\n';
const symbol = {
  id: UID,
  name: 'target',
  type: 'Function',
  filePath: FILE,
  startLine: 0,
  endLine: 0,
};
// One public tool, three call shapes: dry_run omitted (default preview), true, false.
const routes = [
  { route: 'default preview', args: {}, applies: false },
  { route: 'dry run', args: { dry_run: true }, applies: false },
  { route: 'apply', args: { dry_run: false }, applies: true },
] as const;

describe('rename checkout source policy', () => {
  let root: string;
  let checkout: string;
  let storage: string;
  let backend: LocalBackend;

  const writeMeta = async (contentRetention?: string) => {
    await fs.writeFile(
      path.join(storage, 'gitnexus.json'),
      JSON.stringify({ contentRetention, indexedAt: INDEXED_AT }),
    );
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'gnx-rename-retention-'));
    checkout = path.join(root, 'checkout');
    storage = path.join(root, 'index');
    await fs.mkdir(checkout);
    await fs.mkdir(path.join(storage, 'lbug'), { recursive: true });
    await writeMeta('full');
    await fs.writeFile(path.join(checkout, FILE), SOURCE);
    vi.mocked(listRegisteredRepos).mockResolvedValue([
      {
        name: NAME,
        path: checkout,
        storagePath: storage,
        indexedAt: INDEXED_AT,
        lastCommit: 'abc123',
      } as Awaited<ReturnType<typeof listRegisteredRepos>>[number],
    ]);
    lbugMocks.executeQuery.mockResolvedValue([
      { id: `File:${FILE}`, name: FILE, filePath: FILE },
      symbol,
    ]);
    // Context, policy, parser, plan and apply run normally against the graph rows.
    lbugMocks.executeParameterized.mockImplementation(async (_db, query) =>
      query.includes('MATCH (n {id: $uid})') || query.includes('WHERE n.name = $symName')
        ? [symbol]
        : [],
    );
    backend = new LocalBackend();
  });

  afterEach(async () => {
    await backend.disconnect();
    await fs.rm(root, { recursive: true, force: true });
  });

  const rename = ({ args }: (typeof routes)[number]) =>
    backend.callTool('rename', { repo: NAME, symbol_uid: UID, new_name: 'renamed', ...args });

  const expectUnavailable = (result: any, reason: string) => {
    expect(result).toMatchObject({ code: 'source-unavailable', reason });
    expect(Object.keys(result).sort()).toEqual(['code', 'error', 'reason']);
    expect(result.changes).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('retention-private-body');
    expect(lbugMocks.executeQuery).not.toHaveBeenCalled();
  };

  for (const retention of ['none', 'symbol', 'corrupt']) {
    it.each(routes)(
      `refuses $route source disclosure and writes with ${retention} retention`,
      async (route) => {
        await writeMeta(retention);
        const result = await rename(route);
        expectUnavailable(result, 'content-retention');
        expect(await fs.readFile(path.join(checkout, FILE), 'utf8')).toBe(SOURCE);
      },
    );
  }

  it.each(routes)('permits $route under full retention with a live checkout', async (route) => {
    const result = await rename(route);
    expect(result.status).toBe('success');
    expect(result.total_edits).toBe(2);
    expect(result.changes[0].edits[0].before).toContain('retention-private-body');
    expect(result.applied).toBe(route.applies);
    expect(await fs.readFile(path.join(checkout, FILE), 'utf8')).toBe(
      route.applies
        ? 'function renamed() { return "retention-private-body"; }\nrenamed();\n'
        : SOURCE,
    );
  });

  it.each(routes)('refuses $route when the full-retention checkout is missing', async (route) => {
    await fs.rm(checkout, { recursive: true });
    expectUnavailable(await rename(route), 'checkout-missing');
  });

  it('preserves missing-symbol argument validation under non-full retention', async () => {
    await writeMeta('none');
    const result = await backend.callTool('rename', { repo: NAME, new_name: 'renamed' });
    expect(result.error).toContain('Either symbol_name or symbol_uid');
    expect(result.code).toBeUndefined();
  });

  it('preserves symbol ambiguity without exposing source under non-full retention', async () => {
    await writeMeta('none');
    lbugMocks.executeParameterized.mockResolvedValue([
      symbol,
      { ...symbol, id: 'Function:other.ts:target', filePath: 'other.ts' },
    ]);
    const result = await backend.callTool('rename', {
      repo: NAME,
      symbol_name: 'target',
      new_name: 'renamed',
    });
    expect(result.status).toBe('ambiguous');
    expect(result.candidates).toHaveLength(2);
    expect(result.changes).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('retention-private-body');
  });
});
