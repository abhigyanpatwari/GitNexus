import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { expect } from 'expect';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mockWikiGraph, streamedWikiResponse } from '../support/wiki-graph.js';
import type { ModuleTreeNode, WikiOptions } from '../../../../src/core/wiki/generator.js';

let files: string[];
mockWikiGraph({ getAllFiles: async () => files });
const { WikiGenerator } = await import('../../../../dist/core/wiki/generator.js');

const API = ['api/orders.ts', 'api/users.ts'];
const CORE = ['core/cache.ts', 'core/db.ts'];
const JOBS = Array.from({ length: 6 }, (_, i) => `jobs/job${i + 1}.ts`);
/** The committer of the fixture's commits, whatever the global git config says. */
const AUTHOR = ['-c', 'user.name=Wiki Test', '-c', 'user.email=wiki@example.test'];

describe('wiki runs that group the files again', () => {
  let repoPath: string;
  let wikiPath: string;
  /** The stand-in model's answer to the grouping prompt. */
  let grouping: Record<string, string[]>;
  /** One entry per request: 'grouping', 'overview', or the module of the page. */
  let requests: string[];
  /** The last page prompt of each module. */
  let prompts: Map<string, string>;
  /** Part of every page, so a page shows which run wrote it. */
  let revision: number;
  let cutOffOverview: boolean;
  let cutOffGrouping: boolean;

  function git(...args: string[]): void {
    execFileSync('git', args, { cwd: repoPath });
  }

  /** Writes or edits the files and commits them, without the mocked graph listing them. */
  async function commitUnindexed(...paths: string[]): Promise<void> {
    for (const file of paths) {
      const fullPath = path.join(repoPath, file);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.appendFile(fullPath, `export const ${path.basename(file, '.ts')}${revision} = 1;\n`);
    }
    git('add', ...paths);
    git(...AUTHOR, 'commit', '-qm', 'edit');
  }

  /** Writes or edits the files, commits them, and lets the mocked graph list them. */
  async function commit(...paths: string[]): Promise<void> {
    await commitUnindexed(...paths);
    files = [...new Set([...files, ...paths])].sort();
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
  const meta = async () => JSON.parse(await fs.readFile(path.join(wikiPath, 'meta.json'), 'utf8'));
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
    cutOffGrouping = false;
    mock.method(globalThis, 'fetch', async (_url, init: RequestInit = {}) => {
      const { messages } = JSON.parse(String(init.body));
      const prompt: string = messages.at(-1).content;
      if (prompt.startsWith('Group these source files')) {
        requests.push('grouping');
        prompts.set('grouping', prompt);
        return streamedWikiResponse(JSON.stringify(grouping), cutOffGrouping ? 'length' : 'stop');
      }
      const module = prompt.match(/^Write documentation for the \*\*(.+?)\*\* module/)?.[1];
      requests.push(module ?? 'overview');
      prompts.set(module ?? 'overview', prompt);
      if (!module && cutOffOverview) return streamedWikiResponse('cut off', 'length');
      return streamedWikiResponse(`${module ?? 'Overview'} page, revision ${revision}.`);
    });
  });

  afterEach(async () => {
    mock.restoreAll();
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
      // with the same options, reviewOnly off and useSavedTree on.
      const tree = await savedTree();
      tree[0] = { ...tree[0], name: 'Back end', slug: 'back-end' };
      await fs.writeFile(path.join(wikiPath, 'module_tree.json'), JSON.stringify(tree, null, 2));
      requests = [];

      await run({ force: true, useSavedTree: true });

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

    it('keeps the previous overview page when the run fails, then completes the run', async () => {
      await commit(...JOBS);
      grouping = { Api: API, Core: CORE, Jobs: JOBS };
      cutOffOverview = true;

      await expect(run()).rejects.toThrow('completion token limit');

      expect(await page('overview')).toContain('Overview page, revision 1.');
      expect(await page('jobs')).toContain('Jobs page, revision 2.');
      expect((await meta()).regrouping).toMatchObject({ staleRemoved: true });

      // The rerun at the same commit keeps the grouping and the pages of the
      // failed run, whatever the model would answer now.
      grouping = { Services: [...API, ...CORE, ...JOBS] };
      requests = [];
      revision = 3;
      cutOffOverview = false;
      expect(await run()).toEqual({ pagesGenerated: 1, mode: 'incremental', failedModules: [] });

      expect(requests).toEqual(['overview']);
      expect(names(await savedTree())).toEqual(['Api', 'Core', 'Jobs']);
      expect(await page('jobs')).toContain('Jobs page, revision 2.');
      expect(await page('overview')).toContain('Overview page, revision 3.');
      expect((await meta()).regrouping).toBeUndefined();
    });

    /**
     * A run that groups Api with three job files and the other three as Jobs,
     * writes api.md and jobs.md, then fails at the overview.
     */
    async function failAfterRewritingApi(): Promise<void> {
      await commit(...JOBS);
      grouping = { Api: [...API, ...JOBS.slice(0, 3)], Core: CORE, Jobs: JOBS.slice(3) };
      cutOffOverview = true;
      await expect(run()).rejects.toThrow('completion token limit');
      expect(requests).toEqual(['grouping', 'Api', 'Jobs', 'overview']);
      expect(prompts.get('Api')).toContain('--- jobs/job1.ts ---');
      expect(await page('api')).toContain('Api page, revision 2.');
      requests = [];
      revision = 3;
      cutOffOverview = false;
    }

    it('takes back a failed run when HEAD returns to the commit the wiki documents', async () => {
      await failAfterRewritingApi();
      git('checkout', '-q', 'HEAD~1');

      expect(await run()).toEqual({ pagesGenerated: 2, mode: 'incremental', failedModules: [] });

      // api.md documented the job files; it is written again from the old module.
      expect(requests).toEqual(['Api', 'overview']);
      expect(prompts.get('Api')).not.toContain('jobs/');
      expect(await page('api')).toContain('Api page, revision 3.');
      expect(await page('core')).toContain('Core page, revision 1.');
      expect(await pages()).toEqual(['api.md', 'core.md', 'overview.md']);
      expect(names(await savedTree())).toEqual(['Api', 'Core']);
      expect((await meta()).regrouping).toBeUndefined();
    });

    it('takes back a run that stopped while it deleted pages', async () => {
      await commit(...JOBS);
      grouping = { Api: [...API, ...JOBS], Core: CORE };
      const rm = fs.rm.bind(fs);
      const spy = mock.method(fs, 'rm', async (target, options) => {
        if (String(target).endsWith('api.md')) throw new Error('disk unplugged');
        return rm(target, options);
      });
      try {
        await expect(run()).rejects.toThrow('disk unplugged');
      } finally {
        spy.mock.restore();
      }
      requests = [];
      revision = 3;
      git('checkout', '-q', 'HEAD~1');

      await run();

      expect(requests).toEqual(['Api', 'overview']);
      expect(await page('api')).toContain('Api page, revision 3.');
    });

    it('generates the tree approved on --review after a failed run', async () => {
      await failAfterRewritingApi();
      const review = await run({ reviewOnly: true });
      // The review shows the tree of the run to complete.
      expect(requests).toEqual([]);
      expect(names(review.moduleTree ?? [])).toEqual(['Api', 'Core', 'Jobs']);
      const tree = await savedTree();
      tree[1] = { ...tree[1], name: 'Storage', slug: 'storage' };
      await fs.writeFile(path.join(wikiPath, 'module_tree.json'), JSON.stringify(tree, null, 2));

      await run({ useSavedTree: true });

      expect(requests).toEqual(['Api', 'Storage', 'Jobs', 'overview']);
      expect(await pages()).toEqual(['api.md', 'jobs.md', 'overview.md', 'storage.md']);
      expect(await page('jobs')).toContain('Jobs page, revision 3.');
    });

    it('groups again at a later commit and writes again the pages a failed run wrote', async () => {
      await failAfterRewritingApi();
      await commit('core/db.ts');
      grouping = { Api: API, Core: CORE, Jobs: JOBS };

      await run();

      expect(requests).toEqual(['grouping', 'Api', 'Core', 'Jobs', 'overview']);
      expect(prompts.get('Api')).not.toContain('jobs/');
      expect(await page('api')).toContain('Api page, revision 3.');
    });

    it('keeps the saved tree and every page when the grouping request fails', async () => {
      const viewer = await fs.readFile(path.join(wikiPath, 'index.html'), 'utf8');
      await commit(...JOBS);
      grouping = { Services: [...API, ...CORE, ...JOBS] };
      cutOffGrouping = true;

      await expect(run()).rejects.toThrow('completion token limit');

      expect(names(await savedTree())).toEqual(['Api', 'Core']);
      expect(await pages()).toEqual(['api.md', 'core.md', 'overview.md']);
      git('checkout', '-q', 'HEAD~1');
      expect((await run()).mode).toBe('up-to-date');
      expect(await fs.readFile(path.join(wikiPath, 'index.html'), 'utf8')).toBe(viewer);
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

    it('rewrites two modules of unchanged sizes that swapped files', async () => {
      await commit(...JOBS);
      grouping = { Api: [API[0], CORE[0]], Core: [API[1], CORE[1]], Jobs: JOBS };

      await run();

      expect(requests).toEqual(['grouping', 'Api', 'Core', 'Jobs', 'overview']);
    });

    it('accepts any module name, Object members included', async () => {
      await commit(...JOBS);
      grouping = { Api: API, Core: CORE, constructor: JOBS };

      await run();

      expect(requests).toEqual(['grouping', 'constructor', 'overview']);
    });

    it('groups again when the saved tree is not JSON', async () => {
      await fs.writeFile(path.join(wikiPath, 'module_tree.json'), '{');
      await commit(...JOBS);
      grouping = { Api: API, Core: CORE, Jobs: JOBS };

      await run();

      expect(requests).toEqual(['grouping', 'Jobs', 'overview']);
      expect(names(await savedTree())).toEqual(['Api', 'Core', 'Jobs']);
    });

    it('writes again a page an older wiki left under the name of a new module', async () => {
      await fs.writeFile(path.join(wikiPath, 'jobs.md'), '# Jobs of an older wiki\n');
      await commit(...JOBS);
      grouping = { Api: API, Core: CORE, Jobs: JOBS };

      await run();

      expect(requests).toEqual(['grouping', 'Jobs', 'overview']);
      expect(await page('jobs')).toContain('Jobs page, revision 2.');
    });

    it('groups again for files moved to new paths', async () => {
      await commit(...JOBS);
      grouping = { Api: API, Core: CORE, Jobs: JOBS };
      await run();
      requests = [];
      revision = 3;
      git('mv', 'jobs', 'tasks');
      git(...AUTHOR, 'commit', '-qm', 'move');
      const tasks = JOBS.map((job) => job.replace('jobs/', 'tasks/'));
      files = [...API, ...CORE, ...tasks].sort();

      grouping = { Api: API, Core: CORE, Tasks: tasks };

      await run();

      expect(requests).toEqual(['grouping', 'Tasks', 'overview']);
      expect(await pages()).toEqual(['api.md', 'core.md', 'overview.md', 'tasks.md']);
    });

    it('leaves pages it did not write in the wiki folder', async () => {
      await fs.writeFile(path.join(wikiPath, 'runbook.md'), '# Runbook\n');
      await commit(...JOBS);
      grouping = { Services: [...API, ...CORE, ...JOBS] };

      await run();

      expect(await pages()).toEqual(['overview.md', 'runbook.md', 'services.md']);
    });

    it('does not group again for new paths the graph does not index', async () => {
      await commitUnindexed(...Array.from({ length: 6 }, (_, i) => `.changeset/change${i + 1}.md`));
      grouping = { Services: [...API, ...CORE] };

      expect(await run()).toEqual({ pagesGenerated: 0, mode: 'incremental', failedModules: [] });

      expect(requests).toEqual([]);
      expect(names(await savedTree())).toEqual(['Api', 'Core']);
    });

    it('rewrites a module that lost files to another module', async () => {
      await commit(...JOBS);
      grouping = { Api: ['api/orders.ts'], Users: ['api/users.ts'], Core: CORE, Jobs: JOBS };

      await run();

      expect(requests).toEqual(['grouping', 'Api', 'Users', 'Jobs', 'overview']);
      expect(prompts.get('Api')).not.toContain('--- api/users.ts ---');
      expect(await page('core')).toContain('Core page, revision 1.');
    });

    it('leaves the existing pages and the viewer alone while --review waits for the user', async () => {
      const viewer = await fs.readFile(path.join(wikiPath, 'index.html'), 'utf8');
      await commit(...JOBS);
      grouping = { Services: [...API, ...CORE, ...JOBS] };

      await run({ reviewOnly: true });

      expect(requests).toEqual(['grouping']);
      expect(await pages()).toEqual(['api.md', 'core.md', 'overview.md']);
      expect(await fs.readFile(path.join(wikiPath, 'index.html'), 'utf8')).toBe(viewer);
    });

    it('generates the tree approved on --review even when it is the previous tree', async () => {
      await commit(...JOBS);
      grouping = { Api: API, Core: CORE, Jobs: JOBS };
      await run({ reviewOnly: true });
      // The user removes the Jobs module, which gives back the previous tree.
      const tree = await savedTree();
      await fs.writeFile(path.join(wikiPath, 'module_tree.json'), JSON.stringify(tree.slice(0, 2)));
      requests = [];

      await run({ useSavedTree: true });

      expect(requests).toEqual(['overview']);
      expect(names(await savedTree())).toEqual(['Api', 'Core']);
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

      await run({ useSavedTree: true });

      expect(requests).toEqual(['Background jobs', 'overview']);
      expect(await pages()).toEqual(['api.md', 'background-jobs.md', 'core.md', 'overview.md']);
    });
  });

  it('does not group again for edits to files a reviewed tree left out', async () => {
    const tests = Array.from({ length: 6 }, (_, i) => `test/case${i + 1}.ts`);
    await commit(...API, ...CORE, ...tests);
    const tree = [
      { name: 'Api', slug: 'api', files: API },
      { name: 'Storage', slug: 'storage', files: CORE },
    ];
    await fs.writeFile(path.join(wikiPath, 'module_tree.json'), JSON.stringify(tree));
    await run();
    requests = [];
    revision = 2;
    // Six edits outside the tree and one new file: only the new file counts.
    await commit(...tests, 'api/health.ts');
    grouping = { Api: API, Core: CORE, Tests: tests };

    expect(await run()).toEqual({ pagesGenerated: 0, mode: 'incremental', failedModules: [] });

    expect(requests).toEqual([]);
    expect(await pages()).toEqual(['api.md', 'overview.md', 'storage.md']);
  });

  it('rewrites the Other page on a regrouping after files were added to it', async () => {
    await generate([...API, ...CORE, 'misc.ts'], { Api: API, Core: CORE, Other: ['misc.ts'] });
    await commit('a.ts', 'b.ts', 'c.ts');
    await run();
    expect(requests).toEqual(['Other', 'overview']);
    requests = [];
    revision = 3;
    await commit(...JOBS);
    grouping = { Api: API, Core: CORE, Other: ['a.ts', 'b.ts', 'c.ts', 'misc.ts'], Jobs: JOBS };

    await run();

    expect(requests).toEqual(['grouping', 'Other', 'Jobs', 'overview']);
    expect(prompts.get('Other')).toContain('--- a.ts ---');
  });

  it('rewrites the page of a module whose file has a non-ASCII name', async () => {
    const settings = 'core/設定.ts';
    await generate([...API, ...CORE, settings], { Api: API, Core: [...CORE, settings] });
    await commit(settings);

    await run();

    expect(requests).toEqual(['Core', 'overview']);
    expect(await page('core')).toContain('Core page, revision 2.');
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

    /** Proposes the same tree on --review, lets `edit` change it, and generates it. */
    async function reviewAndGenerate(edit: (tree: ModuleTreeNode[]) => void): Promise<void> {
      await commit(...JOBS);
      grouping = { Api: [...V1, ...V2], Core: CORE, Jobs: JOBS };
      await run({ ...options, reviewOnly: true });
      const tree = await savedTree();
      edit(tree);
      await fs.writeFile(path.join(wikiPath, 'module_tree.json'), JSON.stringify(tree, null, 2));
      requests = [];
      await run({ ...options, useSavedTree: true });
    }

    it('rewrites a parent page whose sub-module the user only gave another page name', async () => {
      const [api] = await savedTree();
      const [v1, v2] = api.children ?? [];

      await reviewAndGenerate((tree) => {
        tree[0].children = [v1, { ...v2, slug: 'api-current' }];
      });

      expect(requests).toEqual([v2.name, 'Jobs', 'Api', 'overview']);
      expect(await pages()).toContain('api-current.md');
      expect(await pages()).not.toContain(`${v2.slug}.md`);
    });

    it('rewrites a parent page whose sub-module the user removed', async () => {
      const [api] = await savedTree();
      const [v1, v2] = api.children ?? [];

      await reviewAndGenerate((tree) => {
        tree[0].children = [v1];
      });

      expect(requests).toEqual(['Jobs', 'Api', 'overview']);
      expect(await pages()).not.toContain(`${v2.slug}.md`);
    });

    it('rewrites the page of a module the user renamed without changing its page name', async () => {
      await reviewAndGenerate((tree) => {
        tree[1] = { ...tree[1], name: 'Storage' };
      });

      expect(requests).toEqual(['Storage', 'Jobs', 'overview']);
      expect(await page('core')).toContain('Storage page, revision 2.');
    });

    it('rewrites a parent page the user turned into a module without sub-modules', async () => {
      const [api] = await savedTree();
      const [v1, v2] = api.children ?? [];

      await reviewAndGenerate((tree) => {
        tree[0] = { name: 'Api', slug: api.slug, files: [...V1, ...V2] };
      });

      expect(requests).toEqual(['Api', 'Jobs', 'overview']);
      expect(await pages()).not.toContain(`${v1.slug}.md`);
      expect(await pages()).not.toContain(`${v2.slug}.md`);
      expect(await page(api.slug)).toContain('Api page, revision 2.');
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

      await run({ ...options, useSavedTree: true });

      expect(requests).toEqual(['Api — current', 'Jobs', 'Api', 'overview']);
      expect(prompts.get('Api')).toContain('Api — current page, revision 2.');
      expect(await pages()).not.toContain(`${v2.slug}.md`);
      expect(await page(v1.slug)).toContain(`${v1.name} page, revision 1.`);
    });
  });
});
