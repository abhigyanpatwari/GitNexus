/**
 * #3524, end to end: a real analyze, a new commit that leaves the index behind,
 * then `refresh_index` through LocalBackend with the real analyze worker. The
 * refresh must bring the index to HEAD without touching anything git tracks or
 * creating the agent files a plain `gitnexus analyze` writes. The repository
 * has no `.gitignore`, so a clean `git status` also covers `.gitnexus/`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';
import { createTempDir } from '../helpers/test-db.js';

const CLAUDE_MD = '# Team notes\n\nHand-written; no GitNexus block.\n';

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
}

describe('refresh_index through a real analyze worker (#3524)', () => {
  let temp: Awaited<ReturnType<typeof createTempDir>>;
  let repo: string;
  let backend: LocalBackend;
  let indexedCommit: string;
  let head: string;

  beforeAll(async () => {
    temp = await createTempDir();
    const root = await fs.realpath(temp.dbPath);
    const userHome = path.join(root, 'user-home');
    await fs.mkdir(userHome);
    vi.stubEnv('HOME', userHome);
    vi.stubEnv('USERPROFILE', userHome);
    vi.stubEnv('GITNEXUS_HOME', path.join(root, 'home'));
    vi.stubEnv('GITNEXUS_STORAGE_PATH', undefined);
    vi.stubEnv('GITNEXUS_STORAGE_ROOT', undefined);
    vi.stubEnv('GITNEXUS_SHARED_STORE', 'off');
    vi.stubEnv('GITNEXUS_LBUG_EXTENSION_INSTALL', 'load-only');
    vi.stubEnv('GITNEXUS_WAL_MANUAL_CHECKPOINT', '1');
    repo = path.join(root, 'repo');
    await fs.mkdir(path.join(repo, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(repo, 'src', 'orders.ts'),
      'export function placeOrder(id: string) { return `order:${id}`; }\n',
    );
    await fs.writeFile(path.join(repo, 'CLAUDE.md'), CLAUDE_MD);
    initGitRepo(repo);
    git(repo, 'config', 'commit.gpgsign', 'false');
    commitAll(repo, 'initial');
    await runFullAnalysis(repo, { skipAgentsMd: true, skipSkills: true }, { onProgress: () => {} });
    indexedCommit = git(repo, 'rev-parse', 'HEAD');

    await fs.writeFile(
      path.join(repo, 'src', 'invoices.ts'),
      [
        "import { placeOrder } from './orders';",
        'export function issueInvoice(id: string) { return placeOrder(id); }',
        '',
      ].join('\n'),
    );
    commitAll(repo, 'add invoices');
    head = git(repo, 'rev-parse', 'HEAD');

    backend = new LocalBackend();
    await backend.init();
  }, 180_000);

  afterAll(async () => {
    await backend?.dispose();
    vi.unstubAllEnvs();
    await temp?.cleanup();
  });

  it('reports the stale index on a dry run without rebuilding it', async () => {
    const result = await backend.callTool('refresh_index', { repo, dry_run: true });
    expect(result).toMatchObject({
      status: 'dry_run',
      wouldRefresh: true,
      lastCommit: indexedCommit,
      staleness: { status: 'behind', commitsBehind: 1 },
      // CLAUDE.md is indexed too.
      estimatedFiles: 2,
    });
    const list = await backend.callTool('list_repos', {});
    expect(list.repositories[0].lastCommit).toBe(indexedCommit);
  });

  it('brings the index to HEAD without touching tracked or agent files', async () => {
    const result = await backend.callTool('refresh_index', { repo });
    expect(result).toMatchObject({
      status: 'refreshed',
      previous: { lastCommit: indexedCommit, staleness: { status: 'behind' } },
      lastCommit: head,
      staleness: { status: 'current' },
      stats: { files: 3 },
    });

    expect(git(repo, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    expect(await fs.readFile(path.join(repo, 'CLAUDE.md'), 'utf-8')).toBe(CLAUDE_MD);
    expect(existsSync(path.join(repo, 'AGENTS.md'))).toBe(false);
    expect(existsSync(path.join(repo, '.claude'))).toBe(false);

    // The same backend serves the rebuilt index without a restart.
    const found = await backend.callTool('context', { name: 'issueInvoice', repo });
    expect(found).not.toHaveProperty('error');
    expect(found.staleness).toMatchObject({ status: 'current', lastCommit: head });
  }, 180_000);
});
