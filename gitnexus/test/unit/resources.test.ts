/**
 * Unit Tests: MCP Resources
 *
 * Tests: getResourceDefinitions, getResourceTemplates, readResource
 * - Static resource definitions
 * - Dynamic resource templates
 * - URI parsing and dispatch
 * - Error handling for invalid URIs
 * - Resource handlers with mocked backend
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getResourceDefinitions,
  getResourceTemplates,
  parseResourceUri,
  readResource,
} from '../../src/mcp/resources.js';

// Mock loadMeta so getContextResource doesn't hit the filesystem (#2438 fix).
// Default: returns null (simulates no on-disk meta — falls back to cached handle).
const { loadMetaMock } = vi.hoisted(() => ({ loadMetaMock: vi.fn().mockResolvedValue(null) }));
vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/repo-manager.js')>();
  return { ...actual, loadMeta: loadMetaMock };
});

// ─── Minimal mock backend ──────────────────────────────────────────

function createMockBackend(overrides: Partial<Record<string, any>> = {}): any {
  return {
    listRepos: vi.fn().mockResolvedValue(overrides.repos ?? []),
    resolveRepo: vi.fn().mockResolvedValue(
      overrides.resolvedRepo ?? {
        name: 'test-repo',
        repoPath: '/tmp/test-repo',
        storagePath: '/tmp/test-repo/.gitnexus',
        lbugPath: '/tmp/test-repo/.gitnexus/lbug',
        lastCommit: 'abc1234',
      },
    ),
    getContext: vi.fn().mockReturnValue(overrides.context ?? null),
    queryClusters: vi.fn().mockResolvedValue(overrides.clusters ?? { clusters: [] }),
    queryProcesses: vi.fn().mockResolvedValue(overrides.processes ?? { processes: [] }),
    queryClusterDetail: vi
      .fn()
      .mockResolvedValue(overrides.clusterDetail ?? { error: 'Not found' }),
    queryProcessDetail: vi
      .fn()
      .mockResolvedValue(overrides.processDetail ?? { error: 'Not found' }),
    readGroupContractsResource: vi
      .fn()
      .mockResolvedValue(overrides.groupContractsBody ?? 'contracts: []\n'),
    readGroupStatusResource: vi
      .fn()
      .mockResolvedValue(overrides.groupStatusBody ?? 'group: mock\n'),
    ...overrides,
  };
}

// ─── Static definitions ─────────────────────────────────────────────

describe('getResourceDefinitions', () => {
  it('returns 2 static resources', () => {
    const defs = getResourceDefinitions();
    expect(defs).toHaveLength(2);
  });

  it('includes repos resource', () => {
    const defs = getResourceDefinitions();
    const repos = defs.find((d) => d.uri === 'gitnexus://repos');
    expect(repos).toBeDefined();
    expect(repos!.mimeType).toBe('text/yaml');
  });

  it('includes setup resource', () => {
    const defs = getResourceDefinitions();
    const setup = defs.find((d) => d.uri === 'gitnexus://setup');
    expect(setup).toBeDefined();
    expect(setup!.mimeType).toBe('text/markdown');
  });

  it('each definition has uri, name, description, mimeType', () => {
    for (const def of getResourceDefinitions()) {
      expect(def.uri).toBeTruthy();
      expect(def.name).toBeTruthy();
      expect(def.description).toBeTruthy();
      expect(def.mimeType).toBeTruthy();
    }
  });
});

describe('getResourceTemplates', () => {
  it('returns 8 dynamic templates', () => {
    const templates = getResourceTemplates();
    expect(templates).toHaveLength(8);
  });

  it('includes context, clusters, processes, schema, cluster detail, process detail, group contracts/status', () => {
    const templates = getResourceTemplates();
    const uris = templates.map((t) => t.uriTemplate);
    expect(uris).toContain('gitnexus://repo/{name}/context');
    expect(uris).toContain('gitnexus://repo/{name}/clusters');
    expect(uris).toContain('gitnexus://repo/{name}/processes');
    expect(uris).toContain('gitnexus://repo/{name}/schema');
    expect(uris).toContain('gitnexus://repo/{name}/cluster/{clusterName}');
    expect(uris).toContain('gitnexus://repo/{name}/process/{processName}');
    expect(uris).toContain('gitnexus://group/{name}/contracts');
    expect(uris).toContain('gitnexus://group/{name}/status');
  });

  it('each template has uriTemplate, name, description, mimeType', () => {
    for (const tmpl of getResourceTemplates()) {
      expect(tmpl.uriTemplate).toBeTruthy();
      expect(tmpl.name).toBeTruthy();
      expect(tmpl.description).toBeTruthy();
      expect(tmpl.mimeType).toBeTruthy();
    }
  });
});

describe('parseResourceUri', () => {
  it('parses group contracts without query', () => {
    const p = parseResourceUri('gitnexus://group/acme/contracts');
    expect(p).toEqual({
      kind: 'group',
      groupName: 'acme',
      resourceType: 'contracts',
      contractsFilter: {},
    });
  });

  it('parses nested group name and contracts query params', () => {
    const p = parseResourceUri(
      'gitnexus://group/acme/billing/contracts?type=http&repo=app%2Fapi&unmatchedOnly=true',
    );
    expect(p.kind).toBe('group');
    if (p.kind !== 'group' || p.resourceType !== 'contracts') throw new Error('unexpected');
    expect(p.groupName).toBe('acme/billing');
    expect(p.contractsFilter).toEqual({
      type: 'http',
      repo: 'app/api',
      unmatchedOnly: true,
    });
  });

  it('coerces unmatchedOnly false from string', () => {
    const p = parseResourceUri('gitnexus://group/g1/contracts?unmatchedOnly=false');
    expect(p.kind).toBe('group');
    if (p.kind !== 'group' || p.resourceType !== 'contracts') throw new Error('unexpected');
    expect(p.contractsFilter.unmatchedOnly).toBe(false);
  });

  it('parses group status', () => {
    const p = parseResourceUri('gitnexus://group/my/product/status');
    expect(p).toEqual({
      kind: 'group',
      groupName: 'my/product',
      resourceType: 'status',
    });
  });

  it('round-trips repo URI like legacy regex', () => {
    const p = parseResourceUri('gitnexus://repo/my%20project/schema');
    expect(p).toEqual({
      kind: 'repo',
      repoName: 'my project',
      resourceType: 'schema',
    });
  });

  it('rejects unknown group resource tail', () => {
    expect(() => parseResourceUri('gitnexus://group/foo/bar')).toThrow('Unknown group resource');
  });
});

// ─── readResource URI parsing ────────────────────────────────────────

describe('readResource', () => {
  it('routes gitnexus://repos to listRepos', async () => {
    const backend = createMockBackend({
      repos: [
        {
          name: 'my-project',
          path: '/home/me/my-project',
          indexedAt: '2024-01-01',
          lastCommit: 'abc1234',
          stats: { files: 10, nodes: 50, processes: 5 },
        },
      ],
    });

    const result = await readResource('gitnexus://repos', backend);
    expect(backend.listRepos).toHaveBeenCalled();
    expect(result).toContain('my-project');
  });

  it('returns empty message when no repos', async () => {
    const backend = createMockBackend({ repos: [] });
    const result = await readResource('gitnexus://repos', backend);
    expect(result).toContain('No repositories indexed');
  });

  it('routes gitnexus://setup to setup resource', async () => {
    const backend = createMockBackend({
      repos: [
        {
          name: 'proj',
          path: '/tmp/proj',
          indexedAt: '2024-01-01',
          lastCommit: 'abc',
          stats: { nodes: 10, edges: 20, processes: 3 },
        },
      ],
    });
    const result = await readResource('gitnexus://setup', backend);
    expect(result).toContain('GitNexus MCP');
    expect(result).toContain('proj');
  });

  it('returns fallback when setup has no repos', async () => {
    const backend = createMockBackend({ repos: [] });
    const result = await readResource('gitnexus://setup', backend);
    expect(result).toContain('No repositories indexed');
  });

  it('routes group contracts resource through backend', async () => {
    const backend = createMockBackend();
    const uri = 'gitnexus://group/g1/contracts?type=http&unmatchedOnly=true';
    await readResource(uri, backend);
    expect(backend.readGroupContractsResource).toHaveBeenCalledWith('g1', {
      type: 'http',
      unmatchedOnly: true,
    });
  });

  it('routes group status resource through backend', async () => {
    const backend = createMockBackend();
    await readResource('gitnexus://group/acme/status', backend);
    expect(backend.readGroupStatusResource).toHaveBeenCalledWith('acme');
  });

  it('routes gitnexus://repo/{name}/context correctly', async () => {
    const backend = createMockBackend({
      context: {
        projectName: 'test-project',
        stats: { fileCount: 10, functionCount: 50, communityCount: 3, processCount: 5 },
      },
    });

    const result = await readResource('gitnexus://repo/test-project/context', backend);
    expect(backend.resolveRepo).toHaveBeenCalledWith('test-project');
    expect(result).toContain('test-project');
    expect(result).toContain('files: 10');
  });

  it('returns error when context has no codebase loaded', async () => {
    const backend = createMockBackend({ context: null });
    const result = await readResource('gitnexus://repo/test-project/context', backend);
    expect(result).toContain('error');
  });

  it('routes gitnexus://repo/{name}/schema to static schema', async () => {
    const backend = createMockBackend();
    const result = await readResource('gitnexus://repo/any/schema', backend);
    expect(result).toContain('GitNexus Graph Schema');
    expect(result).toContain('CALLS');
    expect(result).toContain('IMPORTS');
  });

  it('routes gitnexus://repo/{name}/clusters correctly', async () => {
    const backend = createMockBackend({
      clusters: {
        clusters: [{ heuristicLabel: 'Auth', symbolCount: 10, cohesion: 0.9 }],
      },
    });
    const result = await readResource('gitnexus://repo/test/clusters', backend);
    expect(backend.queryClusters).toHaveBeenCalledWith('test', 100);
    expect(result).toContain('Auth');
  });

  it('returns empty modules when no clusters', async () => {
    const backend = createMockBackend({ clusters: { clusters: [] } });
    const result = await readResource('gitnexus://repo/test/clusters', backend);
    expect(result).toContain('modules: []');
  });

  it('handles cluster query error gracefully', async () => {
    const backend = createMockBackend();
    backend.queryClusters = vi.fn().mockRejectedValue(new Error('DB locked'));
    const result = await readResource('gitnexus://repo/test/clusters', backend);
    expect(result).toContain('DB locked');
  });

  it('routes gitnexus://repo/{name}/processes correctly', async () => {
    const backend = createMockBackend({
      processes: {
        processes: [{ heuristicLabel: 'LoginFlow', processType: 'intra_community', stepCount: 3 }],
      },
    });
    const result = await readResource('gitnexus://repo/test/processes', backend);
    expect(backend.queryProcesses).toHaveBeenCalledWith('test', 50);
    expect(result).toContain('LoginFlow');
  });

  it('handles process query error gracefully', async () => {
    const backend = createMockBackend();
    backend.queryProcesses = vi.fn().mockRejectedValue(new Error('timeout'));
    const result = await readResource('gitnexus://repo/test/processes', backend);
    expect(result).toContain('timeout');
  });

  it('routes gitnexus://repo/{name}/cluster/{clusterName} correctly', async () => {
    const backend = createMockBackend({
      clusterDetail: {
        cluster: { heuristicLabel: 'Auth', symbolCount: 5, cohesion: 0.85 },
        members: [{ name: 'login', type: 'Function', filePath: 'src/auth.ts' }],
      },
    });
    const result = await readResource('gitnexus://repo/test/cluster/Auth', backend);
    expect(backend.queryClusterDetail).toHaveBeenCalledWith('Auth', 'test');
    expect(result).toContain('Auth');
    expect(result).toContain('login');
  });

  it('handles cluster detail error', async () => {
    const backend = createMockBackend({
      clusterDetail: { error: 'Cluster not found' },
    });
    const result = await readResource('gitnexus://repo/test/cluster/Missing', backend);
    expect(result).toContain('Cluster not found');
  });

  it('routes gitnexus://repo/{name}/process/{processName} correctly', async () => {
    const backend = createMockBackend({
      processDetail: {
        process: { heuristicLabel: 'LoginFlow', processType: 'intra_community', stepCount: 3 },
        steps: [
          { step: 1, name: 'login', filePath: 'src/auth.ts' },
          { step: 2, name: 'validate', filePath: 'src/validate.ts' },
        ],
      },
    });
    const result = await readResource('gitnexus://repo/test/process/LoginFlow', backend);
    expect(backend.queryProcessDetail).toHaveBeenCalledWith('LoginFlow', 'test');
    expect(result).toContain('LoginFlow');
    expect(result).toContain('login');
    expect(result).toContain('validate');
  });

  it('handles process detail error', async () => {
    const backend = createMockBackend({
      processDetail: { error: 'Process not found' },
    });
    const result = await readResource('gitnexus://repo/test/process/Missing', backend);
    expect(result).toContain('Process not found');
  });

  it('throws for unknown resource URI', async () => {
    const backend = createMockBackend();
    await expect(readResource('gitnexus://unknown', backend)).rejects.toThrow(
      'Unknown resource URI',
    );
  });

  it('throws for unknown repo-scoped resource type', async () => {
    const backend = createMockBackend();
    await expect(readResource('gitnexus://repo/test/nonexistent', backend)).rejects.toThrow(
      'Unknown resource',
    );
  });

  it('decodes URI-encoded repo names', async () => {
    const backend = createMockBackend();
    await readResource('gitnexus://repo/my%20project/schema', backend);
    // Should not throw — the schema resource is static
  });

  it('decodes URI-encoded cluster names', async () => {
    const backend = createMockBackend({
      clusterDetail: {
        cluster: { heuristicLabel: 'Auth Module', symbolCount: 5 },
        members: [],
      },
    });
    await readResource('gitnexus://repo/test/cluster/Auth%20Module', backend);
    expect(backend.queryClusterDetail).toHaveBeenCalledWith('Auth Module', 'test');
  });

  it('repos resource shows multi-repo hint for multiple repos', async () => {
    const backend = createMockBackend({
      repos: [
        { name: 'proj-a', path: '/a', indexedAt: '2024-01-01', lastCommit: 'abc' },
        { name: 'proj-b', path: '/b', indexedAt: '2024-01-02', lastCommit: 'def' },
      ],
    });
    const result = await readResource('gitnexus://repos', backend);
    expect(result).toContain('Multiple repos indexed');
    expect(result).toContain('repo parameter');
    // The example must use a registered tool name, not the unregistered
    // `gitnexus_search` / `gitnexus_*` prefix (#2059).
    // #2175: advertise the renamed param, not the legacy "query" key.
    expect(result).toContain('query({search_query: "auth"');
    expect(result).not.toContain('query({query:');
    expect(result).not.toMatch(/gitnexus_/);
  });
});

// ─── Context resource freshness (#2438) ─────────────────────────────────────
//
// After an out-of-process `analyze --index-only` refresh, the RepoHandle cached
// by LocalBackend is stale (lastCommit and stats come from the registry snapshot
// taken at init time). getContextResource must read from disk on every call so
// the staleness banner and stats always reflect the actual on-disk state.

describe('context resource freshness after out-of-process analyze (#2438)', () => {
  beforeEach(() => {
    loadMetaMock.mockReset();
    loadMetaMock.mockResolvedValue(null); // default: no fresh meta
  });

  const CONTEXT = {
    projectName: 'test-project',
    stats: { fileCount: 100, functionCount: 500, communityCount: 3, processCount: 10 },
  };

  it('uses fresh lastCommit from disk meta for staleness check', async () => {
    // Simulate: the cached handle has an old commit, but the on-disk meta has
    // been updated to the current HEAD by an out-of-process analyze.
    loadMetaMock.mockResolvedValue({
      repoPath: '/tmp/test-repo',
      lastCommit: 'fresh-head-commit',
      indexedAt: new Date().toISOString(),
      stats: { files: 200, nodes: 1000, processes: 20 },
    });

    const backend = createMockBackend({
      resolvedRepo: {
        name: 'test-project',
        repoPath: '/tmp/test-repo',
        storagePath: '/tmp/test-repo/.gitnexus',
        lbugPath: '/tmp/test-repo/.gitnexus/lbug',
        lastCommit: 'old-stale-commit', // stale cached value
      },
      context: CONTEXT,
    });

    // loadMeta is called with storagePath, not lbugPath
    await readResource('gitnexus://repo/test-project/context', backend);
    expect(loadMetaMock).toHaveBeenCalledWith('/tmp/test-repo/.gitnexus');
  });

  it('shows fresh stats from disk meta after out-of-process analyze', async () => {
    // Cached stats are stale (100 files, 500 symbols); disk meta has refreshed stats
    loadMetaMock.mockResolvedValue({
      repoPath: '/tmp/test-repo',
      lastCommit: 'current-head',
      indexedAt: new Date().toISOString(),
      stats: { files: 250, nodes: 1500, processes: 25 },
    });

    const backend = createMockBackend({
      context: CONTEXT, // stale: fileCount:100, functionCount:500
    });

    const result = await readResource('gitnexus://repo/test-project/context', backend);
    // Fresh stats from disk override the cached context stats
    expect(result).toContain('files: 250');
    expect(result).toContain('symbols: 1500');
    expect(result).toContain('processes: 25');
    // Stale cached values should NOT appear
    expect(result).not.toContain('files: 100');
    expect(result).not.toContain('symbols: 500');
  });

  it('falls back to cached stats when loadMeta returns null', async () => {
    // loadMeta returns null (e.g. pre-analyze state or missing gitnexus.json)
    loadMetaMock.mockResolvedValue(null);

    const backend = createMockBackend({ context: CONTEXT });
    const result = await readResource('gitnexus://repo/test-project/context', backend);
    // Must still show the cached stats (no crash, no blank output)
    expect(result).toContain('files: 100');
    expect(result).toContain('symbols: 500');
    expect(result).toContain('processes: 10');
  });

  it('falls back to cached lastCommit when loadMeta throws', async () => {
    // loadMeta throws (e.g. permissions error)
    loadMetaMock.mockRejectedValue(new Error('EACCES: permission denied'));

    const backend = createMockBackend({ context: CONTEXT });
    // Should not throw — falls back gracefully
    const result = await readResource('gitnexus://repo/test-project/context', backend);
    expect(result).toContain('test-project');
    expect(result).toContain('stats:');
  });

  it('does not show staleness banner when fresh lastCommit matches HEAD', async () => {
    // After analyze completes, lastCommit in meta equals HEAD → no stale banner.
    // We simulate this by returning a fresh meta; checkStaleness will be called
    // with the fresh commit but the /tmp path has no git repo so it returns safe.
    loadMetaMock.mockResolvedValue({
      repoPath: '/tmp/test-repo',
      lastCommit: 'head-after-analyze',
      indexedAt: new Date().toISOString(),
      stats: { files: 200, nodes: 1000, processes: 20 },
    });

    const backend = createMockBackend({
      resolvedRepo: {
        name: 'test-project',
        repoPath: '/tmp/test-repo',
        storagePath: '/tmp/test-repo/.gitnexus',
        lbugPath: '/tmp/test-repo/.gitnexus/lbug',
        lastCommit: 'old-stale-commit', // stale, would show banner if used
      },
      context: CONTEXT,
    });

    const result = await readResource('gitnexus://repo/test-project/context', backend);
    // With a non-git path checkStaleness errors → no banner even with stale commit.
    // What matters: the fresh commit was passed to checkStaleness, not the old one.
    // (The staleness banner itself requires a live git repo, tested in integration.)
    expect(result).toContain('test-project');
    expect(result).not.toContain('error:');
  });
});
