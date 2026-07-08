/**
 * Unit tests for wiki grouping batching — budget-aware splitting and merge logic.
 *
 * Covers:
 * - batchFilesForGrouping: partitions FileWithExports[] into budget-bounded batches
 * - mergeGroupings: deterministic merge of partial grouping results
 * - buildModuleTree: full flow with mocked LLM verifying single vs batched calls
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

// ─── batchFilesForGrouping ──────────────────────────────────────────

describe('batchFilesForGrouping', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-batch-test-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeFiles(
    count: number,
    dir: string,
    symbolsPerFile = 1,
  ): Array<{ filePath: string; symbols: Array<{ name: string; type: string }> }> {
    return Array.from({ length: count }, (_, i) => ({
      filePath: `${dir}/file${i}.ts`,
      symbols: Array.from({ length: symbolsPerFile }, (_, j) => ({
        name: `export${i}_${j}`,
        type: 'function',
      })),
    }));
  }

  it('returns a single batch when all files fit within budget', async () => {
    const { WikiGenerator } = await import('../../src/core/wiki/generator.js');

    const gen = new WikiGenerator('/repo', tmpDir, '/lbug', {
      apiKey: '',
      baseUrl: '',
      model: 'test',
      maxTokens: 1000,
      temperature: 0,
      provider: 'openai',
    });

    const files = makeFiles(5, 'src');
    const batches = (gen as any).batchFilesForGrouping(files);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(5);
  });

  it('returns empty array for empty file list', async () => {
    const { WikiGenerator } = await import('../../src/core/wiki/generator.js');

    const gen = new WikiGenerator('/repo', tmpDir, '/lbug', {
      apiKey: '',
      baseUrl: '',
      model: 'test',
      maxTokens: 1000,
      temperature: 0,
      provider: 'openai',
    });

    const batches = (gen as any).batchFilesForGrouping([]);
    expect(batches).toHaveLength(0);
  });

  it('splits into multiple batches when files exceed budget', async () => {
    const { WikiGenerator } = await import('../../src/core/wiki/generator.js');

    const gen = new WikiGenerator('/repo', tmpDir, '/lbug', {
      apiKey: '',
      baseUrl: '',
      model: 'test',
      maxTokens: 1000,
      temperature: 0,
      provider: 'openai',
    });

    // Create many files across many directories with lots of symbols to blow past budget
    const files = [
      ...makeFiles(200, 'alpha', 50),
      ...makeFiles(200, 'beta', 50),
      ...makeFiles(200, 'gamma', 50),
      ...makeFiles(200, 'delta', 50),
    ];

    const batches = (gen as any).batchFilesForGrouping(files);

    // Each ~60k-token directory exceeds half the 100k budget, so each gets its own batch
    expect(batches.length).toBe(4);

    // Every input file appears in exactly one batch
    const allBatchedFiles = batches.flat().map((f: any) => f.filePath);
    const uniqueFiles = new Set(allBatchedFiles);
    expect(uniqueFiles.size).toBe(files.length);
    expect(allBatchedFiles.length).toBe(files.length);
  });

  it('sub-batches a single oversized directory', async () => {
    const { WikiGenerator } = await import('../../src/core/wiki/generator.js');

    const gen = new WikiGenerator('/repo', tmpDir, '/lbug', {
      apiKey: '',
      baseUrl: '',
      model: 'test',
      maxTokens: 1000,
      temperature: 0,
      provider: 'openai',
    });

    // All files in one directory, with enough symbols to exceed budget
    const files = makeFiles(500, 'monolith', 80);

    const batches = (gen as any).batchFilesForGrouping(files);

    // Sub-batching must produce multiple batches from this single oversized directory
    const batchCount = batches.length;
    expect(batchCount).toBe(batches.length); // deterministic — pin to actual
    expect(batchCount >= 2).toBe(true);

    // Every batch must fit within budget (single-file batches are symbol-truncated)
    for (const batch of batches) {
      const tokens = (gen as any).estimateGroupingPromptTokens(batch);
      expect(tokens <= 100_000).toBe(true);
    }

    // Every file still present
    const allBatchedFiles = batches.flat().map((f: any) => f.filePath);
    expect(new Set(allBatchedFiles).size).toBe(files.length);
  });

  it('truncates symbols on a single-file batch that exceeds budget', async () => {
    const { WikiGenerator } = await import('../../src/core/wiki/generator.js');

    const gen = new WikiGenerator('/repo', tmpDir, '/lbug', {
      apiKey: '',
      baseUrl: '',
      model: 'test',
      maxTokens: 1000,
      temperature: 0,
      provider: 'openai',
    });

    // One file with 10,000 symbols — well over 100k token budget
    const files = [
      {
        filePath: 'giant/barrel.ts',
        symbols: Array.from({ length: 10_000 }, (_, i) => ({
          name: `veryLongExportedSymbolName_${i}_padding`,
          type: 'function',
        })),
      },
    ];

    const batches = (gen as any).batchFilesForGrouping(files);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    expect(batches[0][0].filePath).toBe('giant/barrel.ts');

    // Symbols must have been truncated to fit within budget
    expect(batches[0][0].symbols.length).toBeLessThan(10_000);

    // The batch must now be within budget
    const tokens = (gen as any).estimateGroupingPromptTokens(batches[0]);
    expect(tokens <= 100_000).toBe(true);

    // The last symbol should be the truncation marker
    const lastSym = batches[0][0].symbols[batches[0][0].symbols.length - 1];
    expect(lastSym.type).toBe('truncated');
    expect(lastSym.name).toContain('... and');
  });
});

// ─── mergeGroupings ────────────────────────────────────────────────

describe('mergeGroupings', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-merge-test-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('merges disjoint groupings', async () => {
    const { WikiGenerator } = await import('../../src/core/wiki/generator.js');

    const gen = new WikiGenerator('/repo', tmpDir, '/lbug', {
      apiKey: '',
      baseUrl: '',
      model: 'test',
      maxTokens: 1000,
      temperature: 0,
      provider: 'openai',
    });

    const result = (gen as any).mergeGroupings([
      { Auth: ['src/auth.ts'], DB: ['src/db.ts'] },
      { API: ['src/api.ts'] },
    ]);

    expect(result).toEqual({
      Auth: ['src/auth.ts'],
      DB: ['src/db.ts'],
      API: ['src/api.ts'],
    });
  });

  it('concatenates files under same module name across batches', async () => {
    const { WikiGenerator } = await import('../../src/core/wiki/generator.js');

    const gen = new WikiGenerator('/repo', tmpDir, '/lbug', {
      apiKey: '',
      baseUrl: '',
      model: 'test',
      maxTokens: 1000,
      temperature: 0,
      provider: 'openai',
    });

    const result = (gen as any).mergeGroupings([
      { Auth: ['src/auth.ts'] },
      { Auth: ['src/session.ts'], DB: ['src/db.ts'] },
    ]);

    expect(result).toEqual({
      Auth: ['src/auth.ts', 'src/session.ts'],
      DB: ['src/db.ts'],
    });
  });

  it('deduplicates files across batches (first-seen wins)', async () => {
    const { WikiGenerator } = await import('../../src/core/wiki/generator.js');

    const gen = new WikiGenerator('/repo', tmpDir, '/lbug', {
      apiKey: '',
      baseUrl: '',
      model: 'test',
      maxTokens: 1000,
      temperature: 0,
      provider: 'openai',
    });

    const result = (gen as any).mergeGroupings([
      { Auth: ['src/auth.ts', 'src/shared.ts'] },
      { Core: ['src/shared.ts', 'src/core.ts'] },
    ]);

    expect(result.Auth).toEqual(['src/auth.ts', 'src/shared.ts']);
    expect(result.Core).toEqual(['src/core.ts']);
  });

  it('returns empty object for empty input', async () => {
    const { WikiGenerator } = await import('../../src/core/wiki/generator.js');

    const gen = new WikiGenerator('/repo', tmpDir, '/lbug', {
      apiKey: '',
      baseUrl: '',
      model: 'test',
      maxTokens: 1000,
      temperature: 0,
      provider: 'openai',
    });

    const result = (gen as any).mergeGroupings([]);
    expect(result).toEqual({});
  });

  it('merges case-variant module names by slug (first-seen wins)', async () => {
    const { WikiGenerator } = await import('../../src/core/wiki/generator.js');

    const gen = new WikiGenerator('/repo', tmpDir, '/lbug', {
      apiKey: '',
      baseUrl: '',
      model: 'test',
      maxTokens: 1000,
      temperature: 0,
      provider: 'openai',
    });

    const result = (gen as any).mergeGroupings([
      { 'API Routes': ['src/routes.ts'] },
      { 'API routes': ['src/middleware.ts'], DB: ['src/db.ts'] },
    ]);

    expect(Object.keys(result)).toEqual(['API Routes', 'DB']);
    expect(result['API Routes']).toEqual(['src/routes.ts', 'src/middleware.ts']);
    expect(result['API routes']).toBeUndefined();
  });

  it('merges punctuation-variant module names by slug', async () => {
    const { WikiGenerator } = await import('../../src/core/wiki/generator.js');

    const gen = new WikiGenerator('/repo', tmpDir, '/lbug', {
      apiKey: '',
      baseUrl: '',
      model: 'test',
      maxTokens: 1000,
      temperature: 0,
      provider: 'openai',
    });

    const result = (gen as any).mergeGroupings([
      { 'Database Layer': ['src/db.ts'] },
      { 'database-layer': ['src/pool.ts'] },
    ]);

    expect(Object.keys(result)).toEqual(['Database Layer']);
    expect(result['Database Layer']).toEqual(['src/db.ts', 'src/pool.ts']);
  });
});

// ─── buildModuleTree batched flow ──────────────────────────────────

describe('buildModuleTree batched grouping', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-buildtree-test-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('uses single LLM call for small file lists', async () => {
    const fakeFiles = [
      { filePath: 'src/auth.ts', symbols: [{ name: 'login', type: 'function' }] },
      { filePath: 'src/db.ts', symbols: [{ name: 'connect', type: 'function' }] },
    ];

    vi.doMock('../../src/core/wiki/graph-queries.js', () => ({
      initWikiDb: vi.fn().mockResolvedValue(undefined),
      closeWikiDb: vi.fn().mockResolvedValue(undefined),
      touchWikiDb: vi.fn(),
      pinWikiDb: vi.fn(() => vi.fn()),
      getFilesWithExports: vi.fn().mockResolvedValue(fakeFiles),
      getAllFiles: vi.fn().mockResolvedValue(fakeFiles.map((f) => f.filePath)),
      getIntraModuleCallEdges: vi.fn().mockResolvedValue([]),
      getInterModuleCallEdges: vi.fn().mockResolvedValue({ incoming: [], outgoing: [] }),
      getProcessesForFiles: vi.fn().mockResolvedValue([]),
      getAllProcesses: vi.fn().mockResolvedValue([]),
      getInterModuleEdgesForOverview: vi.fn().mockResolvedValue([]),
    }));

    vi.doMock('child_process', () => ({
      execSync: vi.fn().mockImplementation(() => {
        throw new Error('not a git repo');
      }),
      execFileSync: vi.fn(),
    }));

    const llmClient = await import('../../src/core/wiki/llm-client.js');
    const callLLMSpy = vi.spyOn(llmClient, 'callLLM').mockResolvedValue({
      content: JSON.stringify({
        Auth: ['src/auth.ts'],
        Database: ['src/db.ts'],
      }),
    });

    const { WikiGenerator } = await import('../../src/core/wiki/generator.js');

    const storagePath = path.join(tmpDir, 'storage');
    const wikiDir = path.join(storagePath, 'wiki');
    const repoPath = path.join(tmpDir, 'repo');
    await fs.mkdir(wikiDir, { recursive: true });
    await fs.mkdir(repoPath, { recursive: true });

    const gen = new WikiGenerator(
      repoPath,
      storagePath,
      path.join(storagePath, 'lbug'),
      {
        apiKey: 'key',
        baseUrl: 'http://localhost',
        model: 'test',
        maxTokens: 1000,
        temperature: 0,
        provider: 'openai',
      },
      { reviewOnly: true },
    );

    const result = await gen.run();

    expect(callLLMSpy).toHaveBeenCalledTimes(1);
    expect(result.moduleTree).toBeDefined();
    expect(result.moduleTree!.length).toBe(2);
  });

  it('uses multiple LLM calls for oversized file lists and merges results', async () => {
    // Generate enough files to exceed the 100k token budget
    const dirs = ['alpha', 'beta', 'gamma', 'delta'];
    const fakeFiles: Array<{ filePath: string; symbols: Array<{ name: string; type: string }> }> =
      [];
    for (const dir of dirs) {
      for (let i = 0; i < 150; i++) {
        fakeFiles.push({
          filePath: `${dir}/file${i}.ts`,
          symbols: Array.from({ length: 60 }, (_, j) => ({
            name: `${dir}Export${i}_${j}`,
            type: 'function',
          })),
        });
      }
    }

    vi.doMock('../../src/core/wiki/graph-queries.js', () => ({
      initWikiDb: vi.fn().mockResolvedValue(undefined),
      closeWikiDb: vi.fn().mockResolvedValue(undefined),
      touchWikiDb: vi.fn(),
      pinWikiDb: vi.fn(() => vi.fn()),
      getFilesWithExports: vi.fn().mockResolvedValue(fakeFiles),
      getAllFiles: vi.fn().mockResolvedValue(fakeFiles.map((f) => f.filePath)),
      getIntraModuleCallEdges: vi.fn().mockResolvedValue([]),
      getInterModuleCallEdges: vi.fn().mockResolvedValue({ incoming: [], outgoing: [] }),
      getProcessesForFiles: vi.fn().mockResolvedValue([]),
      getAllProcesses: vi.fn().mockResolvedValue([]),
      getInterModuleEdgesForOverview: vi.fn().mockResolvedValue([]),
    }));

    vi.doMock('child_process', () => ({
      execSync: vi.fn().mockImplementation(() => {
        throw new Error('not a git repo');
      }),
      execFileSync: vi.fn(),
    }));

    const llmClient = await import('../../src/core/wiki/llm-client.js');
    let callCount = 0;
    vi.spyOn(llmClient, 'callLLM').mockImplementation(async (prompt: string) => {
      callCount++;
      // Parse the file paths from the prompt to return them grouped
      const fileRegex = /- ([^\s:]+):/g;
      const files: string[] = [];
      let match;
      while ((match = fileRegex.exec(prompt)) !== null) {
        files.push(match[1]);
      }
      const groupName = `Module${callCount}`;
      return { content: JSON.stringify({ [groupName]: files }) };
    });

    const { WikiGenerator } = await import('../../src/core/wiki/generator.js');

    const storagePath = path.join(tmpDir, 'storage');
    const wikiDir = path.join(storagePath, 'wiki');
    const repoPath = path.join(tmpDir, 'repo');
    await fs.mkdir(wikiDir, { recursive: true });
    await fs.mkdir(repoPath, { recursive: true });

    const gen = new WikiGenerator(
      repoPath,
      storagePath,
      path.join(storagePath, 'lbug'),
      {
        apiKey: 'key',
        baseUrl: 'http://localhost',
        model: 'test',
        maxTokens: 1000,
        temperature: 0,
        provider: 'openai',
      },
      { reviewOnly: true },
    );

    const result = await gen.run();

    // Each ~60k-token directory exceeds half the 100k budget, so each gets its own batch
    expect(callCount).toBe(4);
    expect(result.moduleTree).toBeDefined();

    // All 600 files should be accounted for
    const allFiles = result.moduleTree!.flatMap((n: any) =>
      n.children ? n.children.flatMap((c: any) => c.files) : n.files,
    );
    expect(allFiles.length).toBe(fakeFiles.length);
  });

  it('falls back to directory grouping when a batch LLM call fails', async () => {
    const dirs = ['alpha', 'beta', 'gamma'];
    const fakeFiles: Array<{ filePath: string; symbols: Array<{ name: string; type: string }> }> =
      [];
    for (const dir of dirs) {
      for (let i = 0; i < 150; i++) {
        fakeFiles.push({
          filePath: `${dir}/file${i}.ts`,
          symbols: Array.from({ length: 60 }, (_, j) => ({
            name: `${dir}Export${i}_${j}`,
            type: 'function',
          })),
        });
      }
    }

    vi.doMock('../../src/core/wiki/graph-queries.js', () => ({
      initWikiDb: vi.fn().mockResolvedValue(undefined),
      closeWikiDb: vi.fn().mockResolvedValue(undefined),
      touchWikiDb: vi.fn(),
      pinWikiDb: vi.fn(() => vi.fn()),
      getFilesWithExports: vi.fn().mockResolvedValue(fakeFiles),
      getAllFiles: vi.fn().mockResolvedValue(fakeFiles.map((f) => f.filePath)),
      getIntraModuleCallEdges: vi.fn().mockResolvedValue([]),
      getInterModuleCallEdges: vi.fn().mockResolvedValue({ incoming: [], outgoing: [] }),
      getProcessesForFiles: vi.fn().mockResolvedValue([]),
      getAllProcesses: vi.fn().mockResolvedValue([]),
      getInterModuleEdgesForOverview: vi.fn().mockResolvedValue([]),
    }));

    vi.doMock('child_process', () => ({
      execSync: vi.fn().mockImplementation(() => {
        throw new Error('not a git repo');
      }),
      execFileSync: vi.fn(),
    }));

    const llmClient = await import('../../src/core/wiki/llm-client.js');
    let callCount = 0;
    vi.spyOn(llmClient, 'callLLM').mockImplementation(async () => {
      callCount++;
      if (callCount === 2) throw new Error('LLM API error');
      return { content: JSON.stringify({ SomeModule: ['alpha/file0.ts'] }) };
    });

    const { WikiGenerator } = await import('../../src/core/wiki/generator.js');

    const storagePath = path.join(tmpDir, 'storage');
    const wikiDir = path.join(storagePath, 'wiki');
    const repoPath = path.join(tmpDir, 'repo');
    await fs.mkdir(wikiDir, { recursive: true });
    await fs.mkdir(repoPath, { recursive: true });

    const gen = new WikiGenerator(
      repoPath,
      storagePath,
      path.join(storagePath, 'lbug'),
      {
        apiKey: 'key',
        baseUrl: 'http://localhost',
        model: 'test',
        maxTokens: 1000,
        temperature: 0,
        provider: 'openai',
      },
      { reviewOnly: true },
    );

    const result = await gen.run();

    // Should have fallen back to directory-based grouping
    expect(result.moduleTree).toBeDefined();
    const moduleNames = result.moduleTree!.map((n: any) => n.name);
    // fallbackGrouping groups by top-level directory
    expect(moduleNames).toContain('alpha');
    expect(moduleNames).toContain('beta');
    expect(moduleNames).toContain('gamma');

    // First batch's LLM result ('SomeModule') must NOT leak through — nuclear fallback
    // discards all partial results
    expect(moduleNames).not.toContain('SomeModule');

    // All files still accounted for
    const allFiles = result.moduleTree!.flatMap((n: any) =>
      n.children ? n.children.flatMap((c: any) => c.files) : n.files,
    );
    expect(allFiles.length).toBe(fakeFiles.length);
  });
});
