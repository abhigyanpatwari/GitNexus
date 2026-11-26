import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { expect } from 'expect';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTestEnvironment } from '../support/environment.js';
import { mockWikiGraph, streamedWikiResponse } from '../support/wiki-graph.js';
import type { ModuleTreeNode, WikiOptions } from '../../../../src/core/wiki/generator.js';

const environment = createTestEnvironment();
let indexedFiles: string[] = [];
mockWikiGraph({ getAllFiles: async () => indexedFiles });
const { WikiGenerator } = await import('../../../../dist/core/wiki/generator.js');

/** One request the fake provider received: the page it was asked for and its prompt. */
interface PageRequest {
  page: string;
  prompt: string;
}

describe('incremental wiki update of a module with sub-modules', () => {
  let repoPath: string;
  let wikiPath: string;
  let requests: PageRequest[];
  /** Part of every answer, so a page shows which run wrote it. */
  let revision: number;
  /** Pages whose next answer stops at the completion-token limit. */
  let cutOff: Set<string>;

  function git(...args: string[]): void {
    execFileSync('git', args, { cwd: repoPath });
  }

  async function commitChange(...files: string[]): Promise<void> {
    for (const file of files) {
      await fs.appendFile(path.join(repoPath, file), `export const edited${revision} = true;\n`);
    }
    git('add', ...files);
    git('-c', 'user.name=Wiki Test', '-c', 'user.email=wiki@example.test', 'commit', '-qm', 'edit');
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

  const page = (slug: string) => fs.readFile(path.join(wikiPath, `${slug}.md`), 'utf8');

  beforeEach(async () => {
    repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-incremental-'));
    wikiPath = path.join(repoPath, '.gitnexus', 'wiki');
    await fs.mkdir(wikiPath, { recursive: true });
    for (const file of ['billing.ts', 'shipping.ts', 'notes.ts']) {
      await fs.writeFile(path.join(repoPath, file), `export const ${file.slice(0, -3)} = 1;\n`);
    }
    git('init', '-q');
    git('config', 'commit.gpgsign', 'false');
    git('add', 'billing.ts', 'shipping.ts', 'notes.ts');
    indexedFiles = ['billing.ts', 'shipping.ts', 'notes.ts'];
    git('-c', 'user.name=Wiki Test', '-c', 'user.email=wiki@example.test', 'commit', '-qm', 'init');
    // A large module split into sub-modules, next to a module without any.
    await fs.writeFile(
      path.join(wikiPath, 'module_tree.json'),
      JSON.stringify([
        {
          name: 'Commerce',
          slug: 'commerce',
          files: [],
          children: [
            { name: 'Billing', slug: 'billing', files: ['billing.ts'] },
            { name: 'Shipping', slug: 'shipping', files: ['shipping.ts'] },
          ],
        },
        { name: 'Notes', slug: 'notes', files: ['notes.ts'] },
      ]),
    );

    requests = [];
    revision = 1;
    cutOff = new Set();
    mock.method(globalThis, 'fetch', async (_url, init: RequestInit = {}) => {
      const { messages } = JSON.parse(String(init.body));
      const prompt: string = messages.at(-1).content;
      const page = prompt.match(/^Write documentation for the \*\*(.+?)\*\* module/)?.[1];
      requests.push({ page: page ?? 'overview', prompt });
      if (page && cutOff.has(page)) return streamedWikiResponse('cut off', 'length');
      return streamedWikiResponse(`${page ?? 'Overview'} page, revision ${revision}.`);
    });

    expect((await run()).mode).toBe('full');
    expect(requests.map((r) => r.page)).toEqual([
      'Billing',
      'Shipping',
      'Notes',
      'Commerce',
      'overview',
    ]);
    requests = [];
    revision = 2;
  });

  afterEach(async () => {
    mock.restoreAll();
    environment.restore();
    await fs.rm(repoPath, { recursive: true, force: true });
  });

  it('rejects a relative custom Git path', () => {
    environment.set('GITNEXUS_WIKI_GIT_PATH', 'git');
    expect(() => run()).toThrow(/GITNEXUS_WIKI_GIT_PATH must be the absolute path/);
  });

  it('does not report an up-to-date wiki when neither revision is known', async () => {
    await fs.rename(path.join(repoPath, '.git'), path.join(repoPath, 'saved-git'));
    const metaPath = path.join(wikiPath, 'meta.json');
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    await fs.writeFile(metaPath, JSON.stringify({ ...meta, fromCommit: '' }));
    expect((await run()).mode).toBe('full');
  });

  it('regenerates the sub-module page of a changed file before its parent page', async () => {
    await commitChange('billing.ts');
    // Git discovery during wiki generation must be independent of the checkout and PATH.
    environment.set('PATH', repoPath);

    expect(await run()).toEqual({ pagesGenerated: 3, mode: 'incremental', failedModules: [] });

    expect(requests.map((r) => r.page)).toEqual(['Billing', 'Commerce', 'overview']);
    expect(requests[0].prompt).toContain('export const edited2 = true;');
    expect(await page('billing')).toContain('Billing page, revision 2.');
    // The parent page is written from the new sub-module page.
    expect(requests[1].prompt).toContain('Billing page, revision 2.');
    expect(await page('commerce')).toContain('Commerce page, revision 2.');
    expect(await page('shipping')).toContain('Shipping page, revision 1.');
    expect(await page('notes')).toContain('Notes page, revision 1.');
    // A file listed under two modules is a known file, not a new one.
    const meta = JSON.parse(await fs.readFile(path.join(wikiPath, 'meta.json'), 'utf8'));
    expect(Object.keys(meta.moduleFiles)).toEqual(['Commerce', 'Billing', 'Shipping', 'Notes']);
  });

  it('regenerates the parent page once when files of two sub-modules change', async () => {
    await commitChange('billing.ts', 'shipping.ts');

    expect(await run()).toEqual({ pagesGenerated: 4, mode: 'incremental', failedModules: [] });

    expect(requests.map((r) => r.page)).toEqual(['Billing', 'Shipping', 'Commerce', 'overview']);
    expect(requests[2].prompt).toContain('Billing page, revision 2.');
    expect(requests[2].prompt).toContain('Shipping page, revision 2.');
    expect(await page('notes')).toContain('Notes page, revision 1.');
  });

  it('leaves the module tree alone when the changed file is in a module without sub-modules', async () => {
    await commitChange('notes.ts');

    expect(await run()).toEqual({ pagesGenerated: 2, mode: 'incremental', failedModules: [] });

    expect(requests.map((r) => r.page)).toEqual(['Notes', 'overview']);
    expect(await page('billing')).toContain('Billing page, revision 1.');
    expect(await page('commerce')).toContain('Commerce page, revision 1.');
  });

  /** Runs an update whose Billing answer is cut off, so Commerce is held back. */
  async function failBilling(): Promise<void> {
    await commitChange('billing.ts');
    cutOff.add('Billing');
    expect(await run()).toEqual({
      pagesGenerated: 0,
      mode: 'incremental',
      failedModules: ['Billing', 'Commerce'],
    });
    expect(requests.map((r) => r.page)).toEqual(['Billing']);
    requests = [];
    revision = 3;
    cutOff.clear();
  }

  const pageOrNothing = (slug: string) => page(slug).catch(() => '');

  it('holds the parent page back until a failed sub-module page is retried', async () => {
    await commitChange('billing.ts');
    cutOff.add('Billing');

    expect(await run()).toEqual({
      pagesGenerated: 0,
      mode: 'incremental',
      failedModules: ['Billing', 'Commerce'],
    });
    expect(requests.map((r) => r.page)).toEqual(['Billing']);
    // The held-back parent keeps its last page; only the failed page is gone.
    expect(await pageOrNothing('billing')).toBe('');
    expect(await page('commerce')).toContain('Commerce page, revision 1.');
    expect(await page('shipping')).toContain('Shipping page, revision 1.');
    expect(await page('notes')).toContain('Notes page, revision 1.');

    requests = [];
    revision = 3;
    cutOff.clear();
    expect(await run()).toEqual({ pagesGenerated: 3, mode: 'incremental', failedModules: [] });

    expect(requests.map((r) => r.page)).toEqual(['Billing', 'Commerce', 'overview']);
    expect(requests[1].prompt).toContain('Billing page, revision 3.');
    expect(await page('billing')).toContain('Billing page, revision 3.');
    expect(await page('commerce')).toContain('Commerce page, revision 3.');
  });

  it('removes a parent page whose own answer is cut off, and retries it', async () => {
    await commitChange('billing.ts');
    cutOff.add('Commerce');

    // Billing and the overview.
    expect(await run()).toEqual({
      pagesGenerated: 2,
      mode: 'incremental',
      failedModules: ['Commerce'],
    });
    expect(await page('billing')).toContain('Billing page, revision 2.');
    expect(await pageOrNothing('commerce')).toBe('');

    requests = [];
    revision = 3;
    cutOff.clear();
    expect(await run()).toMatchObject({ failedModules: [] });
    expect(requests.map((r) => r.page)).toEqual(['Commerce', 'overview']);
    expect(await page('commerce')).toContain('Commerce page, revision 3.');
  });

  it('retries a held-back parent when the branch has diverged since the failed run', async () => {
    await failBilling();
    // Leave the commit the failed run documented: its history is no longer ours.
    git('reset', '-q', '--hard', 'HEAD~1');
    await commitChange('notes.ts');

    expect(await run()).toMatchObject({ mode: 'incremental', failedModules: [] });

    expect(requests.map((r) => r.page)).toEqual(['Billing', 'Commerce', 'overview']);
    expect(await page('billing')).toContain('Billing page, revision 3.');
    expect(await page('commerce')).toContain('Commerce page, revision 3.');
  });

  it('leaves no page of a held-back parent behind when many new files arrive', async () => {
    await failBilling();
    const added = Array.from({ length: 6 }, (_, i) => `extra${i}.ts`);
    for (const file of added) {
      await fs.writeFile(path.join(repoPath, file), `export const ${file.slice(0, -3)} = 1;\n`);
    }
    // The graph indexes the new files, as it does once analyze has run.
    indexedFiles = ['billing.ts', 'shipping.ts', 'notes.ts', ...added];
    git('add', ...added);
    git('-c', 'user.name=Wiki Test', '-c', 'user.email=wiki@example.test', 'commit', '-qm', 'add');

    expect(await run()).toMatchObject({ mode: 'incremental', failedModules: [] });

    // The full generation this falls back to keeps existing pages: the page
    // from before the failure must be written again, not kept.
    expect(await pageOrNothing('commerce')).not.toContain('revision 1.');
  });

  /** Generates the wiki again from module_tree.json as `edit` changes it, as --review allows. */
  async function regenerateWith(edit: (tree: ModuleTreeNode[]) => void): Promise<void> {
    const treePath = path.join(wikiPath, 'module_tree.json');
    const tree = JSON.parse(await fs.readFile(treePath, 'utf8'));
    edit(tree);
    await fs.writeFile(treePath, JSON.stringify(tree));
    expect(await run({ force: true })).toMatchObject({ mode: 'full', failedModules: [] });
    requests = [];
    revision = 3;
  }

  it('regenerates the pages of modules whose page names do not come from their names', async () => {
    await regenerateWith((tree) => {
      tree[0] = {
        name: 'Commerce',
        slug: 'shop',
        files: [],
        children: [
          { name: 'Billing', slug: 'payments', files: ['billing.ts'] },
          { name: 'Shipping', slug: 'shipping', files: ['shipping.ts'] },
        ],
      };
    });
    await commitChange('billing.ts');

    expect(await run()).toEqual({ pagesGenerated: 3, mode: 'incremental', failedModules: [] });

    expect(requests.map((r) => r.page)).toEqual(['Billing', 'Commerce', 'overview']);
    expect(await page('payments')).toContain('Billing page, revision 3.');
    expect(await page('shop')).toContain('Commerce page, revision 3.');
  });

  it("finds a module by its name before the page another module's name gives", async () => {
    // Shipping renamed Notes, and Notes renamed Journal: both keep their pages.
    await regenerateWith((tree) => {
      tree[0].children = [
        { name: 'Billing', slug: 'billing', files: ['billing.ts'] },
        { name: 'Notes', slug: 'shipping', files: ['shipping.ts'] },
      ];
      tree[1] = { name: 'Journal', slug: 'notes', files: ['notes.ts'] };
    });
    await commitChange('shipping.ts');

    await run();

    expect(requests.map((r) => r.page)).toEqual(['Notes', 'Commerce', 'overview']);
    expect(await page('shipping')).toContain('Notes page, revision 3.');
  });

  it('retries a held-back parent whose page name does not come from its module name', async () => {
    await regenerateWith((tree) => {
      tree[0].slug = 'shop';
    });
    await failBilling();
    expect(await page('shop')).toContain('Commerce page, revision 2.');
    git('reset', '-q', '--hard', 'HEAD~1');
    await commitChange('notes.ts');

    expect(await run()).toMatchObject({ mode: 'incremental', failedModules: [] });

    expect(requests.map((r) => r.page)).toEqual(['Billing', 'Commerce', 'overview']);
    expect(await page('shop')).toContain('Commerce page, revision 3.');
  });

  it('still finds a renamed module by the page name it kept', async () => {
    // The catch-all module renamed on --review: new files are still listed as Other.
    await regenerateWith((tree) => {
      tree[1] = { name: 'Misc', slug: 'other', files: ['notes.ts'] };
    });
    await fs.writeFile(path.join(repoPath, 'todo.ts'), 'export const todo = 1;\n');
    indexedFiles = ['billing.ts', 'shipping.ts', 'notes.ts', 'todo.ts'];
    git('add', 'todo.ts');
    git('-c', 'user.name=Wiki Test', '-c', 'user.email=wiki@example.test', 'commit', '-qm', 'add');

    expect(await run()).toEqual({ pagesGenerated: 2, mode: 'incremental', failedModules: [] });

    expect(requests.map((r) => r.page)).toEqual(['Misc', 'overview']);
  });
});
