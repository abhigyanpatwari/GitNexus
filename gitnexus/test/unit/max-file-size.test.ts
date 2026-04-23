import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DEFAULT_MAX_FILE_SIZE_BYTES,
  MAX_FILE_SIZE_UPPER_BOUND_BYTES,
  getMaxFileSizeBytes,
  getMaxFileSizeBannerMessage,
  _resetMaxFileSizeWarnings,
} from '../../src/core/ingestion/utils/max-file-size.js';

describe('getMaxFileSizeBytes', () => {
  const ORIGINAL = process.env.GITNEXUS_MAX_FILE_SIZE;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.GITNEXUS_MAX_FILE_SIZE;
    _resetMaxFileSizeWarnings();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.GITNEXUS_MAX_FILE_SIZE;
    } else {
      process.env.GITNEXUS_MAX_FILE_SIZE = ORIGINAL;
    }
    warnSpy.mockRestore();
  });

  it('returns the default when the env var is unset', () => {
    expect(getMaxFileSizeBytes()).toBe(DEFAULT_MAX_FILE_SIZE_BYTES);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('parses a positive integer value as KB', () => {
    process.env.GITNEXUS_MAX_FILE_SIZE = '1024';
    expect(getMaxFileSizeBytes()).toBe(1024 * 1024);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('clamps values above the tree-sitter ceiling', () => {
    // One KB above the 32 MB ceiling.
    const aboveCeilingKb = MAX_FILE_SIZE_UPPER_BOUND_BYTES / 1024 + 1;
    process.env.GITNEXUS_MAX_FILE_SIZE = String(aboveCeilingKb);
    expect(getMaxFileSizeBytes()).toBe(MAX_FILE_SIZE_UPPER_BOUND_BYTES);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('clamping');
  });

  it.each(['abc', '0', '-512', '1.5', 'NaN', ''])(
    'falls back to the default and warns on invalid value %s',
    (raw) => {
      if (raw === '') {
        // Empty string is treated as unset by the util (raw falsy check).
        process.env.GITNEXUS_MAX_FILE_SIZE = raw;
        expect(getMaxFileSizeBytes()).toBe(DEFAULT_MAX_FILE_SIZE_BYTES);
        expect(warnSpy).not.toHaveBeenCalled();
        return;
      }
      process.env.GITNEXUS_MAX_FILE_SIZE = raw;
      expect(getMaxFileSizeBytes()).toBe(DEFAULT_MAX_FILE_SIZE_BYTES);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('must be a positive integer');
    },
  );

  it('deduplicates warnings for the same invalid value', () => {
    process.env.GITNEXUS_MAX_FILE_SIZE = 'abc';
    getMaxFileSizeBytes();
    getMaxFileSizeBytes();
    getMaxFileSizeBytes();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('warns separately for distinct invalid values', () => {
    process.env.GITNEXUS_MAX_FILE_SIZE = 'abc';
    getMaxFileSizeBytes();
    process.env.GITNEXUS_MAX_FILE_SIZE = 'xyz';
    getMaxFileSizeBytes();
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('_resetMaxFileSizeWarnings re-enables warnings after reset', () => {
    process.env.GITNEXUS_MAX_FILE_SIZE = 'abc';
    getMaxFileSizeBytes();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    getMaxFileSizeBytes();
    expect(warnSpy).toHaveBeenCalledTimes(1);

    _resetMaxFileSizeWarnings();
    getMaxFileSizeBytes();
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('DEFAULT_MAX_FILE_SIZE_BYTES is 512 KB', () => {
    expect(DEFAULT_MAX_FILE_SIZE_BYTES).toBe(512 * 1024);
  });
});

describe('getMaxFileSizeBannerMessage', () => {
  const ORIGINAL = process.env.GITNEXUS_MAX_FILE_SIZE;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.GITNEXUS_MAX_FILE_SIZE;
    _resetMaxFileSizeWarnings();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.GITNEXUS_MAX_FILE_SIZE;
    } else {
      process.env.GITNEXUS_MAX_FILE_SIZE = ORIGINAL;
    }
    warnSpy.mockRestore();
  });

  it('returns null when the env var is unset (default threshold)', () => {
    expect(getMaxFileSizeBannerMessage()).toBeNull();
  });

  it('returns null when the env var equals the default (in KB)', () => {
    process.env.GITNEXUS_MAX_FILE_SIZE = String(DEFAULT_MAX_FILE_SIZE_BYTES / 1024);
    expect(getMaxFileSizeBannerMessage()).toBeNull();
  });

  it('returns null when an invalid value falls back to the default', () => {
    process.env.GITNEXUS_MAX_FILE_SIZE = 'abc';
    expect(getMaxFileSizeBannerMessage()).toBeNull();
  });

  it('reports the raised effective threshold in KB', () => {
    process.env.GITNEXUS_MAX_FILE_SIZE = '1024';
    const banner = getMaxFileSizeBannerMessage();
    expect(banner).not.toBeNull();
    expect(banner).toContain('effective threshold 1024KB');
    expect(banner).toContain(`default ${DEFAULT_MAX_FILE_SIZE_BYTES / 1024}KB`);
  });

  it('reports the clamped (post-ceiling) threshold, not the raw input', () => {
    const ceilingKb = MAX_FILE_SIZE_UPPER_BOUND_BYTES / 1024;
    const aboveCeilingKb = ceilingKb + 1024;
    process.env.GITNEXUS_MAX_FILE_SIZE = String(aboveCeilingKb);
    const banner = getMaxFileSizeBannerMessage();
    expect(banner).not.toBeNull();
    expect(banner).toContain(`effective threshold ${ceilingKb}KB`);
    expect(banner).not.toContain(`${aboveCeilingKb}KB`);
  });
});
