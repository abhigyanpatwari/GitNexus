import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

// ─── fs/promises mocks ────────────────────────────────────────────────────────
const mockMkdir = vi.fn();
const mockCopyFile = vi.fn();
const mockReaddir = vi.fn();

vi.mock('fs/promises', () => ({
  default: {
    mkdir: mockMkdir,
    copyFile: mockCopyFile,
    readdir: mockReaddir,
  },
}));

// ─── repo-manager mocks ───────────────────────────────────────────────────────
const mockFindRepo = vi.fn();

vi.mock('../../../src/storage/repo-manager.js', () => ({
  findRepo: mockFindRepo,
}));

// ─── lbug-adapter mocks ───────────────────────────────────────────────────────
const mockWithLbugDb = vi.fn();
const mockExecuteQuery = vi.fn();
const mockLoadJsonExtension = vi.fn();

vi.mock('../../../src/core/lbug/lbug-adapter.js', () => ({
  withLbugDb: mockWithLbugDb,
  executeQuery: mockExecuteQuery,
  loadJsonExtension: mockLoadJsonExtension,
}));

// ─── Fake repo fixture ────────────────────────────────────────────────────────
const fakeRepo = {
  repoPath: path.resolve('/repo'),
  storagePath: path.resolve('/repo/.gitnexus'),
  lbugPath: path.resolve('/repo/.gitnexus/lbug'),
  metaPath: path.resolve('/repo/.gitnexus/meta.json'),
  meta: { repoPath: path.resolve('/repo'), lastCommit: 'abc', indexedAt: '2026-01-01T00:00:00Z' },
};

describe('exportCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;

    // Default: repo is indexed
    mockFindRepo.mockResolvedValue(fakeRepo);

    // Default: export dir does not exist yet (readdir throws ENOENT)
    mockReaddir.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    // Default: mkdir and copyFile succeed
    mockMkdir.mockResolvedValue(undefined);
    mockCopyFile.mockResolvedValue(undefined);

    // Default: withLbugDb calls through
    mockWithLbugDb.mockImplementation(async (_dbPath: string, operation: () => Promise<void>) => {
      await operation();
    });

    // Default: JSON extension is available
    mockLoadJsonExtension.mockResolvedValue(true);

    // Default: executeQuery returns count=0 for all tables, [] for COPY/extension queries
    mockExecuteQuery.mockImplementation(async (cypher: string) => {
      if (cypher.includes('RETURN count')) return [{ cnt: 0 }];
      return [];
    });
  });

  it('fails cleanly when repo not indexed', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mockFindRepo.mockResolvedValue(null);

    const { exportCommand } = await import('../../../src/cli/export.js');
    await exportCommand(undefined, {});

    expect(process.exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('No indexed repository'));
    expect(mockWithLbugDb).not.toHaveBeenCalled();
  });

  it('default output path resolves to <storagePath>/export', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const expectedDir = path.join(fakeRepo.storagePath, 'export');

    const { exportCommand } = await import('../../../src/cli/export.js');
    await exportCommand(undefined, { force: true });

    expect(mockMkdir).toHaveBeenCalledWith(expectedDir, { recursive: true });
  });

  it('--output <dir> override uses provided path', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const customDir = path.resolve('/custom/export/dir');

    const { exportCommand } = await import('../../../src/cli/export.js');
    await exportCommand(undefined, { output: customDir, force: true });

    expect(mockMkdir).toHaveBeenCalledWith(customDir, { recursive: true });
  });

  it('skips empty tables — no COPY call when count is 0', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // All counts return 0 (default mock)

    const { exportCommand } = await import('../../../src/cli/export.js');
    await exportCommand(undefined, { force: true });

    const copyCalls = mockExecuteQuery.mock.calls.filter((args: any[]) =>
      (args[0] as string).trimStart().startsWith('COPY'),
    );
    expect(copyCalls).toHaveLength(0);
  });

  it('exports non-empty node tables with correct json filename', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exportDir = path.join(fakeRepo.storagePath, 'export');

    // Only Function table is non-empty
    mockExecuteQuery.mockImplementation(async (cypher: string) => {
      if (cypher.includes('RETURN count') && cypher.includes(':Function')) return [{ cnt: 10 }];
      if (cypher.includes('RETURN count')) return [{ cnt: 0 }];
      return [];
    });

    const { exportCommand } = await import('../../../src/cli/export.js');
    await exportCommand(undefined, { force: true });

    const copyCalls = mockExecuteQuery.mock.calls.filter((args: any[]) =>
      (args[0] as string).trimStart().startsWith('COPY'),
    );
    expect(copyCalls).toHaveLength(1);
    const copyQuery = copyCalls[0][0] as string;
    const expectedPath = path.join(exportDir, 'nodes_Function.json').replace(/\\/g, '/');
    expect(copyQuery).toContain(expectedPath);
    expect(copyQuery).not.toContain('FORMAT PARQUET');
  });

  it('exports edges when edge count is non-zero', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exportDir = path.join(fakeRepo.storagePath, 'export');

    mockExecuteQuery.mockImplementation(async (cypher: string) => {
      if (cypher.includes('RETURN count') && cypher.includes('CodeRelation')) return [{ cnt: 50 }];
      if (cypher.includes('RETURN count')) return [{ cnt: 0 }];
      return [];
    });

    const { exportCommand } = await import('../../../src/cli/export.js');
    await exportCommand(undefined, { force: true });

    const copyCalls = mockExecuteQuery.mock.calls.filter((args: any[]) =>
      (args[0] as string).trimStart().startsWith('COPY'),
    );
    expect(copyCalls).toHaveLength(1);
    const copyQuery = copyCalls[0][0] as string;
    const expectedPath = path.join(exportDir, 'edges_CodeRelation.json').replace(/\\/g, '/');
    expect(copyQuery).toContain(expectedPath);
    expect(copyQuery).toContain('CodeRelation');
    expect(copyQuery).not.toContain('FORMAT PARQUET');
  });

  it('--format parquet produces .parquet files', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exportDir = path.join(fakeRepo.storagePath, 'export');

    mockExecuteQuery.mockImplementation(async (cypher: string) => {
      if (cypher.includes('RETURN count') && cypher.includes(':Function')) return [{ cnt: 10 }];
      if (cypher.includes('RETURN count') && cypher.includes('CodeRelation')) return [{ cnt: 5 }];
      if (cypher.includes('RETURN count')) return [{ cnt: 0 }];
      return [];
    });

    const { exportCommand } = await import('../../../src/cli/export.js');
    await exportCommand(undefined, { force: true, format: 'parquet' });

    const copyCalls = mockExecuteQuery.mock.calls.filter((args: any[]) =>
      (args[0] as string).trimStart().startsWith('COPY'),
    );
    expect(copyCalls.length).toBeGreaterThanOrEqual(2);

    const nodeCopy = copyCalls.find((args: any[]) =>
      (args[0] as string).includes('nodes_Function'),
    );
    const edgeCopy = copyCalls.find((args: any[]) =>
      (args[0] as string).includes('edges_CodeRelation'),
    );
    expect(nodeCopy).toBeDefined();
    expect(edgeCopy).toBeDefined();

    const nodeQuery = nodeCopy![0] as string;
    const edgeQuery = edgeCopy![0] as string;
    expect(nodeQuery).toContain(path.join(exportDir, 'nodes_Function.parquet').replace(/\\/g, '/'));
    expect(nodeQuery).not.toContain('FORMAT PARQUET');
    expect(edgeQuery).toContain(
      path.join(exportDir, 'edges_CodeRelation.parquet').replace(/\\/g, '/'),
    );
    expect(edgeQuery).not.toContain('FORMAT PARQUET');
  });

  it('--format csv produces .csv files with CSV header clause', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exportDir = path.join(fakeRepo.storagePath, 'export');

    mockExecuteQuery.mockImplementation(async (cypher: string) => {
      if (cypher.includes('RETURN count') && cypher.includes(':Function')) return [{ cnt: 10 }];
      if (cypher.includes('RETURN count') && cypher.includes('CodeRelation')) return [{ cnt: 5 }];
      if (cypher.includes('RETURN count')) return [{ cnt: 0 }];
      return [];
    });

    const { exportCommand } = await import('../../../src/cli/export.js');
    await exportCommand(undefined, { force: true, format: 'csv' });

    const copyCalls = mockExecuteQuery.mock.calls.filter((args: any[]) =>
      (args[0] as string).trimStart().startsWith('COPY'),
    );
    expect(copyCalls.length).toBeGreaterThanOrEqual(2);

    const nodeCopy = copyCalls.find((args: any[]) =>
      (args[0] as string).includes('nodes_Function'),
    );
    const edgeCopy = copyCalls.find((args: any[]) =>
      (args[0] as string).includes('edges_CodeRelation'),
    );
    expect(nodeCopy).toBeDefined();
    expect(edgeCopy).toBeDefined();

    const nodeQuery = nodeCopy![0] as string;
    const edgeQuery = edgeCopy![0] as string;
    expect(nodeQuery).toContain(path.join(exportDir, 'nodes_Function.csv').replace(/\\/g, '/'));
    expect(nodeQuery).toContain('HEADER=true');
    expect(nodeQuery).not.toContain('FORMAT CSV');
    expect(nodeQuery).not.toContain('FORMAT PARQUET');
    expect(edgeQuery).toContain(path.join(exportDir, 'edges_CodeRelation.csv').replace(/\\/g, '/'));
    expect(edgeQuery).toContain('HEADER=true');
    expect(edgeQuery).not.toContain('FORMAT CSV');
    expect(edgeQuery).not.toContain('FORMAT PARQUET');
  });

  it('default produces .json files', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exportDir = path.join(fakeRepo.storagePath, 'export');

    mockExecuteQuery.mockImplementation(async (cypher: string) => {
      if (cypher.includes('RETURN count') && cypher.includes(':Function')) return [{ cnt: 10 }];
      if (cypher.includes('RETURN count') && cypher.includes('CodeRelation')) return [{ cnt: 5 }];
      if (cypher.includes('RETURN count')) return [{ cnt: 0 }];
      return [];
    });

    const { exportCommand } = await import('../../../src/cli/export.js');
    await exportCommand(undefined, { force: true });

    const copyCalls = mockExecuteQuery.mock.calls.filter((args: any[]) =>
      (args[0] as string).trimStart().startsWith('COPY'),
    );
    expect(copyCalls.length).toBeGreaterThanOrEqual(2);

    const nodeCopy = copyCalls.find((args: any[]) =>
      (args[0] as string).includes('nodes_Function'),
    );
    const edgeCopy = copyCalls.find((args: any[]) =>
      (args[0] as string).includes('edges_CodeRelation'),
    );
    expect(nodeCopy).toBeDefined();
    expect(edgeCopy).toBeDefined();

    const nodeQuery = nodeCopy![0] as string;
    const edgeQuery = edgeCopy![0] as string;
    expect(nodeQuery).toContain(path.join(exportDir, 'nodes_Function.json').replace(/\\/g, '/'));
    expect(nodeQuery).not.toContain('FORMAT PARQUET');
    expect(edgeQuery).toContain(
      path.join(exportDir, 'edges_CodeRelation.json').replace(/\\/g, '/'),
    );
    expect(edgeQuery).not.toContain('FORMAT PARQUET');
  });

  it('embeddings omitted by default (no --embeddings flag)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // Make all tables non-empty to confirm it's specifically embeddings being omitted
    mockExecuteQuery.mockImplementation(async (cypher: string) => {
      if (cypher.includes('RETURN count')) return [{ cnt: 5 }];
      return [];
    });

    const { exportCommand } = await import('../../../src/cli/export.js');
    await exportCommand(undefined, { force: true }); // no embeddings flag

    const copyCalls = mockExecuteQuery.mock.calls.filter((args: any[]) =>
      (args[0] as string).trimStart().startsWith('COPY'),
    );
    const embeddingCopy = copyCalls.find((args: any[]) =>
      (args[0] as string).includes('CodeEmbedding'),
    );
    expect(embeddingCopy).toBeUndefined();
  });

  it('--embeddings includes embeddings table when non-empty', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exportDir = path.join(fakeRepo.storagePath, 'export');

    mockExecuteQuery.mockImplementation(async (cypher: string) => {
      if (cypher.includes('RETURN count') && cypher.includes('CodeEmbedding')) return [{ cnt: 5 }];
      if (cypher.includes('RETURN count')) return [{ cnt: 0 }];
      return [];
    });

    const { exportCommand } = await import('../../../src/cli/export.js');
    await exportCommand(undefined, { force: true, embeddings: true });

    const copyCalls = mockExecuteQuery.mock.calls.filter((args: any[]) =>
      (args[0] as string).trimStart().startsWith('COPY'),
    );
    const embeddingCopy = copyCalls.find((args: any[]) =>
      (args[0] as string).includes('CodeEmbedding'),
    );
    expect(embeddingCopy).toBeDefined();
    expect(embeddingCopy![0] as string).toContain(
      path.join(exportDir, 'embeddings_CodeEmbedding.json').replace(/\\/g, '/'),
    );
  });

  it('default export (no --embeddings) still exports node and edge tables', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // Function and edges are non-empty
    mockExecuteQuery.mockImplementation(async (cypher: string) => {
      if (cypher.includes('RETURN count') && cypher.includes(':Function')) return [{ cnt: 5 }];
      if (cypher.includes('RETURN count') && cypher.includes('CodeRelation')) return [{ cnt: 5 }];
      if (cypher.includes('RETURN count')) return [{ cnt: 0 }];
      return [];
    });

    const { exportCommand } = await import('../../../src/cli/export.js');
    await exportCommand(undefined, { force: true }); // no embeddings flag

    const copyCalls = mockExecuteQuery.mock.calls.filter((args: any[]) =>
      (args[0] as string).trimStart().startsWith('COPY'),
    );
    const nodeCopy = copyCalls.find((args: any[]) =>
      (args[0] as string).includes('nodes_Function'),
    );
    const edgeCopy = copyCalls.find((args: any[]) =>
      (args[0] as string).includes('edges_CodeRelation'),
    );
    expect(nodeCopy).toBeDefined();
    expect(edgeCopy).toBeDefined();
  });

  it('--embeddings skips COPY when embeddings table is empty', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    mockExecuteQuery.mockImplementation(async (cypher: string) => {
      if (cypher.includes('RETURN count') && cypher.includes('CodeEmbedding')) return [{ cnt: 0 }];
      if (cypher.includes('RETURN count')) return [{ cnt: 0 }];
      return [];
    });

    const { exportCommand } = await import('../../../src/cli/export.js');
    await exportCommand(undefined, { force: true, embeddings: true });

    const embeddingCopy = mockExecuteQuery.mock.calls.find(
      (args: any[]) =>
        (args[0] as string).trimStart().startsWith('COPY') &&
        (args[0] as string).includes('CodeEmbedding'),
    );
    expect(embeddingCopy).toBeUndefined();
  });

  it('forward-slash path passed to COPY even on Windows-style paths', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    mockExecuteQuery.mockImplementation(async (cypher: string) => {
      if (cypher.includes('RETURN count') && cypher.includes(':Function')) return [{ cnt: 10 }];
      if (cypher.includes('RETURN count')) return [{ cnt: 0 }];
      return [];
    });

    const { exportCommand } = await import('../../../src/cli/export.js');
    await exportCommand(undefined, { force: true });

    const copyCalls = mockExecuteQuery.mock.calls.filter((args: any[]) =>
      (args[0] as string).trimStart().startsWith('COPY'),
    );
    for (const args of copyCalls) {
      expect(args[0] as string).not.toMatch(/\\/);
    }
  });

  it('--force skips confirmation — exports without checking existing files', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const { exportCommand } = await import('../../../src/cli/export.js');
    await exportCommand(undefined, { force: true });

    // readdir should NOT have been called when --force is set
    expect(mockReaddir).not.toHaveBeenCalled();
    // DB was opened
    expect(mockWithLbugDb).toHaveBeenCalled();
  });

  it('confirmation prompt on existing dir — returns early without exporting', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Export dir has existing files
    mockReaddir.mockResolvedValue(['old_file.parquet']);

    const { exportCommand } = await import('../../../src/cli/export.js');
    await exportCommand(undefined, {}); // no --force

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('already contains files'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('--force'));
    expect(mockWithLbugDb).not.toHaveBeenCalled();
  });

  it('json format — extension unavailable: errors out, skips export and meta.json copy', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mockLoadJsonExtension.mockResolvedValue(false);

    const { exportCommand } = await import('../../../src/cli/export.js');
    await exportCommand(undefined, { force: true }); // default json format

    expect(process.exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('JSON extension unavailable'));
    const copyCalls = mockExecuteQuery.mock.calls.filter((args: any[]) =>
      (args[0] as string).trimStart().startsWith('COPY'),
    );
    expect(copyCalls).toHaveLength(0);
    expect(mockCopyFile).not.toHaveBeenCalled();
  });

  it('meta.json is always copied to the export directory', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exportDir = path.join(fakeRepo.storagePath, 'export');

    const { exportCommand } = await import('../../../src/cli/export.js');
    await exportCommand(undefined, { force: true });

    expect(mockCopyFile).toHaveBeenCalledWith(fakeRepo.metaPath, path.join(exportDir, 'meta.json'));
  });

  it('summary output mentions the export directory and file count', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exportDir = path.join(fakeRepo.storagePath, 'export');

    const { exportCommand } = await import('../../../src/cli/export.js');
    await exportCommand(undefined, { force: true });

    // Should log summary with exportDir and file count
    const summaryCall = logSpy.mock.calls.find(
      ([msg]) => typeof msg === 'string' && msg.includes(exportDir),
    );
    expect(summaryCall).toBeDefined();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('file(s)'));
  });

  it('backtick-reserved table names are backtick-escaped in Cypher', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // Make Struct (backtick-required) and Function (unquoted) both non-empty
    mockExecuteQuery.mockImplementation(async (cypher: string) => {
      if (cypher.includes('RETURN count') && cypher.includes('`Struct`')) return [{ cnt: 5 }];
      if (cypher.includes('RETURN count') && cypher.includes(':Struct')) return [{ cnt: 5 }];
      if (cypher.includes('RETURN count') && cypher.includes(':Function')) return [{ cnt: 5 }];
      if (cypher.includes('RETURN count')) return [{ cnt: 0 }];
      return [];
    });

    const { exportCommand } = await import('../../../src/cli/export.js');
    await exportCommand(undefined, { force: true });

    const copyCalls = mockExecuteQuery.mock.calls.filter((args: any[]) =>
      (args[0] as string).trimStart().startsWith('COPY'),
    );

    const structCopy = copyCalls.find((args: any[]) =>
      (args[0] as string).includes('nodes_Struct'),
    );
    const functionCopy = copyCalls.find((args: any[]) =>
      (args[0] as string).includes('nodes_Function'),
    );

    expect(structCopy).toBeDefined();
    // Struct must be backtick-escaped in the MATCH clause
    expect(structCopy![0] as string).toMatch(/MATCH \(n:`Struct`\)/);

    expect(functionCopy).toBeDefined();
    // Function must NOT be backtick-escaped
    expect(functionCopy![0] as string).toMatch(/MATCH \(n:Function\)/);
    expect(functionCopy![0] as string).not.toMatch(/MATCH \(n:`Function`\)/);
  });
});
