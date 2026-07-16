import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import {
  ANALYZE_EMBEDDING_INSTALL_TIMEOUT_MS,
  buildEmbeddingInstallCommand,
  composeWin32NpmCommand,
  getEmbeddingInstallTimeoutMs,
  getEmbeddingRuntimeDir,
  getEmbeddingStackSpecs,
  installEmbeddingRuntime,
  quoteWin32Arg,
  resolveEmbeddingRuntime,
} from '../../src/core/embeddings/runtime-install.js';

const require = createRequire(import.meta.url);

// The spawn flow is exercised through a controllable fake child; nothing real
// is spawned. Only `spawn` is overridden — `execFileSync` (the win32 taskkill
// path) keeps its real binding. No `node:module` mock and no resetModules here,
// so the static import of runtime-install is safe (see the dual-instance rule).
const spawnMock = vi.fn();
vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>();
  return { ...orig, spawn: (...args: unknown[]) => spawnMock(...args) };
});

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 4242;
  kill = vi.fn();
}

const ENV_KEYS = [
  'GITNEXUS_EMBEDDING_RUNTIME_DIR',
  'ONNXRUNTIME_NODE_INSTALL',
  'GITNEXUS_EMBEDDING_INSTALL_TIMEOUT_MS',
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('getEmbeddingRuntimeDir', () => {
  it('defaults to ~/.gitnexus/embedding-runtime and honours the env override', () => {
    expect(getEmbeddingRuntimeDir()).toBe(join(homedir(), '.gitnexus', 'embedding-runtime'));
    // resolve() so the expectation matches on Windows too (where an absolute
    // POSIX path picks up the cwd drive letter).
    process.env.GITNEXUS_EMBEDDING_RUNTIME_DIR = resolve('/custom/runtime');
    expect(getEmbeddingRuntimeDir()).toBe(resolve('/custom/runtime'));
  });

  it('resolves a relative override to an absolute path', () => {
    process.env.GITNEXUS_EMBEDDING_RUNTIME_DIR = 'rel/runtime';
    expect(getEmbeddingRuntimeDir()).toBe(resolve('rel/runtime'));
  });

  it('falls through to the default for an empty or whitespace override', () => {
    const fallback = join(homedir(), '.gitnexus', 'embedding-runtime');
    process.env.GITNEXUS_EMBEDDING_RUNTIME_DIR = '';
    expect(getEmbeddingRuntimeDir()).toBe(fallback);
    process.env.GITNEXUS_EMBEDDING_RUNTIME_DIR = '   ';
    expect(getEmbeddingRuntimeDir()).toBe(fallback);
  });
});

describe('getEmbeddingStackSpecs', () => {
  it('mirrors the optionalDependencies manifest exactly (drift guard, #2370)', () => {
    const manifest = require('../../package.json') as {
      optionalDependencies: Record<string, string>;
    };
    expect(getEmbeddingStackSpecs()).toEqual({
      '@huggingface/transformers': manifest.optionalDependencies['@huggingface/transformers'],
      'onnxruntime-node': manifest.optionalDependencies['onnxruntime-node'],
    });
    expect(manifest.optionalDependencies['@huggingface/transformers']).toBeDefined();
    expect(manifest.optionalDependencies['onnxruntime-node']).toBeDefined();
  });
});

describe('buildEmbeddingInstallCommand', () => {
  it('defaults to a registry-only install: --ignore-scripts and the CUDA-download skip env', () => {
    process.env.GITNEXUS_EMBEDDING_RUNTIME_DIR = resolve('/custom/runtime');
    const { args, env } = buildEmbeddingInstallCommand();
    expect(args.slice(0, 3)).toEqual(['install', '--prefix', resolve('/custom/runtime')]);
    expect(args).toContain('--ignore-scripts');
    const specs = getEmbeddingStackSpecs();
    expect(args).toContain(`@huggingface/transformers@${specs['@huggingface/transformers']}`);
    expect(args).toContain(`onnxruntime-node@${specs['onnxruntime-node']}`);
    expect(env.ONNXRUNTIME_NODE_INSTALL).toBe('skip');
  });

  it('with cuda: runs install scripts and leaves the CUDA download enabled', () => {
    const { args, env } = buildEmbeddingInstallCommand({ cuda: true });
    expect(args).not.toContain('--ignore-scripts');
    expect(env.ONNXRUNTIME_NODE_INSTALL).toBeUndefined();
  });

  it('with cuda: clears an inherited ONNXRUNTIME_NODE_INSTALL=skip', () => {
    process.env.ONNXRUNTIME_NODE_INSTALL = 'skip';
    const { env } = buildEmbeddingInstallCommand({ cuda: true });
    expect(env.ONNXRUNTIME_NODE_INSTALL).toBeUndefined();
  });

  it('without cuda: sets the skip env even when the ambient value differs', () => {
    process.env.ONNXRUNTIME_NODE_INSTALL = 'something-else';
    const { env } = buildEmbeddingInstallCommand();
    expect(env.ONNXRUNTIME_NODE_INSTALL).toBe('skip');
  });
});

describe('resolveEmbeddingRuntime', () => {
  it('finds the normally-installed stack (package source wins over the prefix)', () => {
    process.env.GITNEXUS_EMBEDDING_RUNTIME_DIR = '/nonexistent/for/this/test';
    expect(resolveEmbeddingRuntime()).toEqual({ source: 'package' });
  });
});

describe('getEmbeddingInstallTimeoutMs', () => {
  it('returns the caller default when the env override is unset', () => {
    expect(getEmbeddingInstallTimeoutMs(ANALYZE_EMBEDDING_INSTALL_TIMEOUT_MS)).toBe(
      ANALYZE_EMBEDDING_INSTALL_TIMEOUT_MS,
    );
  });

  it('lets the env override win over the caller default (user can raise a short deadline)', () => {
    process.env.GITNEXUS_EMBEDDING_INSTALL_TIMEOUT_MS = '900000';
    expect(getEmbeddingInstallTimeoutMs(ANALYZE_EMBEDDING_INSTALL_TIMEOUT_MS)).toBe(900000);
  });

  it('ignores a non-positive env override and uses the caller default', () => {
    process.env.GITNEXUS_EMBEDDING_INSTALL_TIMEOUT_MS = '-5';
    expect(getEmbeddingInstallTimeoutMs(ANALYZE_EMBEDDING_INSTALL_TIMEOUT_MS)).toBe(
      ANALYZE_EMBEDDING_INSTALL_TIMEOUT_MS,
    );
  });
});

describe('quoteWin32Arg', () => {
  it('quotes a spaced path as a single token', () => {
    expect(quoteWin32Arg('C:\\Users\\John Doe\\.gitnexus\\rt')).toBe(
      '"C:\\Users\\John Doe\\.gitnexus\\rt"',
    );
  });

  it('quotes a caret semver spec so cmd.exe cannot eat the ^', () => {
    expect(quoteWin32Arg('@huggingface/transformers@^4.1.0')).toBe(
      '"@huggingface/transformers@^4.1.0"',
    );
  });

  it('doubles the trailing backslash run so the closing quote is not escaped', () => {
    // A spaced path (needs quoting) ending in a backslash: the added closing
    // quote must not be escaped by that trailing backslash.
    expect(quoteWin32Arg('C:\\Users\\John Doe\\')).toBe('"C:\\Users\\John Doe\\\\"');
  });

  it('quotes the empty string', () => {
    expect(quoteWin32Arg('')).toBe('""');
  });

  it('leaves plain args untouched', () => {
    expect(quoteWin32Arg('install')).toBe('install');
    expect(quoteWin32Arg('--no-fund')).toBe('--no-fund');
  });

  it('throws on an embedded double quote', () => {
    expect(() => quoteWin32Arg('a"b')).toThrow(/double quote/);
  });

  it('throws on NUL/CR/LF', () => {
    expect(() => quoteWin32Arg('a\nb')).toThrow(/NUL\/CR\/LF/);
    expect(() => quoteWin32Arg('a\rb')).toThrow(/NUL\/CR\/LF/);
    expect(() => quoteWin32Arg('a\0b')).toThrow(/NUL\/CR\/LF/);
  });

  it('composeWin32NpmCommand leaves npm unquoted and quotes the args', () => {
    const line = composeWin32NpmCommand(['install', '--prefix', 'C:\\a b\\rt']);
    expect(line).toBe('npm install --prefix "C:\\a b\\rt"');
  });
});

describe('installEmbeddingRuntime — spawn lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    spawnMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects with a timeout message and SIGKILLs the child when npm never exits', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const p = installEmbeddingRuntime({}, 1000);
    const assertion = expect(p).rejects.toThrow(
      /timed out after 1000ms.*GITNEXUS_EMBEDDING_INSTALL_TIMEOUT_MS/s,
    );
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('honours GITNEXUS_EMBEDDING_INSTALL_TIMEOUT_MS for the default timeout', async () => {
    process.env.GITNEXUS_EMBEDDING_INSTALL_TIMEOUT_MS = '1234';
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const p = installEmbeddingRuntime();
    const assertion = expect(p).rejects.toThrow(/timed out after 1234ms/);
    await vi.advanceTimersByTimeAsync(1234);
    await assertion;
  });

  it('lets an explicit timeoutMs override the env default', async () => {
    process.env.GITNEXUS_EMBEDDING_INSTALL_TIMEOUT_MS = '999999';
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const p = installEmbeddingRuntime({}, 500);
    const assertion = expect(p).rejects.toThrow(/timed out after 500ms/);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });

  it('names the signal instead of "exit null" when the child is killed', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const p = installEmbeddingRuntime({}, 10_000);
    const assertion = expect(p).rejects.toThrow(/killed with SIGKILL/);
    child.emit('close', null, 'SIGKILL');
    await assertion;
  });

  it('resolves on exit 0 and removes the parent-exit listener', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const before = process.listenerCount('exit');
    const p = installEmbeddingRuntime({}, 10_000);
    child.emit('close', 0, null);
    await expect(p).resolves.toBeUndefined();
    expect(process.listenerCount('exit')).toBe(before);
  });

  it('rejects once on child error; a later close does not double-settle', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const p = installEmbeddingRuntime({}, 10_000);
    const assertion = expect(p).rejects.toThrow('spawn npm ENOENT');
    child.emit('error', new Error('spawn npm ENOENT'));
    await assertion;
    expect(() => child.emit('close', 1, null)).not.toThrow();
  });

  it('on win32 spawns a single composed command string, no args array (DEP0190-free)', async () => {
    const realPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      // A spaced prefix must flow through compose+quote into ONE string arg. Use
      // resolve() so the path is absolute on the real host too (a bare POSIX path
      // picks up the cwd drive on Windows); the space survives either way.
      process.env.GITNEXUS_EMBEDDING_RUNTIME_DIR = resolve('/opt/John Doe/rt');
      const child = new FakeChild();
      spawnMock.mockReturnValue(child);
      const p = installEmbeddingRuntime({}, 10_000);
      child.emit('close', 0, null);
      await p;
      const call = spawnMock.mock.calls[0] as [unknown, unknown];
      // Byte-identical to the pure compose of the same args, and the spaced
      // prefix appears quoted — host-independent (both sides use the real fns).
      expect(call[0]).toBe(composeWin32NpmCommand(buildEmbeddingInstallCommand().args));
      expect(call[0]).toContain(quoteWin32Arg(getEmbeddingRuntimeDir()));
      expect(call[1]).toMatchObject({ shell: true });
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    }
  });

  it('on posix spawns the array form with no shell', async () => {
    const realPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      const child = new FakeChild();
      spawnMock.mockReturnValue(child);
      const p = installEmbeddingRuntime({}, 10_000);
      child.emit('close', 0, null);
      await p;
      const call = spawnMock.mock.calls[0] as [unknown, unknown, unknown];
      expect(call[0]).toBe('npm');
      expect(Array.isArray(call[1])).toBe(true);
      expect(call[2]).not.toMatchObject({ shell: true });
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    }
  });

  it('spawns with cwd set to homedir(), independent of process.cwd()', async () => {
    const realPlatform = process.platform;
    // Force the posix branch so the options object is at a stable arg position.
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      const child = new FakeChild();
      spawnMock.mockReturnValue(child);
      const p = installEmbeddingRuntime({}, 10_000);
      child.emit('close', 0, null);
      await p;
      const call = spawnMock.mock.calls[0] as [unknown, unknown, unknown];
      expect(call[2]).toMatchObject({ cwd: homedir() });
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    }
  });
});
