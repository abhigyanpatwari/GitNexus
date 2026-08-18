import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { statusCommand } from '../../src/cli/status.js';
import { getStoragePaths, loadMeta } from '../../src/storage/repo-manager.js';

const savedStoragePath = process.env.GITNEXUS_STORAGE_PATH;
const savedRetention = process.env.GITNEXUS_CONTENT_RETENTION;
const savedHome = process.env.GITNEXUS_HOME;
const temporaryPaths: string[] = [];

const makeTempDir = async (prefix: string): Promise<string> => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
};

const restoreEnvironment = () => {
  if (savedStoragePath === undefined) delete process.env.GITNEXUS_STORAGE_PATH;
  else process.env.GITNEXUS_STORAGE_PATH = savedStoragePath;
  if (savedRetention === undefined) delete process.env.GITNEXUS_CONTENT_RETENTION;
  else process.env.GITNEXUS_CONTENT_RETENTION = savedRetention;
  if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
  else process.env.GITNEXUS_HOME = savedHome;
};

afterEach(async () => {
  restoreEnvironment();
  await Promise.all(
    temporaryPaths.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

const recursiveSize = async (target: string): Promise<number> => {
  const stat = await fs.lstat(target);
  if (!stat.isDirectory()) return stat.size;
  const entries = await fs.readdir(target);
  return (
    await Promise.all(entries.map((entry) => recursiveSize(path.join(target, entry))))
  ).reduce((total, size) => total + size, 0);
};

const readGraph = async (lbugPath: string) => {
  const adapter = await import('../../src/core/lbug/lbug-adapter.js');
  try {
    return await adapter.withLbugDb(
      lbugPath,
      async () => {
        const [nodes, edges, files, functions, basicBlocks, basicBlockCount] = await Promise.all([
          adapter.executeQuery('MATCH (n) RETURN count(n) AS count'),
          adapter.executeQuery(
            'MATCH (source)-[r:CodeRelation]->(target) RETURN count(r) AS count',
          ),
          adapter.executeQuery(
            "MATCH (n:File) WHERE n.filePath = 'src/fixture.ts' RETURN n.content AS content",
          ),
          adapter.executeQuery(
            "MATCH (n:Function) WHERE n.name = 'retentionFixture' RETURN n.content AS content, n.description AS description",
          ),
          adapter.executeQuery('MATCH (n:BasicBlock) RETURN n.text AS text LIMIT 1'),
          adapter.executeQuery('MATCH (n:BasicBlock) RETURN count(n) AS count'),
        ]);
        const count = (rows: any[]) => Number(rows[0]?.count ?? rows[0]?.[0] ?? 0);
        return {
          nodes: count(nodes),
          edges: count(edges),
          fileContent: files[0]?.content ?? files[0]?.[0],
          functionContent: functions[0]?.content ?? functions[0]?.[0],
          functionDescription: functions[0]?.description ?? functions[0]?.[1],
          basicBlockText: basicBlocks[0]?.text ?? basicBlocks[0]?.[0],
          basicBlockCount: count(basicBlockCount),
        };
      },
      { readOnly: true },
    );
  } finally {
    await adapter.closeLbug();
  }
};

describe('external storage and content retention', () => {
  it('keeps the full index outside the checkout, rebuilds on retention changes, and remains queryable after checkout removal', async () => {
    const repo = await makeTempDir('gitnexus-run-analyze-retention-repo-');
    const storage = await makeTempDir('gitnexus-run-analyze-retention-storage-');
    const home = await makeTempDir('gitnexus-run-analyze-retention-home-');
    await fs.mkdir(path.join(repo, 'src'));
    await fs.writeFile(
      path.join(repo, 'src/fixture.ts'),
      `/** retention fixture documentation */\nexport function retentionFixture(enabled = true) {\n  const payload = '${'fullRetentionPayload '.repeat(20_000)}';\n  if (enabled) return payload;\n  return '';\n}\n`,
    );
    process.env.GITNEXUS_HOME = home;
    process.env.GITNEXUS_STORAGE_PATH = storage;
    process.env.GITNEXUS_CONTENT_RETENTION = 'full';

    const logs: string[] = [];
    const options = {
      force: true,
      skipGit: true,
      skipAgentsMd: true,
      skipSkills: true,
      workerPoolSize: 1,
      pdg: true,
      streamPdgEmit: true,
      registryName: 'retention-fixture',
    };
    await runFullAnalysis(repo, options, {
      onProgress: () => undefined,
      onLog: (message) => logs.push(message),
    });

    const initialMeta = await loadMeta(storage);
    const { lbugPath } = getStoragePaths(repo);
    const fullGraph = await readGraph(lbugPath);
    const fullDatabaseSize = await recursiveSize(lbugPath);
    expect(initialMeta).toMatchObject({
      repoPath: repo,
      storagePath: storage,
      contentRetention: 'full',
      contentRetentionSchemaVersion: 1,
      ftsProfile: 'full',
    });
    await expect(fs.access(path.join(repo, '.gitnexus'))).rejects.toThrow();
    expect(fullGraph.fileContent).toContain('fullRetentionPayload');
    expect(fullGraph.functionContent).toContain('retentionFixture');
    expect(fullGraph.basicBlockCount).toBeGreaterThan(0);

    process.env.GITNEXUS_CONTENT_RETENTION = 'symbol';
    await runFullAnalysis(
      repo,
      { ...options, force: false },
      {
        onProgress: () => undefined,
        onLog: (message) => logs.push(message),
      },
    );
    const symbolMeta = await loadMeta(storage);
    const symbolGraph = await readGraph(lbugPath);
    const symbolDatabaseSize = await recursiveSize(lbugPath);
    expect(logs.join('\n')).toContain('forcing a full rebuild');
    expect(symbolMeta).toMatchObject({
      contentRetention: 'symbol',
      contentRetentionSchemaVersion: 1,
      ftsProfile: 'symbol-no-file-content',
    });
    expect(symbolGraph).toMatchObject({ nodes: fullGraph.nodes, edges: fullGraph.edges });
    expect(symbolGraph.fileContent).toBeUndefined();
    expect(symbolGraph.functionContent).toContain('retentionFixture');
    expect(symbolGraph.basicBlockCount).toBe(fullGraph.basicBlockCount);
    expect(symbolDatabaseSize).toBeLessThan(fullDatabaseSize);

    process.env.GITNEXUS_CONTENT_RETENTION = 'none';
    await runFullAnalysis(
      repo,
      { ...options, force: false },
      {
        onProgress: () => undefined,
        onLog: (message) => logs.push(message),
      },
    );
    const noneMeta = await loadMeta(storage);
    expect(noneMeta).toMatchObject({
      contentRetention: 'none',
      contentRetentionSchemaVersion: 1,
      ftsProfile: 'name-only',
    });

    await fs.rm(repo, { recursive: true, force: true });
    const output: string[] = [];
    const logSpy = vi
      .spyOn(console, 'log')
      .mockImplementation((value) => output.push(String(value)));
    try {
      await statusCommand({ repo: 'retention-fixture', json: true });
    } finally {
      logSpy.mockRestore();
    }
    expect(JSON.parse(output[0])).toMatchObject({
      storagePath: storage,
      sourceAvailable: false,
      status: 'source-unavailable',
      index: { contentRetention: 'none' },
    });

    const backend = new LocalBackend();
    try {
      await backend.init();
      const context = await backend.callTool('context', {
        name: 'retentionFixture',
        repo: 'retention-fixture',
        include_content: true,
      });
      expect(context).toMatchObject({
        status: 'found',
        contentAvailability: {
          requested: true,
          profile: 'none',
          available: false,
          scope: 'none',
        },
      });
      expect(context.symbol.content).toBeUndefined();
    } finally {
      await backend.disconnect();
    }

    const noneGraph = await readGraph(lbugPath);
    expect(noneGraph).toMatchObject({ nodes: fullGraph.nodes, edges: fullGraph.edges });
    expect(noneGraph.fileContent).toBeUndefined();
    expect(noneGraph.functionContent).toBeUndefined();
    expect(noneGraph.functionDescription).toBeUndefined();
    expect(noneGraph.basicBlockCount).toBe(fullGraph.basicBlockCount);
    expect(noneGraph.basicBlockText).toBeUndefined();
  }, 120_000);
});
