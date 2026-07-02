import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * Tests for the #307 pnpm-strict / `pnpm dlx` fix: a synchronous in-thread ESM
 * resolution hook (`module.registerHooks`) that redirects @huggingface/
 * transformers' phantom `onnxruntime-common` import to gitnexus' own copy.
 *
 * Each test mocks `node:module` with a chosen `registerHooks` (a spy, or
 * `undefined` to simulate Node < 22.15) so we can assert one-shot installation,
 * graceful degradation, and the redirect/passthrough/rethrow logic of the
 * resolve closure — without mutating the real process loader.
 */

const RESOLVER = '../../src/core/embeddings/onnxruntime-common-resolver.js';

/**
 * (Re)load the resolver with a chosen `registerHooks` mocked into node:module.
 * `vi.resetModules()` + the fresh `import()` re-initialises the module-level
 * one-shot guard, so each test gets a pristine resolver with no shared state.
 *
 * When `getEffectiveOnnxRuntimeNodeDir` is supplied, the sibling
 * onnxruntime-node-resolver.js is also mocked with it — letting a test drive
 * (or spy on) whichever onnxruntime-node dir this hook's own onnxruntime-common
 * lookup defers to, instead of independently re-deriving transformers'
 * default (#2341 follow-up).
 */
async function loadResolver(
  registerHooks: unknown,
  getEffectiveOnnxRuntimeNodeDir?: () => string | null,
) {
  vi.resetModules();
  vi.doMock('node:module', async (importOriginal) => {
    const orig = await importOriginal<typeof import('node:module')>();
    return { ...orig, registerHooks };
  });
  if (getEffectiveOnnxRuntimeNodeDir) {
    vi.doMock('../../src/core/embeddings/onnxruntime-node-resolver.js', () => ({
      getEffectiveOnnxRuntimeNodeDir,
    }));
  }
  return import(RESOLVER);
}

const ctx = { conditions: [], importAttributes: {} } as never;
const moduleNotFound = (): Error => {
  const e = new Error("Cannot find package 'onnxruntime-common'") as Error & { code: string };
  e.code = 'ERR_MODULE_NOT_FOUND';
  return e;
};

afterEach(() => {
  vi.doUnmock('node:module');
  vi.doUnmock('../../src/core/embeddings/onnxruntime-node-resolver.js');
});

describe('ensureOnnxRuntimeCommonResolvable — installation', () => {
  it('installs the resolve hook exactly once (idempotent)', async () => {
    const spy = vi.fn();
    const mod = await loadResolver(spy);

    mod.ensureOnnxRuntimeCommonResolvable();
    mod.ensureOnnxRuntimeCommonResolvable(); // second call is a no-op

    expect(spy).toHaveBeenCalledTimes(1);
    expect(typeof spy.mock.calls[0][0].resolve).toBe('function');
  });

  it('no-ops gracefully when registerHooks is unavailable (Node < 22.15)', async () => {
    const mod = await loadResolver(undefined);
    // Must not throw even though there is no synchronous-hooks API to call.
    expect(() => mod.ensureOnnxRuntimeCommonResolvable()).not.toThrow();
  });

  it('is best-effort: swallows a registerHooks() failure instead of throwing into the embedder', async () => {
    const mod = await loadResolver(
      vi.fn(() => {
        throw new Error('hook-install-failed');
      }),
    );
    // The call site (initEmbedder) does not guard the return; a throw here would
    // break `analyze --embeddings`. The outer try/catch must absorb it.
    expect(() => mod.ensureOnnxRuntimeCommonResolvable()).not.toThrow();
  });
});

describe('ensureOnnxRuntimeCommonResolvable — resolve hook behaviour', () => {
  /** Install the fallback and return the resolve closure handed to registerHooks. */
  async function captureResolve(getEffectiveOnnxRuntimeNodeDir?: () => string | null) {
    const spy = vi.fn();
    const mod = await loadResolver(spy, getEffectiveOnnxRuntimeNodeDir);
    mod.ensureOnnxRuntimeCommonResolvable();
    return spy.mock.calls[0][0].resolve as (
      s: string,
      c: never,
      n: (s: string, c: never) => unknown,
    ) => unknown;
  }

  it('passes a successful default resolution through unchanged (no-op on hoisted layouts)', async () => {
    const resolve = await captureResolve();
    const real = { url: 'file:///real/onnxruntime-common/index.js', shortCircuit: true };
    const next = vi.fn(() => real);

    const res = resolve('onnxruntime-common', ctx, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res).toBe(real); // the real resolution, NOT a redirect
  });

  it('redirects onnxruntime-common to the gitnexus copy when default resolution fails', async () => {
    const resolve = await captureResolve();
    const next = vi.fn(() => {
      throw moduleNotFound();
    });

    const res = resolve('onnxruntime-common', ctx, next) as { url: string; shortCircuit: boolean };

    expect(res.shortCircuit).toBe(true);
    // The real resolved onnxruntime-common in node_modules (require.resolve runs
    // for real here) — not just any path containing the substring.
    expect(res.url).toMatch(/^file:\/\/.*\/node_modules\/onnxruntime-common\/.*\.js$/);
  });

  it('never masks an unrelated resolution failure (other specifiers rethrow)', async () => {
    const resolve = await captureResolve();
    const err = moduleNotFound();
    const next = vi.fn(() => {
      throw err;
    });

    expect(() => resolve('some-other-package', ctx, next)).toThrow(err);
  });

  it('rethrows when onnxruntime-common fails for a non-absence reason', async () => {
    const resolve = await captureResolve();
    // A present-but-otherwise-broken resolution (not a missing package) must
    // surface, not be silently papered over with gitnexus' copy.
    const err = Object.assign(new Error('bad specifier'), {
      code: 'ERR_INVALID_MODULE_SPECIFIER',
    });
    const next = vi.fn(() => {
      throw err;
    });

    expect(() => resolve('onnxruntime-common', ctx, next)).toThrow(err);
  });

  it("defers to getEffectiveOnnxRuntimeNodeDir() instead of independently re-deriving transformers' default (#2341 follow-up)", async () => {
    const effectiveDirSpy = vi.fn(() => null as string | null);
    const resolve = await captureResolve(effectiveDirSpy);
    const next = vi.fn(() => {
      throw moduleNotFound();
    });

    const res = resolve('onnxruntime-common', ctx, next) as { url: string; shortCircuit: boolean };

    // The sibling module's decision is consulted (not bypassed)...
    expect(effectiveDirSpy).toHaveBeenCalled();
    // ...and since it reported no effective dir here, the code falls back to
    // gitnexus' own direct dependency (the same fallback as "default
    // resolution fails") rather than independently re-deriving a different
    // path from @huggingface/transformers on its own.
    expect(res.shortCircuit).toBe(true);
    expect(res.url).toMatch(/^file:\/\/.*\/node_modules\/onnxruntime-common\/.*\.js$/);
  });
});
