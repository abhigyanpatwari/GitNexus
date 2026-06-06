import { describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  planWikiAutoRefresh,
  readWikiAutoRefreshMeta,
  runWikiAutoRefresh,
  type WikiAutoRefreshInputs,
} from '../../src/core/wiki/auto-refresh.js';

const readyInputs: WikiAutoRefreshInputs = {
  graphFreshness: {
    isFresh: true,
    indexedCommit: 'abc123',
    currentCommit: 'abc123',
    source: 'auto-reindex',
  },
  wikiMeta: {
    exists: true,
    fromCommit: 'old456',
    path: '/data/gitnexus/wiki/meta.json',
  },
  provider: {
    ready: true,
    provider: 'codex',
    source: 'saved-config',
  },
};

describe('wiki auto-refresh planning', () => {
  it('skips when graph freshness has not been confirmed', () => {
    const plan = planWikiAutoRefresh({
      ...readyInputs,
      graphFreshness: {
        isFresh: false,
        indexedCommit: 'old456',
        currentCommit: 'abc123',
        reason: 'index commit is behind HEAD',
        source: 'status',
      },
    });

    expect(plan).toMatchObject({
      status: 'skipped',
      reason: 'graph-not-fresh',
      shouldRunGenerator: false,
      willMutateOutput: false,
      willRunLLM: false,
      dryRun: true,
    });
    expect(plan.messages.join('\n')).toContain('index commit is behind HEAD');
  });

  it('skips when no existing wiki meta is present by default', () => {
    const plan = planWikiAutoRefresh({
      ...readyInputs,
      wikiMeta: { exists: false, path: '/data/gitnexus/wiki/meta.json' },
    });

    expect(plan).toMatchObject({
      status: 'skipped',
      reason: 'missing-wiki-meta',
      shouldRunGenerator: false,
      willMutateOutput: false,
      willRunLLM: false,
    });
  });

  it('skips when provider readiness is missing', () => {
    const plan = planWikiAutoRefresh({
      ...readyInputs,
      provider: {
        ready: false,
        provider: 'openai',
        reason: 'no API key or local CLI provider configured',
        source: 'config',
      },
    });

    expect(plan).toMatchObject({
      status: 'skipped',
      reason: 'provider-not-ready',
      shouldRunGenerator: false,
      willMutateOutput: false,
      willRunLLM: false,
    });
    expect(plan.messages.join('\n')).toContain('no API key');
  });

  it('skips corrupt wiki metadata instead of treating it as an absent wiki', () => {
    const plan = planWikiAutoRefresh({
      ...readyInputs,
      wikiMeta: {
        exists: true,
        valid: false,
        path: '/data/gitnexus/wiki/meta.json',
        reason: 'Unexpected token',
      },
    });

    expect(plan).toMatchObject({
      status: 'skipped',
      reason: 'corrupt-wiki-meta',
      shouldRunGenerator: false,
      willMutateOutput: false,
      willRunLLM: false,
    });
    expect(plan.messages.join('\n')).toContain('Unexpected token');
  });

  it('defaults to dry-run status even when all prerequisites are ready', async () => {
    const runGenerator = vi.fn();

    const result = await runWikiAutoRefresh({
      ...readyInputs,
      runGenerator,
    });

    expect(runGenerator).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'dry-run',
      reason: 'dry-run',
      shouldRunGenerator: false,
      willMutateOutput: false,
      willRunLLM: false,
    });
    expect(result).not.toHaveProperty('wikiRun');
  });

  it('runs the generator only with explicit output mutation opt-in and shapes the result', async () => {
    const runGenerator = vi.fn(async () => ({
      mode: 'incremental' as const,
      pagesGenerated: 2,
      failedModules: ['Search'],
    }));

    const result = await runWikiAutoRefresh({
      ...readyInputs,
      dryRun: false,
      mutateOutput: true,
      runGenerator,
      now: vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(175),
    });

    expect(runGenerator).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: 'complete',
      reason: 'refreshed',
      shouldRunGenerator: true,
      willMutateOutput: true,
      willRunLLM: true,
      durationMs: 75,
      wikiRun: {
        mode: 'incremental',
        pagesGenerated: 2,
        failedModules: ['Search'],
      },
    });
  });
});

describe('readWikiAutoRefreshMeta', () => {
  it('reads existing wiki metadata from the GitNexus storage path', async () => {
    const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-auto-meta-'));
    const wikiDir = path.join(storagePath, 'wiki');
    await fs.mkdir(wikiDir, { recursive: true });
    await fs.writeFile(
      path.join(wikiDir, 'meta.json'),
      JSON.stringify({ fromCommit: 'abc123', model: 'local-model', lang: 'english' }),
    );

    await expect(readWikiAutoRefreshMeta(storagePath)).resolves.toMatchObject({
      exists: true,
      valid: true,
      fromCommit: 'abc123',
      model: 'local-model',
      lang: 'english',
    });
  });

  it('distinguishes missing wiki metadata from corrupt wiki metadata', async () => {
    const missingStorage = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-auto-missing-'));
    await expect(readWikiAutoRefreshMeta(missingStorage)).resolves.toMatchObject({
      exists: false,
      valid: false,
    });

    const corruptStorage = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-auto-corrupt-'));
    const wikiDir = path.join(corruptStorage, 'wiki');
    await fs.mkdir(wikiDir, { recursive: true });
    await fs.writeFile(path.join(wikiDir, 'meta.json'), '{not json');

    await expect(readWikiAutoRefreshMeta(corruptStorage)).resolves.toMatchObject({
      exists: true,
      valid: false,
    });
  });
});
