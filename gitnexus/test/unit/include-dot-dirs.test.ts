import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getIncludeDotDirs,
  includeDotDirsCoverage,
  indexableGlobPatterns,
  normalizeIncludeDotDirs,
  _resetIncludeDotDirsWarnings,
} from '../../src/core/ingestion/utils/include-dot-dirs.js';
import { _captureLogger } from '../../src/core/logger.js';

describe('include-dot-dirs', () => {
  const ORIGINAL = process.env.GITNEXUS_INCLUDE_DOT_DIRS;
  let cap: ReturnType<typeof _captureLogger>;

  beforeEach(() => {
    delete process.env.GITNEXUS_INCLUDE_DOT_DIRS;
    _resetIncludeDotDirsWarnings();
    cap = _captureLogger();
  });

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.GITNEXUS_INCLUDE_DOT_DIRS;
    } else {
      process.env.GITNEXUS_INCLUDE_DOT_DIRS = ORIGINAL;
    }
    cap.restore();
  });

  it('returns no directories when the env var is unset', () => {
    expect(getIncludeDotDirs()).toEqual([]);
    expect(includeDotDirsCoverage()).toEqual({});
    expect(cap.records().length).toBe(0);
  });

  it('parses a comma-separated list, trimmed, deduplicated and sorted', () => {
    process.env.GITNEXUS_INCLUDE_DOT_DIRS = ' .scallywag, .github/,.scallywag ';
    expect(getIncludeDotDirs()).toEqual(['.github', '.scallywag']);
    expect(includeDotDirsCoverage()).toEqual({ includeDotDirs: ['.github', '.scallywag'] });
    expect(cap.records().length).toBe(0);
  });

  it('refuses version-control directories with a warning', () => {
    expect(normalizeIncludeDotDirs(['.git', '.hg', '.scallywag'])).toEqual(['.scallywag']);
    const messages = cap.records().map((r) => String(r.msg));
    expect(messages.some((m) => m.includes('".git"'))).toBe(true);
    expect(messages.some((m) => m.includes('".hg"'))).toBe(true);
  });

  it.each(['scallywag', '.', '..', 'a/.b', '.a/b', '.a\\b', '.{a,b}', '.a*', '.[ab]', '!.a'])(
    'rejects %j as not a plain dot-directory name',
    (entry) => {
      expect(normalizeIncludeDotDirs([entry])).toEqual([]);
      expect(cap.records().length).toBe(1);
    },
  );

  it('builds the default pattern alone when no directory is listed', () => {
    expect(indexableGlobPatterns([])).toEqual(['**/*']);
  });

  it('adds each listed directory at the root and at any depth', () => {
    expect(indexableGlobPatterns(['.github', '.scallywag'])).toEqual([
      '**/*',
      '.github/**/*',
      '**/.github/**/*',
      '.scallywag/**/*',
      '**/.scallywag/**/*',
    ]);
  });

  it('warns once per invalid entry', () => {
    normalizeIncludeDotDirs(['bad', 'bad']);
    normalizeIncludeDotDirs(['bad']);
    expect(cap.records().length).toBe(1);
  });
});
