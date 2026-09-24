import { describe, expect, it, afterEach } from 'vitest';

/**
 * Verifies that MAX_PROPERTY_DISPATCH_FANOUT reads the
 * GITNEXUS_MAX_PROPERTY_DISPATCH_FANOUT environment variable at module load time
 * and falls back to the default (32) when unset.
 */

const MODULE_PATH = '../../../src/core/ingestion/scope-resolution/passes/property-dispatch.js';

async function loadWithEnv(envValue: string | undefined): Promise<number> {
  const { vi } = await import('vitest');
  vi.resetModules();

  if (envValue === undefined) {
    delete process.env.GITNEXUS_MAX_PROPERTY_DISPATCH_FANOUT;
  } else {
    process.env.GITNEXUS_MAX_PROPERTY_DISPATCH_FANOUT = envValue;
  }

  const mod = await import(MODULE_PATH);
  return mod.MAX_PROPERTY_DISPATCH_FANOUT;
}

describe('MAX_PROPERTY_DISPATCH_FANOUT env override', () => {
  afterEach(() => {
    delete process.env.GITNEXUS_MAX_PROPERTY_DISPATCH_FANOUT;
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
    expect(await loadWithEnv('not-a-number')).toBe(32);
  });

  it('falls back to default for values below 1', async () => {
    expect(await loadWithEnv('0')).toBe(32);
    expect(await loadWithEnv('-1')).toBe(32);
  });
});
