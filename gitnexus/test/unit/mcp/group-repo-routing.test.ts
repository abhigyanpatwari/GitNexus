/**
 * LocalBackend.callTool routes impact/query/context to GroupService when repo starts with "@".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const { lbugMocks } = vi.hoisted(() => ({
  lbugMocks: {
    initLbug: vi.fn().mockResolvedValue(undefined),
    executeQuery: vi.fn().mockResolvedValue([]),
    executeParameterized: vi.fn().mockResolvedValue([]),
    closeLbug: vi.fn().mockResolvedValue(undefined),
    isLbugReady: vi.fn().mockReturnValue(true),
  },
}));

vi.mock('../../../src/core/lbug/pool-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/lbug/pool-adapter.js')>();
  return { ...actual, ...lbugMocks };
});

vi.mock('../../../src/mcp/core/lbug-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/mcp/core/lbug-adapter.js')>();
  return { ...actual, ...lbugMocks };
});

vi.mock('../../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
}));

vi.mock('../../../src/core/search/bm25-index.js', () => ({
  searchFTSFromLbug: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../src/mcp/core/embedder.js', () => ({
  embedQuery: vi.fn().mockResolvedValue([]),
  getEmbeddingDims: vi.fn().mockReturnValue(384),
}));

import { LocalBackend } from '../../../src/mcp/local/local-backend.js';
import { GroupService } from '../../../src/core/group/service.js';

describe('LocalBackend @group repo routing', () => {
  let tmpDir: string;
  let groupSpyQuery: ReturnType<typeof vi.spyOn>;
  let groupSpyImpact: ReturnType<typeof vi.spyOn>;
  let groupSpyContext: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-atgrp-'));
    const groupDir = path.join(tmpDir, 'groups', 'g1');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      path.join(groupDir, 'group.yaml'),
      `version: 1
name: g1
repos:
  app/backend: test-backend
  app/frontend: test-frontend
`,
    );
    vi.stubEnv('GITNEXUS_HOME', tmpDir);
    groupSpyQuery = vi
      .spyOn(GroupService.prototype, 'groupQuery')
      .mockResolvedValue({ via: 'query' });
    groupSpyImpact = vi
      .spyOn(GroupService.prototype, 'groupImpact')
      .mockResolvedValue({ via: 'impact' });
    groupSpyContext = vi.spyOn(GroupService.prototype, 'groupContext').mockResolvedValue({
      group: 'g1',
      results: [],
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('routes query to groupQuery with default member path (first sorted repos key)', async () => {
    const backend = new LocalBackend();
    const out = await backend.callTool('query', { repo: '@g1', query: 'login' });
    expect(out).toEqual({ via: 'query' });
    expect(groupSpyQuery).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'g1', query: 'login' }),
    );
    const arg = groupSpyQuery.mock.calls[0][0] as Record<string, unknown>;
    expect(arg).not.toHaveProperty('repo');
  });

  it('routes query with explicit member path as exact subgroup (no descendant repo bleed)', async () => {
    const backend = new LocalBackend();
    await backend.callTool('query', { repo: '@g1/app/frontend', query: 'x' });
    expect(groupSpyQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'g1',
        query: 'x',
        subgroup: 'app/frontend',
        subgroupExact: true,
      }),
    );
  });

  it('routes impact to groupImpact with resolved repo member path', async () => {
    const backend = new LocalBackend();
    const out = await backend.callTool('impact', {
      repo: '@g1',
      target: 'Sym',
      direction: 'upstream',
    });
    expect(out).toEqual({ via: 'impact' });
    expect(groupSpyImpact).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'g1',
        repo: 'app/backend',
        target: 'Sym',
        direction: 'upstream',
      }),
    );
  });

  it('routes context to groupContext', async () => {
    const backend = new LocalBackend();
    await backend.callTool('context', { repo: '@g1', target: 'Sym' });
    expect(groupSpyContext).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'g1', target: 'Sym' }),
    );
  });

  it('maps MCP symbol name to groupContext target (does not overwrite group name)', async () => {
    const backend = new LocalBackend();
    await backend.callTool('context', { repo: '@g1', name: 'MyClass' });
    expect(groupSpyContext).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'g1', target: 'MyClass' }),
    );
  });

  it('returns error for unknown group name', async () => {
    const backend = new LocalBackend();
    const out = await backend.callTool('query', { repo: '@no-such-group', query: 'x' });
    expect(out).toHaveProperty('error');
    expect(String((out as { error: string }).error)).toMatch(
      /not found|no such|unknown|exist|ENOENT/i,
    );
  });

  it('returns error for unknown member path', async () => {
    const backend = new LocalBackend();
    const out = await backend.callTool('query', { repo: '@g1/not-a-member', query: 'x' });
    expect(out).toHaveProperty('error');
    expect(String((out as { error: string }).error)).toMatch(/Unknown member path/i);
  });

  it('rejects empty service without calling group tools', async () => {
    const backend = new LocalBackend();
    const out = await backend.callTool('query', { repo: '@g1', query: 'x', service: '' });
    expect(out).toEqual({ error: 'service must not be an empty string' });
    expect(groupSpyQuery).not.toHaveBeenCalled();
  });

  it('unknown group_* tools mention removal', async () => {
    const backend = new LocalBackend();
    await expect(backend.callTool('group_query', { name: 'g1', query: 'x' })).rejects.toThrow(
      /Removed tools/,
    );
  });

  it('removed group_contracts mentions migration', async () => {
    const backend = new LocalBackend();
    await expect(backend.callTool('group_contracts', { name: 'g1' })).rejects.toThrow(
      /Removed tools/,
    );
  });

  it('removed group_status mentions migration', async () => {
    const backend = new LocalBackend();
    await expect(backend.callTool('group_status', { name: 'g1' })).rejects.toThrow(/Removed tools/);
  });

  describe('Issue #794 manual smoke checklist (automated)', () => {
    beforeEach(() => {
      const groupDir = path.join(tmpDir, 'groups', 'myproduct');
      fs.mkdirSync(groupDir, { recursive: true });
      fs.writeFileSync(
        path.join(groupDir, 'group.yaml'),
        `version: 1
name: myproduct
repos:
  app/backend: test-backend
  app/frontend: test-frontend
`,
      );
    });

    it.each([
      {
        method: 'impact',
        params: { repo: '@myproduct', target: 'UserService.login', service: 'app/backend' },
        spy: () => groupSpyImpact,
      },
      {
        method: 'query',
        params: { repo: '@myproduct', query: 'login', service: 'app/backend' },
        spy: () => groupSpyQuery,
      },
      {
        method: 'context',
        params: { repo: '@myproduct', target: 'UserService.login', service: 'app/backend' },
        spy: () => groupSpyContext,
      },
    ])(
      '$method with repo "@myproduct" routes to GroupService and forwards service',
      async ({ method, params, spy }) => {
        const backend = new LocalBackend();
        await backend.callTool(method, params);
        expect(spy()).toHaveBeenCalledWith(
          expect.objectContaining({ name: 'myproduct', service: 'app/backend' }),
        );
        const callArg = spy().mock.calls[0][0] as Record<string, unknown>;
        expect(
          typeof callArg.repo === 'string' ? (callArg.repo as string).startsWith('@') : false,
        ).toBe(false);
      },
    );
  });
});
