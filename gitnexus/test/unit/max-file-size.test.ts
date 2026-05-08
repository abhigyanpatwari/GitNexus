import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_MAX_FILE_SIZE_BYTES,
  MAX_FILE_SIZE_UPPER_BOUND_BYTES,
  getMaxFileSizeBytes,
  getMaxFileSizeBannerMessage,
  _resetMaxFileSizeWarnings,
} from '../../src/core/ingestion/utils/max-file-size.js';
import { _captureLogger } from '../../src/core/logger.js';

describe('getMaxFileSizeBytes', () => {
  const ORIGINAL = process.env.GITNEXUS_MAX_FILE_SIZE;
  let cap: ReturnType<typeof _captureLogger>;

  beforeEach(() => {
    delete process.env.GITNEXUS_MAX_FILE_SIZE;
    _resetMaxFileSizeWarnings();
    cap = _captureLogger();
  });

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.GITNEXUS_MAX_FILE_SIZE;
    } else {
      process.env.GITNEXUS_MAX_FILE_SIZE = ORIGINAL;
    }
    cap.restore();
  });

  it('returns the default when the env var is unset', () => {
    expect(getMaxFileSizeBytes()).toBe(DEFAULT_MAX_FILE_SIZE_BYTES);
    expect(cap.records().length).toBe(0);
  });

  it('parses a positive integer value as KB', () => {
    process.env.GITNEXUS_MAX_FILE_SIZE = '1024';
    expect(getMaxFileSizeBytes()).toBe(1024 * 1024);
    expect(cap.records().length).toBe(0);
  });

  it('clamps values above the tree-sitter ceiling', () => {
    const aboveCeilingKb = MAX_FILE_SIZE_UPPER_BOUND_BYTES / 1024 + 1;
    process.env.GITNEXUS_MAX_FILE_SIZE = String(aboveCeilingKb);
    expect(getMaxFileSizeBytes()).toBe(MAX_FILE_SIZE_UPPER_BOUND_BYTES);
    const records = cap.records();
    expect(records.length).toBe(1);
    expect(String(records[0].msg)).toContain('clamping');
  });

  it.each(['abc', '0', '-512', '1.5', 'NaN', ''])(
    'falls back to the default and warns on invalid value %s',
    (raw) => {
      if (raw === '') {
        process.env.GITNEXUS_MAX_FILE_SIZE = raw;
        expect(getMaxFileSizeBytes()).toBe(DEFAULT_MAX_FILE_SIZE_BYTES);
        expect(cap.records().length).toBe(0);
        return;
      }
      process.env.GITNEXUS_MAX_FILE_SIZE = raw;
      expect(getMaxFileSizeBytes()).toBe(DEFAULT_MAX_FILE_SIZE_BYTES);
      const records = cap.records();
      expect(records.length).toBe(1);
      expect(String(records[0].msg)).toContain('must be a positive integer');
    },
  );

  it('deduplicates warnings for the same invalid value', () => {
    process.env.GITNEXUS_MAX_FILE_SIZE = 'abc';
    getMaxFileSizeBytes();
    getMaxFileSizeBytes();
    getMaxFileSizeBytes();
    expect(cap.records().length).toBe(1);
  });

  it('warns separately for distinct invalid values', () => {
    process.env.GITNEXUS_MAX_FILE_SIZE = 'abc';
    getMaxFileSizeBytes();
    process.env.GITNEXUS_MAX_FILE_SIZE = 'xyz';
    getMaxFileSizeBytes();
    expect(cap.records().length).toBe(2);
  });

  it('_resetMaxFileSizeWarnings re-enables warnings after reset', () => {
    process.env.GITNEXUS_MAX_FILE_SIZE = 'abc';
    getMaxFileSizeBytes();
    expect(cap.records().length).toBe(1);

    getMaxFileSizeBytes();
    expect(cap.records().length).toBe(1);

    _resetMaxFileSizeWarnings();
    getMaxFileSizeBytes();
    expect(cap.records().length).toBe(2);
  });

  it('DEFAULT_MAX_FILE_SIZE_BYTES is 512 KB', () => {
    expect(DEFAULT_MAX_FILE_SIZE_BYTES).toBe(512 * 1024);
  });
});

describe('getMaxFileSizeBannerMessage', () => {
  const ORIGINAL = process.env.GITNEXUS_MAX_FILE_SIZE;
  let cap: ReturnType<typeof _captureLogger>;

  beforeEach(() => {
    delete process.env.GITNEXUS_MAX_FILE_SIZE;
    _resetMaxFileSizeWarnings();
    cap = _captureLogger();
  });

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.GITNEXUS_MAX_FILE_SIZE;
    } else {
      process.env.GITNEXUS_MAX_FILE_SIZE = ORIGINAL;
    }
    cap.restore();
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
