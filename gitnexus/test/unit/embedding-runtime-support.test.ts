import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getLocalEmbeddingRuntimeBlocker,
  getMissingLocalEmbeddingStackMessage,
  isLocalEmbeddingRuntimeBlockerMessage,
  isLocalEmbeddingStackInstalled,
  isMissingLocalEmbeddingStackMessage,
  localEmbeddingStackMissingMessage,
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

/**
 * Spy for the CUDA-13 build-matching resolver hook. Both local embedders must
 * call this before importing transformers.js — mocked (rather than exercising
 * the real resolver's env/subprocess probing) to keep this suite fast and
 * platform-independent; `onnxruntime-node-resolver.test.ts` covers the
 * resolver's own decision logic.
 */
const { resolverHookInstalled } = vi.hoisted(() => ({ resolverHookInstalled: vi.fn() }));

vi.mock('../../src/core/embeddings/onnxruntime-node-resolver.js', () => ({
  ensureOnnxRuntimeNodeMatchesSystem: () => resolverHookInstalled(),
  isEffectiveCudaAvailable: () => false,
}));

/**
 * Mock `module.registerHooks` with a spy (#2372). Without this, a successful
 * local `initEmbedder()` calls the REAL `ensureEmbeddingStackResolvable` /
 * onnxruntime-common resolver, which register process-global resolution hooks in
 * the vitest worker — and `vi.resetModules()` (beforeEach) resets their one-shot
 * guards, so each test re-registers real hooks that are never deregistered,
 * silently redirecting resolution for every later test in the worker. Spreading
 * `importOriginal` keeps `createRequire` real, so the CJS resolution probes still
 * work.
 */
const { registerHooksSpy } = vi.hoisted(() => ({ registerHooksSpy: vi.fn() }));

vi.mock('node:module', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:module')>()),
  registerHooks: registerHooksSpy,
}));

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
  resolverHookInstalled.mockClear();
  registerHooksSpy.mockClear();
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

/** Build a module-not-found error the way Node does (message + `code`). */
const moduleNotFound = (message: string, code: string): NodeJS.ErrnoException => {
  const err: NodeJS.ErrnoException = new Error(message);
  err.code = code;
  return err;
};

describe('getMissingLocalEmbeddingStackMessage (#2370 pruned optional stack)', () => {
  it('maps an ESM import failure for @huggingface/transformers to the guidance message', () => {
    const err = moduleNotFound(
      "Cannot find package '@huggingface/transformers' imported from /x/dist/core/embeddings/embedder.js",
      'ERR_MODULE_NOT_FOUND',
    );
    expect(getMissingLocalEmbeddingStackMessage(err)).toBe(localEmbeddingStackMissingMessage());
  });

  it('maps a CJS require failure for onnxruntime-node to the guidance message', () => {
    const err = moduleNotFound("Cannot find module 'onnxruntime-node'", 'MODULE_NOT_FOUND');
    expect(getMissingLocalEmbeddingStackMessage(err)).toBe(localEmbeddingStackMissingMessage());
  });

  it('ignores module-not-found errors for unrelated packages', () => {
    const err = moduleNotFound("Cannot find package 'graphology'", 'ERR_MODULE_NOT_FOUND');
    expect(getMissingLocalEmbeddingStackMessage(err)).toBeNull();
  });

  it('ignores the macOS-Intel native-binding path error (a file path, not the bare specifier)', () => {
    // #1515-style failure: the PACKAGE is installed but its native binding file
    // is absent — must NOT be misreported as a pruned optional install.
    const err = moduleNotFound(
      "Cannot find module '/x/node_modules/onnxruntime-node/bin/napi-v6/darwin/x64/onnxruntime_binding.node'",
      'MODULE_NOT_FOUND',
    );
    expect(getMissingLocalEmbeddingStackMessage(err)).toBeNull();
  });

  it('ignores errors without a module-not-found code and non-Error values', () => {
    expect(
      getMissingLocalEmbeddingStackMessage(new Error("Cannot find package 'onnxruntime-node'")),
    ).toBeNull();
    expect(
      getMissingLocalEmbeddingStackMessage("Cannot find package 'onnxruntime-node'"),
    ).toBeNull();
    expect(getMissingLocalEmbeddingStackMessage(undefined)).toBeNull();
  });

  it('produces guidance naming every recovery path', () => {
    const msg = localEmbeddingStackMissingMessage();
    expect(msg).toContain('gitnexus embeddings install');
    expect(msg).toContain('ONNXRUNTIME_NODE_INSTALL=skip');
    expect(msg).toContain('GLOBAL_AGENT_HTTPS_PROXY');
    expect(msg).toContain('GITNEXUS_EMBEDDING_URL');
    expect(msg).toContain('#2370');
    // Must not trip analyze.ts's generic "installation may be corrupt" branch.
    expect(msg).not.toMatch(/Cannot find (module|package)/);
    expect(msg).not.toContain('MODULE_NOT_FOUND');
  });
});

describe('isMissingLocalEmbeddingStackMessage', () => {
  it('recognises its own message and rejects the platform blocker and unrelated errors', () => {
    expect(isMissingLocalEmbeddingStackMessage(localEmbeddingStackMissingMessage())).toBe(true);
    const blocker = getLocalEmbeddingRuntimeBlocker({ platform: 'darwin', arch: 'x64' }) as string;
    expect(isMissingLocalEmbeddingStackMessage(blocker)).toBe(false);
    expect(isLocalEmbeddingRuntimeBlockerMessage(localEmbeddingStackMissingMessage())).toBe(false);
    expect(isMissingLocalEmbeddingStackMessage('ECONNREFUSED while downloading model')).toBe(false);
  });
});

describe('isLocalEmbeddingStackInstalled', () => {
  it('resolves the optional stack in the dev workspace without importing it', () => {
    expect(isLocalEmbeddingStackInstalled()).toBe(true);
    // Resolution only — the transformers.js import spy must not fire.
    expect(transformersImported).not.toHaveBeenCalled();
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

describe('CUDA-13 resolver hook installation (both local-embedding entrypoints)', () => {
  // Regression guard for the two local embedders drifting apart (gitnexus PR #2341
  // follow-up): both `core/embeddings/embedder.ts` and `mcp/core/embedder.ts` must
  // install the CUDA-build-matching redirect during a successful local init. (The
  // source itself places the call before `await import('@huggingface/transformers')`
  // — not re-asserted here via mock call-order, since the hoisted `@huggingface/
  // transformers` mock's factory only fires once per file run for this external
  // package, making a second per-test "called fresh" assertion on it unreliable.)
  it('core embedder installs the resolver hook on a successful local init', async () => {
    const restore = stubPlatform('linux', 'x64');
    try {
      const { initEmbedder } = await import('../../src/core/embeddings/embedder.js');
      await expect(initEmbedder()).resolves.toBeDefined();

      expect(resolverHookInstalled).toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('MCP embedder installs the resolver hook on a successful local init', async () => {
    const restore = stubPlatform('linux', 'x64');
    try {
      const { initEmbedder } = await import('../../src/mcp/core/embedder.js');
      await expect(initEmbedder()).resolves.toBeDefined();

      expect(resolverHookInstalled).toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('registers the runtime-prefix fallback through the mocked registerHooks, not the real global API (#2372)', async () => {
    // The whole point of the node:module mock: a successful local init exercises
    // ensureEmbeddingStackResolvable's registration via the spy, so no real
    // process-global resolution hook leaks into other tests in the worker.
    const restore = stubPlatform('linux', 'x64');
    try {
      const { initEmbedder } = await import('../../src/core/embeddings/embedder.js');
      await expect(initEmbedder()).resolves.toBeDefined();
      expect(registerHooksSpy).toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});
