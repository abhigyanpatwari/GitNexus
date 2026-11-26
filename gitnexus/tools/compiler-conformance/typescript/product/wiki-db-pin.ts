import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import { expect } from 'expect';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mockWikiGraph } from '../support/wiki-graph.js';

const events: string[] = [];
const initialized: string[] = [];
mockWikiGraph({
  initWikiDb: async (file) => {
    initialized.push(file);
  },
  pinWikiDb: () => {
    events.push('pin');
    return () => {
      events.push('release');
    };
  },
  closeWikiDb: async () => {
    events.push('close');
  },
  getFilesWithExports: async () => [
    { filePath: 'src/index.ts', symbols: [{ name: 'value', type: 'Variable' }] },
  ],
  getAllFiles: async () => ['src/index.ts'],
});
const html = mock.module(
  new URL('../../../../dist/core/wiki/html-viewer.js', import.meta.url).href,
  {
    namedExports: { generateHTMLViewer: async () => '' },
  },
);
after(() => html.restore());
const { WikiGenerator } = await import('../../../../dist/core/wiki/generator.js');

describe('WikiGenerator DB pinning', () => {
  let tmpDir: string;
  let repoPath: string;
  let storagePath: string;
  let lbugPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-wiki-pin-'));
    repoPath = path.join(tmpDir, 'repo');
    storagePath = path.join(repoPath, '.gitnexus');
    lbugPath = path.join(storagePath, 'lbug');

    await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });
    await fs.mkdir(path.join(storagePath, 'wiki'), { recursive: true });
    await fs.writeFile(path.join(repoPath, 'src', 'index.ts'), 'export const value = 1;\n');
    await fs.writeFile(lbugPath, '');
    await fs.writeFile(
      path.join(storagePath, 'wiki', 'module_tree.json'),
      JSON.stringify([{ name: 'Core', slug: 'core', files: ['src/index.ts'] }]),
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('pins the wiki DB for the run and releases the lease before closing', async () => {
    const generator = new WikiGenerator(
      repoPath,
      storagePath,
      lbugPath,
      {
        provider: 'openai',
        model: 'test-model',
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: 'test',
        maxTokens: 1024,
        temperature: 0,
      },
      { force: true, reviewOnly: true },
    );

    await expect(generator.run()).resolves.toMatchObject({
      mode: 'full',
      pagesGenerated: 0,
    });

    expect(initialized).toEqual([lbugPath]);
    expect(events).toEqual(['pin', 'release', 'close']);
  });
});
