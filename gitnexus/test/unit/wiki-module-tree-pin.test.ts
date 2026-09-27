/**
 * Unit tests for module-tree persistence in the wiki generator.
 *
 * Regression: `saveModuleTree` writes `module_tree.json` at the end of every
 * full run, and `buildModuleTree` used to honour that file whenever it parsed —
 * so the grouping from the FIRST run was reused forever. `--force` and the
 * ">5 new files" incremental escalation only deleted `first_module_tree.json`,
 * leaving the real pin in place. Measured on a 1240-file repo: `wiki --force`
 * reproduced the identical 22-module tree while covering 14% of files.
 *
 * Fix: `module_tree.json` is output only. An EDITED tree is honoured only while
 * a review is pending (`module_tree.review-pending` marker written by the
 * `--review` stop), and consuming it refreshes the resumability snapshot.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

const LLM_CONFIG = {
  apiKey: 'key',
  baseUrl: 'http://localhost',
  model: 'test',
  maxTokens: 1000,
  temperature: 0,
  provider: 'openai' as const,
};

const OLD_TREE = [{ name: 'Old', slug: 'old', files: ['src/old.ts'] }];

const FRESH_FILES = [
  { filePath: 'src/auth.ts', symbols: [{ name: 'login', type: 'function' }] },
  { filePath: 'src/db.ts', symbols: [{ name: 'connect', type: 'function' }] },
];

const FRESH_GROUPING = { Auth: ['src/auth.ts'], Database: ['src/db.ts'] };

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

describe('buildModuleTree does not reuse a stale module_tree.json', () => {
  let tmpDir: string;
  let storagePath: string;
  let wikiDir: string;
  let repoPath: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-tree-pin-test-'));
    storagePath = path.join(tmpDir, 'storage');
    wikiDir = path.join(storagePath, 'wiki');
    repoPath = path.join(tmpDir, 'repo');
    await fs.mkdir(wikiDir, { recursive: true });
    await fs.mkdir(repoPath, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.doUnmock('../../src/core/wiki/graph-queries.js');
    vi.doUnmock('child_process');
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function mockGraph(files = FRESH_FILES) {
    vi.doMock('../../src/core/wiki/graph-queries.js', () => ({
      initWikiDb: vi.fn().mockResolvedValue(undefined),
      closeWikiDb: vi.fn().mockResolvedValue(undefined),
      touchWikiDb: vi.fn(),
      getFilesWithExports: vi.fn().mockResolvedValue(files),
      getAllFiles: vi.fn().mockResolvedValue(files.map((f) => f.filePath)),
      getIntraModuleCallEdges: vi.fn().mockResolvedValue([]),
      getInterModuleCallEdges: vi.fn().mockResolvedValue({ incoming: [], outgoing: [] }),
      getProcessesForFiles: vi.fn().mockResolvedValue([]),
      getAllProcesses: vi.fn().mockResolvedValue([]),
      getInterModuleEdgesForOverview: vi.fn().mockResolvedValue([]),
    }));
  }

  function mockNoGit() {
    vi.doMock('child_process', () => ({
      execSync: vi.fn().mockImplementation(() => {
        throw new Error('not a git repo');
      }),
      execFileSync: vi.fn().mockImplementation(() => {
        throw new Error('not a git repo');
      }),
    }));
  }

  async function makeGenerator(options: Record<string, unknown>) {
    const { WikiGenerator } = await import('../../src/core/wiki/generator.js');
    return new WikiGenerator(
      repoPath,
      storagePath,
      path.join(storagePath, 'lbug'),
      LLM_CONFIG,
      options as any,
    );
  }

  async function spyLLM() {
    const llmClient = await import('../../src/core/wiki/llm-client.js');
    return vi
      .spyOn(llmClient, 'callLLM')
      .mockResolvedValue({ content: JSON.stringify(FRESH_GROUPING) });
  }

  it('ignores a leftover module_tree.json when no review is pending', async () => {
    mockGraph();
    mockNoGit();
    await fs.writeFile(path.join(wikiDir, 'module_tree.json'), JSON.stringify(OLD_TREE));
    const llm = await spyLLM();

    const gen = await makeGenerator({ reviewOnly: true });
    const result = await gen.run();

    expect(llm).toHaveBeenCalledTimes(1);
    expect(result.moduleTree!.map((n) => n.name)).toEqual(['Auth', 'Database']);
  });

  it('--force regroups from scratch even when a previous run left both tree files', async () => {
    mockGraph();
    mockNoGit();
    await fs.writeFile(path.join(wikiDir, 'module_tree.json'), JSON.stringify(OLD_TREE));
    await fs.writeFile(path.join(wikiDir, 'first_module_tree.json'), JSON.stringify(OLD_TREE));
    await fs.writeFile(
      path.join(wikiDir, 'meta.json'),
      JSON.stringify({
        fromCommit: 'aaaa',
        generatedAt: '2026-01-01T00:00:00.000Z',
        model: 'test',
        lang: '',
        moduleFiles: { Old: ['src/old.ts'] },
        moduleTree: OLD_TREE,
      }),
    );
    const llm = await spyLLM();

    const gen = await makeGenerator({ force: true, reviewOnly: true });
    const result = await gen.run();

    expect(llm).toHaveBeenCalledTimes(1);
    expect(result.moduleTree!.map((n) => n.name)).toEqual(['Auth', 'Database']);
  });

  it('incremental escalation (>5 new files) regroups instead of reusing the pinned tree', async () => {
    const manyNew = Array.from({ length: 6 }, (_, i) => ({
      filePath: `src/new${i}.ts`,
      symbols: [{ name: `fn${i}`, type: 'function' }],
    }));
    mockGraph([...FRESH_FILES, ...manyNew]);
    vi.doMock('child_process', () => ({
      execSync: vi.fn().mockReturnValue(Buffer.from('bbbb\n')),
      execFileSync: vi.fn().mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'merge-base') return Buffer.from('');
        if (args[0] === 'diff') return Buffer.from(manyNew.map((f) => f.filePath).join('\n'));
        throw new Error(`unexpected git call: ${args.join(' ')}`);
      }),
    }));
    await fs.writeFile(path.join(wikiDir, 'module_tree.json'), JSON.stringify(OLD_TREE));
    await fs.writeFile(path.join(wikiDir, 'first_module_tree.json'), JSON.stringify(OLD_TREE));
    await fs.writeFile(
      path.join(wikiDir, 'meta.json'),
      JSON.stringify({
        fromCommit: 'aaaa',
        generatedAt: '2026-01-01T00:00:00.000Z',
        model: 'test',
        lang: '',
        moduleFiles: { Old: ['src/old.ts'] },
        moduleTree: OLD_TREE,
      }),
    );
    const llm = await spyLLM();

    const gen = await makeGenerator({ reviewOnly: true });
    const result = await gen.run();

    expect(llm).toHaveBeenCalledTimes(1);
    const names = result.moduleTree!.map((n) => n.name);
    // Fresh grouping: the LLM's modules plus the catch-all for files it left
    // unassigned — and no trace of the pinned 'Old' tree.
    expect(names).toEqual(['Auth', 'Database', 'Other']);
    expect(names).not.toContain('Old');
  });

  it('incremental escalation clears the old module pages before regrouping', async () => {
    // A slug that survives regrouping ('auth') must not keep its stale page —
    // fullGeneration skips modules whose page already exists — and a slug
    // that dies ('old') must not linger as an orphan in the viewer.
    const manyNew = Array.from({ length: 6 }, (_, i) => ({
      filePath: `src/new${i}.ts`,
      symbols: [{ name: `fn${i}`, type: 'function' }],
    }));
    mockGraph([...FRESH_FILES, ...manyNew]);
    vi.doMock('child_process', () => ({
      execSync: vi.fn().mockReturnValue(Buffer.from('bbbb\n')),
      execFileSync: vi.fn().mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'merge-base') return Buffer.from('');
        if (args[0] === 'diff') return Buffer.from(manyNew.map((f) => f.filePath).join('\n'));
        throw new Error(`unexpected git call: ${args.join(' ')}`);
      }),
    }));
    await fs.writeFile(path.join(wikiDir, 'old.md'), '# Old');
    await fs.writeFile(path.join(wikiDir, 'auth.md'), '# Auth (stale)');
    await fs.writeFile(path.join(wikiDir, 'module_tree.json'), JSON.stringify(OLD_TREE));
    await fs.writeFile(
      path.join(wikiDir, 'meta.json'),
      JSON.stringify({
        fromCommit: 'aaaa',
        generatedAt: '2026-01-01T00:00:00.000Z',
        model: 'test',
        lang: '',
        moduleFiles: { Old: ['src/old.ts'] },
        moduleTree: OLD_TREE,
      }),
    );
    await spyLLM();

    // reviewOnly stops right after grouping, so anything still on disk was
    // deliberately kept — and nothing new has been generated yet.
    const gen = await makeGenerator({ reviewOnly: true });
    await gen.run();

    expect(await exists(path.join(wikiDir, 'old.md'))).toBe(false);
    expect(await exists(path.join(wikiDir, 'auth.md'))).toBe(false);
  });

  it('a --review stop writes module_tree.json AND the review-pending marker', async () => {
    mockGraph();
    mockNoGit();
    await spyLLM();

    const gen = await makeGenerator({ reviewOnly: true });
    await gen.run();

    expect(await exists(path.join(wikiDir, 'module_tree.json'))).toBe(true);
    expect(await exists(path.join(wikiDir, 'module_tree.review-pending'))).toBe(true);
  });

  it('honours an edited module_tree.json while a review is pending, then consumes the marker', async () => {
    mockGraph();
    mockNoGit();
    const edited = [{ name: 'Edited', slug: 'edited', files: ['src/auth.ts', 'src/db.ts'] }];
    await fs.writeFile(path.join(wikiDir, 'module_tree.json'), JSON.stringify(edited));
    await fs.writeFile(path.join(wikiDir, 'first_module_tree.json'), JSON.stringify(OLD_TREE));
    await fs.writeFile(path.join(wikiDir, 'module_tree.review-pending'), '');
    const llm = await spyLLM();

    const gen = await makeGenerator({ reviewOnly: true });
    const result = await gen.run();

    expect(llm).not.toHaveBeenCalled();
    expect(result.moduleTree!.map((n) => n.name)).toEqual(['Edited']);
    // The edit becomes the resumability snapshot so a crash mid-generation
    // resumes with the user's tree, not the pre-edit one.
    const snapshot = JSON.parse(
      await fs.readFile(path.join(wikiDir, 'first_module_tree.json'), 'utf-8'),
    );
    expect(snapshot.map((n: { name: string }) => n.name)).toEqual(['Edited']);
    // reviewOnly re-arms the marker for the next continue; the consumed one is
    // proven by the snapshot refresh above.
  });

  it('a pending review whose module_tree.json is unreadable falls back to fresh grouping', async () => {
    mockGraph();
    mockNoGit();
    await fs.writeFile(path.join(wikiDir, 'module_tree.json'), '{not json');
    await fs.writeFile(path.join(wikiDir, 'module_tree.review-pending'), '');
    const llm = await spyLLM();

    const gen = await makeGenerator({ reviewOnly: true });
    const result = await gen.run();

    expect(llm).toHaveBeenCalledTimes(1);
    expect(result.moduleTree!.map((n) => n.name)).toEqual(['Auth', 'Database']);
  });
});
