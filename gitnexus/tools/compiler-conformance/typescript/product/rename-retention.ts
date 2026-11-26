import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import { expect } from 'expect';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerCases } from '../support/cases.mjs';
import * as pool from '../../../../dist/core/lbug/pool-adapter.js';
import * as mcpAdapter from '../../../../dist/mcp/core/lbug-adapter.js';
import * as storageManager from '../../../../dist/storage/repo-manager.js';
import * as staleness from '../../../../dist/core/git-staleness.js';

let registrations: Awaited<ReturnType<typeof storageManager.listRegisteredRepos>> = [];
let candidates: (typeof symbol)[];
const rows = mock.fn(async () => [{ id: `File:${FILE}`, name: FILE, filePath: FILE }, symbol]);
const graph = {
  initLbug: async () => {},
  executeQuery: rows,
  executeParameterized: async (_db: string, query: string) =>
    query.includes('MATCH (n {id: $uid})') || query.includes('WHERE n.name = $symName')
      ? candidates
      : [],
  ensureVectorExtension: async () => true,
  closeLbug: async () => {},
  isLbugReady: () => true,
};
const handles = [
  mock.module(new URL('../../../../dist/core/lbug/pool-adapter.js', import.meta.url).href, {
    namedExports: { ...pool, ...graph },
  }),
  mock.module(new URL('../../../../dist/mcp/core/lbug-adapter.js', import.meta.url).href, {
    namedExports: { ...mcpAdapter, ...graph },
  }),
  mock.module(new URL('../../../../dist/storage/repo-manager.js', import.meta.url).href, {
    namedExports: { ...storageManager, listRegisteredRepos: async () => registrations },
  }),
  mock.module(new URL('../../../../dist/core/git-staleness.js', import.meta.url).href, {
    namedExports: {
      ...staleness,
      checkStaleness: () => ({ isStale: false, commitsBehind: 0 }),
      checkStalenessAsync: async () => ({ isStale: false, commitsBehind: 0 }),
      checkCwdMatch: async () => ({ match: 'none' }),
    },
  }),
];
after(() => {
  for (const handle of handles) handle.restore();
});
const { LocalBackend } = await import('../../../../dist/mcp/local/local-backend.js');
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
  let backend: InstanceType<typeof LocalBackend>;

  const writeMeta = async (contentRetention?: string) => {
    await fs.writeFile(
      path.join(storage, 'gitnexus.json'),
      JSON.stringify({ contentRetention, indexedAt: INDEXED_AT }),
    );
  };

  beforeEach(async () => {
    candidates = [symbol];
    rows.mock.resetCalls();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'gnx-rename-retention-'));
    checkout = path.join(root, 'checkout');
    storage = path.join(root, 'index');
    await fs.mkdir(checkout);
    await fs.mkdir(path.join(storage, 'lbug'), { recursive: true });
    await writeMeta('full');
    await fs.writeFile(path.join(checkout, FILE), SOURCE);
    registrations = [
      {
        name: NAME,
        path: checkout,
        storagePath: storage,
        indexedAt: INDEXED_AT,
        lastCommit: 'abc123',
      } as Awaited<ReturnType<typeof storageManager.listRegisteredRepos>>[number],
    ];
    backend = new LocalBackend();
  });

  afterEach(async () => {
    await backend.disconnect();
    await fs.rm(root, { recursive: true, force: true });
  });

  // Policy refusals must precede capability consumption; a permitted apply uses
  // an actual reviewed preview token below.
  const rename = ({ args, applies }: (typeof routes)[number], planToken = 'source-policy-test') =>
    backend.callTool('rename', {
      repo: NAME,
      symbol_uid: UID,
      new_name: 'renamed',
      ...(applies ? { plan_token: planToken } : {}),
      ...args,
    });

  const expectUnavailable = (result: any, reason: string) => {
    expect(result).toMatchObject({ code: 'source-unavailable', reason });
    expect(Object.keys(result).sort()).toEqual(['code', 'error', 'reason']);
    expect(result.changes).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('retention-private-body');
    expect(rows.mock.callCount()).toBe(0);
  };

  for (const retention of ['none', 'symbol', 'corrupt']) {
    registerCases(
      it,
      routes,
      `refuses $route source disclosure and writes with ${retention} retention`,
      async (route) => {
        await writeMeta(retention);
        const result = await rename(route);
        expectUnavailable(result, 'content-retention');
        expect(await fs.readFile(path.join(checkout, FILE), 'utf8')).toBe(SOURCE);
      },
    );
  }

  registerCases(
    it,
    routes,
    'permits $route under full retention with a live checkout',
    async (route) => {
      const preview = route.applies ? await rename(routes[1]) : undefined;
      if (preview) expect(preview.status).toBe('success');
      const result = await rename(route, preview?.plan_token);
      expect(result.status).toBe('success');
      expect(result.total_edits).toBe(2);
      expect(result.changes[0].edits[0].before).toContain('retention-private-body');
      expect(result.applied).toBe(route.applies);
      expect(await fs.readFile(path.join(checkout, FILE), 'utf8')).toBe(
        route.applies
          ? 'function renamed() { return "retention-private-body"; }\nrenamed();\n'
          : SOURCE,
      );
    },
  );

  registerCases(
    it,
    routes,
    'refuses $route when the full-retention checkout is missing',
    async (route) => {
      await fs.rm(checkout, { recursive: true });
      expectUnavailable(await rename(route), 'checkout-missing');
    },
  );

  it('preserves missing-symbol argument validation under non-full retention', async () => {
    await writeMeta('none');
    const result = await backend.callTool('rename', { repo: NAME, new_name: 'renamed' });
    expect(result.error).toContain('Either symbol_name or symbol_uid');
    expect(result.code).toBeUndefined();
  });

  it('preserves symbol ambiguity without exposing source under non-full retention', async () => {
    await writeMeta('none');
    candidates = [symbol, { ...symbol, id: 'Function:other.ts:target', filePath: 'other.ts' }];
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
