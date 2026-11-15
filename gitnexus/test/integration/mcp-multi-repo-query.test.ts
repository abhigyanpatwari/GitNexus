/** Ten real indexes through one MCP session, including pool eviction and branch pins. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as adapter from '../../src/core/lbug/lbug-adapter.js';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { mergeRepositoryQueries } from '../../src/mcp/local/multi-repo-query.js';
import { createMCPServer, getNextStepHint } from '../../src/mcp/server.js';
import { getStoragePaths } from '../../src/storage/repo-manager.js';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';
import { createTempDir } from '../helpers/test-db.js';

type QueryResponse = Extract<ReturnType<typeof mergeRepositoryQueries>, { processes: unknown }>;
const SOURCE = `export function selectionNeedle() { return 42; }
export function startSelectionFlow() { return middleSelectionFlow(); }
function middleSelectionFlow() { return selectionNeedle(); }
`;
const UID = 'Function:src/fixture.ts:selectionNeedle';

describe('multi-repository queries through native indexes', () => {
  let temp: Awaited<ReturnType<typeof createTempDir>>;
  const repos: string[] = [];
  const commits: string[] = [];
  const branchCommits: string[] = [];
  const backend = new LocalBackend();
  const server = createMCPServer(backend);
  const client = new Client({ name: 'multi-repo-native', version: '1' });

  beforeAll(async () => {
    temp = await createTempDir();
    const root = await fs.realpath(temp.dbPath);
    vi.stubEnv('GITNEXUS_HOME', path.join(root, 'home'));
    vi.stubEnv('GITNEXUS_STORAGE_PATH', undefined);
    vi.stubEnv('GITNEXUS_STORAGE_ROOT', undefined);
    vi.stubEnv('GITNEXUS_SHARED_STORE', 'off');
    vi.stubEnv('GITNEXUS_CONTENT_RETENTION', 'full');
    vi.stubEnv('GITNEXUS_WAL_MANUAL_CHECKPOINT', '1');
    vi.stubEnv('GITNEXUS_LBUG_EXTENSION_INSTALL', 'load-only');
    await adapter.initLbug(path.join(root, 'fts-probe'));
    const ftsLoaded = await adapter.loadFTSExtension(undefined, { policy: 'load-only' });
    await adapter.closeLbug();
    if (!ftsLoaded && process.env.GITNEXUS_REQUIRE_FTS === '1') throw new Error('FTS is required');
    const options = { skipAgentsMd: true, skipSkills: true, skipFts: !ftsLoaded };
    for (let i = 0; i < 10; i++) {
      const repo = path.join(root, `repo${i}`);
      repos.push(repo);
      await fs.mkdir(path.join(repo, 'src'), { recursive: true });
      await fs.writeFile(path.join(repo, '.gitignore'), '.gitnexus/\n');
      await fs.writeFile(path.join(repo, 'src/fixture.ts'), SOURCE);
      initGitRepo(repo);
      execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });
      commitAll(repo, 'query fixture');
      commits.push(
        execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
      );
      await runFullAnalysis(repo, options, { onProgress: () => {} });
      if (i < 2) {
        const main = execFileSync('git', ['branch', '--show-current'], {
          cwd: repo,
          encoding: 'utf8',
        }).trim();
        execFileSync('git', ['checkout', '-qb', 'selection-release'], { cwd: repo });
        await fs.writeFile(
          path.join(repo, 'src/fixture.ts'),
          SOURCE.replace('42', String(i + 100)),
        );
        commitAll(repo, 'release fixture');
        branchCommits.push(
          execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
        );
        await runFullAnalysis(
          repo,
          { ...options, branch: 'selection-release' },
          { onProgress: () => {} },
        );
        execFileSync('git', ['checkout', '-q', main], { cwd: repo });
      }
    }
    await backend.init();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  }, 180_000);

  afterAll(async () => {
    await client.close();
    await server.close();
    await backend.dispose();
    await adapter.closeLbug();
    vi.unstubAllEnvs();
    await temp?.cleanup();
  });

  async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const response = await client.callTool({ name, arguments: args });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    const text = (response.content as { text: string }[])[0]!.text;
    const hint = name === 'query' ? '' : getNextStepHint(name, args);
    return JSON.parse(hint ? text.slice(0, -hint.length) : text) as T;
  }

  it('returns ten distinct provenances and supports scalar context after cycling the pool', async () => {
    const start = performance.now();
    const result = await call<QueryResponse>('query', {
      repo: repos,
      search_query: 'selectionNeedle',
      limit: 10,
      include_content: true,
      chain_depth: 1,
    });
    expect(result).not.toHaveProperty('error');
    expect(result.repos).toEqual(repos);
    expect(result.processes).toHaveLength(10);
    expect(new Set(result.processes.map((row) => row.id)).size).toBeLessThan(10);
    expect(
      new Set(result.process_symbols.filter((row) => row.id === UID).map((row) => row._repo)),
    ).toEqual(new Set(repos));
    expect(result.processes.every((row) => Array.isArray(row.chain))).toBe(true);
    expect(
      result.process_symbols.reduce(
        (size, row) => size + (typeof row.content === 'string' ? row.content.length : 0),
        0,
      ),
    ).toBeLessThanOrEqual(16_000);
    for (const [i, member] of result.per_repo.entries()) {
      expect(member.status).toBe('ok');
      expect(member).toMatchObject({ staleness: { lastCommit: commits[i], status: 'current' } });
    }
    const context = await call('context', { repo: repos[0], uid: UID });
    expect(context).toMatchObject({
      status: 'found',
      symbol: { uid: UID, name: 'selectionNeedle' },
    });
    const repeated = await call<QueryResponse>('query', {
      repo: [...repos].reverse(),
      search_query: 'selectionNeedle',
      limit: 10,
      include_content: true,
      chain_depth: 1,
    });
    expect(repeated.processes).toEqual(result.processes);
    expect(repeated.process_symbols).toEqual(result.process_symbols);
    console.info(
      `[multi-repo-query] ten indexes and repeat: ${Math.round(performance.now() - start)}ms, rss=${Math.round(process.memoryUsage().rss / 1024 / 1024)}MiB`,
    );
  }, 60_000);

  it('uses each member branch index and preserves its generation metadata', async () => {
    const result = await call<QueryResponse>('query', {
      repo: repos.slice(0, 2),
      branch: 'selection-release',
      search_query: 'selectionNeedle',
      include_content: true,
    });
    expect(result).not.toHaveProperty('error');
    for (const [i, member] of result.per_repo.entries()) {
      expect(member).toMatchObject({
        staleness: {
          lastCommit: branchCommits[i],
          branch: 'selection-release',
        },
      });
      const symbol = result.process_symbols.find((row) => row._repo === repos[i] && row.id === UID);
      expect(symbol?.content).toContain(String(i + 100));
    }
  });

  it('keeps successful peers when a selected database is unavailable', async () => {
    await backend.dispose();
    const broken = repos[9]!;
    const lbugPath = getStoragePaths(broken).lbugPath;
    const backup = `${lbugPath}.saved`;
    await fs.rename(lbugPath, backup);
    // A directory at the database path is reliably unreadable even as root.
    await fs.mkdir(lbugPath);
    try {
      const result = await call<QueryResponse>('query', {
        repo: repos,
        search_query: 'selectionNeedle',
        limit: 10,
      });
      expect(result).not.toHaveProperty('error');
      expect(result.partial).toBe(true);
      expect(result.per_repo.find((member) => member.repo === broken)?.status).toBe('error');
      expect(
        new Set(result.process_symbols.filter((row) => row.id === UID).map((row) => row._repo)),
      ).toEqual(new Set(repos.slice(0, 9)));
    } finally {
      await backend.dispose();
      await fs.rmdir(lbugPath);
      await fs.rename(backup, lbugPath);
    }
  }, 60_000);
});
