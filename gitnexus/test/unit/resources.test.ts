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
import { describe, it, expect, vi } from 'vitest';
import {
  getResourceDefinitions,
  getResourceTemplates,
  readResource,
} from '../../src/mcp/resources.js';

// ─── Minimal mock backend ──────────────────────────────────────────

function createMockBackend(overrides: Partial<Record<string, any>> = {}): any {
  return {
    listRepos: vi.fn().mockResolvedValue(overrides.repos ?? []),
    resolveRepo: vi.fn().mockResolvedValue(overrides.resolvedRepo ?? {
      name: 'test-repo',
      repoPath: '/tmp/test-repo',
      lastCommit: 'abc1234',
    }),
    getContext: vi.fn().mockReturnValue(overrides.context ?? null),
    queryClusters: vi.fn().mockResolvedValue(overrides.clusters ?? { clusters: [] }),
    queryProcesses: vi.fn().mockResolvedValue(overrides.processes ?? { processes: [] }),
    queryClusterDetail: vi.fn().mockResolvedValue(overrides.clusterDetail ?? { error: 'Not found' }),
    queryProcessDetail: vi.fn().mockResolvedValue(overrides.processDetail ?? { error: 'Not found' }),
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
    const repos = defs.find(d => d.uri === 'gitnexus://repos');
    expect(repos).toBeDefined();
    expect(repos!.mimeType).toBe('text/yaml');
  });

  it('includes setup resource', () => {
    const defs = getResourceDefinitions();
    const setup = defs.find(d => d.uri === 'gitnexus://setup');
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
  it('returns 6 dynamic templates', () => {
    const templates = getResourceTemplates();
    expect(templates).toHaveLength(6);
  });

  it('includes context, clusters, processes, schema, cluster detail, process detail', () => {
    const templates = getResourceTemplates();
    const uris = templates.map(t => t.uriTemplate);
    expect(uris).toContain('gitnexus://repo/{name}/context');
    expect(uris).toContain('gitnexus://repo/{name}/clusters');
    expect(uris).toContain('gitnexus://repo/{name}/processes');
    expect(uris).toContain('gitnexus://repo/{name}/schema');
    expect(uris).toContain('gitnexus://repo/{name}/cluster/{clusterName}');
    expect(uris).toContain('gitnexus://repo/{name}/process/{processName}');
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

// ─── readResource URI parsing ────────────────────────────────────────

describe('readResource', () => {
  it('routes gitnexus://repos to listRepos', async () => {
    const backend = createMockBackend({
      repos: [
        { name: 'my-project', path: '/home/me/my-project', indexedAt: '2024-01-01', lastCommit: 'abc1234', stats: { files: 10, nodes: 50, processes: 5 } },
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
        { name: 'proj', path: '/tmp/proj', indexedAt: '2024-01-01', lastCommit: 'abc', stats: { nodes: 10, edges: 20, processes: 3 } },
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
        clusters: [
          { heuristicLabel: 'Auth', symbolCount: 10, cohesion: 0.9 },
        ],
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
        processes: [
          { heuristicLabel: 'LoginFlow', processType: 'intra_community', stepCount: 3 },
        ],
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
        members: [
          { name: 'login', type: 'Function', filePath: 'src/auth.ts' },
        ],
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
    await expect(readResource('gitnexus://unknown', backend))
      .rejects.toThrow('Unknown resource URI');
  });

  it('throws for unknown repo-scoped resource type', async () => {
    const backend = createMockBackend();
    await expect(readResource('gitnexus://repo/test/nonexistent', backend))
      .rejects.toThrow('Unknown resource');
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
  });
});
