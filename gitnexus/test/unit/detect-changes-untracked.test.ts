/**
 * Scope `all` is `git diff HEAD` — tracked staged + unstaged only. An untracked
 * indexed source never appears in that diff. These tests pin the omission note
 * that keeps a tracked-clean tree from reading as "nothing to review" (#4177).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import * as pool from '../../src/core/lbug/pool-adapter.js';
import * as registry from '../../src/storage/repo-manager.js';
import { createTempDirPool } from '../helpers/temp-dir-pool.js';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';
import { findToolDefinition } from '../../src/mcp/tools.js';

const tempDirs = createTempDirPool('gnx-detect-untracked-');

describe('detect_changes scope all — untracked source omission (#4177)', () => {
  let repoDir: string;
  let backend: LocalBackend;
  const params = { scope: 'all', repo: 'untracked-omit' };

  beforeEach(async () => {
    repoDir = tempDirs.dir();
    initGitRepo(repoDir);
    writeFileSync(path.join(repoDir, 'app.ts'), 'export function answer() { return 42; }\n');
    commitAll(repoDir, 'initial');
    const storagePath = path.join(repoDir, '.gitnexus');
    mkdirSync(path.join(storagePath, 'lbug'), { recursive: true });
    writeFileSync(path.join(storagePath, 'meta.json'), '{}');
    vi.spyOn(registry, 'listRegisteredRepos').mockResolvedValue([
      {
        name: params.repo,
        path: repoDir,
        storagePath,
        indexedAt: '2026-01-01T00:00:00Z',
        lastCommit: 'abc1234',
      },
    ]);
    vi.spyOn(pool, 'initLbug').mockResolvedValue(false);
    vi.spyOn(pool, 'isLbugReady').mockReturnValue(true);
    vi.spyOn(pool, 'executeParameterized').mockResolvedValue([]);
    backend = new LocalBackend();
    await backend.init();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await backend?.dispose();
  });

  it('advertises that scope all covers tracked paths only', () => {
    const tool = findToolDefinition('detect_changes');
    expect(tool?.inputSchema.properties?.scope?.description).toMatch(/untracked/i);
  });

  it('reports omitted untracked indexed sources when the tracked tree is clean', async () => {
    writeFileSync(path.join(repoDir, 'extra.ts'), 'export function added() { return 1; }\n');
    writeFileSync(path.join(repoDir, 'notes.md'), '# scratch\n');

    const result = (await backend.callTool('detect_changes', params)) as {
      summary: { changed_count: number; risk_level: string; message?: string };
      omitted_untracked_sources?: string[];
      partial?: boolean;
    };

    expect(result.summary.changed_count).toBe(0);
    expect(result.summary.risk_level).toBe('none');
    expect(result.partial).toBeUndefined();
    expect(result.omitted_untracked_sources).toEqual(['extra.ts']);
    expect(result.summary.message).toMatch(/No tracked changes vs HEAD/);
  });

  it('keeps a pristine tracked tree as a plain clean result', async () => {
    const result = (await backend.callTool('detect_changes', params)) as {
      summary: { message?: string };
      omitted_untracked_sources?: string[];
    };
    expect(result.omitted_untracked_sources).toBeUndefined();
    expect(result.summary.message).toBe('No changes detected.');
  });

  it('does not apply the omission note to the default unstaged scope', async () => {
    writeFileSync(path.join(repoDir, 'extra.ts'), 'export function added() { return 1; }\n');
    const result = (await backend.callTool('detect_changes', {
      scope: 'unstaged',
      repo: params.repo,
    })) as {
      summary: { message?: string };
      omitted_untracked_sources?: string[];
    };
    expect(result.omitted_untracked_sources).toBeUndefined();
    expect(result.summary.message).toBe('No changes detected.');
  });
});
