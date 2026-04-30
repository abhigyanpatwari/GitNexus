import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { syncGroupsForAnalyzedRepo } from '../../../src/core/group/auto-sync.js';
import type { GroupConfig } from '../../../src/core/group/types.js';
import type { SyncResult } from '../../../src/core/group/sync.js';

async function makeHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'gn-auto-sync-'));
}

async function writeGroup(
  home: string,
  name: string,
  repos: Record<string, string>,
): Promise<void> {
  const groupDir = path.join(home, 'groups', name);
  await fs.mkdir(groupDir, { recursive: true });
  const repoLines = Object.entries(repos)
    .map(([groupPath, registryName]) => `  ${groupPath}: ${registryName}`)
    .join('\n');
  await fs.writeFile(
    path.join(groupDir, 'group.yaml'),
    `version: 1
name: ${name}
description: ""
repos:
${repoLines || '  {}'}
links: []
`,
    'utf-8',
  );
}

function makeResult(): SyncResult {
  return {
    contracts: [],
    crossLinks: [],
    unmatched: [],
    missingRepos: [],
    repoSnapshots: {},
  };
}

describe('syncGroupsForAnalyzedRepo', () => {
  const homes: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const home of homes.splice(0)) {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('syncs every group whose repos map includes the analyzed registry name', async () => {
    const home = await makeHome();
    homes.push(home);
    await writeGroup(home, 'product', {
      'app/backend': 'backend',
      'app/frontend': 'frontend',
    });
    await writeGroup(home, 'unrelated', {
      'tools/admin': 'admin',
    });

    const synced: string[] = [];
    const sync = vi.fn(async (config: GroupConfig) => {
      synced.push(config.name);
      return makeResult();
    });

    const result = await syncGroupsForAnalyzedRepo({
      repoName: 'backend',
      gitnexusDir: home,
      sync,
    });

    expect(result).toMatchObject({ scanned: 2, matched: 1, synced: 1, failed: 0 });
    expect(synced).toEqual(['product']);
    expect(result.groups[0].memberPaths).toEqual(['app/backend']);
  });

  it('matches absolute repo path entries as a compatibility fallback', async () => {
    const home = await makeHome();
    homes.push(home);
    const repoPath = path.join(home, 'backend');
    await writeGroup(home, 'paths', {
      'app/backend': repoPath,
    });

    const sync = vi.fn(async () => makeResult());

    const result = await syncGroupsForAnalyzedRepo({
      repoName: 'backend-alias',
      repoPath,
      gitnexusDir: home,
      sync,
    });

    expect(result.matched).toBe(1);
    expect(sync).toHaveBeenCalledOnce();
  });

  it('records per-group sync failures without throwing', async () => {
    const home = await makeHome();
    homes.push(home);
    await writeGroup(home, 'product', {
      'app/backend': 'backend',
    });

    const logs: string[] = [];
    const result = await syncGroupsForAnalyzedRepo({
      repoName: 'backend',
      gitnexusDir: home,
      onLog: (message) => logs.push(message),
      sync: vi.fn(async () => {
        throw new Error('bridge write failed');
      }),
    });

    expect(result).toMatchObject({ scanned: 1, matched: 1, synced: 0, failed: 1 });
    expect(result.groups[0].error).toContain('bridge write failed');
    expect(logs.join('\n')).toContain('auto-sync failed');
  });
});
