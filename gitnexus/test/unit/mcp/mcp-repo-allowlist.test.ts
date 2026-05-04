/**
 * MCP repo allowlist: LocalBackend registry view, GroupService, resolveAtGroupMemberRepoPath.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import type { RegistryEntry } from '../../../src/storage/repo-manager.js';

vi.mock('../../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn(),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
}));

import { listRegisteredRepos } from '../../../src/storage/repo-manager.js';
import { LocalBackend } from '../../../src/mcp/local/local-backend.js';
import { GroupService, type GroupToolPort } from '../../../src/core/group/service.js';
import { resolveAtGroupMemberRepoPath } from '../../../src/core/group/resolve-at-member.js';

function makePort(overrides: Partial<GroupToolPort> = {}): GroupToolPort {
  return {
    resolveRepo: vi.fn(async (name?: string) => ({
      id: (name || 'test').toLowerCase(),
      name: name || 'test',
      repoPath: '/tmp/repo',
      storagePath: '/tmp/repo/.gitnexus',
    })),
    impact: vi.fn(async () => ({ symbols: [] })),
    query: vi.fn(async () => ({ processes: [] })),
    impactByUid: vi.fn(async () => null),
    context: vi.fn(async () => ({ status: 'not_found' })),
    ...overrides,
  };
}

describe('MCP repo allowlist', () => {
  beforeEach(() => {
    vi.mocked(listRegisteredRepos).mockReset();
  });

  it('LocalBackend filters registry entries to mcpRepoAllowlist', async () => {
    const entries: RegistryEntry[] = [
      {
        name: 'Alpha',
        path: '/x/a',
        storagePath: '/x/a/.gitnexus',
        indexedAt: '1',
        lastCommit: 'deadbeef1',
      },
      {
        name: 'Beta',
        path: '/x/b',
        storagePath: '/x/b/.gitnexus',
        indexedAt: '1',
        lastCommit: 'deadbeef2',
      },
    ];
    vi.mocked(listRegisteredRepos).mockResolvedValue(entries);

    const backend = new LocalBackend({ mcpRepoAllowlist: ['alpha'] });
    expect(backend.isMcpRepoAllowlistActive()).toBe(true);
    expect(new LocalBackend().isMcpRepoAllowlistActive()).toBe(false);
    await backend.init();
    const listed = await backend.listRepos();
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe('Alpha');

    await expect(backend.resolveRepo('Beta')).rejects.toThrow(/not found/i);
    const a = await backend.resolveRepo('Alpha');
    expect(a.name).toBe('Alpha');
  });

  it('group_sync is disabled when port has mcpRepoAllowlist', async () => {
    const port = makePort({ mcpRepoAllowlist: new Set(['any']) });
    const svc = new GroupService(port);
    const out = await svc.groupSync({ name: 'g' });
    expect(out).toMatchObject({
      error: expect.stringMatching(/group_sync is disabled/i),
    });
  });
});

describe('resolveAtGroupMemberRepoPath with MCP allowlist', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-mcp-al-'));
    const groupDir = path.join(tmpDir, 'groups', 'g1');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      path.join(groupDir, 'group.yaml'),
      `version: 1
name: g1
repos:
  zeta/backend: test-backend
  app/frontend: test-frontend
`,
    );
    vi.stubEnv('GITNEXUS_HOME', tmpDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('picks first sorted member whose registry name is allowed', async () => {
    const al = new Set(['test-frontend']);
    const r = await resolveAtGroupMemberRepoPath('g1', undefined, al);
    expect(r).toEqual({ ok: true, repoPath: 'app/frontend' });
  });

  it('skips lexicographically earlier members when their registry name is not allowed', async () => {
    const al = new Set(['test-backend']);
    const r = await resolveAtGroupMemberRepoPath('g1', undefined, al);
    expect(r).toEqual({ ok: true, repoPath: 'zeta/backend' });
  });

  it('rejects explicit member when registry name not in allowlist', async () => {
    const al = new Set(['test-frontend']);
    const r = await resolveAtGroupMemberRepoPath('g1', 'zeta/backend', al);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not exposed/i);
  });
});
