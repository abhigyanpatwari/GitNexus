/** Persisted Elixir PDG/taint integration coverage. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import {
  loadParseCache,
  PARSE_CACHE_VERSION,
  pruneCache,
  saveParseCache,
  type ParseCache,
} from '../../src/storage/parse-cache.js';
import {
  getDurableParsedFileDir,
  pruneAndSaveDurableParsedFileStore,
} from '../../src/storage/parsedfile-store.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/storage/repo-manager.js')>()),
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
  findSiblingClones: vi.fn().mockResolvedValue([]),
}));

let fixtureRoot = '';

function writeFixture(root: string): void {
  fs.mkdirSync(path.join(root, 'lib/my_app'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'lib/my_app/security.ex'),
    `
defmodule MyApp.Security do
  def vulnerable(conn, params) do
    code = conn.params["code"]
    sql = params["sql"]
    Code.eval_string(code)
    Repo.query!(sql)
    Repo.query!("select * from posts where id = ?", [sql])
  end

  def guarded(value) when value != nil do
    rebound = value
    if rebound do
      result = rebound
      Code.eval_string(result)
    else
      :ok
    end
  end

  def closure(value) do
    fn arg -> result = value <> arg; Code.eval_string(result) end
  end

  def mailbox do
    receive do message -> message end
  end
end
`,
  );
}

afterAll(() => {
  if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

withTestLbugDB(
  'elixir-pdg-persistence',
  (handle) => {
    describe('persisted Elixir PDG and taint', () => {
      let backend: LocalBackend;
      beforeAll(() => {
        const extended = handle as typeof handle & { _backend?: LocalBackend };
        if (!extended._backend) throw new Error('LocalBackend not initialized');
        backend = extended._backend;
      });

      it('surfaces only dynamic-eval and raw-SQL taint findings after COPY persistence', async () => {
        const result = (await backend.callTool('explain', { target: 'vulnerable' })) as any;
        expect(result).not.toHaveProperty('error');
        expect(result.findings.map((finding: any) => finding.sinkKind).sort()).toEqual([
          'code-injection',
          'sql-injection',
        ]);
        expect(result.findings.some((finding: any) => finding.sink?.line === 8)).toBe(false);
      });

      it('persists representative CDG and reaching-definition results without receive cross-process flow', async () => {
        const controls = (await backend.callTool('pdg_query', {
          mode: 'controls',
          target: 'guarded',
        })) as any;
        const flows = (await backend.callTool('pdg_query', {
          mode: 'flows',
          target: 'guarded',
          variable: 'rebound',
        })) as any;
        expect(controls).not.toHaveProperty('error');
        expect(controls.results.length).toBeGreaterThan(0);
        expect(flows).not.toHaveProperty('error');
        expect(flows.results.length).toBeGreaterThan(0);
        expect(JSON.stringify([...controls.results, ...flows.results])).not.toMatch(
          /message-delivery/i,
        );
      });
    });
  },
  {
    poolAdapter: true,
    beforeFTS: async (dbPath) => {
      fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-elixir-pdg-'));
      writeFixture(fixtureRoot);
      const cachePath = path.join(fixtureRoot, '.cache');
      const cache: ParseCache = {
        version: PARSE_CACHE_VERSION,
        entries: new Map(),
        usedKeys: new Set(),
        storagePath: cachePath,
        onDiskKeys: new Set(),
      };
      const cold = await runPipelineFromRepo(fixtureRoot, () => {}, {
        pdg: true,
        parseCache: cache,
        workerPoolSize: 1,
      });
      pruneCache(cache, cache.usedKeys);
      const saved = await saveParseCache(cachePath, cache);
      await pruneAndSaveDurableParsedFileStore(
        getDurableParsedFileDir(cachePath),
        PARSE_CACHE_VERSION,
        new Set(saved),
      );
      const warm = await loadParseCache(cachePath);
      const replay = await runPipelineFromRepo(fixtureRoot, () => {}, {
        pdg: true,
        parseCache: warm ?? undefined,
        workerPoolSize: 1,
      });
      const normal = await runPipelineFromRepo(fixtureRoot, () => {}, { workerPoolSize: 1 });
      expect(cold.usedWorkerPool).toBe(true);
      expect(replay.usedWorkerPool).toBe(false);
      expect(
        [...replay.graph.iterRelationships()]
          .filter((rel) => ['CDG', 'REACHING_DEF', 'TAINTED'].includes(rel.type))
          .map((rel) => `${rel.type}:${rel.reason}`)
          .sort(),
      ).toEqual(
        [...cold.graph.iterRelationships()]
          .filter((rel) => ['CDG', 'REACHING_DEF', 'TAINTED'].includes(rel.type))
          .map((rel) => `${rel.type}:${rel.reason}`)
          .sort(),
      );
      expect(
        [...cold.graph.iterNodes()].filter((node) => node.label === 'BasicBlock').length,
      ).toBeGreaterThan(0);
      expect([...cold.graph.iterRelationships()].some((rel) => rel.type === 'TAINTED')).toBe(true);
      expect(
        [...normal.graph.iterNodes()].filter((node) => node.label === 'BasicBlock'),
      ).toHaveLength(0);
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      await adapter.loadGraphToLbug(cold.graph, fixtureRoot, path.dirname(dbPath));
    },
    afterSetup: async (handle) => {
      vi.mocked(listRegisteredRepos).mockResolvedValue([
        {
          name: 'elixir-pdg-repo',
          path: fixtureRoot,
          storagePath: handle.tmpHandle.dbPath,
          indexedAt: new Date().toISOString(),
          lastCommit: 'elixir-pdg',
          stats: { files: 1, nodes: 1, communities: 0, processes: 0 },
        },
      ]);
      const backend = new LocalBackend();
      await backend.init();
      (handle as any)._backend = backend;
    },
  },
);
