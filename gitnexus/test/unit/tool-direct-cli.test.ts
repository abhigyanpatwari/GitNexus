import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const initMock = vi.fn();
const callToolMock = vi.fn();
const disconnectMock = vi.fn();
const writeSyncMock = vi.fn();
const selectToolRepositoryMock = vi.fn();
const checkStalenessAsyncMock = vi.fn();

vi.mock('../../src/mcp/local/local-backend.js', () => ({
  LocalBackend: class {
    init = initMock;
    callTool = callToolMock;
    disconnect = disconnectMock;
    selectToolRepository = selectToolRepositoryMock;
  },
}));

// `--stale-policy error` runs this git check for results with no staleness field.
vi.mock('../../src/core/git-staleness.js', () => ({
  checkStalenessAsync: checkStalenessAsyncMock,
}));

// output() writes a byte buffer from an offset until every byte lands (#3947).
// Record the text each call carries and report it fully written, so the
// assertions below can match on strings.
vi.mock('node:fs', () => ({
  writeSync: (fd: number, bytes: Buffer, offset = 0) => {
    writeSyncMock(fd, bytes.subarray(offset).toString('utf8'));
    return bytes.length - offset;
  },
}));

describe('direct CLI tool commands', () => {
  it.each(['0', '1.5', '10tokens'])('rejects invalid impact budgets: %s', async (maxTokens) => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    try {
      const { impactCommand } = await import('../../src/cli/tool.js');
      await impactCommand('auth', { maxTokens });
      expect(callToolMock).not.toHaveBeenCalled();
      expect(JSON.parse(writeSyncMock.mock.calls[0][1]).error).toContain('positive integer');
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      exit.mockRestore();
    }
  });

  it('returns a JSON budget error and fails when impact metadata cannot fit', async () => {
    callToolMock.mockResolvedValue({
      impactedCount: 1,
      byDepth: { 1: [{ id: 'caller' }] },
      affected_processes: [{ name: 'x'.repeat(10_000) }],
    });
    const { impactCommand } = await import('../../src/cli/tool.js');
    await impactCommand('auth', { maxTokens: '100' });
    const text = writeSyncMock.mock.calls[0][1];
    expect(JSON.parse(text).error).toContain('Increase maxTokens');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(400);
    expect(process.exitCode).toBe(1);
  });

  it('budgets compact output even on a terminal', async () => {
    const tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    try {
      callToolMock.mockResolvedValue({
        byDepth: {
          1: Array.from({ length: 20 }, (_, i) => ({
            id: `caller${i}`,
            name: `caller${i}`,
            filePath: `src/${i}.ts`,
          })),
        },
      });
      const { impactCommand } = await import('../../src/cli/tool.js');
      await impactCommand('auth', { maxTokens: '150' });
      const text = writeSyncMock.mock.calls[0][1];
      expect(Buffer.byteLength(text.trim())).toBeLessThanOrEqual(600);
      expect(JSON.parse(text).pagination.trimmedForBudget.maxTokens).toBe(150);
      expect(process.exitCode).toBeUndefined();
    } finally {
      if (tty) Object.defineProperty(process.stdout, 'isTTY', tty);
      else delete process.stdout.isTTY;
    }
  });

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('GITNEXUS_LANG', 'en');
    vi.resetModules();
    initMock.mockReset();
    callToolMock.mockReset();
    disconnectMock.mockReset();
    writeSyncMock.mockReset();
    selectToolRepositoryMock.mockReset();
    checkStalenessAsyncMock.mockReset();
    process.exitCode = undefined;
    initMock.mockResolvedValue(true);
    disconnectMock.mockResolvedValue(undefined);
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

    expect(writeSyncMock).toHaveBeenCalledWith(1, expect.stringContaining('"status":"clean"'));
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

    expect(writeSyncMock).toHaveBeenCalledWith(1, expect.stringContaining('"row_count":1'));
    expect(process.exitCode).toBeUndefined();
  });

  it('fails closed when query returns a backend error payload', async () => {
    callToolMock.mockResolvedValue({ error: 'Repository "missing" not found.' });
    const { queryCommand } = await import('../../src/cli/tool.js');

    await queryCommand('auth flow');

    expect(writeSyncMock).toHaveBeenCalledWith(1, expect.stringContaining('not found'));
    expect(process.exitCode).toBe(1);
    expect(disconnectMock).toHaveBeenCalledOnce();
  });

  it('disconnects after a successful query so the embedding sidecar cannot hold the CLI open', async () => {
    callToolMock.mockResolvedValue({ definitions: [], processes: [] });
    const { queryCommand } = await import('../../src/cli/tool.js');

    await queryCommand('auth flow');

    expect(writeSyncMock).toHaveBeenCalledWith(1, expect.stringContaining('"definitions":[]'));
    expect(disconnectMock).toHaveBeenCalledOnce();
  });

  it('disconnects when a query throws', async () => {
    callToolMock.mockRejectedValue(new Error('embedding failed'));
    const { queryCommand } = await import('../../src/cli/tool.js');

    await expect(queryCommand('auth flow')).rejects.toThrow('embedding failed');

    expect(disconnectMock).toHaveBeenCalledOnce();
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

  // #3127: --stale-policy, applied in the CLI layer right after callTool.
  describe('--stale-policy', () => {
    const staleResult = () => ({
      definitions: [],
      processes: [],
      staleness: {
        status: 'behind',
        branch: 'main',
        lastCommit: 'abc123',
        indexedAt: '2026-11-01T00:00:00.000Z',
        measuredAgainst: 'HEAD',
        commitsBehind: 1,
        hint: '⚠️ Index is 1 commit behind HEAD.',
      },
    });
    let stderr: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });
    afterEach(() => stderr.mockRestore());

    const stderrText = () => stderr.mock.calls.map((call) => String(call[0])).join('');

    it('warn prints exactly what no flag prints', async () => {
      callToolMock.mockResolvedValue(staleResult());
      const { queryCommand } = await import('../../src/cli/tool.js');
      await queryCommand('auth flow');
      const withoutFlag = writeSyncMock.mock.calls[0][1];

      writeSyncMock.mockReset();
      callToolMock.mockResolvedValue(staleResult());
      await queryCommand('auth flow', { stalePolicy: 'warn' });

      expect(writeSyncMock.mock.calls[0][1]).toBe(withoutFlag);
      expect(withoutFlag).toContain('"hint"');
      expect(process.exitCode).toBeUndefined();
      expect(stderrText()).toBe('');
    });

    it('ignore drops the hint but keeps status and the ref', async () => {
      callToolMock.mockResolvedValue(staleResult());
      const { queryCommand } = await import('../../src/cli/tool.js');

      await queryCommand('auth flow', { stalePolicy: 'ignore' });

      const printed = JSON.parse(writeSyncMock.mock.calls[0][1]);
      expect(printed.staleness).toEqual({
        status: 'behind',
        branch: 'main',
        lastCommit: 'abc123',
        indexedAt: '2026-11-01T00:00:00.000Z',
        measuredAgainst: 'HEAD',
        commitsBehind: 1,
      });
      expect(process.exitCode).toBeUndefined();
    });

    it('error prints the result, then fails with a one-line reason', async () => {
      callToolMock.mockResolvedValue(staleResult());
      const { queryCommand } = await import('../../src/cli/tool.js');

      await queryCommand('auth flow', { stalePolicy: 'error' });

      expect(JSON.parse(writeSyncMock.mock.calls[0][1])).toEqual(staleResult());
      expect(stderrText()).toBe('Index is 1 commit(s) behind HEAD\n');
      expect(process.exitCode).toBe(1);
      expect(disconnectMock).toHaveBeenCalledOnce();
    });

    it('error passes a current index', async () => {
      callToolMock.mockResolvedValue({
        definitions: [],
        staleness: { status: 'current', lastCommit: 'abc123', indexedAt: 'x' },
      });
      const { contextCommand } = await import('../../src/cli/tool.js');

      await contextCommand('login', { stalePolicy: 'error' });

      expect(process.exitCode).toBeUndefined();
      expect(stderrText()).toBe('');
    });

    it('error stays fail-open on unknown freshness (e.g. --skip-git)', async () => {
      callToolMock.mockResolvedValue({
        markdown: '| n |\n| --- |\n| 1 |',
        row_count: 1,
        staleness: { status: 'unknown', lastCommit: 'abc123', indexedAt: 'x' },
      });
      const { cypherCommand } = await import('../../src/cli/tool.js');

      await cypherCommand('MATCH (n) RETURN n', { stalePolicy: 'error' });

      expect(process.exitCode).toBeUndefined();
      expect(stderrText()).toBe('');
    });

    it('error fails impact on a diverged index', async () => {
      callToolMock.mockResolvedValue({
        byDepth: {},
        risk: 'LOW',
        staleness: { status: 'diverged', lastCommit: 'abc123', indexedAt: 'x', hint: 'h' },
      });
      const { impactCommand } = await import('../../src/cli/tool.js');

      await impactCommand('auth', { stalePolicy: 'error' });

      expect(stderrText()).toContain('Index is not at HEAD (diverged)\n');
      expect(process.exitCode).toBe(1);
    });

    // The backend attaches no staleness field to check, detect_changes or trace,
    // so `error` measures the index itself — and only under `error`.
    const probeBehind = (commits: number) => {
      selectToolRepositoryMock.mockResolvedValue({ repoPath: '/repo', lastCommit: 'abc123' });
      checkStalenessAsyncMock.mockResolvedValue({
        isStale: true,
        commitsBehind: commits,
        status: 'behind',
        hint: 'h',
      });
    };

    it('error covers check in prose mode, after the prose is printed', async () => {
      probeBehind(2);
      callToolMock.mockResolvedValue({ status: 'clean', cycleCount: 0, cycles: [] });
      const { checkCommand } = await import('../../src/cli/tool.js');

      await checkCommand({ cycles: true, repo: 'gitnexus', stalePolicy: 'error' });

      expect(writeSyncMock).toHaveBeenCalledWith(1, 'No circular imports found.\n');
      expect(selectToolRepositoryMock).toHaveBeenCalledWith('gitnexus', undefined, {
        allowCwdDefault: true,
      });
      expect(checkStalenessAsyncMock).toHaveBeenCalledWith('/repo', 'abc123');
      expect(stderrText()).toBe('Index is 2 commit(s) behind HEAD\n');
      expect(process.exitCode).toBe(1);
    });

    it('error covers detect-changes and trace, which carry no staleness field', async () => {
      probeBehind(4);
      callToolMock.mockResolvedValue({
        summary: { changed_files: 0, changed_count: 0, affected_count: 0, risk_level: 'LOW' },
        changed_symbols: [],
        affected_processes: [],
      });
      const { detectChangesCommand, traceCommand } = await import('../../src/cli/tool.js');
      await detectChangesCommand({ stalePolicy: 'error' });
      expect(process.exitCode).toBe(1);

      process.exitCode = undefined;
      callToolMock.mockResolvedValue({ status: 'found', path: [] });
      await traceCommand('a', 'b', { stalePolicy: 'error' });
      expect(process.exitCode).toBe(1);
      expect(stderrText().match(/Index is 4 commit\(s\) behind HEAD/g)).toHaveLength(2);
    });

    it('error measures a raw-row cypher result too', async () => {
      probeBehind(1);
      callToolMock.mockResolvedValue([{ n: 1 }]);
      const { cypherCommand } = await import('../../src/cli/tool.js');

      await cypherCommand('MATCH (n) RETURN n', { stalePolicy: 'error' });

      expect(writeSyncMock.mock.calls[0][1]).toBe('[{"n":1}]\n');
      expect(process.exitCode).toBe(1);
    });

    it('warn and ignore never spawn the git check', async () => {
      probeBehind(3);
      callToolMock.mockResolvedValue({ status: 'clean', cycleCount: 0, cycles: [] });
      const { checkCommand } = await import('../../src/cli/tool.js');

      await checkCommand({ cycles: true });
      await checkCommand({ cycles: true, stalePolicy: 'warn' });
      await checkCommand({ cycles: true, stalePolicy: 'ignore' });

      expect(selectToolRepositoryMock).not.toHaveBeenCalled();
      expect(checkStalenessAsyncMock).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    });

    it('error does not measure a result that already states its freshness', async () => {
      probeBehind(3);
      callToolMock.mockResolvedValue({
        definitions: [],
        staleness: { status: 'current', lastCommit: 'abc123', indexedAt: 'x' },
      });
      const { queryCommand } = await import('../../src/cli/tool.js');

      await queryCommand('auth', { stalePolicy: 'error' });

      expect(checkStalenessAsyncMock).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    });

    it('error stays fail-open when the git check is unknown or cannot run', async () => {
      callToolMock.mockResolvedValue({ status: 'clean', cycleCount: 0, cycles: [] });
      const { checkCommand } = await import('../../src/cli/tool.js');

      selectToolRepositoryMock.mockResolvedValue({ repoPath: '/repo', lastCommit: 'abc123' });
      checkStalenessAsyncMock.mockResolvedValue({
        isStale: false,
        commitsBehind: 0,
        status: 'unknown',
      });
      await checkCommand({ cycles: true, stalePolicy: 'error' });

      // A --skip-git index records no commit: nothing to measure.
      selectToolRepositoryMock.mockResolvedValue({ repoPath: '/plain', lastCommit: '' });
      await checkCommand({ cycles: true, stalePolicy: 'error' });

      selectToolRepositoryMock.mockRejectedValue(new Error('ambiguous repo'));
      await checkCommand({ cycles: true, stalePolicy: 'error' });

      expect(checkStalenessAsyncMock).toHaveBeenCalledOnce();
      expect(process.exitCode).toBeUndefined();
      expect(stderrText()).toBe('');
    });
  });
});
