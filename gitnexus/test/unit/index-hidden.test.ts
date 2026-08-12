import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_INDEX_HIDDEN,
  isIndexHiddenEnabled,
  getIndexHiddenBannerMessage,
  _resetIndexHiddenWarnings,
} from '../../src/core/ingestion/utils/index-hidden.js';
import { _captureLogger } from '../../src/core/logger.js';

describe('isIndexHiddenEnabled', () => {
  const ORIGINAL = process.env.GITNEXUS_INDEX_HIDDEN;
  let cap: ReturnType<typeof _captureLogger>;

  beforeEach(() => {
    delete process.env.GITNEXUS_INDEX_HIDDEN;
    _resetIndexHiddenWarnings();
    cap = _captureLogger();
  });

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.GITNEXUS_INDEX_HIDDEN;
    } else {
      process.env.GITNEXUS_INDEX_HIDDEN = ORIGINAL;
    }
    cap.restore();
  });

  it('defaults to excluding hidden paths when the env var is unset', () => {
    expect(isIndexHiddenEnabled()).toBe(DEFAULT_INDEX_HIDDEN);
    expect(DEFAULT_INDEX_HIDDEN).toBe(false);
    expect(cap.records().length).toBe(0);
  });

  it('treats an empty value as unset rather than as a directive', () => {
    process.env.GITNEXUS_INDEX_HIDDEN = '';
    expect(isIndexHiddenEnabled()).toBe(DEFAULT_INDEX_HIDDEN);
    expect(cap.records().length).toBe(0);
  });

  for (const truthy of ['1', 'true', 'TRUE', ' true ']) {
    it(`enables hidden-path indexing for ${JSON.stringify(truthy)}`, () => {
      process.env.GITNEXUS_INDEX_HIDDEN = truthy;
      expect(isIndexHiddenEnabled()).toBe(true);
      expect(cap.records().length).toBe(0);
    });
  }

  for (const falsy of ['0', 'false', 'FALSE', ' false ']) {
    it(`keeps hidden paths excluded for ${JSON.stringify(falsy)}`, () => {
      process.env.GITNEXUS_INDEX_HIDDEN = falsy;
      expect(isIndexHiddenEnabled()).toBe(false);
      expect(cap.records().length).toBe(0);
    });
  }

  it('falls back to the default and warns once on an unparseable value', () => {
    process.env.GITNEXUS_INDEX_HIDDEN = 'yes-please';
    expect(isIndexHiddenEnabled()).toBe(DEFAULT_INDEX_HIDDEN);

    const records = cap.records();
    expect(records.length).toBe(1);
    expect(records[0]?.msg).toContain('GITNEXUS_INDEX_HIDDEN');

    // Repeated reads must not re-warn — the walker calls this per analyze run.
    expect(isIndexHiddenEnabled()).toBe(DEFAULT_INDEX_HIDDEN);
    expect(cap.records().length).toBe(1);
  });
});

describe('getIndexHiddenBannerMessage', () => {
  const ORIGINAL = process.env.GITNEXUS_INDEX_HIDDEN;

  beforeEach(() => {
    delete process.env.GITNEXUS_INDEX_HIDDEN;
    _resetIndexHiddenWarnings();
  });

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.GITNEXUS_INDEX_HIDDEN;
    } else {
      process.env.GITNEXUS_INDEX_HIDDEN = ORIGINAL;
    }
  });

  it('returns null when the effective setting equals the default', () => {
    expect(getIndexHiddenBannerMessage()).toBeNull();
  });

  it('returns null when explicitly set to the default value', () => {
    process.env.GITNEXUS_INDEX_HIDDEN = '0';
    expect(getIndexHiddenBannerMessage()).toBeNull();
  });

  it('announces the override when hidden-path indexing is enabled', () => {
    process.env.GITNEXUS_INDEX_HIDDEN = '1';
    const banner = getIndexHiddenBannerMessage();
    expect(banner).toContain('GITNEXUS_INDEX_HIDDEN');
    // Operators must be told the safety net still applies.
    expect(banner).toContain('DEFAULT_IGNORE_LIST');
  });
});
