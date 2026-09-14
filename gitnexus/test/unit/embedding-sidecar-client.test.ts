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
    if (msg.type === 'dispose') {
      return { id: msg.id, type: 'disposed' };
    }
    return undefined;
  }
}

describe('embedding sidecar client', () => {
  const originalUrl = process.env.GITNEXUS_EMBEDDING_URL;
  const originalHfTimeout = process.env.HF_DOWNLOAD_TIMEOUT_MS;
  const originalHfAttempts = process.env.HF_MAX_ATTEMPTS;

  let forkMock: ReturnType<typeof vi.fn>;
  let children: FakeChild[];

  beforeEach(async () => {
    delete process.env.GITNEXUS_EMBEDDING_URL;
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
    if (originalHfTimeout === undefined) delete process.env.HF_DOWNLOAD_TIMEOUT_MS;
    else process.env.HF_DOWNLOAD_TIMEOUT_MS = originalHfTimeout;
    if (originalHfAttempts === undefined) delete process.env.HF_MAX_ATTEMPTS;
    else process.env.HF_MAX_ATTEMPTS = originalHfAttempts;
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
    expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe', 'ipc']);
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
    vi.unstubAllGlobals();
    delete process.env.GITNEXUS_EMBEDDING_MODEL;
  });

  it('treats signal death as sidecar-dead and recreates once', async () => {
    const { sidecarEmbedBatch } =
      await import('../../src/core/embeddings/embedding-sidecar-client.js');
    await sidecarEmbedBatch(['first']);
    expect(forkMock).toHaveBeenCalledTimes(1);

    children[0].emit('close', null, 'SIGSEGV');

    await sidecarEmbedBatch(['second']);
    expect(forkMock).toHaveBeenCalledTimes(2);

    children[1].emit('close', null, 'SIGABRT');
    await expect(sidecarEmbedBatch(['third'])).rejects.toThrow(
      /unavailable after the sidecar aborted/,
    );
    expect(forkMock).toHaveBeenCalledTimes(2);
  });

  it('does not use worker_threads or import the embeddings barrel', () => {
    const clientSrc = readFileSync(path.join(embeddingsDir, 'embedding-sidecar-client.ts'), 'utf8');
    const façadeSrc = readFileSync(path.join(embeddingsDir, 'embedder.ts'), 'utf8');
    const importLines = clientSrc
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line) || /^\s*\} from /.test(line))
      .join('\n');
    expect(clientSrc).not.toMatch(/worker_threads/);
    expect(clientSrc).not.toMatch(/new Worker\b/);
    expect(importLines).not.toContain('embedding-pipeline');
    expect(importLines).not.toContain('embedding-identity');
    expect(importLines).not.toContain('./index.js');
    const façadeImports = façadeSrc
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line) || /^\s*\} from /.test(line))
      .join('\n');
    expect(façadeImports).not.toContain('@huggingface/transformers');
    expect(façadeImports).not.toContain('onnxruntime-node');
    expect(façadeImports).not.toContain('onnxruntime-common-resolver');
    expect(façadeImports).not.toContain('embedding-local-init');
  });

  it('sizes the init deadline from the HF download budget, not a 15s process lifetime', async () => {
    const { sidecarInitTimeoutMs } =
      await import('../../src/core/embeddings/embedding-sidecar-client.js');
    delete process.env.HF_DOWNLOAD_TIMEOUT_MS;
    delete process.env.HF_MAX_ATTEMPTS;
    expect(sidecarInitTimeoutMs()).toBe(5 * 60 * 1_000 * 3);
    expect(sidecarInitTimeoutMs()).toBeGreaterThan(15_000);

    process.env.HF_DOWNLOAD_TIMEOUT_MS = '120000';
    process.env.HF_MAX_ATTEMPTS = '2';
    expect(sidecarInitTimeoutMs()).toBe(240_000);
  });
});
