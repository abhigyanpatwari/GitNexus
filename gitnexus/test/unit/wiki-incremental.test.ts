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
import { estimateTokens } from '../../src/core/wiki/llm-client.js';
import { createDocumentPlan } from '../../src/core/wiki/document/planner.js';
import { resolveLanguage } from '../../src/core/wiki/profiles/locale.js';
import { resolveTemplateProfile } from '../../src/core/wiki/profiles/registry.js';

const profile = resolveTemplateProfile('arc42');
const language = resolveLanguage('chinese', profile.profile);
const llmConfig = {
  apiKey: 'test',
  baseUrl: 'http://localhost',
  model: 'test-model',
  maxTokens: 1000,
  temperature: 0,
  provider: 'openai' as const,
};
const moduleTree: ModuleTreeNode[] = [{ name: 'Core', slug: 'core', files: ['src/core.ts'] }];

describe('standard Profile full and incremental generation', () => {
  let tempDir: string;
  let repoPath: string;
  let storagePath: string;
  let wikiDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-standard-incremental-'));
    repoPath = path.join(tempDir, 'repo');
    storagePath = path.join(tempDir, 'storage');
    wikiDir = path.join(storagePath, 'wiki');
    await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });
    await fs.mkdir(wikiDir, { recursive: true });
    await fs.writeFile(path.join(repoPath, 'src/core.ts'), 'export const core = true;\n');
    await fs.writeFile(path.join(repoPath, 'README.md'), '# Project\n');
    await fs.writeFile(path.join(wikiDir, 'module_tree.json'), JSON.stringify(moduleTree));

    graphMocks.pinWikiDb.mockReturnValue(graphMocks.releaseWikiDbPin);
    graphMocks.getFilesWithExports.mockResolvedValue([
      { filePath: 'src/core.ts', symbols: [{ name: 'core', type: 'Variable' }] },
    ]);
    graphMocks.getAllFiles.mockResolvedValue(['README.md', 'src/core.ts']);
    graphMocks.getIntraModuleCallEdges.mockResolvedValue([]);
    graphMocks.getInterModuleCallEdges.mockResolvedValue({ incoming: [], outgoing: [] });
    graphMocks.getProcessesForFiles.mockResolvedValue([]);
    graphMocks.getAllProcesses.mockResolvedValue([]);
    graphMocks.getInterModuleEdgesForOverview.mockResolvedValue([]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function generator(commit: string) {
    const instance = new WikiGenerator(
      repoPath,
      storagePath,
      path.join(storagePath, 'lbug'),
      llmConfig,
      { profile, language, lang: 'chinese' },
    );
    (instance as any).getCurrentCommit = () => commit;
    return instance;
  }

  function mockStructuredResponses(instance: WikiGenerator) {
    return vi.spyOn(instance as any, 'invokeLLM').mockImplementation(async (prompt: string) => {
      const sectionId = prompt.match(/(?:section|design section) ([a-z0-9-]+)/)?.[1];
      if (!sectionId) throw new Error(`Cannot find section ID in prompt: ${prompt}`);
      return {
        content: JSON.stringify({
          schemaVersion: 1,
          sectionId,
          blocks: [
            {
              type: 'unknown',
              status: 'needs-human',
              reason: 'Repository evidence does not establish this concern.',
              evidenceIds: [],
            },
          ],
        }),
      };
    });
  }

  it('generates a localized standard document and publishes one versioned generation', async () => {
    const instance = generator('commit-1');
    const invokeLLM = mockStructuredResponses(instance);

    await expect(instance.run()).resolves.toMatchObject({
      pagesGenerated: profile.profile.sections.length,
      mode: 'full',
      failedModules: [],
    });
    expect(invokeLLM).toHaveBeenCalledTimes(profile.profile.sections.length);

    const current = JSON.parse(
      await fs.readFile(path.join(wikiDir, '.state/current.json'), 'utf8'),
    );
    const generationDir = path.join(wikiDir, '.generations', current.generationId);
    const manifest = JSON.parse(
      await fs.readFile(path.join(generationDir, 'manifest.json'), 'utf8'),
    );
    const plan = JSON.parse(
      await fs.readFile(path.join(generationDir, 'document_plan.json'), 'utf8'),
    );
    const meta = JSON.parse(await fs.readFile(path.join(generationDir, 'meta.json'), 'utf8'));

    expect(manifest).toMatchObject({
      profile: { id: 'arc42' },
      language: { requestedLanguage: 'chinese', resolvedLocale: 'zh-CN' },
      sourceCommit: 'commit-1',
    });
    expect(manifest.pages).toHaveLength(profile.profile.sections.length + 1);
    expect(plan.status).toBe('generated');
    expect(plan.sections[0].title).toBe('引言与目标');
    expect(meta.generation.generationId).toBe(current.generationId);
    expect(await fs.readFile(path.join(wikiDir, 'architecture-description.md'), 'utf8')).toContain(
      '# arc42 架构文档',
    );
    expect(await fs.readFile(path.join(wikiDir, 'index.html'), 'utf8')).toContain(
      '<html lang="zh-CN">',
    );
  });

  it('bounds each standard section prompt while retaining section-relevant evidence', async () => {
    const boundedProfile = resolveTemplateProfile('ieee-1016-sdd');
    const boundedLanguage = resolveLanguage('chinese', boundedProfile.profile);
    const instance = new WikiGenerator(
      repoPath,
      storagePath,
      path.join(storagePath, 'lbug'),
      llmConfig,
      {
        profile: boundedProfile,
        language: boundedLanguage,
        lang: 'chinese',
        maxTokensPerModule: 1_000,
      },
    );
    const evidenceKinds = [
      'file',
      'config',
      'test',
      'existing-doc',
      'relation',
      'process',
    ] as const;
    const repository = Array.from({ length: 180 }, (_, index) => ({
      id: `ev-budget-${index.toString().padStart(3, '0')}`,
      kind: evidenceKinds[index % evidenceKinds.length],
      status: 'verified' as const,
      filePath: `src/evidence-${index}.ts`,
      summary: `Evidence ${index}`,
      excerpt: 'x'.repeat(2_000),
    }));
    (instance as any).evidenceBundle = {
      schemaVersion: 1,
      repoPath,
      sourceCommit: 'commit-budget',
      collectedAt: '2026-08-12T00:00:00.000Z',
      repository,
      modules: {},
      conflicts: [],
      limitations: [],
    };
    const plan = createDocumentPlan({
      profile: boundedProfile,
      language: boundedLanguage,
      sourceCommit: 'commit-budget',
      moduleTree,
      evidence: (instance as any).evidenceBundle,
    });
    const promptTokenCounts: number[] = [];
    vi.spyOn(instance as any, 'invokeLLM').mockImplementation(
      async (prompt: string, systemPrompt: string) => {
        promptTokenCounts.push(estimateTokens(prompt) + estimateTokens(systemPrompt));
        const sectionId = prompt.match(/(?:section|design section) ([a-z0-9-]+)/)?.[1];
        if (!sectionId) throw new Error(`Cannot find section ID in prompt: ${prompt}`);
        return {
          content: JSON.stringify({
            schemaVersion: 1,
            sectionId,
            blocks: [
              {
                type: 'unknown',
                status: 'needs-human',
                reason: 'Repository evidence does not establish this concern.',
                evidenceIds: [],
              },
            ],
          }),
        };
      },
    );

    await expect((instance as any).writeStandardSections(plan)).resolves.toBe(
      boundedProfile.profile.sections.length,
    );
    expect(promptTokenCounts).toHaveLength(boundedProfile.profile.sections.length);
    expect(Math.max(...promptTokenCounts)).toBeLessThanOrEqual(1_500);
    expect(
      plan.sections.some((section) =>
        section.diagnostics.some((diagnostic) => diagnostic.code === 'evidence-prompt-truncated'),
      ),
    ).toBe(true);
  });

  it('writes a versioned review plan and rejects locale identity tampering before section LLM calls', async () => {
    const reviewGenerator = new WikiGenerator(
      repoPath,
      storagePath,
      path.join(storagePath, 'lbug'),
      llmConfig,
      { profile, language, lang: 'chinese', reviewOnly: true },
    );
    (reviewGenerator as any).getCurrentCommit = () => 'commit-1';
    const reviewLLM = vi.spyOn(reviewGenerator as any, 'invokeLLM');

    await expect(reviewGenerator.run()).resolves.toMatchObject({
      pagesGenerated: 0,
      moduleTree,
    });
    expect(reviewLLM).not.toHaveBeenCalled();
    const planPath = path.join(wikiDir, 'document_plan.json');
    const plan = JSON.parse(await fs.readFile(planPath, 'utf8'));
    expect(plan).toMatchObject({
      status: 'planned',
      profile: { id: 'arc42' },
      language: { requestedLanguage: 'chinese', resolvedLocale: 'zh-CN' },
    });

    plan.language.resolvedLocale = 'en';
    await fs.writeFile(planPath, JSON.stringify(plan));
    const continueGenerator = generator('commit-1');
    const continueLLM = mockStructuredResponses(continueGenerator);
    await expect(continueGenerator.run()).rejects.toThrow(
      'Reviewed DocumentPlan language identity does not match',
    );
    expect(continueLLM).not.toHaveBeenCalled();
  });

  it('reuses unaffected SectionIR and regenerates only documentation-dependent sections', async () => {
    const first = generator('commit-1');
    mockStructuredResponses(first);
    await first.run();
    const firstCurrent = JSON.parse(
      await fs.readFile(path.join(wikiDir, '.state/current.json'), 'utf8'),
    );

    const second = generator('commit-2');
    (second as any).getChangedFiles = () => ['README.md'];
    const invokeLLM = mockStructuredResponses(second);
    const result = await second.run();
    const expectedAffected = profile.profile.sections.filter((section) =>
      section.evidenceRequirements.some((requirement) => requirement.kind === 'documentation'),
    ).length;

    expect(result).toMatchObject({ mode: 'incremental', pagesGenerated: expectedAffected });
    expect(invokeLLM).toHaveBeenCalledTimes(expectedAffected);
    const secondCurrent = JSON.parse(
      await fs.readFile(path.join(wikiDir, '.state/current.json'), 'utf8'),
    );
    expect(secondCurrent.generationId).not.toBe(firstCurrent.generationId);
    expect(secondCurrent.previousGenerationId).toBe(firstCurrent.generationId);
    const secondPlan = JSON.parse(
      await fs.readFile(
        path.join(wikiDir, '.generations', secondCurrent.generationId, 'document_plan.json'),
        'utf8',
      ),
    );
    expect(secondPlan.sourceCommit).toBe('commit-2');
    expect(secondPlan.moduleTree).toContainEqual({
      name: 'Other',
      slug: 'other',
      files: ['README.md'],
    });
  });

  it('retries only failed standard sections on the same commit', async () => {
    const first = generator('commit-retry');
    vi.spyOn(first as any, 'invokeLLM').mockImplementation(async (prompt: string) => {
      const sectionId = prompt.match(/(?:section|design section) ([a-z0-9-]+)/)?.[1];
      if (!sectionId) throw new Error(`Cannot find section ID in prompt: ${prompt}`);
      if (sectionId === profile.profile.sections[0].id) return { content: 'invalid-json' };
      return {
        content: JSON.stringify({
          schemaVersion: 1,
          sectionId,
          blocks: [
            {
              type: 'unknown',
              status: 'needs-human',
              reason: 'Repository evidence does not establish this concern.',
              evidenceIds: [],
            },
          ],
        }),
      };
    });
    await expect(first.run()).resolves.toMatchObject({
      mode: 'full',
      failedModules: [profile.profile.sections[0].id],
    });

    const retry = generator('commit-retry');
    (retry as any).getChangedFiles = () => [];
    const invokeLLM = mockStructuredResponses(retry);
    await expect(retry.run()).resolves.toMatchObject({
      mode: 'incremental',
      pagesGenerated: 1,
      failedModules: [],
    });
    expect(invokeLLM).toHaveBeenCalledTimes(1);
  });

  it('adds a small unassigned source-file set to a real Other node and publication closure', async () => {
    await fs.writeFile(path.join(repoPath, 'src/new.ts'), 'export const added = true;\n');
    graphMocks.getAllFiles.mockResolvedValue(['README.md', 'src/core.ts', 'src/new.ts']);
    await fs.writeFile(path.join(wikiDir, 'core.md'), '# Core\n\nOld core');
    await fs.writeFile(path.join(wikiDir, 'overview.md'), '# Repo — Wiki\n\nOld overview');
    await fs.writeFile(
      path.join(wikiDir, 'meta.json'),
      JSON.stringify({
        fromCommit: 'commit-1',
        generatedAt: '2026-08-12T00:00:00.000Z',
        model: 'test-model',
        moduleFiles: { Core: ['src/core.ts'] },
        moduleTree,
      }),
    );

    const instance = new WikiGenerator(
      repoPath,
      storagePath,
      path.join(storagePath, 'lbug'),
      llmConfig,
    );
    (instance as any).getCurrentCommit = () => 'commit-2';
    (instance as any).getChangedFiles = () => ['src/new.ts'];
    vi.spyOn(instance as any, 'invokeLLM').mockImplementation(
      async (_prompt: string, systemPrompt: string) => ({
        content: systemPrompt.includes('top-level overview') ? 'New overview.' : 'Other body.',
      }),
    );

    await expect(instance.run()).resolves.toMatchObject({
      mode: 'incremental',
      pagesGenerated: 2,
    });
    const meta = JSON.parse(await fs.readFile(path.join(wikiDir, 'meta.json'), 'utf8'));
    expect(meta.moduleFiles.Other).toEqual(['src/new.ts']);
    expect(meta.moduleTree).toContainEqual({
      name: 'Other',
      slug: 'other',
      files: ['src/new.ts'],
    });
    expect(await fs.readFile(path.join(wikiDir, 'other.md'), 'utf8')).toBe(
      '# Other\n\nOther body.',
    );
    const current = JSON.parse(
      await fs.readFile(path.join(wikiDir, '.state/current.json'), 'utf8'),
    );
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(wikiDir, '.generations', current.generationId, 'manifest.json'),
        'utf8',
      ),
    );
    expect(manifest.pages.map((page: { slug: string }) => page.slug)).toEqual(['core', 'other']);
  });

  it('removes a deleted leaf from the module, metadata, overview, and manifest closure', async () => {
    const treeWithDeleted: ModuleTreeNode[] = [
      ...moduleTree,
      { name: 'Deleted', slug: 'deleted', files: ['src/deleted.ts'] },
    ];
    await fs.writeFile(path.join(wikiDir, 'core.md'), '# Core\n\nCore');
    await fs.writeFile(path.join(wikiDir, 'deleted.md'), '# Deleted\n\nOld');
    await fs.writeFile(path.join(wikiDir, 'overview.md'), '# Repo — Wiki\n\nOld overview');
    await fs.writeFile(
      path.join(wikiDir, 'meta.json'),
      JSON.stringify({
        fromCommit: 'commit-1',
        generatedAt: '2026-08-12T00:00:00.000Z',
        model: 'test-model',
        moduleFiles: { Core: ['src/core.ts'], Deleted: ['src/deleted.ts'] },
        moduleTree: treeWithDeleted,
      }),
    );

    const instance = new WikiGenerator(
      repoPath,
      storagePath,
      path.join(storagePath, 'lbug'),
      llmConfig,
    );
    (instance as any).getCurrentCommit = () => 'commit-2';
    (instance as any).getChangedFiles = () => ['src/deleted.ts'];
    const invokeLLM = vi
      .spyOn(instance as any, 'invokeLLM')
      .mockResolvedValue({ content: 'Updated overview.' });

    await expect(instance.run()).resolves.toMatchObject({
      mode: 'incremental',
      pagesGenerated: 1,
    });
    expect(invokeLLM).toHaveBeenCalledTimes(1);
    await expect(fs.access(path.join(wikiDir, 'deleted.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const meta = JSON.parse(await fs.readFile(path.join(wikiDir, 'meta.json'), 'utf8'));
    expect(meta.moduleFiles).toEqual({ Core: ['src/core.ts'] });
    expect(meta.moduleTree).toEqual(moduleTree);
    const current = JSON.parse(
      await fs.readFile(path.join(wikiDir, '.state/current.json'), 'utf8'),
    );
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(wikiDir, '.generations', current.generationId, 'manifest.json'),
        'utf8',
      ),
    );
    expect(manifest.pages.map((page: { slug: string }) => page.slug)).toEqual(['core']);
  });

  it('force regeneration discards edited trees and review plans before regrouping', async () => {
    const staleTree = [{ name: 'Stale', slug: 'stale', files: ['src/core.ts'] }];
    await fs.writeFile(path.join(wikiDir, 'module_tree.json'), JSON.stringify(staleTree));
    await fs.writeFile(path.join(wikiDir, 'first_module_tree.json'), JSON.stringify(staleTree));
    await fs.writeFile(path.join(wikiDir, 'document_plan.json'), '{"tampered":true}');
    await fs.writeFile(path.join(wikiDir, 'stale.md'), '# Stale');

    const instance = new WikiGenerator(
      repoPath,
      storagePath,
      path.join(storagePath, 'lbug'),
      llmConfig,
      { force: true },
    );
    (instance as any).getCurrentCommit = () => 'commit-2';
    const invokeLLM = vi
      .spyOn(instance as any, 'invokeLLM')
      .mockImplementation(async (_prompt: string, systemPrompt: string) => {
        if (systemPrompt.includes('documentation architect')) {
          return { content: JSON.stringify({ Core: ['src/core.ts'], Other: ['README.md'] }) };
        }
        return {
          content: systemPrompt.includes('top-level overview') ? 'New overview.' : 'Module body.',
        };
      });

    await expect(instance.run()).resolves.toMatchObject({ mode: 'full' });
    expect(invokeLLM).toHaveBeenCalledTimes(4);
    const tree = JSON.parse(await fs.readFile(path.join(wikiDir, 'module_tree.json'), 'utf8'));
    expect(tree.map((node: ModuleTreeNode) => node.slug)).toEqual(['core', 'other']);
    expect(tree).not.toEqual(staleTree);
    await expect(fs.access(path.join(wikiDir, 'document_plan.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.access(path.join(wikiDir, 'stale.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
