/**
 * Unit Tests: `status` freshness verdict from per-file drift (#3077)
 *
 * The reported defect was a verdict nobody could clear: any modified or
 * untracked file in the working tree — including files the index never reads —
 * made `status` print "stale (re-run gitnexus analyze)", and running `analyze`
 * left it unchanged. These tests pin the new decision order: the per-file
 * comparison decides when it can run, and the repo-wide dirty flag survives
 * only as the fallback for metadata written before `fileHashes` existed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { runnerIdentity } = vi.hoisted(() => ({
  runnerIdentity: {
    schemaVersion: 4 as const,
    runtime: {
      executablePath: '/usr/bin/node',
      version: 'v22.0.0',
      platform: 'linux',
      architecture: 'x64',
      modulesAbi: '127',
      libc: 'glibc:2.39',
    },
    cliVersion: '1.6.10',
    invokedArtifact: { path: '/opt/gitnexus/dist/cli/index.js', digest: 'sha256:entry' },
    build: {
      kind: 'distribution' as const,
      rootPath: '/opt/gitnexus/dist',
      canonicalization: 'gitnexus-analyzer-build-v2' as const,
      digest: 'sha256:build',
    },
    dependencyRuntime: {
      manifestPath: '/opt/gitnexus/package.json',
      lockfilePath: '/opt/package-lock.json',
      canonicalization: 'gitnexus-analyzer-dependency-runtime-v4' as const,
      packageCount: 42,
      artifactCount: 12,
      digest: 'sha256:dependencies',
    },
  },
}));

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn(),
  findRepo: vi.fn(),
  getStoragePaths: vi.fn((repoPath: string) => ({
    storagePath: `${repoPath}/.gitnexus`,
    lbugPath: `${repoPath}/.gitnexus/lbug`,
    metaPath: `${repoPath}/.gitnexus/meta.json`,
  })),
  loadMeta: vi.fn(),
  hasKuzuIndex: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../src/core/analyzer-identity.js', () => ({
  resolveAnalyzerRunnerIdentity: vi.fn(() => runnerIdentity),
  analyzerRunnerIdentitiesEqual: vi.fn((indexed: unknown, current: unknown) => indexed === current),
}));

vi.mock('../../src/storage/git.js', () => ({
  isGitRepo: vi.fn().mockReturnValue(true),
  getCurrentCommit: vi.fn().mockReturnValue('headsha0'),
  getCurrentBranch: vi.fn().mockReturnValue('main'),
  getGitRoot: vi.fn((p: string) => p),
  isWorkingTreeDirty: vi.fn().mockReturnValue(false),
}));

vi.mock('../../src/core/index-content-drift.js', () => ({
  detectIndexContentDrift: vi.fn(),
}));

import { statusCommand } from '../../src/cli/status.js';
import { findRepo } from '../../src/storage/repo-manager.js';
import { getCurrentCommit, isWorkingTreeDirty } from '../../src/storage/git.js';
import { detectIndexContentDrift } from '../../src/core/index-content-drift.js';

let logSpy: ReturnType<typeof vi.spyOn>;
const output = () => logSpy.mock.calls.map((c) => c.join(' ')).join('\n');

const repoWithCoverage = {
  repoPath: '/repo',
  storagePath: '/repo/.gitnexus',
  lbugPath: '/repo/.gitnexus/lbug',
  metaPath: '/repo/.gitnexus/meta.json',
  meta: {
    repoPath: '/repo',
    lastCommit: 'headsha0',
    indexedAt: '2026-08-28T12:00:00.000Z',
    branch: 'main',
    runnerIdentity,
    fileHashes: { 'a.js': 'sha-a' },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  (findRepo as any).mockResolvedValue(repoWithCoverage);
  (getCurrentCommit as any).mockReturnValue('headsha0');
  (isWorkingTreeDirty as any).mockReturnValue(false);
});

describe('status freshness from per-file drift (#3077)', () => {
  it('is up-to-date when every covered file matches, despite a dirty working tree', async () => {
    // The reported case: one modified file outside the index's coverage. The
    // old repo-wide check called this stale and `analyze` could not clear it.
    (isWorkingTreeDirty as any).mockReturnValue(true);
    (detectIndexContentDrift as any).mockResolvedValue({ kind: 'current', coveredFileCount: 210 });

    await statusCommand({ json: true });

    expect(JSON.parse(output())).toMatchObject({
      status: 'up-to-date',
      contentDrift: { status: 'current', coveredFiles: 210 },
    });
  });

  it('reports covered-file drift as stale and names the files', async () => {
    (detectIndexContentDrift as any).mockResolvedValue({
      kind: 'drifted',
      changed: ['src/app.ts'],
      added: [],
      deleted: [],
    });

    await statusCommand();

    const out = output();
    expect(out).not.toContain('up-to-date');
    expect(out).toContain('1 changed, 0 added, 0 deleted');
    expect(out).toContain('src/app.ts');
  });

  it('exposes drift counts and a capped sample in --json', async () => {
    const changed = Array.from({ length: 25 }, (_, i) => `src/file-${i}.ts`);
    (detectIndexContentDrift as any).mockResolvedValue({
      kind: 'drifted',
      changed,
      added: [],
      deleted: [],
    });

    await statusCommand({ json: true });

    const parsed = JSON.parse(output());
    expect(parsed.status).toBe('stale');
    expect(parsed.contentDrift.counts).toEqual({ changed: 25, added: 0, deleted: 0 });
    expect(parsed.contentDrift.changed).toHaveLength(10);
  });

  it('falls back to the working-tree check when coverage cannot be compared', async () => {
    (detectIndexContentDrift as any).mockResolvedValue({
      kind: 'unmeasurable',
      reason: 'no-file-hashes',
    });
    (isWorkingTreeDirty as any).mockReturnValue(true);

    await statusCommand({ json: true });

    expect(JSON.parse(output())).toMatchObject({
      status: 'stale',
      contentDrift: { status: 'unmeasurable', reason: 'no-file-hashes' },
    });
  });

  it('is up-to-date on a clean tree when coverage cannot be compared', async () => {
    (detectIndexContentDrift as any).mockResolvedValue({
      kind: 'unmeasurable',
      reason: 'scan-failed',
    });

    await statusCommand({ json: true });

    expect(JSON.parse(output())).toMatchObject({ status: 'up-to-date' });
  });

  it('skips the scan when the index is already stale on metadata alone', async () => {
    // A moved HEAD is decided without paying for a repository-wide hash pass.
    (getCurrentCommit as any).mockReturnValue('othersha');

    await statusCommand({ json: true });

    expect(detectIndexContentDrift).not.toHaveBeenCalled();
    expect(JSON.parse(output())).toMatchObject({
      status: 'stale',
      contentDrift: { status: 'not-checked' },
    });
  });
});
