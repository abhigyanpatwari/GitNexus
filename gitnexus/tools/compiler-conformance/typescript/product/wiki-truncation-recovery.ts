import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { expect } from 'expect';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerCases } from '../support/cases.mjs';
import { mockWikiGraph, streamedWikiResponse } from '../support/wiki-graph.js';
import type { WikiOptions } from '../../../../src/core/wiki/generator.js';

mockWikiGraph({ getAllFiles: async () => ['billing.ts', 'shipping.ts'] });
const { WikiGenerator } = await import('../../../../dist/core/wiki/generator.js');

/** The grouping answer a forced run asks for first, before any page. */
function sameGrouping(): Response {
  return streamedWikiResponse(
    JSON.stringify({ Billing: ['billing.ts'], Shipping: ['shipping.ts'] }),
  );
}

describe('wiki generation after a completion-token limit', () => {
  let repoPath: string;
  let storagePath: string;
  let wikiPath: string;
  let responses: Response[];
  let requests: RequestInit[];
  let defaultResponse: () => Response;

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

  function generator(options: WikiOptions = {}) {
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
    responses = [];
    requests = [];
    defaultResponse = () => streamedWikiResponse('Complete documentation.');
    mock.method(globalThis, 'fetch', async (_url, init: RequestInit = {}) => {
      requests.push(init);
      return responses.shift() ?? defaultResponse();
    });
  });

  afterEach(async () => {
    mock.restoreAll();
    await fs.rm(repoPath, { recursive: true, force: true });
  });

  it('does not save a truncated page and retries it at the same commit', async () => {
    responses.push(streamedWikiResponse('Incomplete table | --- | -', 'length'));

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
    requests.length = 0;

    expect(await generator().run()).toEqual({
      pagesGenerated: 2,
      mode: 'incremental',
      failedModules: [],
    });
    expect(requests).toHaveLength(2);
    for (const init of requests) {
      expect(JSON.parse(String(init.body)).max_completion_tokens).toBe(65_536);
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
    expect(requests).toHaveLength(2);
  });

  registerCases(
    it,
    ['interrupted', 'context-window'] as const,
    'retries an incomplete Anthropic page after %s without saving partial output',
    async (failure: string) => {
      const anthropicResponse = (content: string, stopReason: string | null): Response => {
        const events: unknown[] = [
          { type: 'content_block_delta', delta: { type: 'text_delta', text: content } },
        ];
        if (stopReason !== null) {
          events.push(
            { type: 'message_delta', delta: { stop_reason: stopReason } },
            { type: 'message_stop' },
          );
        }
        return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      };
      const anthropicGenerator = () =>
        new WikiGenerator(
          repoPath,
          storagePath,
          '/unused/lbug',
          {
            apiKey: 'test',
            baseUrl: 'https://wiki.example.test/v1',
            model: 'test-model',
            maxTokens: 4096,
            temperature: 0,
            provider: 'anthropic',
          },
          { concurrency: 1 },
        );
      defaultResponse = () => anthropicResponse('Complete documentation.', 'end_turn');
      responses.push(
        anthropicResponse(
          'Incomplete page',
          failure === 'interrupted' ? null : 'model_context_window_exceeded',
        ),
      );

      expect(await anthropicGenerator().run()).toEqual({
        pagesGenerated: 2,
        mode: 'full',
        failedModules: ['Billing'],
      });
      await expect(fs.readFile(path.join(wikiPath, 'billing.md'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect((await metadata()).failedModules).toEqual(['Billing']);
      const shippingBefore = await fs.readFile(path.join(wikiPath, 'shipping.md'), 'utf8');
      requests.length = 0;

      expect(await anthropicGenerator().run()).toEqual({
        pagesGenerated: 2,
        mode: 'incremental',
        failedModules: [],
      });
      expect(requests).toHaveLength(2);
      expect(await fs.readFile(path.join(wikiPath, 'billing.md'), 'utf8')).toContain(
        'Complete documentation.',
      );
      expect(await fs.readFile(path.join(wikiPath, 'shipping.md'), 'utf8')).toBe(shippingBefore);
      expect((await metadata()).failedModules).toEqual([]);
    },
  );

  it('retries a truncated incremental page after the new commit was recorded', async () => {
    await generator().run();
    await fs.writeFile(path.join(repoPath, 'billing.ts'), 'export const bill = 2;\n');
    const currentCommit = commit();
    requests.length = 0;
    responses.push(streamedWikiResponse('', 'length'));

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
    expect(requests).toHaveLength(3);
  });

  it('retries failed forced generation even when an older wiki covers the same commit', async () => {
    await generator().run();
    requests.length = 0;
    responses.push(sameGrouping(), streamedWikiResponse('cut off', 'length'));

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
    responses.push(streamedWikiResponse('cut off', 'length'));

    expect((await generator().run()).failedModules).toEqual(['Billing', 'Commerce']);
    await expect(fs.readFile(path.join(wikiPath, 'commerce.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    requests.length = 0;

    expect(await generator({ concurrency: 3 }).run()).toEqual({
      pagesGenerated: 3,
      mode: 'incremental',
      failedModules: [],
    });
    expect(requests).toHaveLength(3);
    const parentPrompt = JSON.parse(String(requests[1].body)).messages[1].content;
    expect(parentPrompt).toContain('Complete documentation.');
    expect(parentPrompt).not.toContain('Documentation pending');
    expect((await metadata()).failedModules).toEqual([]);
  });

  it('does not retain a completion receipt when the forced overview is truncated', async () => {
    await generator().run();
    requests.length = 0;
    responses.push(
      sameGrouping(),
      streamedWikiResponse('Billing complete'),
      streamedWikiResponse('Shipping complete'),
      streamedWikiResponse('overview cut off', 'length'),
    );

    await expect(generator({ force: true }).run()).rejects.toThrow('completion token limit');
    await expect(fs.readFile(path.join(wikiPath, 'meta.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await generator().run()).toEqual({
      pagesGenerated: 1,
      mode: 'full',
      failedModules: [],
    });
    expect(requests).toHaveLength(5);
    expect(await fs.readFile(path.join(wikiPath, 'billing.md'), 'utf8')).toContain(
      'Billing complete',
    );
    expect(await fs.readFile(path.join(wikiPath, 'overview.md'), 'utf8')).toContain(
      'Complete documentation.',
    );
  });
});
