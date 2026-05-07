import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import { join } from 'node:path';
import {
  applyHfEnvOverrides,
  isNetworkFetchError,
  isHfDownloadFailure,
  isHfCircuitOpenError,
  HfDownloadCircuitBreaker,
  withDownloadTimeout,
  withHfDownloadRetry,
  CIRCUIT_OPEN_TAG,
  type HfEnvSubset,
} from '../../src/core/embeddings/hf-env.js';

describe('applyHfEnvOverrides', () => {
  let envStub: HfEnvSubset;
  // Snapshot the two env vars so tests don't leak state into each other (or
  // into the rest of the test run). `delete` + restore is the simplest pattern
  // — vitest doesn't reset `process.env` between tests by default.
  let originalHfHome: string | undefined;
  let originalHfEndpoint: string | undefined;

  beforeEach(() => {
    envStub = { cacheDir: '', remoteHost: '' };
    originalHfHome = process.env.HF_HOME;
    originalHfEndpoint = process.env.HF_ENDPOINT;
    delete process.env.HF_HOME;
    delete process.env.HF_ENDPOINT;
  });

  afterEach(() => {
    if (originalHfHome === undefined) delete process.env.HF_HOME;
    else process.env.HF_HOME = originalHfHome;
    if (originalHfEndpoint === undefined) delete process.env.HF_ENDPOINT;
    else process.env.HF_ENDPOINT = originalHfEndpoint;
  });

  it('cacheDir defaults to ~/.cache/huggingface when HF_HOME is unset', () => {
    applyHfEnvOverrides(envStub);
    expect(envStub.cacheDir).toBe(join(os.homedir(), '.cache', 'huggingface'));
  });

  it('cacheDir respects HF_HOME when set', () => {
    process.env.HF_HOME = '/custom/hf/cache';
    applyHfEnvOverrides(envStub);
    expect(envStub.cacheDir).toBe('/custom/hf/cache');
  });

  it('remoteHost is set when HF_ENDPOINT is set, with a trailing slash appended', () => {
    process.env.HF_ENDPOINT = 'https://hf-mirror.com';
    applyHfEnvOverrides(envStub);
    expect(envStub.remoteHost).toBe('https://hf-mirror.com/');
  });

  it('remoteHost preserves existing trailing slash on HF_ENDPOINT', () => {
    process.env.HF_ENDPOINT = 'https://hf-mirror.com/';
    applyHfEnvOverrides(envStub);
    expect(envStub.remoteHost).toBe('https://hf-mirror.com/');
  });

  it('remoteHost is left untouched when HF_ENDPOINT is unset', () => {
    // Pre-populate to a sentinel so we can prove the function does NOT
    // overwrite remoteHost when no env var is set. Without this guard a
    // future refactor that always assigns `env.remoteHost = ...` would
    // silently break consumers that have already configured it elsewhere.
    envStub.remoteHost = 'pre-existing-do-not-touch';
    applyHfEnvOverrides(envStub);
    expect(envStub.remoteHost).toBe('pre-existing-do-not-touch');
  });

  it('remoteHost is left untouched when HF_ENDPOINT is whitespace-only', () => {
    // Common copy-paste failure mode for users on restricted networks who
    // pull `HF_ENDPOINT` values from shell scripts or docs with stray
    // whitespace. The `.trim()` + truthiness guard ensures this is treated
    // as "unset" rather than as an invalid host like `'   /'` that would
    // silently misroute model downloads. Pinned by the @claude review on
    // PR #1252.
    process.env.HF_ENDPOINT = '   ';
    envStub.remoteHost = 'sentinel';
    applyHfEnvOverrides(envStub);
    expect(envStub.remoteHost).toBe('sentinel');
  });

  it('remoteHost trims surrounding whitespace from HF_ENDPOINT', () => {
    // Compatible mirror of the previous test for the case where the env
    // var is non-empty AFTER trimming. Without `.trim()`, the bogus
    // leading/trailing space would survive into the URL and break
    // downloads.
    process.env.HF_ENDPOINT = '  https://hf-mirror.com  ';
    applyHfEnvOverrides(envStub);
    expect(envStub.remoteHost).toBe('https://hf-mirror.com/');
  });
});

describe('isNetworkFetchError', () => {
  it('returns true for "fetch failed" (the undici error seen on macOS/Node 24)', () => {
    expect(isNetworkFetchError('fetch failed')).toBe(true);
  });

  it('returns true for ECONNREFUSED', () => {
    expect(isNetworkFetchError('connect ECONNREFUSED 13.45.67.89:443')).toBe(true);
  });

  it('returns true for ENOTFOUND (DNS failure)', () => {
    expect(isNetworkFetchError('getaddrinfo ENOTFOUND huggingface.co')).toBe(true);
  });

  it('returns true for ETIMEDOUT', () => {
    expect(isNetworkFetchError('connect ETIMEDOUT 13.45.67.89:443')).toBe(true);
  });

  it('returns true for ECONNRESET', () => {
    expect(isNetworkFetchError('read ECONNRESET')).toBe(true);
  });

  it('returns false for generic model-load errors (ONNX device failure)', () => {
    expect(isNetworkFetchError('Failed to initialize CUDA backend')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isNetworkFetchError('')).toBe(false);
  });

  it('returns false for module-not-found errors', () => {
    expect(isNetworkFetchError('Cannot find module onnxruntime-node')).toBe(false);
  });
});

describe('isHfCircuitOpenError', () => {
  it('returns true for a circuit-open tag message', () => {
    expect(isHfCircuitOpenError(`${CIRCUIT_OPEN_TAG}: circuit is open`)).toBe(true);
  });

  it('returns false for a plain network error', () => {
    expect(isHfCircuitOpenError('fetch failed')).toBe(false);
  });
});

describe('isHfDownloadFailure', () => {
  it('returns true for network fetch errors', () => {
    expect(isHfDownloadFailure('ECONNREFUSED 127.0.0.1:443')).toBe(true);
  });

  it('returns true for circuit-open errors', () => {
    expect(isHfDownloadFailure(`${CIRCUIT_OPEN_TAG}: open`)).toBe(true);
  });

  it('returns false for ONNX device errors', () => {
    expect(isHfDownloadFailure('Failed to initialize CUDA')).toBe(false);
  });
});

describe('HfDownloadCircuitBreaker', () => {
  it('starts in closed state', () => {
    const cb = new HfDownloadCircuitBreaker();
    expect(cb.isOpen()).toBe(false);
    expect(cb.state).toBe('closed');
  });

  it('opens after reaching the failure threshold', () => {
    const cb = new HfDownloadCircuitBreaker(3);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen()).toBe(false);
    cb.recordFailure(); // threshold reached
    expect(cb.isOpen()).toBe(true);
    expect(cb.state).toBe('open');
  });

  it('closes on recordSuccess after being open', () => {
    const cb = new HfDownloadCircuitBreaker(1);
    cb.recordFailure();
    expect(cb.isOpen()).toBe(true);
    cb.recordSuccess();
    expect(cb.isOpen()).toBe(false);
    expect(cb.state).toBe('closed');
  });

  it('transitions to half-open after the reset timeout', () => {
    vi.useFakeTimers();
    try {
      const cb = new HfDownloadCircuitBreaker(1, 100 /* 100ms */);
      cb.recordFailure();
      expect(cb.isOpen()).toBe(true);
      vi.advanceTimersByTime(200);
      expect(cb.isOpen()).toBe(false);
      expect(cb.state).toBe('half-open');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reset() restores closed state', () => {
    const cb = new HfDownloadCircuitBreaker(1);
    cb.recordFailure();
    expect(cb.isOpen()).toBe(true);
    cb.reset();
    expect(cb.isOpen()).toBe(false);
    expect(cb.state).toBe('closed');
  });
});

describe('withDownloadTimeout', () => {
  it('resolves when fn completes before the timeout', async () => {
    const result = await withDownloadTimeout(() => Promise.resolve(42), 1_000);
    expect(result).toBe(42);
  });

  it('rejects with ETIMEDOUT when fn takes too long', async () => {
    const neverResolves = () => new Promise<never>(() => {});
    await expect(withDownloadTimeout(neverResolves, 20)).rejects.toThrow('ETIMEDOUT');
  });

  it('propagates non-timeout errors from fn', async () => {
    await expect(
      withDownloadTimeout(() => Promise.reject(new Error('download error')), 1_000),
    ).rejects.toThrow('download error');
  });
});

describe('withHfDownloadRetry', () => {
  it('returns the result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const cb = new HfDownloadCircuitBreaker();
    const result = await withHfDownloadRetry(fn, { circuit: cb, baseDelayMs: 0 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on network errors and succeeds on second attempt', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('fetch failed')).mockResolvedValue('ok');
    const cb = new HfDownloadCircuitBreaker();
    const result = await withHfDownloadRetry(fn, {
      circuit: cb,
      maxAttempts: 3,
      baseDelayMs: 0,
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws the last network error after all attempts are exhausted', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:443'));
    const cb = new HfDownloadCircuitBreaker(99 /* high threshold */);
    await expect(
      withHfDownloadRetry(fn, { circuit: cb, maxAttempts: 3, baseDelayMs: 0 }),
    ).rejects.toThrow('ECONNREFUSED');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry non-network errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Failed to initialize CUDA backend'));
    const cb = new HfDownloadCircuitBreaker();
    await expect(
      withHfDownloadRetry(fn, { circuit: cb, maxAttempts: 3, baseDelayMs: 0 }),
    ).rejects.toThrow('Failed to initialize CUDA backend');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('fails immediately when the circuit is already open', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const cb = new HfDownloadCircuitBreaker(1);
    cb.recordFailure(); // open the circuit
    await expect(withHfDownloadRetry(fn, { circuit: cb })).rejects.toThrow(CIRCUIT_OPEN_TAG);
    expect(fn).not.toHaveBeenCalled();
  });

  it('opens the circuit after failureThreshold failures and throws a circuit-open error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('ENOTFOUND huggingface.co'));
    const cb = new HfDownloadCircuitBreaker(2 /* threshold */, 60_000);
    // First call: 2 attempts, threshold=2 → circuit opens on 2nd failure
    await expect(
      withHfDownloadRetry(fn, { circuit: cb, maxAttempts: 2, baseDelayMs: 0 }),
    ).rejects.toThrow(CIRCUIT_OPEN_TAG);
    expect(cb.isOpen()).toBe(true);
  });

  it('calls onRetry with correct arguments on each retry', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValue('ok');
    const cb = new HfDownloadCircuitBreaker(99);
    const onRetry = vi.fn();
    await withHfDownloadRetry(fn, { circuit: cb, maxAttempts: 3, baseDelayMs: 0, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(
      1,
      1,
      3,
      expect.objectContaining({ message: 'fetch failed' }),
    );
    expect(onRetry).toHaveBeenNthCalledWith(
      2,
      2,
      3,
      expect.objectContaining({ message: 'fetch failed' }),
    );
  });

  it('resets the circuit on success', async () => {
    const fn = vi.fn().mockResolvedValue('value');
    const cb = new HfDownloadCircuitBreaker(5);
    cb.recordFailure();
    cb.recordFailure(); // 2 failures, circuit still closed
    await withHfDownloadRetry(fn, { circuit: cb, baseDelayMs: 0 });
    expect(cb.state).toBe('closed');
  });
});
