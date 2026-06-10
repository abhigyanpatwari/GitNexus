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

/** (Re)load the resolver with a chosen `registerHooks` mocked into node:module. */
async function loadResolver(registerHooks: unknown) {
  vi.resetModules();
  vi.doMock('node:module', async (importOriginal) => {
    const orig = await importOriginal<typeof import('node:module')>();
    return { ...orig, registerHooks };
  });
  const mod = await import(RESOLVER);
  mod.__resetOnnxRuntimeCommonResolverForTests();
  return mod;
}

const ctx = { conditions: [], importAttributes: {} } as never;
const moduleNotFound = (): Error => {
  const e = new Error("Cannot find package 'onnxruntime-common'") as Error & { code: string };
  e.code = 'ERR_MODULE_NOT_FOUND';
  return e;
};

afterEach(() => {
  vi.doUnmock('node:module');
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
});

describe('ensureOnnxRuntimeCommonResolvable — resolve hook behaviour', () => {
  /** Install the fallback and return the resolve closure handed to registerHooks. */
  async function captureResolve() {
    const spy = vi.fn();
    const mod = await loadResolver(spy);
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
    expect(res.url).toMatch(/^file:\/\/.*onnxruntime-common/); // gitnexus' own copy
  });

  it('never masks an unrelated resolution failure (other specifiers rethrow)', async () => {
    const resolve = await captureResolve();
    const err = moduleNotFound();
    const next = vi.fn(() => {
      throw err;
    });

    expect(() => resolve('some-other-package', ctx, next)).toThrow(err);
  });
});
