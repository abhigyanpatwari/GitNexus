/**
 * Unit Tests: per-file index freshness (core/index-content-drift.ts)
 *
 * Issue #3077: `status` answered "is the index fresh?" with a repo-wide
 * `git status --porcelain` boolean, so a modified or untracked file the index
 * never reads pinned the verdict to "stale" — and because `analyze` cannot
 * commit or delete that file, the advice it printed could never clear it.
 *
 * These tests use real temporary directories rather than mocks: the whole
 * point of the helper is that it reuses analyze's own scan, so the ignore
 * rules and the large-file cap are exactly what the assertions are about.
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

import { detectIndexContentDrift } from '../../src/core/index-content-drift.js';
import { walkRepositoryPaths } from '../../src/core/ingestion/filesystem-walker.js';
import { computeFileHashes } from '../../src/storage/file-hash.js';
import {
  GITNEXUS_MANAGED_PATH_EXCLUDES,
  isGitNexusManagedPath,
} from '../../src/storage/gitnexus-managed-paths.js';

const isolatedTmpRoot = (() => {
  const root =
    process.platform === 'win32'
      ? path.join(path.parse(os.tmpdir()).root, 'gitnexus-drift')
      : path.join(os.tmpdir(), 'gitnexus-drift');
  fs.mkdirSync(root, { recursive: true });
  return root;
})();

const createdRepos: string[] = [];

const makeRepo = (files: Record<string, string>): string => {
  const dir = fs.mkdtempSync(path.join(isolatedTmpRoot, 'repo-'));
  createdRepos.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
};

/** Reproduce what `analyze` records in `meta.fileHashes` for a repository. */
const recordCoverage = async (repoPath: string): Promise<Record<string, string>> => {
  const scanned = await walkRepositoryPaths(repoPath);
  const hashes = await computeFileHashes(
    repoPath,
    scanned.map((f) => f.path),
  );
  return Object.fromEntries(hashes);
};

afterEach(() => {
  while (createdRepos.length > 0) {
    fs.rmSync(createdRepos.pop()!, { recursive: true, force: true });
  }
});

describe('detectIndexContentDrift', () => {
  it('reports current when every covered file still matches disk', async () => {
    const repo = makeRepo({ 'a.js': 'export const a = 1;\n' });
    const recorded = await recordCoverage(repo);

    const drift = await detectIndexContentDrift(repo, recorded);

    expect(drift).toEqual({ kind: 'current', coveredFileCount: Object.keys(recorded).length });
  });

  it('stays current when a file the index does not cover is modified (#3077)', async () => {
    // `.lock` is an ignored extension, so the indexer never reads this file.
    // Under the old repo-wide dirty check its edit forced an unclearable
    // "stale" verdict on an index that was byte-current with its own coverage.
    const repo = makeRepo({
      'a.js': 'export const a = 1;\n',
      'toolingdir/state.lock': 'before\n',
    });
    const recorded = await recordCoverage(repo);
    expect(Object.keys(recorded)).not.toContain('toolingdir/state.lock');

    fs.writeFileSync(path.join(repo, 'toolingdir/state.lock'), 'after\n');

    expect(await detectIndexContentDrift(repo, recorded)).toMatchObject({ kind: 'current' });
  });

  it('stays current when an ignored directory changes', async () => {
    const repo = makeRepo({ 'a.js': 'export const a = 1;\n' });
    const recorded = await recordCoverage(repo);

    fs.mkdirSync(path.join(repo, 'node_modules', 'left-pad'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'node_modules', 'left-pad', 'index.js'),
      'module.exports=1;\n',
    );

    expect(await detectIndexContentDrift(repo, recorded)).toMatchObject({ kind: 'current' });
  });

  it('reports the covered file that changed', async () => {
    const repo = makeRepo({ 'a.js': 'export const a = 1;\n', 'b.js': 'export const b = 2;\n' });
    const recorded = await recordCoverage(repo);

    fs.writeFileSync(path.join(repo, 'b.js'), 'export const b = 3;\n');

    const drift = await detectIndexContentDrift(repo, recorded);
    expect(drift).toMatchObject({ kind: 'drifted', changed: ['b.js'], added: [], deleted: [] });
  });

  it('reports a new coverable file as added rather than certifying the index', async () => {
    // The index is missing a file `analyze` would pick up, so "up-to-date"
    // would be a false all-clear even though every recorded hash matches.
    const repo = makeRepo({ 'a.js': 'export const a = 1;\n' });
    const recorded = await recordCoverage(repo);

    fs.writeFileSync(path.join(repo, 'new-source.js'), 'export const n = 1;\n');

    expect(await detectIndexContentDrift(repo, recorded)).toMatchObject({
      kind: 'drifted',
      added: ['new-source.js'],
      changed: [],
    });
  });

  it('reports a removed covered file as deleted', async () => {
    const repo = makeRepo({ 'a.js': 'export const a = 1;\n', 'b.js': 'export const b = 2;\n' });
    const recorded = await recordCoverage(repo);

    fs.rmSync(path.join(repo, 'b.js'));

    expect(await detectIndexContentDrift(repo, recorded)).toMatchObject({
      kind: 'drifted',
      deleted: ['b.js'],
      changed: [],
    });
  });

  it('clears back to current once the coverage set is re-recorded', async () => {
    // The loop the issue reports: `analyze` ran, reported success, and the
    // verdict did not move. Re-recording coverage must settle the verdict.
    const repo = makeRepo({ 'a.js': 'export const a = 1;\n' });
    const stale = await recordCoverage(repo);
    fs.writeFileSync(path.join(repo, 'notes.txt'), 'scratch\n');
    expect(await detectIndexContentDrift(repo, stale)).toMatchObject({ kind: 'drifted' });

    const reanalyzed = await recordCoverage(repo);

    expect(await detectIndexContentDrift(repo, reanalyzed)).toMatchObject({ kind: 'current' });
  });

  it("ignores GitNexus's own analyze output on both sides", async () => {
    // analyze rewrites AGENTS.md/CLAUDE.md after recording hashes. Counting
    // them made a freshly indexed repo report itself stale: absent from the
    // first run's coverage, then rewritten on every run after that.
    const repo = makeRepo({ 'a.js': 'export const a = 1;\n' });
    const firstRun = await recordCoverage(repo);
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'stats block\n');
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), 'stats block\n');

    expect(await detectIndexContentDrift(repo, firstRun)).toMatchObject({ kind: 'current' });

    const secondRun = await recordCoverage(repo);
    expect(Object.keys(secondRun)).toContain('AGENTS.md');
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'refreshed stats block\n');

    expect(await detectIndexContentDrift(repo, secondRun)).toMatchObject({ kind: 'current' });
  });

  it('is unmeasurable, not current, when metadata carries no file hashes', async () => {
    const repo = makeRepo({ 'a.js': 'export const a = 1;\n' });

    expect(await detectIndexContentDrift(repo, undefined)).toEqual({
      kind: 'unmeasurable',
      reason: 'no-file-hashes',
    });
    expect(await detectIndexContentDrift(repo, {})).toEqual({
      kind: 'unmeasurable',
      reason: 'no-file-hashes',
    });
  });
});

describe('isGitNexusManagedPath', () => {
  it('matches managed files and whole managed trees', () => {
    expect(isGitNexusManagedPath('AGENTS.md')).toBe(true);
    expect(isGitNexusManagedPath('CLAUDE.md')).toBe(true);
    expect(isGitNexusManagedPath('.agents/skills/gitnexus-area-auth/SKILL.md')).toBe(true);
    expect(isGitNexusManagedPath('.gitnexus/meta.json')).toBe(true);
  });

  it('does not match prefix collisions or nested lookalikes', () => {
    // Same boundaries the `:(exclude)` pathspecs enforce for isWorkingTreeDirty.
    expect(isGitNexusManagedPath('.agentsrc')).toBe(false);
    expect(isGitNexusManagedPath('.claudefoo')).toBe(false);
    expect(isGitNexusManagedPath('subdir/.agents/x')).toBe(false);
    expect(isGitNexusManagedPath('docs/AGENTS.md')).toBe(false);
  });

  it('emits both the bare and recursive pathspec for every managed path', () => {
    expect(GITNEXUS_MANAGED_PATH_EXCLUDES).toContain(':(exclude)AGENTS.md');
    expect(GITNEXUS_MANAGED_PATH_EXCLUDES).toContain(':(exclude).agents');
    expect(GITNEXUS_MANAGED_PATH_EXCLUDES).toContain(':(exclude).agents/**');
  });
});

describe('walkRepositoryPaths quiet option', () => {
  const savedMaxFileSize = process.env.GITNEXUS_MAX_FILE_SIZE;
  const savedProgressActive = process.env.GITNEXUS_ANALYZE_PROGRESS_ACTIVE;

  afterEach(() => {
    if (savedMaxFileSize === undefined) delete process.env.GITNEXUS_MAX_FILE_SIZE;
    else process.env.GITNEXUS_MAX_FILE_SIZE = savedMaxFileSize;
    if (savedProgressActive === undefined) delete process.env.GITNEXUS_ANALYZE_PROGRESS_ACTIVE;
    else process.env.GITNEXUS_ANALYZE_PROGRESS_ACTIVE = savedProgressActive;
  });

  it('suppresses the large-file notice so read-only callers stay silent', async () => {
    const repo = makeRepo({ 'big.js': `// ${'x'.repeat(4096)}\n` });
    process.env.GITNEXUS_MAX_FILE_SIZE = '1'; // 1KB cap — big.js is skipped
    process.env.GITNEXUS_ANALYZE_PROGRESS_ACTIVE = '1'; // routes the notice to console.warn

    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args);
    try {
      const noisy = await walkRepositoryPaths(repo);
      const noisyCount = warnings.length;
      warnings.length = 0;
      const quiet = await walkRepositoryPaths(repo, undefined, { quiet: true });

      expect(noisyCount).toBeGreaterThan(0);
      expect(warnings).toEqual([]);
      expect(quiet).toEqual(noisy);
    } finally {
      console.warn = originalWarn;
    }
  });
});
