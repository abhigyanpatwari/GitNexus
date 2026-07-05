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
