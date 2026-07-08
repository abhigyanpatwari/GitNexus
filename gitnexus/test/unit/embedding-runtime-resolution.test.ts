import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * Tier-resolution tests for `resolveEmbeddingRuntime` (#2372).
 *
 * The package tier uses runtime-install's module-scope require (anchored at its
 * own `import.meta.url`); the prefix tier uses a require anchored at
 * `<prefix>/noop.js`. In dev/CI both optional deps ARE really installed, so the
 * package tier can never miss with the real require — we mock `createRequire` to
 * route each anchor to a fake whose `.resolve()` is driven by a fixture map,
 * exercising the partial / full / missing permutations.
 *
 * This file has ZERO static import of runtime-install.js (the dual-instance
 * rule): every load goes through the dynamic-import harness, so no real
 * process-global loader state is ever touched.
 */

const RUNTIME_INSTALL = '../../src/core/embeddings/runtime-install.js';
const RUNTIME_SUPPORT = '../../src/core/embeddings/runtime-support.js';
const PREFIX = '/fake/embedding-runtime';

const toPosix = (p: string): string => p.replace(/\\/g, '/');

/** A require()-like function whose .resolve() is driven by a specifier -> path map. */
function fakeRequire(resolveMap: Record<string, string>) {
  return Object.assign(
    (specifier: string) => {
      throw new Error(`fakeRequire: unexpected require(${specifier})`);
    },
    {
      resolve: (specifier: string) => {
        const hit = resolveMap[specifier];
        if (!hit) {
          throw Object.assign(new Error(`Cannot find module '${specifier}'`), {
            code: 'MODULE_NOT_FOUND',
          });
        }
        return hit;
      },
    },
  );
}

/** Load runtime-install with createRequire routed: package anchor vs <prefix>/noop.js. */
async function loadWithTiers(pkg: Record<string, string>, prefix: Record<string, string>) {
  vi.resetModules();
  process.env.GITNEXUS_EMBEDDING_RUNTIME_DIR = PREFIX;
  const packageRequire = fakeRequire(pkg);
  const prefixRequire = fakeRequire(prefix);
  vi.doMock('node:module', async (io) => {
    const orig = await io<typeof import('node:module')>();
    return {
      ...orig,
      createRequire: (from: string | URL) =>
        toPosix(String(from)) === `${PREFIX}/noop.js` ? prefixRequire : packageRequire,
    };
  });
  const runtimeInstall = await import(RUNTIME_INSTALL);
  const runtimeSupport = await import(RUNTIME_SUPPORT);
  return { runtimeInstall, runtimeSupport };
}

const BOTH = {
  '@huggingface/transformers': '/x/transformers/index.js',
  'onnxruntime-node': '/x/onnxruntime-node/index.js',
};
const ONLY_TRANSFORMERS = { '@huggingface/transformers': '/x/transformers/index.js' };
const NONE: Record<string, string> = {};

afterEach(() => {
  vi.doUnmock('node:module');
  delete process.env.GITNEXUS_EMBEDDING_RUNTIME_DIR;
});

describe('resolveEmbeddingRuntime — tier resolution', () => {
  it('reports package source when both packages resolve from the package anchor', async () => {
    const { runtimeInstall } = await loadWithTiers(BOTH, NONE);
    expect(runtimeInstall.resolveEmbeddingRuntime()).toEqual({ source: 'package' });
  });

  it('reports runtime-prefix when the package tier misses and the prefix has both', async () => {
    const { runtimeInstall } = await loadWithTiers(NONE, BOTH);
    expect(runtimeInstall.resolveEmbeddingRuntime()).toEqual({ source: 'runtime-prefix' });
  });

  it('returns null when the prefix is partial (transformers but no onnxruntime-node)', async () => {
    const { runtimeInstall } = await loadWithTiers(NONE, ONLY_TRANSFORMERS);
    expect(runtimeInstall.resolveEmbeddingRuntime()).toBeNull();
  });

  it('isLocalEmbeddingStackInstalled is false for a partial prefix', async () => {
    const { runtimeSupport } = await loadWithTiers(NONE, ONLY_TRANSFORMERS);
    expect(runtimeSupport.isLocalEmbeddingStackInstalled()).toBe(false);
  });
});

type ResolveHook = (
  specifier: string,
  context: unknown,
  next: (s: string, c: unknown) => unknown,
) => unknown;

const HOOK_CTX = { conditions: [] as string[], importAttributes: {} };
const esmMiss = (): Error =>
  Object.assign(new Error("Cannot find package 'x'"), { code: 'ERR_MODULE_NOT_FOUND' });
const exportsMiss = (): Error =>
  Object.assign(new Error('No known export'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
const cjsMiss = (): Error =>
  Object.assign(new Error("Cannot find module 'x'"), { code: 'MODULE_NOT_FOUND' });

/** Load runtime-install with a registerHooks spy + createRequire routing, and return the resolve closure. */
async function loadWithHook(pkg: Record<string, string>, prefix: Record<string, string>) {
  vi.resetModules();
  process.env.GITNEXUS_EMBEDDING_RUNTIME_DIR = PREFIX;
  const spy = vi.fn();
  const packageRequire = fakeRequire(pkg);
  const prefixRequire = fakeRequire(prefix);
  vi.doMock('node:module', async (io) => {
    const orig = await io<typeof import('node:module')>();
    return {
      ...orig,
      registerHooks: spy,
      createRequire: (from: string | URL) =>
        toPosix(String(from)) === `${PREFIX}/noop.js` ? prefixRequire : packageRequire,
    };
  });
  const runtimeInstall = await import(RUNTIME_INSTALL);
  runtimeInstall.ensureEmbeddingStackResolvable();
  const resolve = (spy.mock.calls[0][0] as { resolve: ResolveHook }).resolve;
  return { resolve };
}

describe('ensureEmbeddingStackResolvable — onnxruntime-common source gate', () => {
  it('package-sourced stack: an onnxruntime-common miss rethrows (leaves #307 in control)', async () => {
    const { resolve } = await loadWithHook(BOTH, NONE);
    const next = vi.fn(() => {
      throw esmMiss();
    });
    expect(() => resolve('onnxruntime-common', HOOK_CTX, next)).toThrow();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('prefix-sourced stack: an onnxruntime-common miss re-anchors to the prefix', async () => {
    const { resolve } = await loadWithHook(NONE, BOTH);
    const next = vi
      .fn()
      .mockImplementationOnce(() => {
        throw esmMiss();
      })
      .mockImplementationOnce(() => ({ url: 'redirected', shortCircuit: true }));
    resolve('onnxruntime-common', HOOK_CTX, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect((next.mock.calls[1][1] as { parentURL: string }).parentURL).toContain('noop.js');
  });

  it('null-sourced stack: an onnxruntime-common miss rethrows', async () => {
    const { resolve } = await loadWithHook(NONE, NONE);
    const next = vi.fn(() => {
      throw esmMiss();
    });
    expect(() => resolve('onnxruntime-common', HOOK_CTX, next)).toThrow();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('transformers miss re-anchors regardless of source', async () => {
    const { resolve } = await loadWithHook(BOTH, NONE);
    const next = vi
      .fn()
      .mockImplementationOnce(() => {
        throw esmMiss();
      })
      .mockImplementationOnce(() => ({ url: 'ok', shortCircuit: true }));
    resolve('@huggingface/transformers', HOOK_CTX, next);
    expect(next).toHaveBeenCalledTimes(2);
    const anchor = (next.mock.calls[1][1] as { parentURL: string }).parentURL;
    expect(anchor).toMatch(/^file:\/\//);
    expect(anchor).toContain('noop.js');
  });

  it('re-anchors on ERR_PACKAGE_PATH_NOT_EXPORTED as well as ERR_MODULE_NOT_FOUND', async () => {
    const { resolve } = await loadWithHook(BOTH, NONE);
    const next = vi
      .fn()
      .mockImplementationOnce(() => {
        throw exportsMiss();
      })
      .mockImplementationOnce(() => ({ url: 'ok', shortCircuit: true }));
    resolve('@huggingface/transformers', HOOK_CTX, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect((next.mock.calls[1][1] as { parentURL: string }).parentURL).toContain('noop.js');
  });

  it('a non-stack specifier passes straight through', async () => {
    const { resolve } = await loadWithHook(BOTH, NONE);
    const next = vi.fn(() => ({ url: 'x', shortCircuit: true }));
    resolve('some-other-pkg', HOOK_CTX, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('a CJS MODULE_NOT_FOUND (not ERR_) is rethrown, never re-anchored', async () => {
    const { resolve } = await loadWithHook(NONE, BOTH);
    const next = vi.fn(() => {
      throw cjsMiss();
    });
    expect(() => resolve('onnxruntime-node', HOOK_CTX, next)).toThrow();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('re-entrancy latch: a hook re-entered during the source probe passes straight through', async () => {
    vi.resetModules();
    process.env.GITNEXUS_EMBEDDING_RUNTIME_DIR = PREFIX;
    const spy = vi.fn();
    const reentrantNext = vi.fn(() => ({ url: 'passthrough', shortCircuit: true }));
    const captured: { resolve?: ResolveHook } = {};

    // A prefix require whose .resolve re-enters the closure — simulating a Node
    // that routed require.resolve through the sync hook. The latch must make the
    // re-entrant call pass straight through instead of recursing into the gate.
    const prefixRequire = {
      resolve: (specifier: string) => {
        captured.resolve?.('onnxruntime-common', HOOK_CTX, reentrantNext);
        return `/x/${specifier}`;
      },
    };
    const packageRequire = fakeRequire(NONE);
    vi.doMock('node:module', async (io) => {
      const orig = await io<typeof import('node:module')>();
      return {
        ...orig,
        registerHooks: spy,
        createRequire: (from: string | URL) =>
          toPosix(String(from)) === `${PREFIX}/noop.js` ? prefixRequire : packageRequire,
      };
    });
    const runtimeInstall = await import(RUNTIME_INSTALL);
    runtimeInstall.ensureEmbeddingStackResolvable();
    captured.resolve = (spy.mock.calls[0][0] as { resolve: ResolveHook }).resolve;

    const outerNext = vi
      .fn()
      .mockImplementationOnce(() => {
        throw esmMiss();
      })
      .mockImplementationOnce(() => ({ url: 'redirected', shortCircuit: true }));
    // Must not stack-overflow; the re-entrant probe call short-circuits.
    captured.resolve('onnxruntime-common', HOOK_CTX, outerNext);
    expect(reentrantNext).toHaveBeenCalled();
    expect(outerNext).toHaveBeenCalledTimes(2);
  });
});
