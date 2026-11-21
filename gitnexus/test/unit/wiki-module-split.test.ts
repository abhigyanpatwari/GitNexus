/**
 * Splitting an oversized wiki module into pages (#1060).
 *
 * - splitModuleByDirectory: the directory-based division on its own
 * - WikiGenerator.buildModuleTree: the module tree written for real files,
 *   with IntelliJ and Gradle metadata left out of the wiki
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  splitModuleByDirectory,
  TOP_LEVEL_LABEL,
  type ModulePart,
} from '../../src/core/wiki/module-split.js';
import type { ModuleTreeNode } from '../../src/core/wiki/generator.js';

/** The private WikiGenerator methods these tests call. */
interface GeneratorInternals {
  slugify(name: string): string;
  findNodeBySlug(tree: ModuleTreeNode[], slug: string): ModuleTreeNode | null;
  uniqueModuleName(name: string, taken: Set<string>): string;
}

const range = (count: number) => Array.from({ length: count }, (_, i) => i);
const labels = (parts: ModulePart[]) => parts.map((part) => part.label);
const sorted = (files: readonly string[]) => [...files].sort();

describe('splitModuleByDirectory', () => {
  it('splits a Maven module at its packages, not at src/main', () => {
    const pkg = 'src/main/java/com/linkedin/metadata';
    const files = [
      ...range(6).map((i) => `${pkg}/entity/Entity${i}.java`),
      ...range(6).map((i) => `${pkg}/graph/Graph${i}.java`),
      ...range(6).map((i) => `${pkg}/search/Search${i}.java`),
      ...range(10).map((i) => `src/test/java/com/linkedin/metadata/Test${i}.java`),
      'src/testFixtures/java/com/linkedin/metadata/Fixture.java',
    ];

    const parts = splitModuleByDirectory(files, () => 100, 1000);

    expect(labels(parts)).toEqual([
      'main/entity',
      'main/graph',
      'main/search',
      'test',
      'testFixtures',
    ]);
    expect(parts[0].files).toEqual(range(6).map((i) => `${pkg}/entity/Entity${i}.java`));
    expect(sorted(parts.flatMap((part) => part.files))).toEqual(sorted(files));
  });

  it('keeps files at the repository root on one page instead of one page each', () => {
    const files = [
      'README.md',
      'build.gradle',
      'gma-create-all.sql',
      'gma-drop-all.sql',
      'settings.gradle',
    ];

    expect(splitModuleByDirectory(files, () => 1000, 1000)).toEqual([
      { label: TOP_LEVEL_LABEL, files },
    ]);
  });

  it('puts the files directly in the module directory on their own page, not one named after the module', () => {
    const files = [
      'metadata-io-api/build.gradle',
      'metadata-io-api/README.md',
      ...range(4).map((i) => `metadata-io-api/src/main/java/com/acme/a/A${i}.java`),
      ...range(4).map((i) => `metadata-io-api/src/main/java/com/acme/b/B${i}.java`),
    ];

    const parts = splitModuleByDirectory(files, () => 100, 500);

    expect(parts).toEqual([
      {
        label: TOP_LEVEL_LABEL,
        files: ['metadata-io-api/build.gradle', 'metadata-io-api/README.md'],
      },
      { label: 'src/a', files: files.slice(2, 6) },
      { label: 'src/b', files: files.slice(6) },
    ]);
  });

  it('lets small neighbouring directories share a page, so many small directories make few pages', () => {
    const names = range(50).map((i) => `d${String(i).padStart(2, '0')}`);
    const files = names.map((name) => `migrations/${name}/migration.sql`);

    const parts = splitModuleByDirectory(files, () => 100, 1000);

    expect(labels(parts)).toEqual([
      'd00 … d09',
      'd10 … d19',
      'd20 … d29',
      'd30 … d39',
      'd40 … d49',
    ]);
    expect(parts.map((part) => part.files.length)).toEqual([10, 10, 10, 10, 10]);
  });

  it('names a page shared by two directories after both', () => {
    const tokens: Record<string, number> = { a: 300, b: 300, c: 900 };
    const files = ['a', 'b', 'c'].flatMap((dir) => range(4).map((i) => `lib/${dir}/f${i}.ts`));

    const parts = splitModuleByDirectory(files, (file) => tokens[file.split('/')[1]] / 4, 1000);

    expect(labels(parts)).toEqual(['a, b', 'c']);
  });

  it('returns a directory it cannot divide whole, even over budget', () => {
    const oneDirectory = range(10).map((i) => `src/big/F${i}.java`);
    expect(splitModuleByDirectory(oneDirectory, () => 500, 1000)).toEqual([
      { label: TOP_LEVEL_LABEL, files: oneDirectory },
    ]);

    // Fewer than four files are never divided, even across directories.
    const files = [
      'src/a/x/Huge1.java',
      'src/a/y/Huge2.java',
      ...range(4).map((i) => `src/b/Small${i}.java`),
    ];
    const parts = splitModuleByDirectory(
      files,
      (file) => (file.includes('Huge') ? 2000 : 100),
      1000,
    );
    expect(parts).toEqual([
      { label: 'a', files: ['src/a/x/Huge1.java', 'src/a/y/Huge2.java'] },
      { label: 'b', files: files.slice(2) },
    ]);
  });

  it('returns a module that fits the budget exactly as one page', () => {
    const files = range(4).map((i) => `src/d${i}/F.java`);
    expect(splitModuleByDirectory(files, () => 250, 1000)).toEqual([
      { label: TOP_LEVEL_LABEL, files },
    ]);
  });

  it('divides Windows paths the same way and returns them unchanged', () => {
    const posix = [
      ...range(4).map((i) => `src/main/a/A${i}.java`),
      ...range(4).map((i) => `src/main/b/B${i}.java`),
    ];
    const windows = posix.map((file) => file.replace(/\//g, '\\'));

    const parts = splitModuleByDirectory(windows, () => 100, 500);

    expect(labels(parts)).toEqual(['a', 'b']);
    expect(parts[0].files).toEqual(windows.slice(0, 4));
  });

  it('returns no pages for no files', () => {
    expect(splitModuleByDirectory([], () => 1, 1)).toEqual([]);
  });

  // Random trees, checked against what any split must hold: every file on
  // exactly one page, unique labels, pages within budget unless they cannot
  // be divided, and the same pages whatever order the files come in.
  it('holds its invariants on random directory trees', () => {
    // mulberry32, seeded so that a failure reproduces
    let seed = 1060;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)];
    const directoryOf = (file: string) => file.split('/').slice(0, -1).join('/');

    for (let run = 0; run < 300; run++) {
      const fileCount = 1 + Math.floor(random() * 60);
      const files = new Set<string>();
      for (let i = 0; i < fileCount; i++) {
        const depth = Math.floor(random() * 5);
        const dirs = range(depth).map(() => pick(['a', 'b', 'c', 'src', 'main']));
        files.add([...dirs, `f${i}.ts`].join('/'));
      }
      const list = [...files];
      const size = new Map(list.map((file) => [file, 1 + Math.floor(random() * 800)]));
      const tokensOf = (file: string) => size.get(file) ?? 0;
      const budget = 500 + Math.floor(random() * 2500);

      const parts = splitModuleByDirectory(list, tokensOf, budget);

      expect(sorted(parts.flatMap((part) => part.files))).toEqual(sorted(list));
      expect(new Set(labels(parts)).size).toBe(parts.length);
      for (const part of parts) {
        const tokens = part.files.reduce((sum, file) => sum + tokensOf(file), 0);
        const undividable =
          part.files.length < 4 || new Set(part.files.map(directoryOf)).size === 1;
        expect(tokens <= budget || undividable).toBe(true);
      }

      const reversed = splitModuleByDirectory([...list].reverse(), tokensOf, budget);
      expect(reversed.map((part) => [part.label, sorted(part.files)])).toEqual(
        parts.map((part) => [part.label, sorted(part.files)]),
      );
    }
  });
});

describe('WikiGenerator module tree for a Gradle module (#1060)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-module-split-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.doUnmock('../../src/core/wiki/graph-queries.js');
    vi.doUnmock('child_process');
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * Write `files` (path → characters) under a repository, index them as the
   * graph lists them, answer grouping with something that is not JSON so the
   * directory fallback groups the modules, and return the reviewed tree.
   */
  async function buildTree(
    files: Record<string, number>,
    maxTokensPerModule: number,
    reviewOnly = true,
  ) {
    const repoPath = path.join(tmpDir, 'repo');
    for (const [file, chars] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(repoPath, file)), { recursive: true });
      await fs.writeFile(path.join(repoPath, file), 'x'.repeat(chars));
    }
    const indexed = Object.keys(files).sort();

    vi.doMock('../../src/core/wiki/graph-queries.js', () => ({
      initWikiDb: vi.fn().mockResolvedValue(undefined),
      closeWikiDb: vi.fn().mockResolvedValue(undefined),
      touchWikiDb: vi.fn(),
      pinWikiDb: vi.fn(() => vi.fn()),
      getFilesWithExports: vi.fn().mockResolvedValue([]),
      getAllFiles: vi.fn().mockResolvedValue(indexed),
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
    const callLLM = vi.spyOn(llmClient, 'callLLM').mockResolvedValue({ content: 'not json' });
    const { WikiGenerator } = await import('../../src/core/wiki/generator.js');

    const storagePath = path.join(tmpDir, 'storage');
    await fs.mkdir(path.join(storagePath, 'wiki'), { recursive: true });
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
      { reviewOnly, maxTokensPerModule },
    );
    const result = await gen.run();
    const prompts = callLLM.mock.calls.map((call) => String(call[0]));
    // A full run does not return the tree; it saves it like a review does.
    const tree: ModuleTreeNode[] =
      result.moduleTree ??
      JSON.parse(await fs.readFile(path.join(storagePath, 'wiki', 'module_tree.json'), 'utf-8'));
    return { gen: gen as unknown as GeneratorInternals, tree, prompts };
  }

  const moduleNamed = (tree: ModuleTreeNode[], name: string): ModuleTreeNode => {
    const node = tree.find((candidate) => candidate.name === name);
    if (!node) throw new Error(`no module named ${name}`);
    return node;
  };
  const childNames = (tree: ModuleTreeNode[], module: string) =>
    moduleNamed(tree, module).children?.map((child) => child.name);

  it('leaves IntelliJ and Gradle metadata out and splits the module at its packages', async () => {
    const pkg = 'src/main/java/com/linkedin/metadata';
    const api = 'metadata-io-api/src/main/java/com/linkedin/metadata';
    const files: Record<string, number> = {
      'README.md': 400,
      'build.gradle': 400,
      'gradle.lockfile': 4000,
      'metadata-io.iml': 4000,
      'oss-datahub.metadata-io.main-1.iml': 4000,
      'metadata-io-api/build.gradle': 400,
      'metadata-io-api/metadata-io-api.iml': 4000,
      'src/testFixtures/java/com/linkedin/metadata/F0.java': 400,
      'src/testFixtures/java/com/linkedin/metadata/F1.java': 400,
    };
    for (const i of range(4)) {
      // Over budget, but all in one directory: one page, as on main.
      files[`docs/guide${i}.md`] = 800;
      for (const dir of ['entity', 'graph', 'search', 'timeline']) {
        files[`${pkg}/${dir}/C${i}.java`] = 400;
      }
      files[`${api}/api/A${i}.java`] = 400;
      files[`${api}/spi/S${i}.java`] = 400;
      files[`src/test/java/com/linkedin/metadata/T${i}.java`] = 400;
    }

    const { gen, tree, prompts } = await buildTree(files, 500);

    expect(prompts.join('\n')).not.toMatch(/\.iml|\.lockfile/);
    const allFiles = tree.flatMap((node) => [
      ...node.files,
      ...(node.children ?? []).flatMap((child) => child.files),
    ]);
    expect(allFiles.filter((file) => /\.iml$|\.lockfile$/.test(file))).toEqual([]);

    expect(tree.map((node) => node.name)).toEqual(['Root', 'docs', 'metadata-io-api', 'src']);
    const root = moduleNamed(tree, 'Root');
    expect(root.children).toBeUndefined();
    expect(root.files).toEqual(['README.md', 'build.gradle']);
    const docs = moduleNamed(tree, 'docs');
    expect(docs.children).toBeUndefined();
    expect(docs.files).toHaveLength(4);
    expect(childNames(tree, 'metadata-io-api')).toEqual([
      'metadata-io-api — top-level files',
      'metadata-io-api — src/api',
      'metadata-io-api — src/spi',
    ]);
    expect(childNames(tree, 'src')).toEqual([
      'src — main/entity',
      'src — main/graph',
      'src — main/search',
      'src — main/timeline',
      'src — test',
      'src — testFixtures',
    ]);

    // Incremental updates find a page by the slug of its name.
    const nodes = tree.flatMap((node) => [node, ...(node.children ?? [])]);
    for (const node of nodes) {
      expect(node.slug).toBe(gen.slugify(node.name));
      expect(gen.findNodeBySlug(tree, gen.slugify(node.name))).toBe(node);
    }
    expect(new Set(nodes.map((node) => node.slug)).size).toBe(nodes.length);
  });

  it('sizes pages by what their prompt quotes, so a full page is not truncated', async () => {
    // `a` and `b` fit the budget together by content alone, not with the
    // `--- path ---` line each file is quoted under.
    const { tree, prompts } = await buildTree(
      { 'lib/a/A.ts': 1000, 'lib/b/B.ts': 1000, 'lib/c/C0.ts': 100, 'lib/c/C1.ts': 100 },
      500,
      false,
    );

    expect(childNames(tree, 'lib')).toEqual(['lib — a', 'lib — b, c']);
    const pagePrompts = prompts.filter((prompt) => prompt.startsWith('Write documentation for'));
    expect(pagePrompts).toHaveLength(3);
    for (const prompt of pagePrompts) expect(prompt).not.toContain('source truncated');
  });

  it('numbers a page whose slug another page already has', async () => {
    // `api-v1` and `api_v1` share a slug, and `svc — core` would take the
    // page of the `svc-core` module.
    const files: Record<string, number> = { 'svc-core/index.ts': 400 };
    for (const i of range(4)) {
      files[`svc/api-v1/A${i}.ts`] = 400;
      files[`svc/api_v1/B${i}.ts`] = 400;
      files[`svc/core/C${i}.ts`] = 400;
    }

    const { tree } = await buildTree(files, 500);

    expect(tree.map((node) => [node.name, node.slug])).toEqual([
      ['svc-core', 'svc-core'],
      ['svc', 'svc'],
    ]);
    const children = moduleNamed(tree, 'svc').children ?? [];
    expect(children.map((child) => [child.name, child.slug])).toEqual([
      ['svc — api-v1', 'svc-api-v1'],
      ['svc — api_v1 2', 'svc-api-v1-2'],
      ['svc — core 2', 'svc-core-2'],
    ]);
  });
});

describe('WikiGenerator.uniqueModuleName', () => {
  it('keeps the number inside the 60-character slug and stops at a free one', async () => {
    const { WikiGenerator } = await import('../../src/core/wiki/generator.js');
    const gen = new WikiGenerator('/repo', '/storage', '/lbug', {
      apiKey: '',
      baseUrl: '',
      model: 'test',
      maxTokens: 1000,
      temperature: 0,
      provider: 'openai',
    }) as unknown as GeneratorInternals;

    const taken = new Set<string>();
    const name = `${'Very Long Module Name '.repeat(4)}— main/entity`;
    const slugs = range(12).map(() => gen.slugify(gen.uniqueModuleName(name, taken)));

    expect(new Set(slugs).size).toBe(12);
    expect(slugs[0]).toBe(gen.slugify(name));
    expect(slugs.slice(1).map((slug) => slug.split('-').pop())).toEqual(
      range(11).map((i) => String(i + 2)),
    );
    for (const slug of slugs) expect(slug.length).toBeLessThanOrEqual(60);
    expect([...taken].sort()).toEqual([...slugs].sort());

    const punctuation = new Set<string>(['']);
    expect(gen.slugify(gen.uniqueModuleName('—', punctuation))).toBe('2');
  });
});
