import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WikiGenerator, type WikiOptions } from '../../src/core/wiki/generator.js';

vi.mock('../../src/core/wiki/graph-queries.js', () => ({
  initWikiDb: vi.fn().mockResolvedValue(undefined),
  closeWikiDb: vi.fn().mockResolvedValue(undefined),
  touchWikiDb: vi.fn(),
  pinWikiDb: vi.fn(() => vi.fn()),
  getFilesWithExports: vi.fn().mockResolvedValue([]),
  getAllFiles: vi.fn().mockResolvedValue(['billing.ts', 'shipping.ts']),
  getIntraModuleCallEdges: vi.fn().mockResolvedValue([]),
  getInterModuleCallEdges: vi.fn().mockResolvedValue({ incoming: [], outgoing: [] }),
  getProcessesForFiles: vi.fn().mockResolvedValue([]),
  getAllProcesses: vi.fn().mockResolvedValue([]),
  getInterModuleEdgesForOverview: vi.fn().mockResolvedValue([]),
}));

function response(content: string, finishReason = 'stop'): Response {
  const chunk = { choices: [{ delta: { content }, finish_reason: finishReason }] };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('wiki generation after a completion-token limit', () => {
  let repoPath: string;
  let storagePath: string;
  let wikiPath: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  function git(...args: string[]): string {
    return execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' }).trim();
  }

  function commit(): string {
    git('add', 'billing.ts', 'shipping.ts');
    git(
      '-c',
      'user.name=Wiki Test',
      '-c',
      'user.email=wiki@example.test',
      'commit',
      '-qm',
      'fixture',
    );
    return git('rev-parse', 'HEAD');
  }

  function generator(options: WikiOptions = {}): WikiGenerator {
    return new WikiGenerator(
      repoPath,
      storagePath,
      '/unused/lbug',
      {
        apiKey: 'test',
        baseUrl: 'https://wiki.example.test/v1',
        model: 'test-model',
        maxTokens: 65_536,
        temperature: 0,
        provider: 'custom',
      },
      { concurrency: 1, ...options },
    );
  }

  async function metadata() {
    return JSON.parse(await fs.readFile(path.join(wikiPath, 'meta.json'), 'utf8'));
  }

  beforeEach(async () => {
    repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-truncation-'));
    storagePath = path.join(repoPath, '.gitnexus');
    wikiPath = path.join(storagePath, 'wiki');
    await fs.mkdir(wikiPath, { recursive: true });
    await fs.writeFile(path.join(repoPath, 'billing.ts'), 'export const bill = 1;\n');
    await fs.writeFile(path.join(repoPath, 'shipping.ts'), 'export const ship = 1;\n');
    git('init', '-q');
    commit();
    await fs.writeFile(
      path.join(wikiPath, 'module_tree.json'),
      JSON.stringify([
        { name: 'Billing', slug: 'billing', files: ['billing.ts'] },
        { name: 'Shipping', slug: 'shipping', files: ['shipping.ts'] },
      ]),
    );
    fetchMock = vi.fn().mockImplementation(async () => response('Complete documentation.'));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(repoPath, { recursive: true, force: true });
  });

  it('does not save a truncated page and retries it at the same commit', async () => {
    fetchMock.mockResolvedValueOnce(response('Incomplete table | --- | -', 'length'));

    expect(await generator().run()).toEqual({
      pagesGenerated: 2,
      mode: 'full',
      failedModules: ['Billing'],
    });
    await expect(fs.readFile(path.join(wikiPath, 'billing.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await metadata()).failedModules).toEqual(['Billing']);
    const shippingBefore = await fs.readFile(path.join(wikiPath, 'shipping.md'), 'utf8');
    fetchMock.mockClear();

    expect(await generator().run()).toEqual({
      pagesGenerated: 2,
      mode: 'incremental',
      failedModules: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(JSON.parse(init.body).max_completion_tokens).toBe(65_536);
    }
    expect(await fs.readFile(path.join(wikiPath, 'billing.md'), 'utf8')).toContain(
      'Complete documentation.',
    );
    expect(await fs.readFile(path.join(wikiPath, 'shipping.md'), 'utf8')).toBe(shippingBefore);
    expect((await metadata()).failedModules).toEqual([]);
    expect(await generator().run()).toEqual({
      pagesGenerated: 0,
      mode: 'up-to-date',
      failedModules: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a truncated incremental page after the new commit was recorded', async () => {
    await generator().run();
    await fs.writeFile(path.join(repoPath, 'billing.ts'), 'export const bill = 2;\n');
    const currentCommit = commit();
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(response('', 'length'));

    expect(await generator().run()).toEqual({
      pagesGenerated: 0,
      mode: 'incremental',
      failedModules: ['Billing'],
    });
    expect(await metadata()).toMatchObject({
      fromCommit: currentCommit,
      failedModules: ['Billing'],
    });
    expect(await generator().run()).toEqual({
      pagesGenerated: 2,
      mode: 'incremental',
      failedModules: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries failed forced generation even when an older wiki covers the same commit', async () => {
    await generator().run();
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(response('cut off', 'length'));

    expect((await generator({ force: true }).run()).failedModules).toEqual(['Billing']);
    expect((await generator().run()).mode).toBe('incremental');
    expect((await metadata()).failedModules).toEqual([]);
    expect(await fs.readFile(path.join(wikiPath, 'billing.md'), 'utf8')).toContain(
      'Complete documentation.',
    );
  });

  it('waits for a failed child to recover before generating its parent page', async () => {
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
      ]),
    );
    fetchMock.mockResolvedValueOnce(response('cut off', 'length'));

    expect((await generator().run()).failedModules).toEqual(['Billing', 'Commerce']);
    await expect(fs.readFile(path.join(wikiPath, 'commerce.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    fetchMock.mockClear();

    expect(await generator({ concurrency: 3 }).run()).toEqual({
      pagesGenerated: 3,
      mode: 'incremental',
      failedModules: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const parentPrompt = JSON.parse(fetchMock.mock.calls[1][1].body).messages[1].content;
    expect(parentPrompt).toContain('Complete documentation.');
    expect(parentPrompt).not.toContain('Documentation pending');
    expect((await metadata()).failedModules).toEqual([]);
  });

  it('does not retain a completion receipt when the forced overview is truncated', async () => {
    await generator().run();
    fetchMock.mockClear();
    fetchMock
      .mockResolvedValueOnce(response('Billing complete'))
      .mockResolvedValueOnce(response('Shipping complete'))
      .mockResolvedValueOnce(response('overview cut off', 'length'));

    await expect(generator({ force: true }).run()).rejects.toThrow('completion token limit');
    await expect(fs.readFile(path.join(wikiPath, 'meta.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await generator().run()).toEqual({
      pagesGenerated: 1,
      mode: 'full',
      failedModules: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(await fs.readFile(path.join(wikiPath, 'overview.md'), 'utf8')).toContain(
      'Complete documentation.',
    );
  });
});
