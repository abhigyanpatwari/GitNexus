import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { AnalyzeResult } from '../../src/core/run-analyze.js';
import type { CliPreparedAnalysisMessage } from '../../src/cli/analyze-phase-ipc.js';

type SendCallback = (error: Error | null) => void;

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  spawn: vi.fn(),
  skills: vi.fn(async () => ({
    skills: [{ name: 'community' }],
    outputPath: '/repo/.claude/skills',
  })),
  context: vi.fn(async () => ({ files: [] })),
  finalized: vi.fn(async () => undefined),
  commit: vi.fn(),
  snapshot: vi.fn(
    () =>
      new Map([
        ['AGENTS.md', false],
        ['CLAUDE.md', true],
      ]),
  ),
  nativeReady: vi.fn(() => false),
  channel: {
    connected: true,
    send: vi.fn((_message: unknown, callback: SendCallback) => callback(null)),
  },
}));
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  spawn: mocks.spawn,
}));
vi.mock('../../src/cli/analyze-phase-ipc.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/analyze-phase-ipc.js')>();
  return {
    ...actual,
    requireCliAnalysisSupervisor: () => actual.requireCliAnalysisSupervisor(mocks.channel),
    sendCliPreparedAnalysis: (message: CliPreparedAnalysisMessage) =>
      actual.sendCliPreparedAnalysis(message, mocks.channel),
  };
});
vi.mock('../../src/core/run-analyze.js', () => ({ runFullAnalysis: mocks.run }));
vi.mock('../../src/cli/ai-context.js', () => ({ generateAIContextFiles: mocks.context }));
vi.mock('../../src/cli/skill-gen.js', () => ({ generateSkillFiles: mocks.skills }));
vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  closeLbug: vi.fn(),
  closeLbugBeforeExit: vi.fn(),
  isLbugReady: mocks.nativeReady,
  LbugWipeError: class LbugWipeError extends Error {},
}));
vi.mock('../../src/storage/repo-manager.js', () => ({
  loadMeta: vi.fn(async () => null),
  getStoragePaths: vi.fn(() => ({
    storagePath: '/repo/.gitnexus',
    metaPath: '/repo/.gitnexus/gitnexus.json',
  })),
  getGlobalRegistryPath: vi.fn(() => '/nonexistent/registry.json'),
  RegistryNameCollisionError: class RegistryNameCollisionError extends Error {},
  AnalysisNotFinalizedError: class AnalysisNotFinalizedError extends Error {},
  assertAnalysisFinalized: mocks.finalized,
}));
vi.mock('../../src/storage/git.js', () => ({
  getGitRoot: vi.fn(() => '/repo'),
  hasGitDir: vi.fn(() => true),
  getDefaultBranch: vi.fn(() => null),
  selfCommitContextFiles: mocks.commit,
  snapshotSelfCommitSafety: mocks.snapshot,
}));
vi.mock('../../src/core/ingestion/utils/max-file-size.js', () => ({
  getMaxFileSizeBannerMessage: vi.fn(() => null),
}));

const send = mocks.channel.send;
const baselineUnhandled = process.listeners('unhandledRejection');
const baselineUncaught = process.listeners('uncaughtException');
let result: AnalyzeResult;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NODE_OPTIONS', '--max-old-space-size=8192');
  process.exitCode = undefined;
  mocks.nativeReady.mockReturnValue(false);
  result = {
    repoPath: '/repo',
    storagePath: '/repo/.gitnexus',
    repoName: 'registered-repo',
    stats: { files: 1, nodes: 10, edges: 20, communities: 1, processes: 2 },
    rebuildReasons: [],
    preparedGraph: {
      version: 1,
      publicationId: 'a'.repeat(32),
      commit: 'b'.repeat(40),
      repoPath: '/repo',
      storagePath: '/repo/.gitnexus',
      metadataDirectory: '/repo/.gitnexus',
      repoName: 'registered-repo',
    },
    pipelineResult: {
      graph: {
        toJSON: () => {
          throw new Error('Live graph serialized');
        },
      },
    },
  };
  mocks.run.mockResolvedValue(result);
  send.mockImplementation((message, callback) => {
    JSON.stringify(message);
    callback(null);
  });
  mocks.channel.connected = true;
  vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const listener of process.listeners('unhandledRejection')) {
    if (!baselineUnhandled.includes(listener))
      process.removeListener('unhandledRejection', listener);
  }
  for (const listener of process.listeners('uncaughtException')) {
    if (!baselineUncaught.includes(listener)) process.removeListener('uncaughtException', listener);
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

describe('CLI graph phase handoff', () => {
  it('announces cancellation readiness before starting graph work', async () => {
    vi.stubEnv('GITNEXUS_ANALYSIS_SUPERVISED', '1');
    vi.stubEnv('GITNEXUS_ANALYSIS_MANUAL_HEAP', '1');
    const sendReady = vi.spyOn(process, 'send').mockImplementation((message, callback) => {
      if ((message as { type?: string }).type === 'analysis-ready') {
        process.emit('message', { type: 'cancel' }, undefined);
        if (typeof callback === 'function') callback(null);
      }
      return true;
    });
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    await analyzeCommand(undefined, {});
    expect(sendReady).toHaveBeenCalledWith({ type: 'analysis-ready' }, expect.any(Function));
    expect(mocks.run).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(130);
  });

  it.each(['SIGINT', 'SIGTERM', 'ipc'] as const)(
    'waits for active work after %s and removes cancellation listeners',
    async (kind) => {
      const events = ['SIGINT', 'SIGTERM', 'message', 'disconnect'] as const;
      const before = events.map((event) => process.listenerCount(event));
      let finish!: (value: AnalyzeResult) => void;
      mocks.run.mockImplementationOnce(
        () =>
          new Promise<AnalyzeResult>((resolve) => {
            finish = resolve;
          }),
      );
      const { analyzeCommand } = await import('../../src/cli/analyze.js');
      const pending = analyzeCommand(undefined, {});
      await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledOnce());
      if (kind === 'ipc') process.emit('message', { type: 'cancel' }, undefined);
      else process.emit(kind);
      expect(mocks.run.mock.calls[0][2].signal.aborted).toBe(true);
      expect(process.exit).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      finish(result);
      await pending;
      expect(process.exitCode).toBe(kind === 'SIGTERM' ? 143 : 130);
      expect(send).not.toHaveBeenCalled();
      expect(events.map((event) => process.listenerCount(event))).toEqual(before);
    },
  );

  it.each(['pin', 'off', 'ambient'] as const)(
    'keeps %s heap flags when graph work requires a supervisor',
    async (kind) => {
      vi.stubEnv('GITNEXUS_MEMORY', kind === 'off' ? 'off' : '');
      vi.stubEnv(
        'NODE_OPTIONS',
        kind === 'ambient' ? '--max_old_space_size=65536 --max-semi-space-size=16' : '',
      );
      const descriptor = Object.getOwnPropertyDescriptor(process, 'execArgv')!;
      const flags =
        kind === 'pin' ? ['--max_old_space_size', '2048', '--max-semi-space-size=16'] : [];
      Object.defineProperty(process, 'execArgv', { configurable: true, value: flags });
      try {
        const { AnalysisSupervisorRequired } =
          await import('../../src/core/analysis-supervision.js');
        mocks.run.mockRejectedValueOnce(new AnalysisSupervisorRequired());
        mocks.spawn.mockImplementationOnce(() => {
          const child = Object.assign(new EventEmitter(), {
            stdout: new EventEmitter(),
            stderr: new EventEmitter(),
          });
          queueMicrotask(() => child.emit('close', 0, null));
          return child;
        });
        const { analyzeCommand } = await import('../../src/cli/analyze.js');
        await analyzeCommand(undefined, {});
        expect(mocks.spawn).toHaveBeenCalledOnce();
        const [, args, options] = mocks.spawn.mock.calls[0];
        expect(args).toEqual([...flags, '--stack-size=4096', ...process.argv.slice(1)]);
        expect(options.env.NODE_OPTIONS).toBe(process.env.NODE_OPTIONS);
        expect(options.env.GITNEXUS_ANALYSIS_MANUAL_HEAP).toBe('1');
      } finally {
        Object.defineProperty(process, 'execArgv', descriptor);
      }
    },
  );

  it('finishes live-graph skills before IPC and defers finalization, self-commit and success', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    const output = console.log;
    await analyzeCommand(undefined, { skills: true, selfCommit: true });

    expect(send).toHaveBeenCalledTimes(1);
    expect(mocks.snapshot.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.run.mock.invocationCallOrder[0],
    );
    expect(mocks.skills).toHaveBeenCalledWith('/repo', 'registered-repo', result.pipelineResult);
    expect(mocks.context.mock.invocationCallOrder[0]).toBeLessThan(
      send.mock.invocationCallOrder[0],
    );
    expect(send.mock.calls[0][0]).toMatchObject({
      type: 'graph-prepared',
      handoff: result.preparedGraph,
      selfCommitSafety: { agentsMd: false, claudeMd: true },
      result: { repoName: 'registered-repo', stats: result.stats },
    });
    expect(JSON.stringify(send.mock.calls[0][0]).length).toBeLessThan(2048);
    expect(mocks.finalized).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(output).not.toHaveBeenCalledWith(expect.stringContaining('indexed successfully'));
    expect(process.exitCode).toBe(0);
  });

  it('keeps --index-only skill suppression and does not snapshot self-commit when omitted', async () => {
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    await analyzeCommand(undefined, { skills: true, indexOnly: true });
    expect(mocks.skills).not.toHaveBeenCalled();
    expect(mocks.context).not.toHaveBeenCalled();
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(send.mock.calls[0][0]).not.toHaveProperty('selfCommitSafety', expect.anything());
    expect(process.exitCode).toBe(0);
  });

  it('waits for IPC delivery before the native-handle exit, including channel backpressure', async () => {
    let delivered!: SendCallback;
    let received!: () => void;
    const receiving = new Promise<void>((resolve) => {
      received = resolve;
    });
    send.mockImplementationOnce((_message, callback) => {
      delivered = callback;
      received();
      return false;
    });
    mocks.nativeReady.mockReturnValue(true);
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    const running = analyzeCommand(undefined, {});
    await receiving;
    expect(process.exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    delivered(null);
    await running;
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it.each(['throw', 'callback'] as const)(
    'reports an IPC %s failure without success or self-commit',
    async (mode) => {
      send.mockImplementationOnce((_message, callback) => {
        const error = new Error('Supervisor disconnected');
        if (mode === 'throw') throw error;
        callback(error);
      });
      mocks.nativeReady.mockReturnValue(true);
      const { analyzeCommand } = await import('../../src/cli/analyze.js');
      const output = console.log;
      await analyzeCommand(undefined, { selfCommit: true });
      expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(mocks.commit).not.toHaveBeenCalled();
      expect(output).not.toHaveBeenCalledWith(expect.stringContaining('indexed successfully'));
    },
  );

  it('fails before skill writes when the supervisor is missing', async () => {
    mocks.channel.connected = false;
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    await analyzeCommand(undefined, { skills: true, selfCommit: true });
    expect(process.exitCode).toBe(1);
    expect(mocks.skills).not.toHaveBeenCalled();
    expect(mocks.finalized).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('fails if the supervisor disconnects during child-local postprocessing', async () => {
    mocks.context.mockImplementationOnce(async () => {
      mocks.channel.connected = false;
      return { files: [] };
    });
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    await analyzeCommand(undefined, { skills: true, selfCommit: true });
    expect(process.exitCode).toBe(1);
    expect(mocks.skills).toHaveBeenCalledOnce();
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    { repoName: 'different-registration' },
    { repoPath: '/other' },
    { storagePath: '/other' },
    { alreadyUpToDate: true },
    { ftsRepairedOnly: true },
    { graphWriteCollapsed: { expected: 20, persisted: 0 } },
  ])('rejects an incompatible result before skills: %j', async (invalid) => {
    Object.assign(result, invalid);
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    await analyzeCommand(undefined, { skills: true, selfCommit: true });
    expect(process.exitCode).toBe(1);
    expect(mocks.skills).not.toHaveBeenCalled();
    expect(mocks.finalized).not.toHaveBeenCalled();
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('projects only named counters and safety flags, without traversing future payload fields', async () => {
    const poison = {
      enumerable: true,
      get() {
        throw new Error('Unbounded field traversed');
      },
    };
    Object.defineProperty(result.stats, 'perFile', poison);
    Object.defineProperty(result.preparedGraph, 'sourceMaps', poison);
    Object.defineProperty(result, 'sourceMaps', poison);
    mocks.snapshot.mockReturnValueOnce(
      new Map([
        ['unrelated-file', true],
        ['CLAUDE.md', true],
      ]),
    );
    result.ftsSkipped = true;
    result.ftsSkipReason = 'disabled-by-flag';
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    await analyzeCommand(undefined, { selfCommit: true });
    expect(send.mock.calls[0][0]).toMatchObject({
      selfCommitSafety: { agentsMd: false, claudeMd: true },
      result: { ftsSkipped: true, ftsSkipReason: 'disabled-by-flag' },
    });
    expect(JSON.stringify(send.mock.calls[0][0])).not.toMatch(/perFile|sourceMaps|unrelated-file/);
    expect(process.exitCode).toBe(0);
  });

  it.each([NaN, Infinity, -1, 1.5])('rejects invalid summary counter %s', async (nodes) => {
    result.stats.nodes = nodes;
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    await analyzeCommand(undefined, { skills: true });
    expect(process.exitCode).toBe(1);
    expect(mocks.skills).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
