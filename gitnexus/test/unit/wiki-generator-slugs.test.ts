import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WikiGenerator, type ModuleTreeNode } from '../../src/core/wiki/generator.js';

const {
  callLLMMock,
  getIntraModuleCallEdgesMock,
  getProcessesForFilesMock,
  getInterModuleEdgesForOverviewMock,
  getAllProcessesMock,
} = vi.hoisted(() => ({
  callLLMMock: vi.fn(),
  getIntraModuleCallEdgesMock: vi.fn().mockResolvedValue([]),
  getProcessesForFilesMock: vi.fn().mockResolvedValue([]),
  getInterModuleEdgesForOverviewMock: vi.fn().mockResolvedValue([]),
  getAllProcessesMock: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/core/wiki/graph-queries.js', () => ({
  initWikiDb: vi.fn().mockResolvedValue(undefined),
  closeWikiDb: vi.fn().mockResolvedValue(undefined),
  touchWikiDb: vi.fn(),
  pinWikiDb: vi.fn(() => vi.fn()),
  getFilesWithExports: vi.fn().mockResolvedValue([]),
  getAllFiles: vi.fn().mockResolvedValue([]),
  getIntraModuleCallEdges: getIntraModuleCallEdgesMock,
  getInterModuleCallEdges: vi.fn().mockResolvedValue({ incoming: [], outgoing: [] }),
  getProcessesForFiles: getProcessesForFilesMock,
  getAllProcesses: getAllProcessesMock,
  getInterModuleEdgesForOverview: getInterModuleEdgesForOverviewMock,
}));

vi.mock('../../src/core/wiki/llm-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/wiki/llm-client.js')>();
  return {
    ...actual,
    callLLM: callLLMMock,
  };
});

describe('WikiGenerator slug propagation in prompts', () => {
  let tmpRepoDir: string;
  let tmpStorageDir: string;
  let tmpWikiDir: string;

  beforeEach(async () => {
    tmpRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-slugs-repo-'));
    tmpStorageDir = path.join(tmpRepoDir, '.gitnexus');
    tmpWikiDir = path.join(tmpStorageDir, 'wiki');
    await fs.mkdir(tmpWikiDir, { recursive: true });

    await fs.writeFile(
      path.join(tmpRepoDir, 'package.json'),
      JSON.stringify({ name: 'test-project', description: 'Test project description' }),
      'utf-8',
    );

    callLLMMock.mockReset();
    callLLMMock.mockResolvedValue({
      content: '## Overview\n\nGenerated documentation content.',
    });
    getIntraModuleCallEdgesMock.mockResolvedValue([]);
    getProcessesForFilesMock.mockResolvedValue([]);
    getInterModuleEdgesForOverviewMock.mockResolvedValue([]);
    getAllProcessesMock.mockResolvedValue([]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpRepoDir, { recursive: true, force: true });
  });

  function createGenerator(): WikiGenerator {
    return new WikiGenerator(tmpRepoDir, tmpStorageDir, '/dummy/lbug', {
      apiKey: 'test-key',
      baseUrl: 'https://test.local',
      model: 'test-model',
      maxTokens: 1000,
      temperature: 0,
      provider: 'openai',
    });
  }

  it('generateParentPage passes each child module real slug (.md file) in the prompt context', async () => {
    const generator = createGenerator();

    const child1Slug = 'pkg-a-launch';
    const child2Slug = 'pkg-a-composition-database';

    await fs.writeFile(
      path.join(tmpWikiDir, `${child1Slug}.md`),
      '# pkg_a — launch\n\nLaunch sub-module handles startup.\n### Architecture\nStartup details...',
      'utf-8',
    );
    await fs.writeFile(
      path.join(tmpWikiDir, `${child2Slug}.md`),
      '# pkg_a — composition/database\n\nDatabase sub-module handles pooling.\n### Architecture\nPool details...',
      'utf-8',
    );

    const parentNode: ModuleTreeNode = {
      name: 'pkg_a — Launch & Database',
      slug: 'pkg-a-launch-database',
      files: [],
      children: [
        {
          name: 'pkg_a — launch',
          slug: child1Slug,
          files: ['packages/a/launch.ts'],
        },
        {
          name: 'pkg_a — composition/database',
          slug: child2Slug,
          files: ['packages/a/db.ts'],
        },
      ],
    };

    await (generator as any).generateParentPage(parentNode);

    expect(callLLMMock).toHaveBeenCalledTimes(1);
    const capturedPrompt = callLLMMock.mock.calls[0][0] as string;

    // Both real file targets must appear in the prompt so the LLM does not guess slugs
    expect(capturedPrompt).toContain(`${child1Slug}.md`);
    expect(capturedPrompt).toContain(`${child2Slug}.md`);
  });

  it('generateParentPage passes child slug even when child doc is not yet generated', async () => {
    const generator = createGenerator();

    const childSlug = 'pkg-b-use-cases-1-4';
    const parentNode: ModuleTreeNode = {
      name: 'pkg_b — Use Cases',
      slug: 'pkg-b-use-cases',
      files: [],
      children: [
        {
          name: 'pkg_b — use_cases (1/4)',
          slug: childSlug,
          files: ['packages/b/uc1.ts'],
        },
      ],
    };

    await (generator as any).generateParentPage(parentNode);

    expect(callLLMMock).toHaveBeenCalledTimes(1);
    const capturedPrompt = callLLMMock.mock.calls[0][0] as string;

    expect(capturedPrompt).toContain(`${childSlug}.md`);
  });

  it('generateOverview passes each module real slug (.md file) in the prompt context', async () => {
    const generator = createGenerator();

    const mod1Slug = 'pkg-a-launch-database';
    const mod2Slug = 'pkg-c';

    await fs.writeFile(
      path.join(tmpWikiDir, `${mod1Slug}.md`),
      '# pkg_a — Launch & Database\n\nParent module documentation.\n### Architecture\nDetails...',
      'utf-8',
    );
    await fs.writeFile(
      path.join(tmpWikiDir, `${mod2Slug}.md`),
      '# pkg_c\n\nModule C documentation.\n### Architecture\nDetails...',
      'utf-8',
    );

    const moduleTree: ModuleTreeNode[] = [
      {
        name: 'pkg_a — Launch & Database',
        slug: mod1Slug,
        files: [],
        children: [
          {
            name: 'pkg_a — launch',
            slug: 'pkg-a-launch',
            files: ['packages/a/launch.ts'],
          },
        ],
      },
      {
        name: 'pkg_c',
        slug: mod2Slug,
        files: ['packages/c/index.ts'],
      },
    ];

    await (generator as any).generateOverview(moduleTree);

    expect(callLLMMock).toHaveBeenCalledTimes(1);
    const capturedPrompt = callLLMMock.mock.calls[0][0] as string;

    // Both real file targets must appear in the prompt so the LLM does not guess slugs
    expect(capturedPrompt).toContain(`${mod1Slug}.md`);
    expect(capturedPrompt).toContain(`${mod2Slug}.md`);
  });

  it('generateOverview passes module slug even when module doc is pending', async () => {
    const generator = createGenerator();

    const modSlug = 'pkg-c-pending';
    const moduleTree: ModuleTreeNode[] = [
      {
        name: 'pkg_c pending module',
        slug: modSlug,
        files: ['packages/c/pending.ts'],
      },
    ];

    await (generator as any).generateOverview(moduleTree);

    expect(callLLMMock).toHaveBeenCalledTimes(1);
    const capturedPrompt = callLLMMock.mock.calls[0][0] as string;

    expect(capturedPrompt).toContain(`${modSlug}.md`);
  });
});
