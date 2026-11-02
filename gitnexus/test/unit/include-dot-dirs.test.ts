import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  getIncludeDotDirs,
  includeDotDirsCoverage,
  indexableGlobPatterns,
  normalizeIncludeDotDirs,
  filterDotDirectorySymlinks,
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

  it.each(['.GIT', '.SvN', '.HG', '.Bzr', '.ssh', '.AWS', '.azure', '.kube', '.gnupg', '.docker'])(
    'refuses the protected directory %s regardless of case',
    (entry) => {
      expect(normalizeIncludeDotDirs([entry])).toEqual([]);
    },
  );

  it.each(['...', '.git.', '.ssh.'])('rejects Windows path aliases such as %s', (entry) => {
    expect(normalizeIncludeDotDirs([entry])).toEqual([]);
  });

  it('does not echo invalid environment values into logs', () => {
    const invalid = 'SYNTHETIC_PRIVATE_VALUE\nforged log entry';
    normalizeIncludeDotDirs([invalid]);
    expect(cap.records()).toHaveLength(1);
    expect(JSON.stringify(cap.records())).not.toContain(invalid.split('\n')[0]);
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

  it('rejects already-enumerated paths beneath directory links before content discovery', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-dot-links-'));
    const repo = path.join(root, 'repo');
    const external = path.join(root, 'external');
    try {
      await fs.mkdir(path.join(repo, '.source'), { recursive: true });
      await fs.mkdir(path.join(external, '.source'), { recursive: true });
      await fs.writeFile(path.join(repo, '.source', 'allowed.h'), '#pragma once');
      await fs.writeFile(path.join(repo, 'visible.h'), '#pragma once');
      await fs.writeFile(path.join(external, 'private.h'), 'SYNTHETIC_TEST_ONLY');
      await fs.writeFile(path.join(external, '.source', 'private.h'), 'SYNTHETIC_TEST_ONLY');
      const linkType = process.platform === 'win32' ? 'junction' : 'dir';
      await fs.symlink(external, path.join(repo, '.linked'), linkType);
      await fs.symlink(external, path.join(repo, 'alias'), linkType);
      // Glob can emit these descendants while its cached parent type is unknown.
      const candidates = [
        '.linked/private.h',
        'alias/.source/private.h',
        '.source/missing.h',
        '.source/allowed.h',
        'visible.h',
      ];
      if (process.platform !== 'win32') {
        await fs.symlink(
          path.join(external, 'private.h'),
          path.join(repo, '.source', 'file-link.h'),
        );
        candidates.push('.source/file-link.h');
      }
      expect(await filterDotDirectorySymlinks(repo, candidates)).toEqual([
        '.source/allowed.h',
        'visible.h',
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when a dot-directory ancestor cannot be inspected', async () => {
    const error = Object.assign(new Error('unreadable directory'), { code: 'EACCES' });
    const lstat = vi.spyOn(fs, 'lstat').mockRejectedValue(error);
    try {
      await expect(filterDotDirectorySymlinks('/synthetic-repo', ['.source/file.h'])).rejects.toBe(
        error,
      );
    } finally {
      lstat.mockRestore();
    }
  });
});
