import { beforeEach, describe, expect, it, vi } from 'vitest';

const initMock = vi.fn();
const callToolMock = vi.fn();
const writeSyncMock = vi.fn();

vi.mock('../../src/mcp/local/local-backend.js', () => ({
  LocalBackend: class {
    init = initMock;
    callTool = callToolMock;
  },
}));

vi.mock('node:fs', () => ({
  writeSync: writeSyncMock,
}));

describe('direct CLI tool commands', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('GITNEXUS_LANG', 'en');
    vi.resetModules();
    initMock.mockReset();
    callToolMock.mockReset();
    writeSyncMock.mockReset();
    process.exitCode = undefined;
    initMock.mockResolvedValue(true);
  });

  it('dispatches circular-import checks and fails CI when cycles exist', async () => {
    callToolMock.mockResolvedValue({
      status: 'cycles_found',
      cycleCount: 1,
      cycles: [{ files: ['src/a.ts', 'src/b.ts', 'src/a.ts'] }],
    });
    const { checkCommand } = await import('../../src/cli/tool.js');

    await checkCommand({ cycles: true, repo: 'gitnexus' });

    expect(callToolMock).toHaveBeenCalledWith('check', {
      cycles: true,
      repo: 'gitnexus',
    });
    expect(writeSyncMock).toHaveBeenCalledWith(
      1,
      expect.stringContaining('src/a.ts -> src/b.ts -> src/a.ts'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('emits JSON and succeeds for a clean import graph', async () => {
    callToolMock.mockResolvedValue({ status: 'clean', cycleCount: 0, cycles: [] });
    const { checkCommand } = await import('../../src/cli/tool.js');

    await checkCommand({ cycles: true, json: true });

    expect(writeSyncMock).toHaveBeenCalledWith(1, expect.stringContaining('"status": "clean"'));
    expect(process.exitCode).toBeUndefined();
  });

  it('fails closed for backend error payloads in JSON mode', async () => {
    callToolMock.mockResolvedValue({ error: 'Import graph exceeds the safety limit.' });
    const { checkCommand } = await import('../../src/cli/tool.js');

    await checkCommand({ cycles: true, json: true });

    expect(writeSyncMock).toHaveBeenCalledWith(
      1,
      expect.stringContaining('Import graph exceeds the safety limit.'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('fails closed when the backend throws', async () => {
    callToolMock.mockRejectedValue(new Error('unknown branch'));
    const { checkCommand } = await import('../../src/cli/tool.js');

    await checkCommand({ cycles: true });

    expect(writeSyncMock).toHaveBeenCalledWith(1, expect.stringContaining('unknown branch'));
    expect(process.exitCode).toBe(1);
  });

  it('dispatches detect_changes with CLI-shaped arguments', async () => {
    callToolMock.mockResolvedValue({
      summary: {
        changed_files: 1,
        changed_count: 2,
        affected_count: 1,
        risk_level: 'low',
      },
    });
    const { detectChangesCommand } = await import('../../src/cli/tool.js');

    await detectChangesCommand({
      scope: 'compare',
      baseRef: 'main',
      repo: 'gitnexus',
    });

    expect(callToolMock).toHaveBeenCalledWith('detect_changes', {
      scope: 'compare',
      base_ref: 'main',
      repo: 'gitnexus',
    });
    expect(writeSyncMock).toHaveBeenCalledWith(1, expect.stringContaining('Risk level: low'));
  });

  it('prints "No changes detected." when changed_count is 0', async () => {
    callToolMock.mockResolvedValue({
      summary: { changed_files: 0, changed_count: 0, affected_count: 0, risk_level: 'low' },
    });
    const { detectChangesCommand } = await import('../../src/cli/tool.js');

    await detectChangesCommand({});

    expect(writeSyncMock).toHaveBeenCalledWith(1, expect.stringContaining('No changes detected.'));
  });

  it('prints error message when result contains an error', async () => {
    callToolMock.mockResolvedValue({ error: 'index is stale' });
    const { detectChangesCommand } = await import('../../src/cli/tool.js');

    await detectChangesCommand({});

    expect(writeSyncMock).toHaveBeenCalledWith(1, expect.stringContaining('Error: index is stale'));
  });

  it('truncates changed_symbols list beyond 15 and shows overflow count', async () => {
    const symbols = Array.from({ length: 17 }, (_, i) => ({
      type: 'function',
      name: `fn${i}`,
      filePath: `src/file${i}.ts`,
    }));
    callToolMock.mockResolvedValue({
      summary: { changed_files: 17, changed_count: 17, affected_count: 0, risk_level: 'low' },
      changed_symbols: symbols,
    });
    const { detectChangesCommand } = await import('../../src/cli/tool.js');

    await detectChangesCommand({});

    const output: string = writeSyncMock.mock.calls[0][1];
    expect(output).toContain('function fn14 → src/file14.ts');
    expect(output).not.toContain('fn15');
    expect(output).toContain('... and 2 more');
  });

  it('truncates affected_processes list beyond 10', async () => {
    const processes = Array.from({ length: 12 }, (_, i) => ({
      name: `proc${i}`,
      step_count: 3,
      changed_steps: [{ symbol: `sym${i}` }],
    }));
    callToolMock.mockResolvedValue({
      summary: { changed_files: 1, changed_count: 1, affected_count: 12, risk_level: 'low' },
      affected_processes: processes,
    });
    const { detectChangesCommand } = await import('../../src/cli/tool.js');

    await detectChangesCommand({});

    const output: string = writeSyncMock.mock.calls[0][1];
    expect(output).toContain('proc9');
    expect(output).not.toContain('proc10');
  });

  it('localizes detect_changes formatter labels for Simplified Chinese', async () => {
    vi.stubEnv('GITNEXUS_LANG', 'zh-CN');
    callToolMock.mockResolvedValue({
      summary: { changed_files: 2, changed_count: 3, affected_count: 1, risk_level: 'MEDIUM' },
      changed_symbols: [{ type: 'Function', name: 'foo', filePath: 'src/a.ts' }],
      affected_processes: [
        { name: 'Auth Flow', step_count: 5, changed_steps: [{ symbol: 'foo' }] },
      ],
    });
    const { detectChangesCommand } = await import('../../src/cli/tool.js');

    await detectChangesCommand({});

    const output: string = writeSyncMock.mock.calls[0][1];
    expect(output).toContain('变更：2 个文件，3 个符号');
    expect(output).toContain('受影响流程：1');
    expect(output).toContain('风险等级：MEDIUM');
    expect(output).toContain('已变更符号：');
    expect(output).toContain('受影响执行流程：');
    expect(output).toContain('Auth Flow (5 步) — 已变更：foo');
  });
});
