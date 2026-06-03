import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getLocalEmbeddingRuntimeBlocker,
  isLocalEmbeddingRuntimeBlockerMessage,
} from '../../src/core/embeddings/runtime-support.js';

/**
 * Spy that fires whenever @huggingface/transformers is actually imported.
 * Hoisted so the vi.mock factory below can reference it. The mock replaces the
 * real module entirely, so this suite never loads onnxruntime-node — it is safe
 * to run on any platform, including hosts without the native binding.
 */
const { transformersImported } = vi.hoisted(() => ({ transformersImported: vi.fn() }));

vi.mock('@huggingface/transformers', () => {
  transformersImported();
  const fakePipeline: any = async () => ({ data: new Float32Array(384) });
  return {
    pipeline: vi.fn(async () => fakePipeline),
    env: { allowLocalModels: true, cacheDir: '', remoteHost: '' },
  };
});

const EMBED_ENV_KEYS = [
  'GITNEXUS_EMBEDDING_URL',
  'GITNEXUS_EMBEDDING_MODEL',
  'GITNEXUS_EMBEDDING_API_KEY',
  'GITNEXUS_EMBEDDING_DIMS',
] as const;

const savedEnv = Object.fromEntries(EMBED_ENV_KEYS.map((k) => [k, process.env[k]]));

/** Stub process.platform/arch via DI-friendly defineProperty; returns a restore fn. */
const stubPlatform = (platform: NodeJS.Platform, arch: NodeJS.Architecture): (() => void) => {
  const orig = { platform: process.platform, arch: process.arch };
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'arch', { value: arch, configurable: true });
  return () => {
    Object.defineProperty(process, 'platform', { value: orig.platform, configurable: true });
    Object.defineProperty(process, 'arch', { value: orig.arch, configurable: true });
  };
};

beforeEach(() => {
  vi.resetModules();
  transformersImported.mockClear();
  for (const key of EMBED_ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of EMBED_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('getLocalEmbeddingRuntimeBlocker', () => {
  it('blocks darwin/x64 (macOS Intel)', () => {
    expect(getLocalEmbeddingRuntimeBlocker({ platform: 'darwin', arch: 'x64' })).not.toBeNull();
  });

  it('returns null for darwin/arm64, linux/x64, and win32/x64', () => {
    expect(getLocalEmbeddingRuntimeBlocker({ platform: 'darwin', arch: 'arm64' })).toBeNull();
    expect(getLocalEmbeddingRuntimeBlocker({ platform: 'linux', arch: 'x64' })).toBeNull();
    expect(getLocalEmbeddingRuntimeBlocker({ platform: 'win32', arch: 'x64' })).toBeNull();
  });

  it('explains macOS Intel, local embeddings, the ONNX native binding, and safe alternatives', () => {
    const msg = getLocalEmbeddingRuntimeBlocker({ platform: 'darwin', arch: 'x64' });
    expect(msg).not.toBeNull();
    const text = msg as string;
    // What failed
    expect(text).toMatch(/macOS Intel/);
    expect(text).toMatch(/local semantic embeddings/i);
    expect(text).toMatch(/ONNX/);
    expect(text).toMatch(/native binding/i);
    // Does NOT imply wasm rescues it, and does NOT leak the raw native error
    expect(text).toMatch(/wasm does not help/i);
    expect(text).not.toMatch(/Cannot find module/);
    // Safe alternatives
    expect(text).toMatch(/without --embeddings/);
    expect(text).toContain('GITNEXUS_EMBEDDING_URL');
    expect(text).toMatch(/Linux or in Docker/);
    expect(text).toMatch(/Apple Silicon/);
    // Addresses the GitNexus device knob too, not only ONNX_WEB_BACKEND (R3 / #1987)
    expect(text).toContain('GITNEXUS_EMBEDDING_DEVICE');
  });

  it('reads platform/arch from process when no options are given', () => {
    // Stub the process so the no-arg call must consult process.platform/arch —
    // this falsifiably exercises the `?? process.platform` / `?? process.arch`
    // fallback (a plain null === null on the CI host would not).
    const restoreBlocked = stubPlatform('darwin', 'x64');
    try {
      expect(getLocalEmbeddingRuntimeBlocker()).not.toBeNull();
      expect(getLocalEmbeddingRuntimeBlocker()).toBe(
        getLocalEmbeddingRuntimeBlocker({ platform: 'darwin', arch: 'x64' }),
      );
    } finally {
      restoreBlocked();
    }

    const restoreSupported = stubPlatform('linux', 'x64');
    try {
      expect(getLocalEmbeddingRuntimeBlocker()).toBeNull();
    } finally {
      restoreSupported();
    }
  });
});

describe('isLocalEmbeddingRuntimeBlockerMessage', () => {
  it('recognises the blocker message and rejects unrelated errors', () => {
    const blocker = getLocalEmbeddingRuntimeBlocker({ platform: 'darwin', arch: 'x64' }) as string;
    expect(isLocalEmbeddingRuntimeBlockerMessage(blocker)).toBe(true);
    expect(isLocalEmbeddingRuntimeBlockerMessage('ECONNREFUSED while downloading model')).toBe(
      false,
    );
    expect(
      isLocalEmbeddingRuntimeBlockerMessage(
        "Cannot find module '../bin/.../onnxruntime_binding.node'",
      ),
    ).toBe(false);
  });
});

describe('lazy transformers.js import', () => {
  it('control: the spy fires when transformers.js is actually imported', async () => {
    expect(transformersImported).not.toHaveBeenCalled();
    await import('@huggingface/transformers');
    expect(transformersImported).toHaveBeenCalled();
  });

  it('importing the guard module does not import transformers.js', async () => {
    await import('../../src/core/embeddings/runtime-support.js');
    expect(transformersImported).not.toHaveBeenCalled();
  });

  it('importing the core embedder does not import transformers.js at module load', async () => {
    await import('../../src/core/embeddings/embedder.js');
    expect(transformersImported).not.toHaveBeenCalled();
  });

  it('importing the MCP embedder does not import transformers.js at module load', async () => {
    await import('../../src/mcp/core/embedder.js');
    expect(transformersImported).not.toHaveBeenCalled();
  });
});

describe('initEmbedder local-runtime guard (darwin/x64)', () => {
  it('rejects the core initEmbedder before importing transformers.js', async () => {
    const restore = stubPlatform('darwin', 'x64');
    try {
      const { initEmbedder } = await import('../../src/core/embeddings/embedder.js');
      await expect(initEmbedder()).rejects.toThrow(/macOS Intel/);
      // The guard must short-circuit before the lazy transformers.js import.
      expect(transformersImported).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('rejects with a clean GitNexus message, not the raw native module error', async () => {
    const restore = stubPlatform('darwin', 'x64');
    try {
      const { initEmbedder } = await import('../../src/core/embeddings/embedder.js');
      const err = (await initEmbedder().catch((e) => e)) as Error;
      expect(err.message).toMatch(/native binding/i);
      expect(err.message).not.toMatch(/Cannot find module/);
      expect(err.message).not.toMatch(/onnxruntime_binding/);
    } finally {
      restore();
    }
  });

  it('rejects the MCP initEmbedder before importing transformers.js', async () => {
    const restore = stubPlatform('darwin', 'x64');
    try {
      const { initEmbedder } = await import('../../src/mcp/core/embedder.js');
      await expect(initEmbedder()).rejects.toThrow(/macOS Intel/);
      expect(transformersImported).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});

describe('HTTP embedding mode on darwin/x64', () => {
  it('is not blocked by the local-runtime guard and never touches the native runtime', async () => {
    process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
    process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
    const mockVec = Array.from({ length: 384 }, (_, i) => i / 384);
    // Size the response to the request's `input` length so both the single
    // (embedText) and batched (embedBatch) calls get matching vector counts.
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

    const restore = stubPlatform('darwin', 'x64');
    try {
      const { embedText, embedBatch, isEmbedderReady } =
        await import('../../src/core/embeddings/embedder.js');

      // HTTP mode is ready without any local/native initialization.
      expect(isEmbedderReady()).toBe(true);

      const single = await embedText('hello from macOS Intel');
      expect(single).toBeInstanceOf(Float32Array);
      expect(single.length).toBe(384);

      const batch = await embedBatch(['a', 'b']);
      expect(batch).toHaveLength(2);

      // HTTP embeddings must route through fetch, never the local ONNX runtime.
      expect(fetch).toHaveBeenCalled();
      expect(transformersImported).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});

describe('MCP embedQuery on darwin/x64', () => {
  it('routes HTTP mode through httpEmbedQuery without importing transformers.js', async () => {
    process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
    process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
    const mockVec = Array.from({ length: 384 }, (_, i) => i / 384);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: [{ embedding: mockVec }] }),
      })),
    );

    const restore = stubPlatform('darwin', 'x64');
    try {
      const { embedQuery } = await import('../../src/mcp/core/embedder.js');
      const vec = await embedQuery('query from macOS Intel');

      // httpEmbedQuery validates against the default 384 dims (no GITNEXUS_EMBEDDING_DIMS
      // set), so the reused stub stays 384-length; resize the stub + DIMS together to vary it.
      expect(Array.isArray(vec)).toBe(true);
      expect(vec).toHaveLength(384);
      expect(fetch).toHaveBeenCalled();
      expect(transformersImported).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('rejects local mode before importing transformers.js', async () => {
    // No GITNEXUS_EMBEDDING_* env (cleared in beforeEach) → local mode → embedQuery
    // calls initEmbedder, which throws the guard before the lazy transformers import.
    const restore = stubPlatform('darwin', 'x64');
    try {
      const { embedQuery } = await import('../../src/mcp/core/embedder.js');
      await expect(embedQuery('query from macOS Intel')).rejects.toThrow(/macOS Intel/);
      expect(transformersImported).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});
