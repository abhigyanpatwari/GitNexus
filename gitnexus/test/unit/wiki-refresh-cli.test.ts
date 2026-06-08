import { beforeEach, describe, expect, it, vi } from 'vitest';

const findRepoMock = vi.fn();
const listRegisteredReposMock = vi.fn();
const loadCLIConfigMock = vi.fn();
const checkStalenessAsyncMock = vi.fn();
const readWikiAutoRefreshMetaMock = vi.fn();
const writeSyncMock = vi.fn();

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
  };
});

describe('wiki-refresh CLI command', () => {
  beforeEach(() => {
    vi.resetModules();
    findRepoMock.mockReset();
    listRegisteredReposMock.mockReset();
    loadCLIConfigMock.mockReset();
    checkStalenessAsyncMock.mockReset();
    readWikiAutoRefreshMetaMock.mockReset();
    writeSyncMock.mockReset();

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
    expect(output).toContain('- Provider execution enabled: no');
    expect(output).toContain('- Output mutation enabled: no');
    expect(output).toContain('- Config writes enabled: no');
    expect(output).toContain('gitnexus wiki "C:\\repo"');
    expect(output).not.toContain('sk-secret');
    expect(output).not.toContain('api.openai.com');
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
});
