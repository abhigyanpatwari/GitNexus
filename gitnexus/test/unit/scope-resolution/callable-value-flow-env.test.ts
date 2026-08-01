import { describe, expect, it, afterEach } from 'vitest';

/**
 * Verifies that MAX_CALLABLE_VALUE_TARGETS reads the
 * GITNEXUS_MAX_CALLABLE_VALUE_TARGETS environment variable at module load time
 * and falls back to the default (32) when unset.
 *
 * Because the constant is evaluated once at import time, we use a dynamic
 * import per test to get a fresh module instance under each env configuration.
 */

const MODULE_PATH = '../../../src/core/ingestion/scope-resolution/passes/callable-value-flow.js';

async function loadWithEnv(envValue: string | undefined): Promise<number> {
  // vitest module cache is keyed by path; vi.resetModules is needed for re-import
  const { vi } = await import('vitest');
  vi.resetModules();

  if (envValue === undefined) {
    delete process.env.GITNEXUS_MAX_CALLABLE_VALUE_TARGETS;
  } else {
    process.env.GITNEXUS_MAX_CALLABLE_VALUE_TARGETS = envValue;
  }

  const mod = await import(MODULE_PATH);
  return mod.MAX_CALLABLE_VALUE_TARGETS;
}

describe('MAX_CALLABLE_VALUE_TARGETS env override', () => {
  afterEach(() => {
    delete process.env.GITNEXUS_MAX_CALLABLE_VALUE_TARGETS;
  });

  it('defaults to 32 when the env var is not set', async () => {
    const cap = await loadWithEnv(undefined);
    expect(cap).toBe(32);
  });

  it('respects a valid positive integer override', async () => {
    const cap = await loadWithEnv('48');
    expect(cap).toBe(48);
  });

  it('falls back to default for non-integer values', async () => {
    expect(await loadWithEnv('abc')).toBe(32);
  });

  it('falls back to default for values below 1', async () => {
    expect(await loadWithEnv('0')).toBe(32);
    expect(await loadWithEnv('-5')).toBe(32);
  });
});
