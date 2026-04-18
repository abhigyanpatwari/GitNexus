/**
 * Integration test for group auto-discover.
 *
 * Tests scanning a parent directory to find indexed repos and create a group.
 * Uses mock GroupToolPort to avoid needing a real LocalBackend.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { GroupService, type GroupToolPort, type GroupRepoHandle } from '../../../src/core/group/service.js';
import { listGroups } from '../../../src/core/group/storage.js';

describe('Group auto-discover integration', () => {
  let tmpDir: string;
  let gitnexusHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `gitnexus-discover-${Date.now()}`);
    gitnexusHome = path.join(tmpDir, '.gitnexus-home');
    fs.mkdirSync(gitnexusHome, { recursive: true });

    // Override GITNEXUS_HOME so we don't pollute the real home dir
    originalHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = gitnexusHome;

    // Create two mock repos with .gitnexus/meta.json
    const repoA = path.join(tmpDir, 'repos', 'shared-utils');
    const repoB = path.join(tmpDir, 'repos', 'web-app');

    fs.mkdirSync(path.join(repoA, '.gitnexus'), { recursive: true });
    fs.writeFileSync(
      path.join(repoA, '.gitnexus', 'meta.json'),
      JSON.stringify({ indexedAt: '2026-04-01T00:00:00Z', lastCommit: 'abc123' }),
    );
    fs.writeFileSync(
      path.join(repoA, 'package.json'),
      JSON.stringify({ name: '@test/shared-utils', version: '1.0.0', dependencies: {} }),
    );
    fs.mkdirSync(path.join(repoA, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repoA, 'src', 'index.ts'),
      'export function formatDate(d: Date): string { return d.toISOString(); }',
    );

    fs.mkdirSync(path.join(repoB, '.gitnexus'), { recursive: true });
    fs.writeFileSync(
      path.join(repoB, '.gitnexus', 'meta.json'),
      JSON.stringify({ indexedAt: '2026-04-01T00:00:00Z', lastCommit: 'def456' }),
    );
    fs.writeFileSync(
      path.join(repoB, 'package.json'),
      JSON.stringify({
        name: '@test/web-app',
        version: '2.0.0',
        dependencies: { '@test/shared-utils': '^1.0.0' },
      }),
    );
    fs.mkdirSync(path.join(repoB, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repoB, 'src', 'app.ts'),
      `import { formatDate } from '@test/shared-utils';
console.log(formatDate(new Date()));`,
    );
  });

  afterEach(() => {
    if (originalHome !== undefined) {
      process.env.GITNEXUS_HOME = originalHome;
    } else {
      delete process.env.GITNEXUS_HOME;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeMockPort(): GroupToolPort {
    const repoHandles: Record<string, GroupRepoHandle> = {
      'shared-utils': {
        id: 'shared-utils',
        name: 'shared-utils',
        repoPath: path.join(tmpDir, 'repos', 'shared-utils'),
        storagePath: path.join(tmpDir, 'repos', 'shared-utils', '.gitnexus'),
      },
      'web-app': {
        id: 'web-app',
        name: 'web-app',
        repoPath: path.join(tmpDir, 'repos', 'web-app'),
        storagePath: path.join(tmpDir, 'repos', 'web-app', '.gitnexus'),
      },
    };

    return {
      resolveRepo: async (nameOrPath?: string): Promise<GroupRepoHandle> => {
        if (nameOrPath && repoHandles[nameOrPath]) {
          return repoHandles[nameOrPath];
        }
        // Try matching by path
        for (const handle of Object.values(repoHandles)) {
          if (nameOrPath && (handle.repoPath === nameOrPath || handle.repoPath.includes(nameOrPath))) {
            return handle;
          }
        }
        throw new Error(`Repo not found: ${nameOrPath}`);
      },
      query: async () => ({ processes: [] }),
    };
  }

  it('discovers repos and creates a group', async () => {
    const service = new GroupService(makeMockPort());
    const reposDir = path.join(tmpDir, 'repos');

    const result = (await service.groupDiscover({
      directory: reposDir,
      name: 'test-discover',
      skipSync: true,
    })) as {
      group: string;
      groupDir: string;
      repos: Array<{ name: string; packageName: string | null }>;
      repoCount: number;
      packageMappings: Record<string, string>;
    };

    expect(result.group).toBe('test-discover');
    expect(result.repoCount).toBe(2);

    // Check repos were discovered
    const repoNames = result.repos.map((r) => r.name).sort();
    expect(repoNames).toEqual(['shared-utils', 'web-app']);

    // Check package names detected
    const sharedRepo = result.repos.find((r) => r.name === 'shared-utils');
    expect(sharedRepo?.packageName).toBe('@test/shared-utils');

    const webRepo = result.repos.find((r) => r.name === 'web-app');
    expect(webRepo?.packageName).toBe('@test/web-app');

    // Check package mappings
    expect(result.packageMappings['@test/shared-utils']).toBeDefined();
    expect(result.packageMappings['@test/web-app']).toBeDefined();

    // Check group.yaml was created
    const groups = await listGroups(gitnexusHome);
    expect(groups).toContain('test-discover');
  });

  it('returns error for empty directory', async () => {
    const emptyDir = path.join(tmpDir, 'empty');
    fs.mkdirSync(emptyDir, { recursive: true });

    const service = new GroupService(makeMockPort());
    const result = (await service.groupDiscover({
      directory: emptyDir,
      name: 'test-empty',
      skipSync: true,
    })) as { error: string };

    expect(result.error).toContain('No indexed repos found');
  });

  it('returns error for non-existent directory', async () => {
    const service = new GroupService(makeMockPort());
    const result = (await service.groupDiscover({
      directory: '/nonexistent/path',
      name: 'test-missing',
    })) as { error: string };

    expect(result.error).toContain('Cannot read directory');
  });

  it('returns error when directory param is missing', async () => {
    const service = new GroupService(makeMockPort());
    const result = (await service.groupDiscover({})) as { error: string };
    expect(result.error).toBe('directory or repoPaths is required');
  });

  it('skips non-indexed subdirectories', async () => {
    // Add a non-indexed directory
    const nonIndexed = path.join(tmpDir, 'repos', 'not-indexed');
    fs.mkdirSync(nonIndexed, { recursive: true });
    fs.writeFileSync(path.join(nonIndexed, 'package.json'), JSON.stringify({ name: 'not-indexed' }));
    // No .gitnexus/meta.json

    const service = new GroupService(makeMockPort());
    const result = (await service.groupDiscover({
      directory: path.join(tmpDir, 'repos'),
      name: 'test-skip',
      skipSync: true,
    })) as { repoCount: number };

    // Should only find 2 (shared-utils and web-app), not 3
    expect(result.repoCount).toBe(2);
  });

  describe('explicit repoPaths mode', () => {
    it('discovers and groups repos from an explicit repoPaths list', async () => {
      const service = new GroupService(makeMockPort());
      const repoA = path.join(tmpDir, 'repos', 'shared-utils');
      const repoB = path.join(tmpDir, 'repos', 'web-app');

      const result = (await service.groupDiscover({
        repoPaths: [repoA, repoB],
        name: 'test-explicit',
        skipSync: true,
      })) as {
        group: string;
        repoCount: number;
        repos: Array<{ name: string; packageName: string | null }>;
        packageMappings: Record<string, string>;
      };

      expect(result.group).toBe('test-explicit');
      expect(result.repoCount).toBe(2);
      const names = result.repos.map((r) => r.name).sort();
      expect(names).toEqual(['shared-utils', 'web-app']);
      expect(result.packageMappings['@test/shared-utils']).toBeDefined();
      expect(result.packageMappings['@test/web-app']).toBeDefined();

      const groups = await listGroups(gitnexusHome);
      expect(groups).toContain('test-explicit');
    });

    it('returns an error when one of the explicit repoPaths is not indexed', async () => {
      const unindexed = path.join(tmpDir, 'repos', 'unindexed');
      fs.mkdirSync(unindexed, { recursive: true });
      fs.writeFileSync(
        path.join(unindexed, 'package.json'),
        JSON.stringify({ name: 'unindexed' }),
      );

      const service = new GroupService(makeMockPort());
      const result = (await service.groupDiscover({
        repoPaths: [path.join(tmpDir, 'repos', 'shared-utils'), unindexed],
        name: 'test-unindexed',
        skipSync: true,
      })) as { error: string };

      expect(result.error).toContain('not indexed');
      expect(result.error).toContain(unindexed);
    });

    it('falls back to directory basename when resolveRepo cannot find a handle', async () => {
      const port: GroupToolPort = {
        resolveRepo: async () => {
          throw new Error('not registered');
        },
        query: async () => ({ processes: [] }),
      };
      const service = new GroupService(port);
      const result = (await service.groupDiscover({
        repoPaths: [path.join(tmpDir, 'repos', 'shared-utils')],
        name: 'test-fallback',
        skipSync: true,
      })) as {
        repoCount: number;
        repos: Array<{ name: string }>;
      };

      expect(result.repoCount).toBe(1);
      expect(result.repos[0].name).toBe('shared-utils');
    });
  });
});
