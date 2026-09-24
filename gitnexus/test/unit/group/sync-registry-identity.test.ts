import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { syncGroup } from '../../../src/core/group/sync.js';
import { RegistryAmbiguousTargetError } from '../../../src/storage/repo-manager.js';
import { createTempDir } from '../../helpers/test-db.js';
import type { GroupConfig } from '../../../src/core/group/types.js';
import { GroupService } from '../../../src/core/group/service.js';
import type { GroupToolPort } from '../../../src/core/group/service.js';

const initLbugMock = vi.fn(async () => {});

vi.mock('../../../src/core/lbug/pool-adapter.js', () => ({
  initLbug: (...args: unknown[]) => initLbugMock(...args),
  executeParameterized: vi.fn(async () => []),
  pinRepo: vi.fn(() => () => {}),
  getMaxResidentRepos: vi.fn(() => 5),
}));

const makeConfig = (repos: Record<string, string>, extra?: Partial<GroupConfig>): GroupConfig => ({
  version: 1,
  name: 'test',
  description: '',
  repos,
  links: [],
  packages: {},
  detect: {
    http: false,
    graphql: false,
    grpc: false,
    thrift: false,
    topics: false,
    includes: false,
    workspace_deps: false,
  },
  matching: {},
  ...extra,
});

const row = (
  tmpHome: string,
  name: string,
  clone: string,
): {
  name: string;
  path: string;
  storagePath: string;
  indexedAt: string;
  lastCommit: string;
} => {
  const repoPath = path.join(tmpHome, 'repos', clone);
  const storagePath = path.join(repoPath, '.gitnexus');
  mkdirSync(path.join(storagePath, 'lbug'), { recursive: true });
  writeFileSync(
    path.join(storagePath, 'gitnexus.json'),
    JSON.stringify({
      repoPath,
      storagePath,
      indexedAt: '2026-01-01T00:00:00.000Z',
      lastCommit: 'abc123',
    }),
  );
  return {
    name,
    path: repoPath,
    storagePath,
    indexedAt: '2026-01-01T00:00:00.000Z',
    lastCommit: 'abc123',
  };
};

describe('syncGroup registry name identity', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let savedGitnexusHome: string | undefined;
  let registryPath: string;

  beforeEach(async () => {
    initLbugMock.mockReset();
    initLbugMock.mockResolvedValue(undefined);
    tmpHome = await createTempDir('gitnexus-sync-registry-id-');
    savedGitnexusHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
    registryPath = path.join(tmpHome.dbPath, 'registry.json');
  });

  afterEach(async () => {
    if (savedGitnexusHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedGitnexusHome;
    await tmpHome.cleanup();
  });

  it('throws RegistryAmbiguousTargetError and does not rewrite group dir files', async () => {
    const a = row(tmpHome.dbPath, 'demo-api', 'clone-a');
    const b = row(tmpHome.dbPath, 'demo-api', 'clone-b');
    await fs.writeFile(registryPath, JSON.stringify([a, b]));

    const groupDir = path.join(tmpHome.dbPath, 'groups', 'g');
    await fs.mkdir(groupDir, { recursive: true });
    const contractsPath = path.join(groupDir, 'contracts.json');
    const prior = '{"contracts":[],"crossLinks":[],"marker":"keep"}\n';
    await fs.writeFile(contractsPath, prior);

    await expect(syncGroup(makeConfig({ 'demo/api': 'demo-api' }), { groupDir })).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(RegistryAmbiguousTargetError);
        const amb = err as RegistryAmbiguousTargetError;
        expect(amb.matches).toHaveLength(2);
        expect(amb.matches.map((m) => m.path).sort()).toEqual([a.path, b.path].sort());
        return true;
      },
    );

    expect(await fs.readFile(contractsPath, 'utf-8')).toBe(prior);
    await expect(fs.access(path.join(groupDir, 'bridge.lbug'))).rejects.toThrow();
  });

  it('records an unknown yaml value as missing and still extracts other members', async () => {
    const known = row(tmpHome.dbPath, 'backend-repo', 'backend');
    await fs.writeFile(registryPath, JSON.stringify([known]));

    const result = await syncGroup(
      makeConfig({ 'app/backend': 'backend-repo', 'app/ghost': 'ghost' }),
      { skipWrite: true },
    );

    expect(result.missingRepos).toEqual(['app/ghost']);
    expect(result.unreadableRepos).toEqual([]);
    expect(result.repoSnapshots['app/backend']).toEqual({
      indexedAt: known.indexedAt,
      lastCommit: known.lastCommit,
    });
  });

  it('treats a registry member with foreign storage metadata as unreadable', async () => {
    const known = row(tmpHome.dbPath, 'backend-repo', 'backend');
    await fs.writeFile(
      path.join(known.storagePath, 'gitnexus.json'),
      JSON.stringify({ repoPath: path.join(tmpHome.dbPath, 'repos', 'other') }),
    );
    await fs.writeFile(registryPath, JSON.stringify([known]));

    const result = await syncGroup(makeConfig({ 'app/backend': 'backend-repo' }), {
      skipWrite: true,
    });

    expect(result.missingRepos).toEqual([]);
    expect(result.unreadableRepos).toEqual(['app/backend']);
    expect(initLbugMock).not.toHaveBeenCalled();
  });

  it('treats mixed missing and ambiguous names as a terminal ambiguity with no write', async () => {
    const a = row(tmpHome.dbPath, 'demo-api', 'clone-a');
    const b = row(tmpHome.dbPath, 'demo-api', 'clone-b');
    await fs.writeFile(registryPath, JSON.stringify([a, b]));

    const groupDir = path.join(tmpHome.dbPath, 'groups', 'g');
    await fs.mkdir(groupDir, { recursive: true });
    const contractsPath = path.join(groupDir, 'contracts.json');
    await fs.writeFile(contractsPath, '{"keep":true}');

    await expect(
      syncGroup(makeConfig({ 'demo/api': 'demo-api', 'app/ghost': 'ghost' }), { groupDir }),
    ).rejects.toBeInstanceOf(RegistryAmbiguousTargetError);

    expect(await fs.readFile(contractsPath, 'utf-8')).toBe('{"keep":true}');
  });

  it('injected resolveRepoHandle still bypasses default name matching', async () => {
    const a = row(tmpHome.dbPath, 'demo-api', 'clone-a');
    const b = row(tmpHome.dbPath, 'demo-api', 'clone-b');
    await fs.writeFile(registryPath, JSON.stringify([a, b]));

    const result = await syncGroup(makeConfig({ 'demo/api': 'demo-api' }), {
      skipWrite: true,
      resolveRepoHandle: async (_name, groupPath) => ({
        id: 'injected',
        path: groupPath,
        repoPath: a.path,
        storagePath: a.storagePath,
      }),
    });

    expect(result.missingRepos).toEqual([]);
    expect(result.unreadableRepos).toEqual([]);
  });

  it('does not treat a filesystem path yaml value as a registry hit', async () => {
    const known = row(tmpHome.dbPath, 'backend-repo', 'backend');
    await fs.writeFile(registryPath, JSON.stringify([known]));

    const result = await syncGroup(makeConfig({ 'app/backend': known.path }), { skipWrite: true });

    expect(result.missingRepos).toEqual(['app/backend']);
    expect(result.repoSnapshots['app/backend']).toBeUndefined();
  });

  it('injected resolveRepoHandle plus workspace_deps does not throw on duplicate names', async () => {
    const a = row(tmpHome.dbPath, 'demo-api', 'clone-a');
    const b = row(tmpHome.dbPath, 'demo-api', 'clone-b');
    await fs.writeFile(registryPath, JSON.stringify([a, b]));

    const result = await syncGroup(
      makeConfig(
        { 'demo/api': 'demo-api' },
        {
          detect: {
            http: false,
            graphql: false,
            grpc: false,
            thrift: false,
            topics: false,
            includes: false,
            workspace_deps: true,
          },
        },
      ),
      {
        skipWrite: true,
        resolveRepoHandle: async (_name, groupPath) => ({
          id: 'injected',
          path: groupPath,
          repoPath: a.path,
          storagePath: a.storagePath,
        }),
      },
    );

    expect(result.missingRepos).toEqual([]);
  });

  it('injected resolveRepoHandle plus workspace_deps still bypasses name lookup after extraction failure', async () => {
    const a = row(tmpHome.dbPath, 'demo-api', 'clone-a');
    const b = row(tmpHome.dbPath, 'demo-api', 'clone-b');
    await fs.writeFile(registryPath, JSON.stringify([a, b]));
    initLbugMock.mockRejectedValueOnce(new Error('init failed'));

    const result = await syncGroup(
      makeConfig(
        { 'demo/api': 'demo-api' },
        {
          detect: {
            http: false,
            graphql: false,
            grpc: false,
            thrift: false,
            topics: false,
            includes: false,
            workspace_deps: true,
          },
        },
      ),
      {
        skipWrite: true,
        resolveRepoHandle: async (_name, groupPath) => ({
          id: 'injected',
          path: groupPath,
          repoPath: a.path,
          storagePath: a.storagePath,
        }),
      },
    );

    expect(result.missingRepos).toEqual([]);
    expect(result.unreadableRepos).toEqual(['demo/api']);
  });

  it('MCP groupSync returns { error } for an ambiguous registry name', async () => {
    const a = row(tmpHome.dbPath, 'demo-api', 'clone-a');
    const b = row(tmpHome.dbPath, 'demo-api', 'clone-b');
    await fs.writeFile(registryPath, JSON.stringify([a, b]));

    const groupDir = path.join(tmpHome.dbPath, 'groups', 'g1');
    await fs.mkdir(groupDir, { recursive: true });
    await fs.writeFile(
      path.join(groupDir, 'group.yaml'),
      `version: 1
name: g1
repos:
  demo/api: demo-api
`,
    );

    const port: GroupToolPort = {
      resolveRepo: vi.fn(),
      impact: vi.fn(),
      query: vi.fn(),
      impactByUid: vi.fn(),
      context: vi.fn(),
    };
    const svc = new GroupService(port);
    const payload = (await svc.groupSync({ name: 'g1' })) as { error?: string };

    expect(payload.error).toBeDefined();
    expect(payload.error).toContain('demo-api');
    expect(payload.error).toContain(a.path);
    expect(payload.error).toContain(b.path);
    expect(payload.error).toMatch(/unique registry name/i);
    expect(payload.error).not.toMatch(/Pass the absolute path/);
  });
});
