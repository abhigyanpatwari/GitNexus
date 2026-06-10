import { beforeEach, describe, expect, it, vi } from 'vitest';

const findRepoMock = vi.fn();
const listRegisteredReposMock = vi.fn();
const loadCLIConfigMock = vi.fn();
const checkStalenessAsyncMock = vi.fn();
const readWikiAutoRefreshMetaMock = vi.fn();
const runWikiAutoRefreshMock = vi.fn();
const writeSyncMock = vi.fn();
const detectLocalCLIMock = vi.fn();

vi.mock('node:fs', () => ({
  writeSync: writeSyncMock,
}));

vi.mock('../../src/storage/repo-manager.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/storage/repo-manager.js')>(
    '../../src/storage/repo-manager.js',
  );
  return {
    ...actual,
    findRepo: findRepoMock,
    listRegisteredRepos: listRegisteredReposMock,
    loadCLIConfig: loadCLIConfigMock,
  };
});

vi.mock('../../src/core/git-staleness.js', () => ({
  checkStalenessAsync: checkStalenessAsyncMock,
}));

vi.mock('../../src/core/wiki/auto-refresh.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/core/wiki/auto-refresh.js')>(
    '../../src/core/wiki/auto-refresh.js',
  );
  return {
    ...actual,
    readWikiAutoRefreshMeta: readWikiAutoRefreshMetaMock,
    runWikiAutoRefresh: runWikiAutoRefreshMock,
  };
});

vi.mock('../../src/core/wiki/local-cli-client.js', () => ({
  detectLocalCLI: detectLocalCLIMock,
}));

describe('wiki-refresh CLI command', () => {
  beforeEach(() => {
    vi.resetModules();
    findRepoMock.mockReset();
    listRegisteredReposMock.mockReset();
    loadCLIConfigMock.mockReset();
    checkStalenessAsyncMock.mockReset();
    readWikiAutoRefreshMetaMock.mockReset();
    runWikiAutoRefreshMock.mockReset();
    writeSyncMock.mockReset();
    detectLocalCLIMock.mockReset();

    findRepoMock.mockResolvedValue({
      repoPath: 'C:\\repo',
      storagePath: 'C:\\repo\\.gitnexus',
      meta: {
        lastCommit: 'abc123',
      },
    });
    checkStalenessAsyncMock.mockResolvedValue({ isStale: false, commitsBehind: 0 });
    readWikiAutoRefreshMetaMock.mockResolvedValue({
      exists: true,
      valid: true,
      path: 'C:\\repo\\.gitnexus\\wiki\\meta.json',
      fromCommit: 'old456',
    });
    loadCLIConfigMock.mockResolvedValue({
      provider: 'openai',
      apiKey: 'sk-secret',
      baseUrl: 'https://api.openai.com/v1',
    });
    detectLocalCLIMock.mockReturnValue(null);
    runWikiAutoRefreshMock.mockImplementation(async (options) => ({
      ...(actualPlan(options) as object),
      durationMs: 0,
    }));
  });

  it('prints a manual refresh plan without exposing provider secrets', async () => {
    const { wikiRefreshCommand } = await import('../../src/cli/wiki-refresh.js');

    await wikiRefreshCommand(undefined, { format: 'markdown' });

    expect(findRepoMock).toHaveBeenCalledWith(process.cwd());
    expect(checkStalenessAsyncMock).toHaveBeenCalledWith('C:\\repo', 'abc123');
    expect(readWikiAutoRefreshMetaMock).toHaveBeenCalledWith('C:\\repo\\.gitnexus');

    const output: string = writeSyncMock.mock.calls[0][1];
    expect(output).toContain('# GitNexus Wiki Refresh Plan');
    expect(output).toContain('Status: dry-run');
    expect(output).toContain('- Runs generator: no');
    expect(output).toContain('- Mutates wiki output: no');
    expect(output).toContain('- Runs LLM provider: no');
    expect(output).toContain('## Execution Boundary');
    expect(output).toContain('- Mode: planning-only');
    expect(output).toContain('- Provider execution enabled by requested mode: no');
    expect(output).toContain('- Output mutation enabled by requested mode: no');
    expect(output).toContain('- Config writes enabled: no');
    expect(output).toContain('gitnexus wiki "C:\\repo"');
    expect(output).not.toContain('sk-secret');
    expect(output).not.toContain('api.openai.com');
  });

  it('uses CLI provider readiness for dry-run planning', async () => {
    loadCLIConfigMock.mockResolvedValue({
      provider: 'codex',
      codexModel: 'gpt-5',
    });
    detectLocalCLIMock.mockReturnValue('codex');

    const { wikiRefreshCommand } = await import('../../src/cli/wiki-refresh.js');

    await wikiRefreshCommand(undefined, { format: 'json' });

    expect(detectLocalCLIMock).toHaveBeenCalledWith('codex');
    const output: string = writeSyncMock.mock.calls[0][1];
    const parsed = JSON.parse(output);
    expect(parsed.plan.status).toBe('dry-run');
    expect(parsed.plan.provider).toMatchObject({
      ready: true,
      provider: 'codex',
      source: 'saved-config',
    });
    expect(parsed.plan.shouldRunGenerator).toBe(false);
    expect(parsed.plan.willMutateOutput).toBe(false);
    expect(parsed.plan.willRunLLM).toBe(false);
    expect(parsed.execution_boundary).toMatchObject({
      mode: 'planning-only',
      provider_execution_enabled: false,
      output_mutation_enabled: false,
      config_writes_enabled: false,
    });
  });

  it('writes JSON with no recommended command when the graph is stale', async () => {
    checkStalenessAsyncMock.mockResolvedValue({
      isStale: true,
      commitsBehind: 2,
      hint: 'Index is 2 commits behind HEAD',
    });

    const { wikiRefreshCommand } = await import('../../src/cli/wiki-refresh.js');

    await wikiRefreshCommand('C:\\repo', { format: 'json' });

    const output: string = writeSyncMock.mock.calls[0][1];
    const parsed = JSON.parse(output);
    expect(parsed.schema_version).toBe('wiki-refresh-plan.v1alpha1');
    expect(parsed.plan.status).toBe('skipped');
    expect(parsed.plan.reason).toBe('graph-not-fresh');
    expect(parsed.plan.shouldRunGenerator).toBe(false);
    expect(parsed.plan.willMutateOutput).toBe(false);
    expect(parsed.plan.willRunLLM).toBe(false);
    expect(parsed.execution_boundary).toMatchObject({
      mode: 'planning-only',
      provider_execution_enabled: false,
      output_mutation_enabled: false,
      config_writes_enabled: false,
    });
    expect(parsed.execution_boundary.required_human_decisions).toContain(
      'Choose output location and overwrite/rollback policy before generated wiki mutation.',
    );
    expect(parsed.recommended_command).toBeUndefined();
  });

  it('can target a registered repo by name and allow create-if-missing planning', async () => {
    findRepoMock.mockReset();
    listRegisteredReposMock.mockResolvedValue([
      {
        name: 'demo',
        path: 'C:\\demo',
        storagePath: 'C:\\demo\\.gitnexus',
        indexedAt: '2026-06-08T00:00:00.000Z',
        lastCommit: 'def456',
      },
    ]);
    readWikiAutoRefreshMetaMock.mockResolvedValue({
      exists: false,
      valid: false,
      path: 'C:\\demo\\.gitnexus\\wiki\\meta.json',
    });

    const { wikiRefreshCommand } = await import('../../src/cli/wiki-refresh.js');

    await wikiRefreshCommand(undefined, {
      repo: 'demo',
      createIfMissing: true,
      format: 'json',
    });

    expect(findRepoMock).not.toHaveBeenCalled();
    expect(listRegisteredReposMock).toHaveBeenCalledWith({ validate: true });
    expect(checkStalenessAsyncMock).toHaveBeenCalledWith('C:\\demo', 'def456');

    const output: string = writeSyncMock.mock.calls[0][1];
    const parsed = JSON.parse(output);
    expect(parsed.repo.name).toBe('demo');
    expect(parsed.plan.status).toBe('dry-run');
    expect(parsed.recommended_command).toBe('gitnexus wiki "C:\\demo"');
  });

  it('can execute a bounded local refresh workflow when explicit execution is requested', async () => {
    runWikiAutoRefreshMock.mockImplementation(async (options) => ({
      ...(actualPlan(options) as object),
      status: 'complete',
      reason: 'refreshed',
      durationMs: 42,
      wikiRun: {
        mode: 'incremental',
        pagesGenerated: 3,
        failedModules: ['Search'],
      },
      messages: ['Wiki auto-refresh completed'],
    }));

    const { wikiRefreshCommand } = await import('../../src/cli/wiki-refresh.js');

    await wikiRefreshCommand(undefined, { format: 'json', execute: true });

    expect(runWikiAutoRefreshMock).toHaveBeenCalledTimes(1);
    expect(runWikiAutoRefreshMock.mock.calls[0][0]).toMatchObject({
      dryRun: false,
      mutateOutput: true,
    });

    const output: string = writeSyncMock.mock.calls[0][1];
    const parsed = JSON.parse(output);
    expect(parsed.plan.status).toBe('complete');
    expect(parsed.plan.reason).toBe('refreshed');
    expect(parsed.execution_boundary).toMatchObject({
      mode: 'explicit-cli-execution',
      provider_execution_enabled: true,
      output_mutation_enabled: true,
      config_writes_enabled: false,
    });
    expect(parsed.execution).toMatchObject({
      requested: true,
      performed: true,
      status: 'completed',
      duration_ms: 42,
      mode: 'incremental',
      pages_generated: 3,
      failed_modules: ['Search'],
    });
    expect(parsed.recommended_command).toBeUndefined();
  });
});

function actualPlan(options: {
  graphFreshness: { isFresh: boolean };
  wikiMeta: { exists: boolean; valid?: boolean };
  provider: { ready: boolean };
  dryRun?: boolean;
  mutateOutput?: boolean;
  createIfMissing?: boolean;
}) {
  if (!options.graphFreshness.isFresh) {
    return {
      status: 'skipped',
      reason: 'graph-not-fresh',
      shouldRunGenerator: false,
      willMutateOutput: false,
      willRunLLM: false,
      dryRun: options.dryRun ?? true,
      messages: [],
      graphFreshness: options.graphFreshness,
      wikiMeta: options.wikiMeta,
      provider: options.provider,
    };
  }

  return {
    status:
      options.dryRun === false && options.mutateOutput === true && options.provider.ready
        ? 'ready'
        : 'dry-run',
    reason:
      options.dryRun === false && options.mutateOutput === true && options.provider.ready
        ? 'ready'
        : 'dry-run',
    shouldRunGenerator:
      options.dryRun === false && options.mutateOutput === true && options.provider.ready,
    willMutateOutput:
      options.dryRun === false && options.mutateOutput === true && options.provider.ready,
    willRunLLM:
      options.dryRun === false && options.mutateOutput === true && options.provider.ready,
    dryRun: options.dryRun ?? true,
    messages: [],
    graphFreshness: options.graphFreshness,
    wikiMeta: options.wikiMeta,
    provider: options.provider,
  };
}
