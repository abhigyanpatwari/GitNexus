import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const graphMocks = vi.hoisted(() => ({
  closeWikiDb: vi.fn(),
  getAllFiles: vi.fn(),
  getAllProcesses: vi.fn(),
  getFilesWithExports: vi.fn(),
  getInterModuleCallEdges: vi.fn(),
  getInterModuleEdgesForOverview: vi.fn(),
  getIntraModuleCallEdges: vi.fn(),
  getProcessesForFiles: vi.fn(),
  initWikiDb: vi.fn(),
  pinWikiDb: vi.fn(),
  releaseWikiDbPin: vi.fn(),
  touchWikiDb: vi.fn(),
}));

vi.mock('../../src/core/wiki/graph-queries.js', () => ({
  closeWikiDb: graphMocks.closeWikiDb,
  getAllFiles: graphMocks.getAllFiles,
  getAllProcesses: graphMocks.getAllProcesses,
  getFilesWithExports: graphMocks.getFilesWithExports,
  getInterModuleCallEdges: graphMocks.getInterModuleCallEdges,
  getInterModuleEdgesForOverview: graphMocks.getInterModuleEdgesForOverview,
  getIntraModuleCallEdges: graphMocks.getIntraModuleCallEdges,
  getProcessesForFiles: graphMocks.getProcessesForFiles,
  initWikiDb: graphMocks.initWikiDb,
  pinWikiDb: graphMocks.pinWikiDb,
  touchWikiDb: graphMocks.touchWikiDb,
}));

import { WikiGenerator, type ModuleTreeNode } from '../../src/core/wiki/generator.js';
import {
  GROUPING_SYSTEM_PROMPT,
  GROUPING_USER_PROMPT,
  MODULE_SYSTEM_PROMPT,
  MODULE_USER_PROMPT,
  OVERVIEW_SYSTEM_PROMPT,
  OVERVIEW_USER_PROMPT,
  PARENT_SYSTEM_PROMPT,
  PARENT_USER_PROMPT,
  fillTemplate,
} from '../../src/core/wiki/prompts.js';

const llmConfig = {
  apiKey: 'test',
  baseUrl: 'http://localhost',
  model: 'test-model',
  maxTokens: 1000,
  temperature: 0,
  provider: 'openai' as const,
};

const moduleTree: ModuleTreeNode[] = [
  {
    name: 'API Routes',
    slug: 'api-routes',
    files: ['src/api.ts'],
  },
];

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('legacy wiki prompt contract', () => {
  it('pins the exact bytes of all eight default prompt templates', () => {
    expect({
      GROUPING_SYSTEM_PROMPT: sha256(GROUPING_SYSTEM_PROMPT),
      GROUPING_USER_PROMPT: sha256(GROUPING_USER_PROMPT),
      MODULE_SYSTEM_PROMPT: sha256(MODULE_SYSTEM_PROMPT),
      MODULE_USER_PROMPT: sha256(MODULE_USER_PROMPT),
      PARENT_SYSTEM_PROMPT: sha256(PARENT_SYSTEM_PROMPT),
      PARENT_USER_PROMPT: sha256(PARENT_USER_PROMPT),
      OVERVIEW_SYSTEM_PROMPT: sha256(OVERVIEW_SYSTEM_PROMPT),
      OVERVIEW_USER_PROMPT: sha256(OVERVIEW_USER_PROMPT),
    }).toEqual({
      GROUPING_SYSTEM_PROMPT: 'a50e9bfd159524fe0b49a10a9a11115ea59a436e0a285eb42502fcf0b0f90548',
      GROUPING_USER_PROMPT: '7c4932844b6ad23ad2c96733091b05d6ae1cb01d23902bb7593f15885b6e8397',
      MODULE_SYSTEM_PROMPT: '6e81bf33c846fbedfe848e595fad1231ce8432002741bf56ce39c800d124151b',
      MODULE_USER_PROMPT: 'd94cb656aae878e0ce6b95e7c7af0a7752ae1a4b7a277e834fd1ba60f369ceb1',
      PARENT_SYSTEM_PROMPT: '0eaf37ecc101f008683053c23029b5f56d47564a204814c016279d0ab162454a',
      PARENT_USER_PROMPT: '301e1380e85b95f90f35c850ee94976e8a7ac9371ad2904cad8f63ec8ea458cd',
      OVERVIEW_SYSTEM_PROMPT: '7df7d37a51fc9cab4d505e77c2298bf25fb9f50c2c16259974d9e6a212c8bda0',
      OVERVIEW_USER_PROMPT: 'ab95502f2e81609ed713c603c3d1deed6dcd6c0571c3019bc1d178338c1b266a',
    });
  });

  it('keeps legacy fillTemplate replacement and residual placeholder semantics', () => {
    expect(fillTemplate('{{KNOWN}}/{{KNOWN}}/{{UNKNOWN}}', { KNOWN: 'value' })).toBe(
      'value/value/{{UNKNOWN}}',
    );
  });
});

describe('legacy WikiGenerator output contract', () => {
  let tmpDir: string;
  let repoPath: string;
  let storagePath: string;
  let wikiDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-wiki-legacy-'));
    repoPath = path.join(tmpDir, 'legacy-project');
    storagePath = path.join(tmpDir, 'storage');
    wikiDir = path.join(storagePath, 'wiki');

    await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });
    await fs.mkdir(wikiDir, { recursive: true });
    await fs.writeFile(path.join(repoPath, 'src', 'api.ts'), 'export function route() {}\n');

    graphMocks.pinWikiDb.mockReturnValue(graphMocks.releaseWikiDbPin);
    graphMocks.getFilesWithExports.mockResolvedValue([
      { filePath: 'src/api.ts', symbols: [{ name: 'route', type: 'Function' }] },
    ]);
    graphMocks.getAllFiles.mockResolvedValue(['src/api.ts']);
    graphMocks.getIntraModuleCallEdges.mockResolvedValue([]);
    graphMocks.getInterModuleCallEdges.mockResolvedValue({ incoming: [], outgoing: [] });
    graphMocks.getProcessesForFiles.mockResolvedValue([]);
    graphMocks.getAllProcesses.mockResolvedValue([]);
    graphMocks.getInterModuleEdgesForOverview.mockResolvedValue([]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function createGenerator(options: { force?: boolean; reviewOnly?: boolean; lang?: string } = {}) {
    const generator = new WikiGenerator(
      repoPath,
      storagePath,
      path.join(storagePath, 'lbug'),
      llmConfig,
      options,
    );
    (generator as any).getCurrentCommit = () => 'current-commit';
    return generator;
  }

  function mockDocumentationResponses(generator: WikiGenerator) {
    return vi
      .spyOn(generator as any, 'invokeLLM')
      .mockImplementation(async (_prompt: string, systemPrompt: string) => ({
        content: systemPrompt.includes('top-level overview') ? 'Overview body.' : 'Module body.',
      }));
  }

  it('preserves full-generation topology, English stable identifiers, language instruction, and HTML bundle', async () => {
    await fs.writeFile(path.join(wikiDir, 'module_tree.json'), JSON.stringify(moduleTree));
    const generator = createGenerator({ lang: 'chinese' });
    const invokeLLM = mockDocumentationResponses(generator);

    await expect(generator.run()).resolves.toEqual({
      pagesGenerated: 2,
      mode: 'full',
      failedModules: [],
    });

    expect((await fs.readdir(wikiDir)).sort()).toEqual([
      '.generations',
      '.staging',
      '.state',
      'api-routes.md',
      'index.html',
      'meta.json',
      'module_tree.json',
      'overview.md',
    ]);
    expect(await fs.readFile(path.join(wikiDir, 'api-routes.md'), 'utf8')).toBe(
      '# API Routes\n\nModule body.',
    );
    expect(await fs.readFile(path.join(wikiDir, 'overview.md'), 'utf8')).toBe(
      '# legacy-project — Wiki\n\nOverview body.',
    );

    const meta = JSON.parse(await fs.readFile(path.join(wikiDir, 'meta.json'), 'utf8'));
    expect(meta).toMatchObject({
      fromCommit: 'current-commit',
      model: 'test-model',
      lang: 'chinese',
      moduleFiles: { 'API Routes': ['src/api.ts'] },
      moduleTree,
    });
    expect(meta.generatedAt).toEqual(expect.any(String));

    expect(invokeLLM).toHaveBeenCalledTimes(2);
    expect(invokeLLM.mock.calls.map((call) => call[1])).toEqual([
      expect.stringContaining('Write ALL documentation content in chinese'),
      expect.stringContaining('Write ALL documentation content in chinese'),
    ]);

    const html = await fs.readFile(path.join(wikiDir, 'index.html'), 'utf8');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<title>legacy-project — Wiki</title>');
    expect(html).toContain('data-page="overview" href="#overview">\' + escH(MESSAGES.overview)');
    expect(html).toContain('"overview":"Overview"');
    expect(html).toContain('Generated by GitNexus');
    expect(html).toContain('"api-routes"');
  });

  it('preserves review-only topology without invoking the LLM or creating pages', async () => {
    await fs.writeFile(path.join(wikiDir, 'first_module_tree.json'), JSON.stringify(moduleTree));
    const generator = createGenerator({ reviewOnly: true });
    const invokeLLM = mockDocumentationResponses(generator);

    await expect(generator.run()).resolves.toEqual({
      pagesGenerated: 0,
      mode: 'full',
      failedModules: [],
      moduleTree,
    });

    expect(invokeLLM).not.toHaveBeenCalled();
    expect((await fs.readdir(wikiDir)).sort()).toEqual([
      'first_module_tree.json',
      'module_tree.json',
    ]);
  });

  it('preserves incremental regeneration and legacy meta cache behavior', async () => {
    await fs.writeFile(path.join(wikiDir, 'module_tree.json'), JSON.stringify(moduleTree));
    await fs.writeFile(path.join(wikiDir, 'api-routes.md'), '# API Routes\n\nOld body.');
    await fs.writeFile(path.join(wikiDir, 'overview.md'), '# legacy-project — Wiki\n\nOld body.');
    await fs.writeFile(
      path.join(wikiDir, 'meta.json'),
      JSON.stringify({
        fromCommit: 'previous-commit',
        generatedAt: '2026-01-01T00:00:00.000Z',
        model: 'old-model',
        moduleFiles: { 'API Routes': ['src/api.ts'] },
        moduleTree,
      }),
    );

    const generator = createGenerator();
    (generator as any).getChangedFiles = () => ['src/api.ts'];
    const invokeLLM = mockDocumentationResponses(generator);

    await expect(generator.run()).resolves.toEqual({
      pagesGenerated: 2,
      mode: 'incremental',
      failedModules: [],
    });
    expect(invokeLLM).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(path.join(wikiDir, 'api-routes.md'), 'utf8')).toBe(
      '# API Routes\n\nModule body.',
    );

    const meta = JSON.parse(await fs.readFile(path.join(wikiDir, 'meta.json'), 'utf8'));
    expect(meta).toMatchObject({
      fromCommit: 'current-commit',
      model: 'test-model',
      lang: '',
      moduleFiles: { 'API Routes': ['src/api.ts'] },
      moduleTree,
    });
    expect(await fs.readFile(path.join(wikiDir, 'index.html'), 'utf8')).toContain('var META = {');
  });

  it('preserves default, chinese, and Traditional Chinese prompt behavior', () => {
    const defaultGenerator = createGenerator();
    expect((defaultGenerator as any).buildSystemPrompt('base')).toBe('base');

    const chineseGenerator = createGenerator({ lang: 'chinese' });
    expect((chineseGenerator as any).buildSystemPrompt('base')).toContain(
      'Write ALL documentation content in chinese',
    );

    const traditionalGenerator = createGenerator({ lang: 'Traditional Chinese' });
    expect((traditionalGenerator as any).effectiveLang()).toBe('Traditional Chinese');
    expect((traditionalGenerator as any).buildSystemPrompt('base')).toContain(
      'Write ALL documentation content in Traditional Chinese',
    );
  });

  it('keeps grouping language-neutral and module names/slugs English-stable', async () => {
    await fs.rm(path.join(wikiDir, 'module_tree.json'), { force: true });
    const generator = createGenerator({ lang: 'chinese', reviewOnly: true });
    const invokeLLM = vi.spyOn(generator as any, 'invokeLLM').mockResolvedValue({
      content: JSON.stringify({ 'API Routes': ['src/api.ts'] }),
    });

    const result = await generator.run();

    expect(result.moduleTree).toEqual(moduleTree);
    expect(invokeLLM).toHaveBeenCalledTimes(1);
    expect(invokeLLM.mock.calls[0][1]).toBe(GROUPING_SYSTEM_PROMPT);
    expect(invokeLLM.mock.calls[0][1]).not.toContain('chinese');
  });
});
