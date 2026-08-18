import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

  // These commands set `process.exitCode` on the real process. Clearing it after
  // each test keeps a deliberate failure here from failing the whole run.
  afterEach(() => {
    process.exitCode = undefined;
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

  it('still fails CI when the enumeration was capped and there is no cycle count', async () => {
    // Past the cap the backend reports one representative cycle per component
    // and `cycleCount: null` — deliberately not a number, so a partial count
    // cannot be read as a real one. Keying the exit code off the count made
    // `null > 0` false and exited 0 on exactly the repositories with the most
    // cycles; this pins that `status` is what decides.
    callToolMock.mockResolvedValue({
      status: 'cycles_found',
      enumeration: 'component-representatives',
      truncated: true,
      cycleCount: null,
      componentCount: 2,
      cycles: [
        { files: ['src/a.ts', 'src/b.ts', 'src/a.ts'] },
        { files: ['src/y.ts', 'src/z.ts', 'src/y.ts'] },
      ],
    });
    const { checkCommand } = await import('../../src/cli/tool.js');

    await checkCommand({ cycles: true });

    expect(process.exitCode).toBe(1);
    // and the operator is told the list is representative, not exhaustive
    expect(writeSyncMock).toHaveBeenCalledWith(1, expect.stringContaining('representative'));
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

  it('prints the safety-limit error in PROSE mode instead of throwing on the missing cycle list', async () => {
    // The `enumeration: 'none'` response — a run that died inside the component
    // decomposition — carries `{ error, truncated }` and deliberately no
    // `status` and no `cycles`. The prose branch reads `result.cycles.map(...)`,
    // so without the error guard ahead of it this shape surfaces as a TypeError
    // instead of the limit it is trying to report. JSON mode was covered; this
    // is the path that renders.
    callToolMock.mockResolvedValue({
      error: 'Import cycle enumeration exceeded its 10000000 step safety limit.',
      truncated: true,
    });
    const { checkCommand } = await import('../../src/cli/tool.js');

    await checkCommand({ cycles: true });

    expect(writeSyncMock).toHaveBeenCalledWith(1, expect.stringContaining('step safety limit'));
    expect(writeSyncMock).not.toHaveBeenCalledWith(1, expect.stringContaining('TypeError'));
    expect(process.exitCode).toBe(1);
  });

  it('fails closed when the backend throws', async () => {
    callToolMock.mockRejectedValue(new Error('unknown branch'));
    const { checkCommand } = await import('../../src/cli/tool.js');

    await checkCommand({ cycles: true });

    expect(writeSyncMock).toHaveBeenCalledWith(1, expect.stringContaining('unknown branch'));
    expect(process.exitCode).toBe(1);
  });

  it('fails closed when cypher returns a backend error payload', async () => {
    callToolMock.mockResolvedValue({ error: 'Binder exception: missing relationship property' });
    const { cypherCommand } = await import('../../src/cli/tool.js');

    await cypherCommand('MATCH ()-[r:CodeRelation]->() RETURN r.missing');

    expect(writeSyncMock).toHaveBeenCalledWith(
      1,
      expect.stringContaining('Binder exception: missing relationship property'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('keeps a successful cypher result at exit zero', async () => {
    callToolMock.mockResolvedValue({ markdown: '| count |\n| --- |\n| 1 |', row_count: 1 });
    const { cypherCommand } = await import('../../src/cli/tool.js');

    await cypherCommand('MATCH (n) RETURN count(n) AS count');

    expect(writeSyncMock).toHaveBeenCalledWith(1, expect.stringContaining('"row_count": 1'));
    expect(process.exitCode).toBeUndefined();
  });

  it('fails closed when query returns a backend error payload', async () => {
    callToolMock.mockResolvedValue({ error: 'Repository "missing" not found.' });
    const { queryCommand } = await import('../../src/cli/tool.js');

    await queryCommand('auth flow');

    expect(writeSyncMock).toHaveBeenCalledWith(1, expect.stringContaining('not found'));
    expect(process.exitCode).toBe(1);
  });

  // `partial` is cross-tool vocabulary, not detect_changes' private flag, and the
  // degraded shape is the dangerous one: it looks like a result. `impact` matters
  // most — AGENTS.md makes it the gate before every edit, so a truncated traversal
  // that exits 0 lets `gitnexus impact … && <edit>` proceed on a short caller set.
  it('fails closed when query degrades to a partial result', async () => {
    callToolMock.mockResolvedValue({ results: [], partial: true });
    const { queryCommand } = await import('../../src/cli/tool.js');

    await queryCommand('auth flow');

    expect(process.exitCode).toBe(1);
  });

  it('fails closed when impact truncates its traversal', async () => {
    callToolMock.mockResolvedValue({ byDepth: {}, risk: 'LOW', partial: true });
    const { impactCommand } = await import('../../src/cli/tool.js');

    await impactCommand('someSymbol', { direction: 'upstream' });

    expect(process.exitCode).toBe(1);
  });

  it('fails closed when context returns a backend error payload', async () => {
    callToolMock.mockResolvedValue({ error: 'Symbol not found: nope' });
    const { contextCommand } = await import('../../src/cli/tool.js');

    await contextCommand('nope');

    expect(writeSyncMock).toHaveBeenCalledWith(1, expect.stringContaining('Symbol not found'));
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

  it('passes --worktree through to the detect_changes tool call', async () => {
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
      scope: 'unstaged',
      repo: 'gitnexus',
      worktree: '/repo/wt-feature',
    });

    expect(callToolMock).toHaveBeenCalledWith('detect_changes', {
      scope: 'unstaged',
      base_ref: undefined,
      repo: 'gitnexus',
      branch: undefined,
      worktree: '/repo/wt-feature',
    });
  });

  it('prints "No changes detected." when changed_count is 0', async () => {
    callToolMock.mockResolvedValue({
      summary: { changed_files: 0, changed_count: 0, affected_count: 0, risk_level: 'low' },
    });
    const { detectChangesCommand } = await import('../../src/cli/tool.js');

    await detectChangesCommand({});

    expect(writeSyncMock).toHaveBeenCalledWith(1, expect.stringContaining('No changes detected.'));
  });

  it('prints error message and fails the gate when result contains an error', async () => {
    callToolMock.mockResolvedValue({ error: 'index is stale' });
    const { detectChangesCommand } = await import('../../src/cli/tool.js');

    await detectChangesCommand({});

    expect(writeSyncMock).toHaveBeenCalledWith(1, expect.stringContaining('Error: index is stale'));
    // `output()` gets the structured result plus its formatter, so the
    // object-payload check sees the `error` the rendered prose hides.
    // `gitnexus detect-changes && git commit` must not proceed here.
    expect(process.exitCode).toBe(1);
  });

  it('fails the gate for a partial run, which reports zeros it did not earn', async () => {
    // A swallowed graph query leaves the counts at zero. Exit 0 would let
    // `detect-changes && git commit` treat a run that never completed as clean.
    callToolMock.mockResolvedValue({
      partial: true,
      summary: { changed_files: 1, changed_count: 0, affected_count: 0, risk_level: 'low' },
    });
    const { detectChangesCommand } = await import('../../src/cli/tool.js');

    await detectChangesCommand({});

    expect(writeSyncMock).toHaveBeenCalledWith(1, expect.stringContaining('PARTIAL RESULT'));
    expect(process.exitCode).toBe(1);
  });

  it('keeps a truncated listing at exit zero — only the list was capped', async () => {
    // Deliberately NOT a failure: `changed_count`, `affected_count` and
    // `risk_level` are computed over every changed symbol, so the gate's verdict
    // is sound. Failing on `truncated` would fire on every large-but-healthy
    // diff and teach people to bypass the gate.
    callToolMock.mockResolvedValue({
      truncated: true,
      summary: { changed_files: 40, changed_count: 500, affected_count: 3, risk_level: 'high' },
      changed_symbols: [{ type: 'function', name: 'fn0', filePath: 'src/file0.ts' }],
    });
    const { detectChangesCommand } = await import('../../src/cli/tool.js');

    await detectChangesCommand({});

    expect(writeSyncMock).toHaveBeenCalledWith(1, expect.stringContaining('LISTING CAPPED'));
    expect(writeSyncMock).toHaveBeenCalledWith(1, expect.stringContaining('Risk level: high'));
    expect(process.exitCode).toBeUndefined();
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
