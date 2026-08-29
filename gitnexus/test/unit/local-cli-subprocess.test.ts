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
  closeOnSpawn?: boolean;
}) {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter() as any;
  child.pid = 12345;
  child.kill = vi.fn();

  let stdinContent = '';
  const finish = () => {
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
  };

  child.stdin.end = vi.fn((data?: string) => {
    if (data) stdinContent += data;
    if (!opts?.closeOnSpawn) finish();
  });

  return { child, getStdin: () => stdinContent, complete: finish };
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

// ─── Grok CLI subprocess contract ─────────────────────────────────────

describe('Grok CLI subprocess contract', () => {
  let spawnSpy: ReturnType<typeof vi.fn>;
  let fakeChild: ReturnType<typeof makeFakeChild>;

  function spawnGrokChild(onSpawn?: (...args: unknown[]) => void) {
    spawnSpy = vi.fn((...args: unknown[]) => {
      onSpawn?.(...args);
      fakeChild.complete();
      return fakeChild.child;
    });
  }

  function grokFake(
    opts: Parameters<typeof makeFakeChild>[0] = {
      stdout: JSON.stringify({ text: 'wiki page', stopReason: 'end_turn' }),
    },
    onSpawn?: (...args: unknown[]) => void,
  ) {
    fakeChild = makeFakeChild({ ...opts, closeOnSpawn: true });
    spawnGrokChild(onSpawn);
  }

  beforeEach(() => {
    vi.resetModules();
    grokFake();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function loadGrokClient() {
    vi.doMock('../../src/core/logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn() },
    }));
    vi.doMock('child_process', () => ({
      execFileSync: vi.fn().mockReturnValue('grok 1.0.5'),
      execSync: vi.fn().mockReturnValue('grok 1.0.5'),
      spawn: spawnSpy,
    }));
    return import('../../src/core/wiki/grok-client.js');
  }

  it('detectGrokCLI returns grok when grok --version succeeds and caches the result', async () => {
    const execFileSync = vi.fn().mockReturnValue('grok 1.0.5');
    vi.doMock('../../src/core/logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn() },
    }));
    vi.doMock('child_process', () => ({
      execFileSync,
      execSync: vi.fn(),
      spawn: spawnSpy,
    }));
    const { detectGrokCLI } = await import('../../src/core/wiki/grok-client.js');

    expect(detectGrokCLI()).toBe('grok');
    expect(detectGrokCLI()).toBe('grok');
    const versionCalls = execFileSync.mock.calls.filter(
      (call: unknown[]) => Array.isArray(call[1]) && (call[1] as string[]).includes('--version'),
    );
    expect(versionCalls).toHaveLength(1);
  });

  it('detectGrokCLI returns null on ENOENT', async () => {
    vi.doMock('../../src/core/logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn() },
    }));
    vi.doMock('child_process', () => ({
      execFileSync: vi.fn().mockImplementation(() => {
        const err = new Error('not found') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }),
      execSync: vi.fn(),
      spawn: spawnSpy,
    }));
    const { detectGrokCLI } = await import('../../src/core/wiki/grok-client.js');

    expect(detectGrokCLI()).toBeNull();
  });

  it('spawns grok with prompt-file, json output, max-turns 15, a tool denylist, and a strict sandbox', async () => {
    const { callGrokLLM } = await loadGrokClient();

    await callGrokLLM('user prompt', {});

    const args = spawnSpy.mock.calls[0][1] as string[];
    expect(args).toContain('--prompt-file');
    expect(args).toContain('--output-format');
    expect(args).toContain('json');
    const turnsIdx = args.indexOf('--max-turns');
    expect(turnsIdx).toBeGreaterThanOrEqual(0);
    expect(args[turnsIdx + 1]).toBe('15');
    expect(args).toContain('--no-plan');
    expect(args).toContain('--no-subagents');
    expect(args).toContain('--disable-web-search');
    expect(args).toContain('--disallowed-tools');
    const denyIdx = args.indexOf('--disallowed-tools');
    expect(args[denyIdx + 1]).toBe(
      'run_terminal_cmd,search_replace,web_search,web_fetch,spawn_subagent',
    );
    expect(args).toContain('--sandbox');
    const sandboxIdx = args.indexOf('--sandbox');
    expect(args[sandboxIdx + 1]).toBe('strict');
    expect(args).not.toContain('--tools');
    expect(args).not.toContain('--yolo');
    expect(args).not.toContain('--always-approve');
    expect(args.some((arg) => arg.includes('user prompt'))).toBe(false);
  });

  it('writes system + separator + user prompt to --prompt-file, not stdin', async () => {
    const { callGrokLLM } = await loadGrokClient();

    await callGrokLLM('user prompt', {}, 'system prompt');

    const args = spawnSpy.mock.calls[0][1] as string[];
    const fileIdx = args.indexOf('--prompt-file');
    const promptPath = args[fileIdx + 1];
    // File is removed after the call; capture contents via spawn-time read.
    // The implementation writes before spawn, so the spy can read it if we hook spawn.
    expect(fakeChild.getStdin()).toBe('');
    expect(promptPath).toContain('gitnexus-wiki-grok-');
  });

  it('writes the concatenated prompt before spawn', async () => {
    let promptContents = '';
    const fs = await import('fs');
    grokFake(
      { stdout: JSON.stringify({ text: 'wiki page', stopReason: 'end_turn' }) },
      (..._spawnArgs: unknown[]) => {
        const args = _spawnArgs[1] as string[];
        const fileIdx = args.indexOf('--prompt-file');
        promptContents = fs.readFileSync(args[fileIdx + 1], 'utf-8');
      },
    );
    const { callGrokLLM } = await loadGrokClient();

    await callGrokLLM('user prompt', {}, 'system prompt');

    expect(promptContents).toBe('system prompt\n\n---\n\nuser prompt');
  });

  it('passes --cwd to an empty temp dir, not a repo path', async () => {
    grokFake(
      { stdout: JSON.stringify({ text: 'wiki page', stopReason: 'end_turn' }) },
      (_cmd, args, opts) => {
        const argv = args as string[];
        const spawnOpts = opts as { cwd?: string };
        expect(argv).toContain('--cwd');
        const cwdIdx = argv.indexOf('--cwd');
        expect(argv[cwdIdx + 1]).toContain('gitnexus-wiki-grok-');
        expect(argv[cwdIdx + 1]).toBe(spawnOpts.cwd);
      },
    );
    const { callGrokLLM } = await loadGrokClient();

    await callGrokLLM('prompt', {});
  });

  it('appends --model only when model is set', async () => {
    const { callGrokLLM } = await loadGrokClient();

    await callGrokLLM('prompt', { model: 'grok-build' });

    const args = spawnSpy.mock.calls[0][1] as string[];
    expect(args).toContain('--model');
    expect(args).toContain('grok-build');
  });

  it('does not include --model when model is empty', async () => {
    const { callGrokLLM } = await loadGrokClient();

    await callGrokLLM('prompt', {});

    const args = spawnSpy.mock.calls[0][1] as string[];
    expect(args).not.toContain('--model');
  });

  it('parses JSON text field as the LLM content', async () => {
    const { callGrokLLM } = await loadGrokClient();

    const result = await callGrokLLM('prompt', {});
    expect(result.content).toBe('wiki page');
  });

  it('rejects with exit code and stderr on non-zero exit', async () => {
    grokFake({ exitCode: 1, stderr: 'auth required' });
    const { callGrokLLM } = await loadGrokClient();

    await expect(callGrokLLM('prompt', {})).rejects.toThrow(
      'grok CLI exited with code 1: auth required',
    );
  });

  it('rejects when grok returns a JSON error object', async () => {
    grokFake({
      stdout: JSON.stringify({ type: 'error', message: 'session failed' }),
    });
    const { callGrokLLM } = await loadGrokClient();

    await expect(callGrokLLM('prompt', {})).rejects.toThrow('session failed');
  });

  it('rejects when JSON text is empty', async () => {
    grokFake({ stdout: JSON.stringify({ text: '   ' }) });
    const { callGrokLLM } = await loadGrokClient();

    await expect(callGrokLLM('prompt', {})).rejects.toThrow('grok CLI returned empty text');
  });

  it('rejects incomplete stopReason even when text is present', async () => {
    grokFake({
      stdout: JSON.stringify({ text: 'cut off mid-sent', stopReason: 'max_tokens' }),
    });
    const { callGrokLLM } = await loadGrokClient();

    await expect(callGrokLLM('prompt', {})).rejects.toThrow(/stopReason=max_tokens/);
  });

  it('rejects PascalCase incomplete stopReason', async () => {
    grokFake({
      stdout: JSON.stringify({ text: 'partial', stopReason: 'MaxTokens' }),
    });
    const { callGrokLLM } = await loadGrokClient();

    await expect(callGrokLLM('prompt', {})).rejects.toThrow(/stopReason=MaxTokens/);
  });

  it('accepts end_turn stopReason with text', async () => {
    grokFake({
      stdout: JSON.stringify({ text: 'wiki page', stopReason: 'end_turn' }),
    });
    const { callGrokLLM } = await loadGrokClient();

    await expect(callGrokLLM('prompt', {})).resolves.toEqual({ content: 'wiki page' });
  });

  it('rejects omitted stopReason even when text is non-empty', async () => {
    grokFake({ stdout: JSON.stringify({ text: 'wiki page' }) });
    const { callGrokLLM } = await loadGrokClient();

    await expect(callGrokLLM('prompt', {})).rejects.toThrow(
      'grok CLI JSON is missing stopReason=end_turn',
    );
  });

  it('rejects null stopReason even when text is non-empty', async () => {
    grokFake({ stdout: JSON.stringify({ text: 'wiki page', stopReason: null }) });
    const { callGrokLLM } = await loadGrokClient();

    await expect(callGrokLLM('prompt', {})).rejects.toThrow(
      'grok CLI JSON is missing stopReason=end_turn',
    );
  });

  it('rejects empty stopReason even when text is non-empty', async () => {
    grokFake({ stdout: JSON.stringify({ text: 'wiki page', stopReason: '' }) });
    const { callGrokLLM } = await loadGrokClient();

    await expect(callGrokLLM('prompt', {})).rejects.toThrow(
      'grok CLI JSON is missing stopReason=end_turn',
    );
  });

  it('rejects empty stdout with a dedicated message', async () => {
    grokFake({ stdout: '   ' });
    const { callGrokLLM } = await loadGrokClient();

    await expect(callGrokLLM('prompt', {})).rejects.toThrow('grok CLI returned empty output');
  });

  it('rejects non-JSON stdout with an excerpt', async () => {
    grokFake({ stdout: 'Update available\nnot-json' });
    const { callGrokLLM } = await loadGrokClient();

    await expect(callGrokLLM('prompt', {})).rejects.toThrow(/non-JSON output:.*Update available/s);
  });

  it('rejects JSON without a text field with an excerpt', async () => {
    grokFake({ stdout: JSON.stringify({ sessionId: 'abc' }) });
    const { callGrokLLM } = await loadGrokClient();

    await expect(callGrokLLM('prompt', {})).rejects.toThrow(/no text field:.*"sessionId"/s);
  });

  it('removes the temp prompt file and cwd after success', async () => {
    const fs = await import('fs');
    let promptPath = '';
    let cwdPath = '';
    grokFake(
      { stdout: JSON.stringify({ text: 'wiki page', stopReason: 'end_turn' }) },
      (_cmd, args) => {
        const argv = args as string[];
        const fileIdx = argv.indexOf('--prompt-file');
        promptPath = argv[fileIdx + 1];
        cwdPath = argv[argv.indexOf('--cwd') + 1];
        expect(fs.existsSync(promptPath)).toBe(true);
      },
    );
    const { callGrokLLM } = await loadGrokClient();

    await callGrokLLM('prompt', {});

    expect(fs.existsSync(promptPath)).toBe(false);
    expect(fs.existsSync(cwdPath)).toBe(false);
  });

  it('removes the temp dir after failure', async () => {
    const fs = await import('fs');
    let cwdPath = '';
    grokFake({ exitCode: 1, stderr: 'nope' }, (_cmd, args) => {
      const argv = args as string[];
      cwdPath = argv[argv.indexOf('--cwd') + 1];
    });
    const { callGrokLLM } = await loadGrokClient();

    await expect(callGrokLLM('prompt', {})).rejects.toThrow(/exited with code 1/);
    expect(fs.existsSync(cwdPath)).toBe(false);
  });

  it('throws when grok CLI is not on PATH', async () => {
    vi.doMock('../../src/core/logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn() },
    }));
    vi.doMock('child_process', () => ({
      execFileSync: vi.fn().mockImplementation(() => {
        const err = new Error('not found') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }),
      execSync: vi.fn(),
      spawn: spawnSpy,
    }));
    const { callGrokLLM } = await import('../../src/core/wiki/grok-client.js');

    await expect(callGrokLLM('prompt', {})).rejects.toThrow(/Grok CLI not found/);
  });

  it('sets CI=1 and windowsHide=true in spawn options', async () => {
    const { callGrokLLM } = await loadGrokClient();

    await callGrokLLM('prompt', {});

    const spawnOpts = spawnSpy.mock.calls[0][2];
    expect(spawnOpts.env.CI).toBe('1');
    expect(spawnOpts.windowsHide).toBe(true);
  });

  it('on Windows detects grok and spawns via cmd.exe /d /s /c, not a .cmd path', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });

    try {
      const execFileSync = vi.fn().mockImplementation((cmd: string) => {
        if (cmd === 'where.exe') return 'C:\\Users\\me\\AppData\\Roaming\\npm\\grok.cmd\r\n';
        return 'grok 1.0.5';
      });
      vi.doMock('../../src/core/logger.js', () => ({
        logger: { info: vi.fn(), warn: vi.fn() },
      }));
      vi.doMock('child_process', () => ({
        execFileSync,
        execSync: vi.fn(),
        spawn: spawnSpy,
      }));
      const { detectGrokCLI, callGrokLLM } = await import('../../src/core/wiki/grok-client.js');

      expect(detectGrokCLI()).toBe('grok');
      await callGrokLLM('prompt', {});

      const spawnCmd = spawnSpy.mock.calls[0][0] as string;
      const spawnArgs = spawnSpy.mock.calls[0][1] as string[];
      expect(spawnCmd.toLowerCase()).not.toMatch(/\.cmd$/);
      expect(spawnCmd).toBe(process.env.ComSpec || 'cmd.exe');
      expect(spawnArgs.slice(0, 4)).toEqual(['/d', '/s', '/c', 'grok']);
      expect(spawnArgs).toContain('--prompt-file');
      expect(spawnArgs).toContain('--sandbox');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it('on Windows uses ComSpec when set instead of cmd.exe', async () => {
    const originalPlatform = process.platform;
    const originalComSpec = process.env.ComSpec;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';

    try {
      vi.doMock('../../src/core/logger.js', () => ({
        logger: { info: vi.fn(), warn: vi.fn() },
      }));
      vi.doMock('child_process', () => ({
        execFileSync: vi.fn().mockReturnValue('grok 1.0.5'),
        execSync: vi.fn(),
        spawn: spawnSpy,
      }));
      const { callGrokLLM } = await import('../../src/core/wiki/grok-client.js');

      await callGrokLLM('prompt', {});

      expect(spawnSpy.mock.calls[0][0]).toBe('C:\\Windows\\System32\\cmd.exe');
      expect((spawnSpy.mock.calls[0][1] as string[]).slice(0, 4)).toEqual([
        '/d',
        '/s',
        '/c',
        'grok',
      ]);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      if (originalComSpec === undefined) delete process.env.ComSpec;
      else process.env.ComSpec = originalComSpec;
    }
  });
});

describe('Grok CLI timeout', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function hangingChild() {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter() as any;
    child.pid = 99;
    child.kill = vi.fn();
    child.stdin.end = vi.fn();
    return child;
  }

  async function loadGrokWithChild(child: any, execFileSyncImpl?: (...args: any[]) => unknown) {
    const spawnSpy = vi.fn(() => child);
    const execFileSync =
      execFileSyncImpl ??
      vi.fn().mockImplementation((cmd: string) => {
        if (cmd === 'taskkill') return '';
        return 'grok 1.0.5';
      });
    vi.doMock('../../src/core/logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn() },
    }));
    vi.doMock('child_process', () => ({
      execFileSync,
      execSync: vi.fn(),
      spawn: spawnSpy,
    }));
    const mod = await import('../../src/core/wiki/grok-client.js');
    return { ...mod, spawnSpy, execFileSync };
  }

  async function waitForSpawn(spawnSpy: ReturnType<typeof vi.fn>) {
    const deadline = Date.now() + 2000;
    while (spawnSpy.mock.calls.length === 0 && Date.now() < deadline) {
      await Promise.resolve();
      await new Promise((r) => setImmediate(r));
    }
    expect(spawnSpy).toHaveBeenCalled();
  }

  it('kills child process after requestTimeoutMs and rejects with timeout error', async () => {
    const child = hangingChild();
    const { callGrokLLM, spawnSpy, execFileSync } = await loadGrokWithChild(child);
    const promise = callGrokLLM('prompt', { requestTimeoutMs: 5000 });
    await waitForSpawn(spawnSpy);
    vi.advanceTimersByTime(5000);
    child.emit('close', null);
    await expect(promise).rejects.toThrow('grok CLI timed out after 5s');
    if (process.platform === 'win32') {
      const taskkillCalls = execFileSync.mock.calls.filter((c: unknown[]) => c[0] === 'taskkill');
      expect(taskkillCalls.length).toBeGreaterThan(0);
    } else {
      expect(child.kill).toHaveBeenCalled();
    }
  });

  it('uses taskkill /T /F /PID on Windows for process-tree kill', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const child = hangingChild();
      child.pid = 42;
      const execFileSync = vi.fn().mockImplementation((cmd: string) => {
        if (cmd === 'taskkill') return '';
        if (cmd === 'where.exe') return 'C:\\npm\\grok.cmd\n';
        return 'grok 1.0.5';
      });
      const { callGrokLLM, spawnSpy } = await loadGrokWithChild(child, execFileSync);
      const promise = callGrokLLM('prompt', { requestTimeoutMs: 3000 });
      await waitForSpawn(spawnSpy);
      vi.advanceTimersByTime(3000);
      child.emit('close', null);
      await expect(promise).rejects.toThrow('grok CLI timed out after 3s');
      const taskkillCalls = execFileSync.mock.calls.filter((c: unknown[]) => c[0] === 'taskkill');
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
      const child = hangingChild();
      child.pid = 42;
      const execFileSync = vi.fn().mockImplementation((cmd: string) => {
        if (cmd === 'taskkill') throw new Error('taskkill: process not found');
        if (cmd === 'where.exe') return 'C:\\npm\\grok.cmd\n';
        return 'grok 1.0.5';
      });
      const { callGrokLLM, spawnSpy } = await loadGrokWithChild(child, execFileSync);
      const promise = callGrokLLM('prompt', { requestTimeoutMs: 2000 });
      await waitForSpawn(spawnSpy);
      vi.advanceTimersByTime(2000);
      child.emit('close', null);
      await expect(promise).rejects.toThrow('grok CLI timed out after 2s');
      expect(child.kill).toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it('does not set a kill timer when requestTimeoutMs is undefined', async () => {
    const child = hangingChild();
    const { callGrokLLM, spawnSpy } = await loadGrokWithChild(child);
    const promise = callGrokLLM('prompt', {});
    await waitForSpawn(spawnSpy);
    child.stdout.emit('data', Buffer.from(JSON.stringify({ text: 'ok', stopReason: 'end_turn' })));
    child.emit('close', 0);
    await expect(promise).resolves.toEqual({ content: 'ok' });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('ignores grok stdin so an unused pipe cannot EPIPE', async () => {
    const child = hangingChild();
    const { callGrokLLM, spawnSpy } = await loadGrokWithChild(child);
    const promise = callGrokLLM('prompt', {});
    await waitForSpawn(spawnSpy);
    const spawnOpts = spawnSpy.mock.calls[0][2] as { stdio?: unknown };
    expect(spawnOpts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(child.stdin.end).not.toHaveBeenCalled();
    child.stdout.emit('data', Buffer.from(JSON.stringify({ text: 'ok', stopReason: 'end_turn' })));
    child.emit('close', 0);
    await expect(promise).resolves.toEqual({ content: 'ok' });
  });

  it('does not remove the temp dir until the child closes after timeout', async () => {
    const fs = await import('fs');
    const child = hangingChild();
    const { callGrokLLM, spawnSpy } = await loadGrokWithChild(child);
    const promise = callGrokLLM('prompt', { requestTimeoutMs: 5000 });
    await waitForSpawn(spawnSpy);
    const cwd = (spawnSpy.mock.calls[0][2] as { cwd: string }).cwd;
    expect(fs.existsSync(cwd)).toBe(true);
    let state: 'pending' | 'ok' | 'err' = 'pending';
    void promise.then(
      () => {
        state = 'ok';
      },
      () => {
        state = 'err';
      },
    );
    vi.advanceTimersByTime(5000);
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setImmediate(r));
    }
    expect(state).toBe('pending');
    expect(fs.existsSync(cwd)).toBe(true);
    child.emit('close', null);
    await expect(promise).rejects.toThrow('grok CLI timed out after 5s');
    expect(fs.existsSync(cwd)).toBe(false);
  });

  it('does not remove the temp dir when the hard deadline rejects without a close event', async () => {
    const fs = await import('fs');
    const child = hangingChild();
    const { callGrokLLM, spawnSpy } = await loadGrokWithChild(child);
    const promise = callGrokLLM('prompt', { requestTimeoutMs: 5000 });
    await waitForSpawn(spawnSpy);
    const cwd = (spawnSpy.mock.calls[0][2] as { cwd: string }).cwd;
    expect(fs.existsSync(cwd)).toBe(true);

    vi.advanceTimersByTime(5000 + 2000 + 2000);
    await expect(promise).rejects.toThrow('grok CLI timed out after 5s');
    expect(fs.existsSync(cwd)).toBe(true);
    child.emit('close', null);
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setImmediate(r));
    }
    expect(fs.existsSync(cwd)).toBe(false);
  });
});
