import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getAllFiles } from '../../src/core/wiki/graph-queries.js';
import {
  WikiGenerator,
  type ModuleTreeNode,
  type WikiOptions,
} from '../../src/core/wiki/generator.js';

vi.mock('../../src/core/wiki/graph-queries.js', () => ({
  initWikiDb: vi.fn().mockResolvedValue(undefined),
  closeWikiDb: vi.fn().mockResolvedValue(undefined),
  touchWikiDb: vi.fn(),
  pinWikiDb: vi.fn(() => vi.fn()),
  getFilesWithExports: vi.fn().mockResolvedValue([]),
  getAllFiles: vi.fn(),
  getIntraModuleCallEdges: vi.fn().mockResolvedValue([]),
  getInterModuleCallEdges: vi.fn().mockResolvedValue({ incoming: [], outgoing: [] }),
  getProcessesForFiles: vi.fn().mockResolvedValue([]),
  getAllProcesses: vi.fn().mockResolvedValue([]),
  getInterModuleEdgesForOverview: vi.fn().mockResolvedValue([]),
}));

const API = ['api/orders.ts', 'api/users.ts'];
const CORE = ['core/cache.ts', 'core/db.ts'];
const JOBS = Array.from({ length: 6 }, (_, i) => `jobs/job${i + 1}.ts`);

// dupe-ok: the same streamed answer as wiki-truncation-recovery.test.ts, which this PR leaves alone
function streamed(content: string, finishReason = 'stop'): Response {
  const chunk = { choices: [{ delta: { content }, finish_reason: finishReason }] };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('wiki runs that group the files again', () => {
  let repoPath: string;
  let wikiPath: string;
  let files: string[];
  /** The stand-in model's answer to the grouping prompt. */
  let grouping: Record<string, string[]>;
  /** One entry per request: 'grouping', 'overview', or the module of the page. */
  let requests: string[];
  /** The last page prompt of each module. */
  let prompts: Map<string, string>;
  /** Part of every page, so a page shows which run wrote it. */
  let revision: number;
  let cutOffOverview: boolean;

  function git(...args: string[]): void {
    execFileSync('git', args, { cwd: repoPath });
  }

  /** Writes or edits the files, commits them, and lets the mocked graph list them. */
  async function commit(...paths: string[]): Promise<void> {
    for (const file of paths) {
      const fullPath = path.join(repoPath, file);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.appendFile(fullPath, `export const ${path.basename(file, '.ts')}${revision} = 1;\n`);
    }
    git('add', ...paths);
    git('-c', 'user.name=Wiki Test', '-c', 'user.email=wiki@example.test', 'commit', '-qm', 'edit');
    files = [...new Set([...files, ...paths])].sort();
    vi.mocked(getAllFiles).mockResolvedValue(files);
  }

  function run(options: WikiOptions = {}) {
    return new WikiGenerator(
      repoPath,
      path.join(repoPath, '.gitnexus'),
      '/unused/lbug',
      {
        apiKey: 'test',
        baseUrl: 'https://wiki.example.test/v1',
        model: 'test-model',
        maxTokens: 4_096,
        temperature: 0,
        provider: 'custom',
      },
      { concurrency: 1, ...options },
    ).run();
  }

  async function savedTree(file = 'module_tree.json'): Promise<ModuleTreeNode[]> {
    return JSON.parse(await fs.readFile(path.join(wikiPath, file), 'utf8'));
  }

  const names = (tree: ModuleTreeNode[]) => tree.map((node) => node.name);
  const page = (slug: string) => fs.readFile(path.join(wikiPath, `${slug}.md`), 'utf8');
  const pages = async () =>
    (await fs.readdir(wikiPath)).filter((file) => file.endsWith('.md')).sort();

  /** A first, complete generation of the given files, grouped as given. */
  async function generate(initial: string[], groups: Record<string, string[]>, options = {}) {
    await commit(...initial);
    grouping = groups;
    expect((await run(options)).mode).toBe('full');
    expect(requests[0]).toBe('grouping');
    requests = [];
    revision = 2;
  }

  beforeEach(async () => {
    repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-regroup-'));
    wikiPath = path.join(repoPath, '.gitnexus', 'wiki');
    await fs.mkdir(wikiPath, { recursive: true });
    git('init', '-q');
    git('config', 'commit.gpgsign', 'false');
    files = [];
    requests = [];
    prompts = new Map();
    revision = 1;
    cutOffOverview = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const { messages } = JSON.parse(String(init.body));
        const prompt: string = messages.at(-1).content;
        if (prompt.startsWith('Group these source files')) {
          requests.push('grouping');
          prompts.set('grouping', prompt);
          return streamed(JSON.stringify(grouping));
        }
        const module = prompt.match(/^Write documentation for the \*\*(.+?)\*\* module/)?.[1];
        requests.push(module ?? 'overview');
        prompts.set(module ?? 'overview', prompt);
        if (!module && cutOffOverview) return streamed('cut off', 'length');
        return streamed(`${module ?? 'Overview'} page, revision ${revision}.`);
      }),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(repoPath, { recursive: true, force: true });
  });

  describe('--force', () => {
    beforeEach(() => generate([...API, ...CORE], { Api: API, Core: CORE }));

    it('groups the files again after a completed generation', async () => {
      grouping = { Services: [...API, ...CORE] };

      expect(await run({ force: true })).toEqual({
        pagesGenerated: 2,
        mode: 'full',
        failedModules: [],
      });

      expect(requests).toEqual(['grouping', 'Services', 'overview']);
      expect(names(await savedTree())).toEqual(['Services']);
      expect(names(await savedTree('first_module_tree.json'))).toEqual(['Services']);
      expect(await pages()).toEqual(['overview.md', 'services.md']);
    });

    it('groups the files again when a tool only reordered the keys of the saved tree', async () => {
      const reordered = (await savedTree()).map(({ files, slug, name }) => ({ files, slug, name }));
      await fs.writeFile(path.join(wikiPath, 'module_tree.json'), JSON.stringify(reordered));
      grouping = { Services: [...API, ...CORE] };

      await run({ force: true });

      expect(requests).toEqual(['grouping', 'Services', 'overview']);
      expect(names(await savedTree())).toEqual(['Services']);
    });

    it('keeps a module tree edited since the last generation', async () => {
      const tree = await savedTree();
      tree[1] = { ...tree[1], name: 'Storage', slug: 'storage' };
      await fs.writeFile(path.join(wikiPath, 'module_tree.json'), JSON.stringify(tree, null, 2));
      grouping = { Services: [...API, ...CORE] };

      await run({ force: true });

      expect(requests).toEqual(['Api', 'Storage', 'overview']);
      expect(names(await savedTree())).toEqual(['Api', 'Storage']);
    });

    it('groups again on --review, then generates the tree as the user edited it', async () => {
      grouping = { Services: [...API, ...CORE] };

      const review = await run({ force: true, reviewOnly: true });
      expect(names(review.moduleTree ?? [])).toEqual(['Services']);
      expect(requests).toEqual(['grouping']);

      // The user renames the module while reviewing. The CLI then runs again
      // with the same options and reviewOnly off.
      const tree = await savedTree();
      tree[0] = { ...tree[0], name: 'Back end', slug: 'back-end' };
      await fs.writeFile(path.join(wikiPath, 'module_tree.json'), JSON.stringify(tree, null, 2));
      requests = [];

      await run({ force: true });

      expect(requests).toEqual(['Back end', 'overview']);
      expect(names(await savedTree())).toEqual(['Back end']);
      expect(await pages()).toEqual(['back-end.md', 'overview.md']);
    });

    it('resumes a failed run from its new grouping', async () => {
      grouping = { Services: [...API, ...CORE] };
      cutOffOverview = true;
      await expect(run({ force: true })).rejects.toThrow('completion token limit');

      requests = [];
      cutOffOverview = false;
      expect(await run()).toEqual({ pagesGenerated: 1, mode: 'full', failedModules: [] });

      expect(requests).toEqual(['overview']);
      expect(names(await savedTree())).toEqual(['Services']);
    });
  });

  it('keeps a module tree written before any generation, even with --force', async () => {
    await commit(...API, ...CORE);
    const tree = [{ name: 'Everything', slug: 'everything', files: [...API, ...CORE] }];
    await fs.writeFile(path.join(wikiPath, 'module_tree.json'), JSON.stringify(tree));

    await run({ force: true });

    expect(requests).toEqual(['Everything', 'overview']);
  });

  describe('more than five new files', () => {
    beforeEach(() => generate([...API, ...CORE], { Api: API, Core: CORE }));

    it('groups again and writes the page of the new module only', async () => {
      await commit(...JOBS);
      grouping = { Api: API, Core: CORE, Jobs: JOBS };

      expect(await run()).toEqual({ pagesGenerated: 2, mode: 'incremental', failedModules: [] });

      expect(requests).toEqual(['grouping', 'Jobs', 'overview']);
      for (const job of JOBS) {
        expect(prompts.get('grouping')).toContain(job);
        expect(prompts.get('Jobs')).toContain(`--- ${job} ---`);
      }
      expect(names(await savedTree())).toEqual(['Api', 'Core', 'Jobs']);
      expect(names(await savedTree('first_module_tree.json'))).toEqual(['Api', 'Core', 'Jobs']);
      expect(await page('jobs')).toContain('Jobs page, revision 2.');
      expect(await page('api')).toContain('Api page, revision 1.');
      expect(await page('core')).toContain('Core page, revision 1.');
    });

    it('keeps the previous overview page when the run fails', async () => {
      await commit(...JOBS);
      grouping = { Api: API, Core: CORE, Jobs: JOBS };
      cutOffOverview = true;

      await expect(run()).rejects.toThrow('completion token limit');

      expect(await page('overview')).toContain('Overview page, revision 1.');
      expect(await page('jobs')).toContain('Jobs page, revision 2.');
    });

    it('rewrites the page of a module whose file changed in the same commits', async () => {
      await commit(...JOBS, 'core/db.ts');
      grouping = { Api: API, Core: CORE, Jobs: JOBS };

      await run();

      expect(requests).toEqual(['grouping', 'Core', 'Jobs', 'overview']);
      expect(prompts.get('Core')).toContain('export const db2 = 1;');
      expect(await page('core')).toContain('Core page, revision 2.');
      expect(await page('api')).toContain('Api page, revision 1.');
    });

    it('rewrites a module that gained files and deletes the page of a module that is gone', async () => {
      await commit(...JOBS);
      grouping = { Api: [...API, ...JOBS], Storage: CORE };

      await run();

      expect(requests).toEqual(['grouping', 'Api', 'Storage', 'overview']);
      expect(prompts.get('Api')).toContain('--- jobs/job1.ts ---');
      expect(await pages()).toEqual(['api.md', 'overview.md', 'storage.md']);
    });

    it('rewrites a module that lost files to another module', async () => {
      await commit(...JOBS);
      grouping = { Api: ['api/orders.ts'], Users: ['api/users.ts'], Core: CORE, Jobs: JOBS };

      await run();

      expect(requests).toEqual(['grouping', 'Api', 'Users', 'Jobs', 'overview']);
      expect(prompts.get('Api')).not.toContain('--- api/users.ts ---');
      expect(await page('core')).toContain('Core page, revision 1.');
    });

    it('leaves the existing pages alone while --review waits for the user', async () => {
      await commit(...JOBS);
      grouping = { Services: [...API, ...CORE, ...JOBS] };

      await run({ reviewOnly: true });

      expect(requests).toEqual(['grouping']);
      expect(await pages()).toEqual(['api.md', 'core.md', 'overview.md']);
    });

    it('generates the tree as the user edited it on --review', async () => {
      await commit(...JOBS);
      grouping = { Api: API, Core: CORE, Jobs: JOBS };

      const review = await run({ reviewOnly: true });
      expect(names(review.moduleTree ?? [])).toEqual(['Api', 'Core', 'Jobs']);
      expect(requests).toEqual(['grouping']);

      const tree = await savedTree();
      tree[2] = { ...tree[2], name: 'Background jobs', slug: 'background-jobs' };
      await fs.writeFile(path.join(wikiPath, 'module_tree.json'), JSON.stringify(tree, null, 2));
      requests = [];

      await run();

      expect(requests).toEqual(['Background jobs', 'overview']);
      expect(await pages()).toEqual(['api.md', 'background-jobs.md', 'core.md', 'overview.md']);
    });
  });

  describe('more than five new files, with sub-modules', () => {
    const V1 = ['api/v1/orders.ts', 'api/v1/users.ts'];
    const V2 = ['api/v2/orders.ts', 'api/v2/users.ts'];
    // About 60 tokens a file: a page holds one version, not both, so Api is
    // split into one sub-module per version, whatever the split counts a file
    // with or without the line naming it in the prompt.
    const options = { maxTokensPerModule: 200 };

    beforeEach(async () => {
      for (const file of [...V1, ...V2]) {
        await fs.mkdir(path.dirname(path.join(repoPath, file)), { recursive: true });
        await fs.writeFile(path.join(repoPath, file), `// ${'x'.repeat(220)}\n`);
      }
      await generate([...V1, ...V2, ...CORE], { Api: [...V1, ...V2], Core: CORE }, options);
    });

    it('keeps a parent page whose sub-module pages are all kept', async () => {
      const [api] = await savedTree();
      expect(api.children?.map((child) => child.files)).toEqual([V1, V2]);
      await commit(...JOBS);
      grouping = { Api: [...V1, ...V2], Core: CORE, Jobs: JOBS };

      await run(options);

      expect(requests).toEqual(['grouping', 'Jobs', 'overview']);
      expect(await page(api.slug)).toContain('Api page, revision 1.');
    });

    it('rewrites a parent page after one of its sub-module pages', async () => {
      const [api] = await savedTree();
      const [v1, v2] = api.children ?? [];
      await commit(...JOBS, 'api/v1/users.ts');
      grouping = { Api: [...V1, ...V2], Core: CORE, Jobs: JOBS };

      await run(options);

      expect(requests).toEqual(['grouping', v1.name, 'Jobs', 'Api', 'overview']);
      expect(prompts.get('Api')).toContain(`${v1.name} page, revision 2.`);
      expect(await page(v2.slug)).toContain(`${v2.name} page, revision 1.`);
    });

    it('rewrites a parent page whose sub-module the user renamed on --review', async () => {
      await commit(...JOBS);
      grouping = { Api: [...V1, ...V2], Core: CORE, Jobs: JOBS };
      await run({ ...options, reviewOnly: true });
      const tree = await savedTree();
      const [v1, v2] = tree[0].children ?? [];
      tree[0].children = [v1, { ...v2, name: 'Api — current', slug: 'api-current' }];
      await fs.writeFile(path.join(wikiPath, 'module_tree.json'), JSON.stringify(tree, null, 2));
      requests = [];

      await run(options);

      expect(requests).toEqual(['Api — current', 'Jobs', 'Api', 'overview']);
      expect(prompts.get('Api')).toContain('Api — current page, revision 2.');
      expect(await pages()).not.toContain(`${v2.slug}.md`);
      expect(await page(v1.slug)).toContain(`${v1.name} page, revision 1.`);
    });
  });
});
