/** Injected corruption proves the query boundary, not the cause of #3527/#3564. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as adapter from '../../src/core/lbug/lbug-adapter.js';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { SYMBOL_IDENTITY_RECOVERY_SUGGESTION } from '../../src/mcp/local/query-result-integrity.js';
import { createMCPServer } from '../../src/mcp/server.js';
import { getStoragePaths } from '../../src/storage/repo-manager.js';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';
import { createTempDir } from '../helpers/test-db.js';

const SOURCE = [
  'export function integrityNeedle() {',
  '  return 42;',
  '}',
  '',
  'export function startIntegrityFlow() {',
  '  return middleIntegrityFlow();',
  '}',
  '',
  'function middleIntegrityFlow() {',
  '  return integrityNeedle();',
  '}',
].join('\n');
const UID = 'Function:src/fixture.ts:integrityNeedle';

describe('query identity boundary through the real MCP server', () => {
  let temp: Awaited<ReturnType<typeof createTempDir>>;
  let repo: string;
  let lbugPath: string;
  let snapshot: string;
  let ftsLoaded = false;

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
    vi.stubEnv('GITNEXUS_CONTENT_RETENTION', 'full');
    vi.stubEnv('GITNEXUS_LBUG_EXTENSION_INSTALL', 'load-only');
    vi.stubEnv('GITNEXUS_WAL_MANUAL_CHECKPOINT', '1');
    await adapter.initLbug(path.join(root, 'fts-probe'));
    ftsLoaded = await adapter.loadFTSExtension(undefined, { policy: 'load-only' });
    await adapter.closeLbug();
    if (!ftsLoaded) {
      if (process.env.GITNEXUS_REQUIRE_FTS === '1')
        throw new Error('FTS is required for this test');
      return;
    }
    repo = path.join(root, 'repo');
    await fs.mkdir(path.join(repo, 'src'), { recursive: true });
    await fs.writeFile(path.join(repo, '.gitignore'), '.gitnexus/\n');
    await fs.writeFile(path.join(repo, 'src/fixture.ts'), SOURCE);
    await fs.writeFile(
      path.join(repo, 'src/fixture.py'),
      'class Fixture:\n    def integrityNeedle(self):\n        return 42\n',
    );
    await fs.writeFile(
      path.join(repo, 'src/fixture.swift'),
      'struct IntegrityNeedle {\n    let value = 42\n}\n',
    );
    initGitRepo(repo);
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });
    commitAll(repo, 'source-derived query fixture');
    await runFullAnalysis(repo, { skipAgentsMd: true, skipSkills: true }, { onProgress: () => {} });
    lbugPath = getStoragePaths(repo).lbugPath;
    snapshot = path.join(root, 'healthy.lbug');
    await fs.copyFile(lbugPath, snapshot);
    const groupDir = path.join(root, 'home', 'groups', 'integrity');
    await fs.mkdir(groupDir, { recursive: true });
    await fs.writeFile(
      path.join(groupDir, 'group.yaml'),
      JSON.stringify({ version: 1, name: 'integrity', repos: { service: 'repo' } }),
    );
  }, 120_000);

  beforeEach(({ skip }) => {
    if (!ftsLoaded) skip('FTS extension unavailable under the load-only policy');
  });

  afterAll(async () => {
    await adapter.closeLbug();
    vi.unstubAllEnvs();
    await temp?.cleanup();
  });

  async function query(
    mutate?: () => Promise<void>,
    legacy = false,
    target = repo,
    includeContent = true,
  ): Promise<any> {
    await fs.copyFile(snapshot, lbugPath);
    if (mutate) {
      await adapter.initLbug(lbugPath);
      try {
        await mutate();
      } finally {
        await adapter.closeLbug();
      }
    }
    const backend = new LocalBackend();
    await backend.init();
    const server = createMCPServer(backend);
    const client = new Client({ name: 'query-integrity-regression', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const args = {
      repo: target,
      [legacy ? 'query' : 'search_query']: 'integrityNeedle',
      include_content: includeContent,
      chain_depth: 1,
    };
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const result = await client.callTool({ name: 'query', arguments: args });
      expect(result.isError).not.toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      const text = content.find((item) => item.type === 'text')!.text;
      return JSON.parse(text);
    } finally {
      await client.close();
      await server.close();
      await backend.dispose();
    }
  }

  it('returns source-derived symbol identity, range and content', async () => {
    const result = await query();
    expect(result).not.toHaveProperty('error');
    expect(result).not.toHaveProperty('partial');
    expect([...result.process_symbols, ...result.definitions]).toContainEqual(
      expect.objectContaining({
        id: UID,
        name: 'integrityNeedle',
        filePath: 'src/fixture.ts',
        startLine: 1,
        endLine: 3,
        content: SOURCE.split('\n').slice(0, 3).join(' '),
      }),
    );
    expect(result.processes.length).toBeGreaterThan(0);
  });

  it.each(['x'.repeat(538_895), '"\\\n😀'.repeat(30_000)])(
    'bounds source previews in native queries without losing matches (%#)',
    async (source) => {
      const setSource = async () => {
        for (const label of ['Function', 'Class', 'Method', 'Struct', 'File']) {
          await adapter.executePrepared(`MATCH (n:${label}) SET n.content = $source`, { source });
        }
      };
      const before = await query(setSource, false, repo, false);
      const result = await query(setSource);
      expect(result).not.toHaveProperty('error');
      expect(result).not.toHaveProperty('partial');
      expect(result.processes).toEqual(before.processes);
      const rows = [...result.process_symbols, ...result.definitions];
      expect(rows.map(({ id, process_id }) => ({ id, process_id }))).toEqual(
        [...before.process_symbols, ...before.definitions].map(({ id, process_id }) => ({
          id,
          process_id,
        })),
      );
      const previews = rows.filter((row) => row.content !== undefined);
      expect(previews.some((row) => row.id === UID)).toBe(true);
      expect(new Set(previews.map((row) => row.id)).size).toBe(previews.length);
      expect(previews.reduce((sum, row) => sum + [...row.content].length, 0)).toBeLessThanOrEqual(
        16_000,
      );
      for (const row of previews) {
        expect(row.content.length).toBeGreaterThan(0);
        expect(source.startsWith(row.content)).toBe(true);
        expect(row.content).not.toContain('\uFFFD');
        expect(row.content_truncated).toBe(true);
      }
      const backend = new LocalBackend();
      try {
        await backend.init();
        const full = await backend.callTool('context', { repo, uid: UID, include_content: true });
        expect(full.symbol.content).toBe(source);
      } finally {
        await backend.dispose();
      }
    },
  );

  it.each([
    [
      'path inconsistent with the symbol UID',
      'MATCH (n:Function {id: $uid}) SET n.filePath = $value',
      'Sources/Unrelated.swift',
    ],
    ['NUL symbol name', 'MATCH (n:Function {id: $uid}) SET n.name = $value', 'invalid\0name'],
    ['NUL symbol path', 'MATCH (n:Function {id: $uid}) SET n.filePath = $value', 'invalid\0path'],
    ['NUL process label', 'MATCH (p:Process) SET p.label = $value', 'invalid\0process'],
    ['NUL cluster label', 'MATCH (c:Community) SET c.heuristicLabel = $value', 'invalid\0cluster'],
  ])(
    'rejects injected %s instead of returning success or a fallback',
    async (_name, statement, value) => {
      const result = await query(async () => {
        await adapter.executePrepared(statement, { uid: UID, value });
      }, true);
      expect(result.error).toContain('invalid symbol identity');
      expect(result.recoverySuggestion).toBe(SYMBOL_IDENTITY_RECOVERY_SUGGESTION);
      expect(result).not.toHaveProperty('definitions');
      expect(JSON.stringify(result)).not.toContain('\\u0000');
    },
  );

  it('rejects a blank UID read from native FTS instead of dropping it', async () => {
    const result = await query(async () => {
      await adapter.executeQuery(
        "CREATE (n:Function {id: '', name: 'integrityNeedle', filePath: 'src/fixture.ts', startLine: 0, endLine: 2})",
      );
      await adapter.dropFTSIndex('Function', 'function_fts');
      await adapter.createFTSIndex('Function', 'function_fts', ['name', 'content', 'description']);
    });
    expect(result.error).toContain('invalid symbol identity');
    expect(result.recoverySuggestion).toBe(SYMBOL_IDENTITY_RECOVERY_SUGGESTION);
    expect(result).not.toHaveProperty('definitions');
  });

  it.each([
    {
      table: 'Method',
      uid: 'Method:src/fixture.py:Fixture.integrityNeedle#0',
      field: 'filePath',
      value: 'src/fixture.swift',
    },
    {
      table: 'Struct',
      uid: 'Struct:src/fixture.swift:IntegrityNeedle',
      field: 'name',
      value: '\0\0\0\0',
    },
  ])('rejects the injected #3527 $table/$field shape', async ({ table, uid, field, value }) => {
    const result = await query(async () => {
      // Prove the source-derived fixture contains the target before injecting the fault.
      expect(
        await adapter.executePrepared(`MATCH (n:${table} {id: $uid}) RETURN n.id AS id`, { uid }),
      ).toEqual([{ id: uid }]);
      await adapter.executePrepared(`MATCH (n:${table} {id: $uid}) SET n.${field} = $value`, {
        uid,
        value,
      });
    });
    expect(result.error).toContain('invalid symbol identity');
    expect(result.recoverySuggestion).toBe(SYMBOL_IDENTITY_RECOVERY_SUGGESTION);
    expect(result).not.toHaveProperty('definitions');
  });

  it('accepts legacy missing process entry points and empty optional labels', async () => {
    const result = await query(async () => {
      await adapter.executeQuery(
        "MATCH (p:Process) SET p.entryPointId = NULL, p.heuristicLabel = ''",
      );
    });
    expect(result).not.toHaveProperty('error');
    expect(result.processes.length).toBeGreaterThan(0);
  });

  it('does not treat source content as an identity', async () => {
    const content = 'source text containing \0 is not an identity';
    const result = await query(async () => {
      await adapter.executePrepared('MATCH (n:Function {id: $uid}) SET n.content = $content', {
        uid: UID,
        content,
      });
    });
    expect(result).not.toHaveProperty('error');
    expect(result.process_symbols).toContainEqual(expect.objectContaining({ id: UID, content }));
  });

  it('rejects corrupt route enrichment rather than degrading to a route-less process', async () => {
    const result = await query(async () => {
      await adapter.executePrepared(
        "CREATE (r:Route {id: 'Route:injected', name: '/example', method: $method})",
        { method: 'GE\0T' },
      );
      await adapter.executeQuery(
        "MATCH (p:Process), (r:Route {id: 'Route:injected'}) CREATE (r)-[:CodeRelation {type: 'ENTRY_POINT_OF'}]->(p)",
      );
    });
    expect(result.error).toContain('invalid symbol identity');
    expect(result.recoverySuggestion).toBe(SYMBOL_IDENTITY_RECOVERY_SUGGESTION);
  });

  it('preserves the integrity error through a group query and its legacy query argument', async () => {
    const healthy = await query(undefined, true, '@integrity');
    expect(healthy).not.toHaveProperty('error');
    expect(healthy.results.length).toBeGreaterThan(0);
    const result = await query(
      async () => {
        await adapter.executePrepared('MATCH (n:Function {id: $uid}) SET n.name = $name', {
          uid: UID,
          name: 'invalid\0name',
        });
      },
      true,
      '@integrity',
    );
    expect(result.error).toContain('invalid symbol identity');
    expect(result.recoverySuggestion).toBe(SYMBOL_IDENTITY_RECOVERY_SUGGESTION);
    expect(result).not.toHaveProperty('results');
  });

  it('rejects corruption found only by concurrent chain enrichment', async () => {
    const result = await query(async () => {
      await adapter.executePrepared(
        "CREATE (n:Function {id: 'Function:chain-only', name: $name, filePath: 'src/fixture.ts'})",
        { name: 'invalid\0chain' },
      );
      await adapter.executeQuery(
        "MATCH (p:Process), (entry:Function), (n:Function {id: 'Function:chain-only'}) WHERE entry.id = p.entryPointId CREATE (entry)-[:CodeRelation {type: 'CALLS'}]->(n)",
      );
    });
    expect(result.error).toContain('invalid symbol identity');
    expect(result.recoverySuggestion).toBe(SYMBOL_IDENTITY_RECOVERY_SUGGESTION);
  });
});
