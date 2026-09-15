import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import type {
  SidecarRequest,
  SidecarResponse,
} from '../../src/core/embeddings/embedding-sidecar-protocol.js';

const embeddingsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/core/embeddings',
);

class FakeChild extends EventEmitter {
  killed = false;
  connected = true;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  send = vi.fn((msg: SidecarRequest) => {
    queueMicrotask(() => {
      const response = this.respond(msg);
      if (response) this.emit('message', response);
    });
    return true;
  });
  kill = vi.fn((signal?: NodeJS.Signals) => {
    this.killed = true;
    this.emit('close', signal === 'SIGKILL' ? null : 0, signal ?? null);
    return true;
  });
  unref = vi.fn();

  respond(msg: SidecarRequest): SidecarResponse | undefined {
    if (msg.type === 'init') {
      return { id: msg.id, type: 'ready', device: 'cpu' };
    }
    if (msg.type === 'embed') {
      return {
        id: msg.id,
        type: 'vectors',
        vectors: msg.texts.map(() => [0.25, 0.5, 0.75]),
      };
    }
    return undefined;
  }
}

describe('embedding sidecar client', () => {
  const originalUrl = process.env.GITNEXUS_EMBEDDING_URL;
  const originalModel = process.env.GITNEXUS_EMBEDDING_MODEL;
  const originalHfTimeout = process.env.HF_DOWNLOAD_TIMEOUT_MS;
  const originalHfAttempts = process.env.HF_MAX_ATTEMPTS;
  const originalSidecarTimeout = process.env.GITNEXUS_EMBEDDING_SIDECAR_TIMEOUT_MS;
  const hostPlatform = process.platform;
  const hostArch = process.arch;

  let forkMock: ReturnType<typeof vi.fn>;
  let children: FakeChild[];

  beforeEach(async () => {
    delete process.env.GITNEXUS_EMBEDDING_URL;
    // Local-success cases must not inherit a darwin/x64 host blocker.
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true });
    children = [];
    forkMock = vi.fn((_script: string, _args: string[], _opts: unknown) => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    });
    const client = await import('../../src/core/embeddings/embedding-sidecar-client.js');
    client._resetEmbeddingSidecarForTests();
    client._setForkForTests(forkMock);
  });

  afterEach(async () => {
    const client = await import('../../src/core/embeddings/embedding-sidecar-client.js');
    client._resetEmbeddingSidecarForTests();
    client._setForkForTests(null);
    if (originalUrl === undefined) delete process.env.GITNEXUS_EMBEDDING_URL;
    else process.env.GITNEXUS_EMBEDDING_URL = originalUrl;
    if (originalModel === undefined) delete process.env.GITNEXUS_EMBEDDING_MODEL;
    else process.env.GITNEXUS_EMBEDDING_MODEL = originalModel;
    if (originalHfTimeout === undefined) delete process.env.HF_DOWNLOAD_TIMEOUT_MS;
    else process.env.HF_DOWNLOAD_TIMEOUT_MS = originalHfTimeout;
    if (originalHfAttempts === undefined) delete process.env.HF_MAX_ATTEMPTS;
    else process.env.HF_MAX_ATTEMPTS = originalHfAttempts;
    if (originalSidecarTimeout === undefined)
      delete process.env.GITNEXUS_EMBEDDING_SIDECAR_TIMEOUT_MS;
    else process.env.GITNEXUS_EMBEDDING_SIDECAR_TIMEOUT_MS = originalSidecarTimeout;
    Object.defineProperty(process, 'platform', { value: hostPlatform, configurable: true });
    Object.defineProperty(process, 'arch', { value: hostArch, configurable: true });
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('strips GITNEXUS_EMBEDDING_URL and does not inherit stdout', async () => {
    process.env.GITNEXUS_EMBEDDING_URL = 'http://custom.example/v1';
    const { ensureEmbeddingSidecar } =
      await import('../../src/core/embeddings/embedding-sidecar-client.js');
    await ensureEmbeddingSidecar();

    expect(forkMock).toHaveBeenCalledTimes(1);
    const opts = forkMock.mock.calls[0][2] as {
      env: NodeJS.ProcessEnv;
      stdio: unknown;
    };
    expect(opts.env.GITNEXUS_EMBEDDING_URL).toBeUndefined();
    expect(opts.stdio).toEqual(['ignore', 'ignore', 'pipe', 'ipc']);
  });

  it('reports no sidecar device until init is ready', async () => {
    const { getSidecarDevice, ensureEmbeddingSidecar } =
      await import('../../src/core/embeddings/embedding-sidecar-client.js');
    expect(getSidecarDevice()).toBeNull();
    await ensureEmbeddingSidecar();
    expect(getSidecarDevice()).toBe('cpu');
  });

  it('rejects a forceDevice that conflicts with the initialized sidecar', async () => {
    const { ensureEmbeddingSidecar } =
      await import('../../src/core/embeddings/embedding-sidecar-client.js');
    await expect(ensureEmbeddingSidecar()).resolves.toEqual({ device: 'cpu' });
    await expect(ensureEmbeddingSidecar({ forceDevice: 'cuda' })).rejects.toThrow(
      /already initialized on cpu; cannot switch to cuda/,
    );
    await expect(ensureEmbeddingSidecar({ forceDevice: 'cpu' })).resolves.toEqual({
      device: 'cpu',
    });
  });

  it('forks once for two batches', async () => {
    const { sidecarEmbedBatch } =
      await import('../../src/core/embeddings/embedding-sidecar-client.js');
    const first = await sidecarEmbedBatch(['a']);
    const second = await sidecarEmbedBatch(['b']);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(forkMock).toHaveBeenCalledTimes(1);
  });

  it('does not fork on darwin/x64', async () => {
    const orig = { platform: process.platform, arch: process.arch };
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true });
    try {
      const { ensureEmbeddingSidecar } =
        await import('../../src/core/embeddings/embedding-sidecar-client.js');
      await expect(ensureEmbeddingSidecar()).rejects.toThrow(/macOS Intel/);
      expect(forkMock).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', { value: orig.platform, configurable: true });
      Object.defineProperty(process, 'arch', { value: orig.arch, configurable: true });
    }
  });

  it('does not fork on an empty batch', async () => {
    const { sidecarEmbedBatch } =
      await import('../../src/core/embeddings/embedding-sidecar-client.js');
    await expect(sidecarEmbedBatch([])).resolves.toEqual([]);
    expect(forkMock).not.toHaveBeenCalled();
  });

  it('does not fork in HTTP mode', async () => {
    process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
    process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
    const mockVec = Array.from({ length: 384 }, (_, i) => i / 384);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        const n = (JSON.parse(init.body) as { input: string[] }).input.length;
        return {
          ok: true,
          json: async () => ({ data: Array.from({ length: n }, () => ({ embedding: mockVec })) }),
        };
      }),
    );
    const { embedBatch, isEmbedderReady } = await import('../../src/core/embeddings/embedder.js');
    expect(isEmbedderReady()).toBe(true);
    const batch = await embedBatch(['hello']);
    expect(batch).toHaveLength(1);
    expect(forkMock).not.toHaveBeenCalled();
  });

  it('marks local embeddings unavailable on native abort and does not respawn', async () => {
    const { sidecarEmbedBatch } =
      await import('../../src/core/embeddings/embedding-sidecar-client.js');
    await sidecarEmbedBatch(['first']);
    expect(forkMock).toHaveBeenCalledTimes(1);

    children[0].emit('close', null, 'SIGSEGV');

    await expect(sidecarEmbedBatch(['second'])).rejects.toThrow(
      /unavailable after the sidecar aborted/,
    );
    expect(forkMock).toHaveBeenCalledTimes(1);
  });

  it('does not respawn after init-time SIGSEGV', async () => {
    forkMock.mockImplementation(() => {
      const child = new FakeChild();
      children.push(child);
      child.send = vi.fn(() => {
        queueMicrotask(() => child.emit('close', null, 'SIGSEGV'));
        return true;
      });
      return child as unknown as ChildProcess;
    });
    const { ensureEmbeddingSidecar } =
      await import('../../src/core/embeddings/embedding-sidecar-client.js');
    await expect(ensureEmbeddingSidecar()).rejects.toThrow(/Embedding sidecar died/);
    expect(forkMock).toHaveBeenCalledTimes(1);
    await expect(ensureEmbeddingSidecar()).rejects.toThrow(/unavailable after the sidecar aborted/);
    expect(forkMock).toHaveBeenCalledTimes(1);
  });

  it('SIGKILLs a stalled embed request and rejects with a timeout', async () => {
    process.env.GITNEXUS_EMBEDDING_SIDECAR_TIMEOUT_MS = '50';
    vi.useFakeTimers();
    const { sidecarEmbedBatch } =
      await import('../../src/core/embeddings/embedding-sidecar-client.js');
    await sidecarEmbedBatch(['warmup']);
    children[0].send = vi.fn(() => true);
    const pending = sidecarEmbedBatch(['stalled']);
    const assertion = expect(pending).rejects.toThrow(/timed out after 50ms \(embed\)/);
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('embedBatch throws after sidecar return when the signal aborted mid-flight', async () => {
    const { embedBatch } = await import('../../src/core/embeddings/embedder.js');
    const controller = new AbortController();
    children.length = 0;
    const pending = embedBatch(['x'], { signal: controller.signal });
    await vi.waitFor(() => expect(forkMock).toHaveBeenCalled());
    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  it('does not use worker_threads or import the embeddings barrel', () => {
    const clientSrc = readFileSync(path.join(embeddingsDir, 'embedding-sidecar-client.ts'), 'utf8');
    const façadeSrc = readFileSync(path.join(embeddingsDir, 'embedder.ts'), 'utf8');
    const importLines = clientSrc
      .split('\n')
      .filter(
        (line) =>
          /^\s*import\b/.test(line) || /^\s*\} from /.test(line) || /import\s*\(/.test(line),
      )
      .join('\n');
    expect(clientSrc).not.toMatch(/worker_threads/);
    expect(clientSrc).not.toMatch(/new Worker\b/);
    expect(importLines).not.toContain('embedding-pipeline');
    expect(importLines).not.toContain('embedding-identity');
    expect(importLines).not.toContain('./index.js');
    expect(façadeSrc).not.toMatch(/from\s+['"]@huggingface\/transformers['"]/);
    expect(façadeSrc).not.toMatch(/import\s*\(\s*['"]@huggingface\/transformers['"]/);
    expect(façadeSrc).not.toMatch(/from\s+['"]onnxruntime-node['"]/);
    expect(façadeSrc).not.toMatch(/import\s*\(\s*['"]onnxruntime-node['"]/);
    expect(façadeSrc).not.toMatch(/from\s+['"].*onnxruntime-common-resolver['"]/);
    expect(façadeSrc).not.toMatch(/import\s*\(\s*['"].*onnxruntime-common-resolver['"]/);
    expect(façadeSrc).not.toMatch(/from\s+['"].*embedding-local-init['"]/);
    expect(façadeSrc).not.toMatch(/import\s*\(\s*['"].*embedding-local-init['"]/);
  });

  it('sizes the init deadline from the HF download budget, not a 15s process lifetime', async () => {
    const { SIDECAR_INIT_IPC_SLACK_MS, sidecarInitTimeoutMs } =
      await import('../../src/core/embeddings/embedding-sidecar-client.js');
    delete process.env.HF_DOWNLOAD_TIMEOUT_MS;
    delete process.env.HF_MAX_ATTEMPTS;
    // 3 attempts × 5 min plus 2s + 4s exponential backoff, plus IPC slack.
    expect(sidecarInitTimeoutMs()).toBe(
      5 * 60 * 1_000 * 3 + 2_000 + 4_000 + SIDECAR_INIT_IPC_SLACK_MS,
    );
    expect(sidecarInitTimeoutMs()).toBeGreaterThan(15_000);

    process.env.HF_DOWNLOAD_TIMEOUT_MS = '120000';
    process.env.HF_MAX_ATTEMPTS = '2';
    expect(sidecarInitTimeoutMs()).toBe(240_000 + 2_000 + SIDECAR_INIT_IPC_SLACK_MS);

    process.env.HF_DOWNLOAD_TIMEOUT_MS = String(60 * 60 * 1_000);
    process.env.HF_MAX_ATTEMPTS = '1';
    expect(sidecarInitTimeoutMs()).toBe(30 * 60 * 1_000 + SIDECAR_INIT_IPC_SLACK_MS);
  });

  it('clears the reap wait timeout once the child closes', async () => {
    vi.useFakeTimers();
    const { ensureEmbeddingSidecar, reapEmbeddingSidecarAndWait } =
      await import('../../src/core/embeddings/embedding-sidecar-client.js');
    await ensureEmbeddingSidecar();
    await reapEmbeddingSidecarAndWait(5_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not let a reaped child reset its replacement', async () => {
    const { ensureEmbeddingSidecar, reapEmbeddingSidecar, sidecarEmbedBatch } =
      await import('../../src/core/embeddings/embedding-sidecar-client.js');
    await ensureEmbeddingSidecar();
    const first = children[0];
    reapEmbeddingSidecar();
    await ensureEmbeddingSidecar();
    expect(forkMock).toHaveBeenCalledTimes(2);
    first.emit('error', new Error('late error from reaped child'));
    first.emit('close', 1, null);
    await expect(sidecarEmbedBatch(['still-alive'])).resolves.toHaveLength(1);
    expect(forkMock).toHaveBeenCalledTimes(2);
  });
});
