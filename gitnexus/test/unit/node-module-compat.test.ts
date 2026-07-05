import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * Tests for the #2372 `node:module` compat seam. `module.registerHooks` was
 * added in Node 22.15 / 23.5, but the engines floor is >=22.0.0, so on
 * 22.0–22.14 and 23.0–23.4 the export is absent. `getRegisterHooks()` must
 * hand back the real function when present and `undefined` when not — the value
 * the resolver guards degrade on. `isPrefixRuntimeLoadable()` (exported from
 * runtime-install.ts so CLI code never imports the compat module) is the
 * boolean the truthful-messaging gates consume; it is tested here un-mocked,
 * through the same `node:module` doMock seam, because a polarity bug in that
 * thin wrapper would otherwise ship green (every consumer mocks it wholesale).
 *
 * Absence is simulated by passing an explicit `registerHooks: undefined` over
 * the `importOriginal` spread — a bare omission would keep the real function.
 */

const COMPAT = '../../src/core/embeddings/node-module-compat.js';
const RUNTIME_INSTALL = '../../src/core/embeddings/runtime-install.js';

async function loadWithRegisterHooks(registerHooks: unknown) {
  vi.resetModules();
  vi.doMock('node:module', async (importOriginal) => {
    const orig = await importOriginal<typeof import('node:module')>();
    return { ...orig, registerHooks };
  });
  const compat = await import(COMPAT);
  const runtimeInstall = await import(RUNTIME_INSTALL);
  return { compat, runtimeInstall };
}

afterEach(() => {
  vi.doUnmock('node:module');
});

describe('getRegisterHooks', () => {
  it('returns the real function when node:module exposes registerHooks', async () => {
    const fn = vi.fn();
    const { compat } = await loadWithRegisterHooks(fn);
    expect(compat.getRegisterHooks()).toBe(fn);
  });

  it('returns undefined when registerHooks is absent (Node < 22.15 / < 23.5)', async () => {
    const { compat } = await loadWithRegisterHooks(undefined);
    expect(compat.getRegisterHooks()).toBeUndefined();
  });
});

describe('isPrefixRuntimeLoadable', () => {
  it('is true when registerHooks is a function', async () => {
    const { runtimeInstall } = await loadWithRegisterHooks(vi.fn());
    expect(runtimeInstall.isPrefixRuntimeLoadable()).toBe(true);
  });

  it('is false when registerHooks is absent', async () => {
    const { runtimeInstall } = await loadWithRegisterHooks(undefined);
    expect(runtimeInstall.isPrefixRuntimeLoadable()).toBe(false);
  });
});
