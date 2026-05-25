/**
 * Integration-level tests for local CLI subprocess contracts.
 *
 * Validates the actual argv, stdin content, spawn options, and exit
 * behavior for Claude and Codex providers — the layer that
 * wiki-flags.test.ts mocks out. Uses a fake spawn that captures
 * args and emits controlled events.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

function makeFakeChild(opts?: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  stdinEndBehavior?: 'normal' | 'epipe';
}) {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter() as any;
  child.pid = 12345;
  child.kill = vi.fn();

  let stdinContent = '';
  child.stdin.end = vi.fn((data?: string) => {
    if (data) stdinContent += data;
    queueMicrotask(() => {
      if (opts?.stdinEndBehavior === 'epipe') {
        child.stdin.emit('error', new Error('write EPIPE'));
      }
      if (opts?.stdout) {
        child.stdout.emit('data', Buffer.from(opts.stdout));
      }
      if (opts?.stderr) {
        child.stderr.emit('data', Buffer.from(opts.stderr));
      }
      child.emit('close', opts?.exitCode ?? 0);
    });
  });

  return { child, getStdin: () => stdinContent };
}

// ─── Claude CLI argv contract ─────────────────────────────────────────

describe('Claude CLI subprocess contract', () => {
  let spawnSpy: ReturnType<typeof vi.fn>;
  let fakeChild: ReturnType<typeof makeFakeChild>;

  beforeEach(() => {
    vi.resetModules();
    fakeChild = makeFakeChild({ stdout: 'Claude response text' });
    spawnSpy = vi.fn(() => fakeChild.child);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes correct flags: -p --output-format text --no-session-persistence', async () => {
    vi.doMock('child_process', () => ({
      execFileSync: vi.fn().mockReturnValue('claude 1.0.0'),
      spawn: spawnSpy,
    }));
    const { callClaudeLLM } = await import('../../src/core/wiki/local-cli-client.js');

    await callClaudeLLM('user prompt', {});

    const args = spawnSpy.mock.calls[0][1] as string[];
    expect(args).toContain('-p');
    expect(args).toContain('--output-format');
    expect(args).toContain('text');
    expect(args).toContain('--no-session-persistence');
  });

  it('appends --model only when model is set', async () => {
    vi.doMock('child_process', () => ({
      execFileSync: vi.fn().mockReturnValue('claude 1.0.0'),
      spawn: spawnSpy,
    }));
    const { callClaudeLLM } = await import('../../src/core/wiki/local-cli-client.js');

    await callClaudeLLM('prompt', { model: 'claude-sonnet-4-20250514' });

    const args = spawnSpy.mock.calls[0][1] as string[];
    expect(args).toContain('--model');
    expect(args).toContain('claude-sonnet-4-20250514');
  });

  it('does not include --model when model is empty', async () => {
    vi.doMock('child_process', () => ({
      execFileSync: vi.fn().mockReturnValue('claude 1.0.0'),
      spawn: spawnSpy,
    }));
    const { callClaudeLLM } = await import('../../src/core/wiki/local-cli-client.js');

    await callClaudeLLM('prompt', {});

    const args = spawnSpy.mock.calls[0][1] as string[];
    expect(args).not.toContain('--model');
  });

  it('sends full prompt (system + separator + user) via stdin', async () => {
    vi.doMock('child_process', () => ({
      execFileSync: vi.fn().mockReturnValue('claude 1.0.0'),
      spawn: spawnSpy,
    }));
    const { callClaudeLLM } = await import('../../src/core/wiki/local-cli-client.js');

    await callClaudeLLM('user prompt', {}, 'system prompt');

    const stdinText = fakeChild.getStdin();
    expect(stdinText).toBe('system prompt\n\n---\n\nuser prompt');
  });

  it('sends only user prompt when no system prompt', async () => {
    vi.doMock('child_process', () => ({
      execFileSync: vi.fn().mockReturnValue('claude 1.0.0'),
      spawn: spawnSpy,
    }));
    const { callClaudeLLM } = await import('../../src/core/wiki/local-cli-client.js');

    await callClaudeLLM('just the user prompt', {});

    expect(fakeChild.getStdin()).toBe('just the user prompt');
  });

  it('sets CI=1 and windowsHide=true in spawn options', async () => {
    vi.doMock('child_process', () => ({
      execFileSync: vi.fn().mockReturnValue('claude 1.0.0'),
      spawn: spawnSpy,
    }));
    const { callClaudeLLM } = await import('../../src/core/wiki/local-cli-client.js');

    await callClaudeLLM('prompt', {});

    const spawnOpts = spawnSpy.mock.calls[0][2];
    expect(spawnOpts.env.CI).toBe('1');
    expect(spawnOpts.windowsHide).toBe(true);
  });

  it('rejects with exit code and stderr on non-zero exit', async () => {
    fakeChild = makeFakeChild({ exitCode: 1, stderr: 'auth required' });
    spawnSpy = vi.fn(() => fakeChild.child);

    vi.doMock('child_process', () => ({
      execFileSync: vi.fn().mockReturnValue('claude 1.0.0'),
      spawn: spawnSpy,
    }));
    const { callClaudeLLM } = await import('../../src/core/wiki/local-cli-client.js');

    await expect(callClaudeLLM('prompt', {})).rejects.toThrow(
      'claude CLI exited with code 1: auth required',
    );
  });

  it('rejects with actionable error on empty stdout', async () => {
    fakeChild = makeFakeChild({ stdout: '' });
    spawnSpy = vi.fn(() => fakeChild.child);

    vi.doMock('child_process', () => ({
      execFileSync: vi.fn().mockReturnValue('claude 1.0.0'),
      spawn: spawnSpy,
    }));
    const { callClaudeLLM } = await import('../../src/core/wiki/local-cli-client.js');

    await expect(callClaudeLLM('prompt', {})).rejects.toThrow('claude CLI returned empty output');
  });
});

// ─── Codex CLI argv contract ──────────────────────────────────────────

describe('Codex CLI subprocess contract', () => {
  let spawnSpy: ReturnType<typeof vi.fn>;
  let fakeChild: ReturnType<typeof makeFakeChild>;

  beforeEach(() => {
    vi.resetModules();
    fakeChild = makeFakeChild({ stdout: 'codex response' });
    spawnSpy = vi.fn(() => fakeChild.child);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes correct subcommand and flags: exec --sandbox read-only -c approval_policy', async () => {
    vi.doMock('child_process', () => ({
      execFileSync: vi.fn().mockReturnValue('codex 0.1.0'),
      spawn: spawnSpy,
    }));
    const { callCodexLLM } = await import('../../src/core/wiki/local-cli-client.js');

    await callCodexLLM('prompt', { workingDirectory: '/repo' });

    const args = spawnSpy.mock.calls[0][1] as string[];
    expect(args).toContain('exec');
    expect(args).toContain('--sandbox');
    expect(args).toContain('read-only');
    expect(args).toContain('-c');
    expect(args).toContain('approval_policy="never"');
    expect(args).toContain('--color');
    expect(args).toContain('never');
  });

  it('includes --output-last-message with a temp file path', async () => {
    vi.doMock('child_process', () => ({
      execFileSync: vi.fn().mockReturnValue('codex 0.1.0'),
      spawn: spawnSpy,
    }));
    const { callCodexLLM } = await import('../../src/core/wiki/local-cli-client.js');

    await callCodexLLM('prompt', { workingDirectory: '/repo' });

    const args = spawnSpy.mock.calls[0][1] as string[];
    const outputIdx = args.indexOf('--output-last-message');
    expect(outputIdx).toBeGreaterThan(-1);
    const outputPath = args[outputIdx + 1];
    expect(outputPath).toContain('gitnexus-wiki-codex-');
    expect(outputPath).toContain('last-message.txt');
  });

  it('passes --cd with the working directory', async () => {
    vi.doMock('child_process', () => ({
      execFileSync: vi.fn().mockReturnValue('codex 0.1.0'),
      spawn: spawnSpy,
    }));
    const { callCodexLLM } = await import('../../src/core/wiki/local-cli-client.js');

    await callCodexLLM('prompt', { workingDirectory: '/my/repo' });

    const args = spawnSpy.mock.calls[0][1] as string[];
    const cdIdx = args.indexOf('--cd');
    expect(cdIdx).toBeGreaterThan(-1);
    expect(args[cdIdx + 1]).toBe('/my/repo');
  });

  it('ends args with - (stdin marker)', async () => {
    vi.doMock('child_process', () => ({
      execFileSync: vi.fn().mockReturnValue('codex 0.1.0'),
      spawn: spawnSpy,
    }));
    const { callCodexLLM } = await import('../../src/core/wiki/local-cli-client.js');

    await callCodexLLM('prompt', { workingDirectory: '/repo' });

    const args = spawnSpy.mock.calls[0][1] as string[];
    expect(args[args.length - 1]).toBe('-');
  });

  it('sends full prompt via stdin', async () => {
    vi.doMock('child_process', () => ({
      execFileSync: vi.fn().mockReturnValue('codex 0.1.0'),
      spawn: spawnSpy,
    }));
    const { callCodexLLM } = await import('../../src/core/wiki/local-cli-client.js');

    await callCodexLLM('user msg', { workingDirectory: '/repo' }, 'sys msg');

    expect(fakeChild.getStdin()).toBe('sys msg\n\n---\n\nuser msg');
  });

  it('appends --model only when set', async () => {
    vi.doMock('child_process', () => ({
      execFileSync: vi.fn().mockReturnValue('codex 0.1.0'),
      spawn: spawnSpy,
    }));
    const { callCodexLLM } = await import('../../src/core/wiki/local-cli-client.js');

    await callCodexLLM('prompt', { workingDirectory: '/repo', model: 'o3-pro' });

    const args = spawnSpy.mock.calls[0][1] as string[];
    expect(args).toContain('--model');
    expect(args).toContain('o3-pro');
    const modelIdx = args.indexOf('--model');
    const stdinIdx = args.indexOf('-');
    expect(modelIdx).toBeLessThan(stdinIdx);
  });
});

// ─── Timeout behavior ─────────────────────────────────────────────────

describe('local CLI timeout', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('kills child process after requestTimeoutMs and rejects with timeout error', async () => {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter() as any;
    child.pid = 99;
    child.kill = vi.fn();
    child.stdin.end = vi.fn();

    vi.doMock('child_process', () => ({
      execFileSync: vi.fn().mockReturnValue('claude 1.0.0'),
      spawn: vi.fn(() => child),
    }));
    const { callClaudeLLM } = await import('../../src/core/wiki/local-cli-client.js');

    const promise = callClaudeLLM('prompt', { requestTimeoutMs: 5000 });

    vi.advanceTimersByTime(5000);
    child.emit('close', null);
    await expect(promise).rejects.toThrow('claude CLI timed out after 5s');
  });

  it('uses taskkill /T /F /PID on Windows for process-tree kill', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });

    try {
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = new EventEmitter() as any;
      child.pid = 42;
      child.kill = vi.fn();
      child.stdin.end = vi.fn();

      const execFileSyncSpy = vi.fn().mockImplementation((cmd: string, args: string[]) => {
        if (cmd !== 'taskkill') return 'claude 1.0.0';
        return '';
      });

      vi.doMock('child_process', () => ({
        execFileSync: execFileSyncSpy,
        spawn: vi.fn(() => child),
      }));
      const { callClaudeLLM } = await import('../../src/core/wiki/local-cli-client.js');

      const promise = callClaudeLLM('prompt', { requestTimeoutMs: 3000 });
      vi.advanceTimersByTime(3000);
      // Timeout fires, taskkill runs, but child hasn't emitted close yet.
      // Emit close now to settle the promise.
      child.emit('close', null);
      await expect(promise).rejects.toThrow('claude CLI timed out after 3s');

      const taskkillCalls = execFileSyncSpy.mock.calls.filter(
        (c: unknown[]) => c[0] === 'taskkill',
      );
      expect(taskkillCalls.length).toBe(1);
      expect(taskkillCalls[0][1]).toEqual(['/T', '/F', '/PID', '42']);
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it('falls back to child.kill() when taskkill fails on Windows', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });

    try {
      const child = new EventEmitter() as any;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = new EventEmitter() as any;
      child.pid = 42;
      child.kill = vi.fn();
      child.stdin.end = vi.fn();

      vi.doMock('child_process', () => ({
        execFileSync: vi.fn().mockImplementation((cmd: string) => {
          if (cmd === 'taskkill') throw new Error('taskkill: process not found');
          return 'claude 1.0.0';
        }),
        spawn: vi.fn(() => child),
      }));
      const { callClaudeLLM } = await import('../../src/core/wiki/local-cli-client.js');

      const promise = callClaudeLLM('prompt', { requestTimeoutMs: 2000 });
      vi.advanceTimersByTime(2000);
      child.emit('close', null);
      await expect(promise).rejects.toThrow('claude CLI timed out after 2s');
      expect(child.kill).toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it('does not set a kill timer when requestTimeoutMs is undefined', async () => {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter() as any;
    child.pid = 99;
    child.kill = vi.fn();
    child.stdin.end = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('response'));
        child.emit('close', 0);
      });
    });

    vi.doMock('child_process', () => ({
      execFileSync: vi.fn().mockReturnValue('claude 1.0.0'),
      spawn: vi.fn(() => child),
    }));
    const { callClaudeLLM } = await import('../../src/core/wiki/local-cli-client.js');

    const response = await callClaudeLLM('prompt', {});
    expect(response.content).toBe('response');
    expect(child.kill).not.toHaveBeenCalled();
  });
});

// ─── Codex output file fallback ───────────────────────────────────────

describe('Codex output file fallback', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses stdout when output file is missing', async () => {
    const fakeChild = makeFakeChild({ stdout: 'stdout content' });

    vi.doMock('child_process', () => ({
      execFileSync: vi.fn().mockReturnValue('codex 0.1.0'),
      spawn: vi.fn(() => fakeChild.child),
    }));
    const { callCodexLLM } = await import('../../src/core/wiki/local-cli-client.js');

    const result = await callCodexLLM('prompt', { workingDirectory: '/repo' });
    expect(result.content).toBe('stdout content');
  });

  it('rejects when both stdout and output file are empty', async () => {
    const fakeChild = makeFakeChild({ stdout: '' });

    vi.doMock('child_process', () => ({
      execFileSync: vi.fn().mockReturnValue('codex 0.1.0'),
      spawn: vi.fn(() => fakeChild.child),
    }));
    const { callCodexLLM } = await import('../../src/core/wiki/local-cli-client.js');

    await expect(callCodexLLM('prompt', { workingDirectory: '/repo' })).rejects.toThrow(
      'codex CLI returned empty output',
    );
  });
});

// ─── detectLocalCLI diagnostics ───────────────────────────────────────

describe('detectLocalCLI diagnostics', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null and warns when CLI exists but --version fails (non-ENOENT)', async () => {
    const warnSpy = vi.fn();
    vi.doMock('../../src/core/logger.js', () => ({
      logger: { info: vi.fn(), warn: warnSpy },
    }));
    vi.doMock('child_process', () => ({
      execFileSync: vi.fn().mockImplementation(() => {
        const err = new Error('exit code 1') as any;
        err.status = 1;
        throw err;
      }),
      spawn: vi.fn(),
    }));

    const { detectLocalCLI } = await import('../../src/core/wiki/local-cli-client.js');

    const result = detectLocalCLI('claude');
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('--version failed'));
  });

  it('returns null silently when CLI is truly not found (ENOENT)', async () => {
    const warnSpy = vi.fn();
    vi.doMock('../../src/core/logger.js', () => ({
      logger: { info: vi.fn(), warn: warnSpy },
    }));
    vi.doMock('child_process', () => ({
      execFileSync: vi.fn().mockImplementation(() => {
        const err = new Error('ENOENT') as any;
        err.code = 'ENOENT';
        throw err;
      }),
      spawn: vi.fn(),
    }));

    const { detectLocalCLI } = await import('../../src/core/wiki/local-cli-client.js');

    const result = detectLocalCLI('claude');
    expect(result).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ─── onChunk progress callback ────────────────────────────────────────

describe('local CLI onChunk callback', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fires onChunk with cumulative stdout byte count', async () => {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter() as any;
    child.pid = 1;
    child.stdin.end = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('chunk1'));
        child.stdout.emit('data', Buffer.from('chunk2'));
        child.emit('close', 0);
      });
    });

    vi.doMock('child_process', () => ({
      execFileSync: vi.fn().mockReturnValue('claude 1.0.0'),
      spawn: vi.fn(() => child),
    }));
    const { callClaudeLLM } = await import('../../src/core/wiki/local-cli-client.js');

    const chunks: number[] = [];
    await callClaudeLLM('prompt', {}, undefined, { onChunk: (n) => chunks.push(n) });

    expect(chunks).toEqual([6, 12]);
  });
});

// ─── Codex CLI flag contract snapshot ─────────────────────────────────

describe('Codex CLI flag contract snapshot', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('spawn args match the exact expected contract (flag rename = test failure)', async () => {
    const fakeChild = makeFakeChild({ stdout: 'codex output' });
    const spawnSpy = vi.fn(() => fakeChild.child);

    vi.doMock('child_process', () => ({
      execFileSync: vi.fn().mockReturnValue('codex 0.1.0'),
      spawn: spawnSpy,
    }));
    const { callCodexLLM } = await import('../../src/core/wiki/local-cli-client.js');

    await callCodexLLM('prompt', { workingDirectory: '/repo', model: 'o3' });

    const args = spawnSpy.mock.calls[0][1] as string[];

    // The contract flags start at 'exec' — skip any platform argsPrefix
    // (e.g., ['/d', '/s', '/c', 'codex'] on Windows cmd.exe fallback)
    const execIdx = args.indexOf('exec');
    expect(execIdx).toBeGreaterThanOrEqual(0);
    const contractArgs = args.slice(execIdx);

    // Strip the dynamic temp path for comparison
    const outputMsgIdx = contractArgs.indexOf('--output-last-message');
    const normalized = [...contractArgs];
    if (outputMsgIdx !== -1) {
      normalized[outputMsgIdx + 1] = '<TEMP_PATH>';
    }

    expect(normalized).toEqual([
      'exec',
      '--cd',
      '/repo',
      '--sandbox',
      'read-only',
      '-c',
      'approval_policy="never"',
      '--color',
      'never',
      '--output-last-message',
      '<TEMP_PATH>',
      '--model',
      'o3',
      '-',
    ]);
  });

  it('--model appears before - (stdin marker) and after --output-last-message', async () => {
    const fakeChild = makeFakeChild({ stdout: 'codex output' });
    const spawnSpy = vi.fn(() => fakeChild.child);

    vi.doMock('child_process', () => ({
      execFileSync: vi.fn().mockReturnValue('codex 0.1.0'),
      spawn: spawnSpy,
    }));
    const { callCodexLLM } = await import('../../src/core/wiki/local-cli-client.js');

    await callCodexLLM('prompt', { workingDirectory: '/repo', model: 'test-model' });

    const args = spawnSpy.mock.calls[0][1] as string[];
    const outputIdx = args.indexOf('--output-last-message');
    const modelIdx = args.indexOf('--model');
    const stdinIdx = args.lastIndexOf('-');

    expect(outputIdx).toBeLessThan(modelIdx);
    expect(modelIdx).toBeLessThan(stdinIdx);
    expect(args[args.length - 1]).toBe('-');
  });
});
