import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {
  buildEmbeddingInstallCommand,
  getEmbeddingRuntimeDir,
  getEmbeddingStackSpecs,
  installEmbeddingRuntime,
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
    process.env.GITNEXUS_EMBEDDING_RUNTIME_DIR = '/custom/runtime';
    expect(getEmbeddingRuntimeDir()).toBe('/custom/runtime');
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
    process.env.GITNEXUS_EMBEDDING_RUNTIME_DIR = '/custom/runtime';
    const { args, env } = buildEmbeddingInstallCommand();
    expect(args.slice(0, 3)).toEqual(['install', '--prefix', '/custom/runtime']);
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
});

describe('resolveEmbeddingRuntime', () => {
  it('finds the normally-installed stack (package source wins over the prefix)', () => {
    process.env.GITNEXUS_EMBEDDING_RUNTIME_DIR = '/nonexistent/for/this/test';
    expect(resolveEmbeddingRuntime()).toEqual({ source: 'package' });
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
});
