import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { acquireIndexLock, sweepStagingArtifacts } from '../../src/storage/index-lock.js';
import {
  prepareAnalysisPublication,
  publishPreparedAnalysis,
} from '../../src/core/analysis-publication.js';
import { saveMeta } from '../../src/storage/repo-manager.js';
import type { RepoMeta } from '../../src/storage/repo-meta.js';

let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gn-prepared-sweep-')));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

it('keeps the prepared graph through ordinary lock reacquisition and then publishes it', async () => {
  const stage = path.join(root, `lbug.staging.${randomUUID()}`);
  await fs.writeFile(stage, 'verified graph');
  const metadata: RepoMeta = {
    repoPath: root,
    lastCommit: 'a'.repeat(40),
    indexedAt: '2026-11-04T00:00:00Z',
    runnerIdentity: { schemaVersion: 4 } as RepoMeta['runnerIdentity'],
  };
  await saveMeta(root, metadata);
  const prepared = await prepareAnalysisPublication(root, stage, metadata, 'b'.repeat(64));
  const lock = await acquireIndexLock(root);
  try {
    expect(await fs.readFile(stage, 'utf8')).toBe('verified graph');
    const published = await publishPreparedAnalysis(root, {
      verify: async (file) => {
        expect(await fs.readFile(file, 'utf8')).toBe('verified graph');
      },
      saveMetadata: (meta) => saveMeta(root, meta),
    });
    expect(published?.graphGeneration?.id).toBe(prepared.id);
  } finally {
    lock.release();
  }
});

it.each(['malformed', 'directory', 'dangling-link'])(
  'retains staging evidence when the prepared receipt is %s',
  async (kind) => {
    const receipt = path.join(root, 'analysis-publication.json');
    if (kind === 'directory') await fs.mkdir(receipt);
    else if (kind === 'dangling-link') await fs.symlink(path.join(root, 'missing'), receipt);
    else await fs.writeFile(receipt, '{');
    const stage = path.join(root, `lbug.staging.${randomUUID()}`);
    await fs.writeFile(stage, 'unverified but owned work');
    await fs.writeFile(stage + '.wal', 'native recovery evidence');
    sweepStagingArtifacts(root);
    expect(await fs.readFile(stage, 'utf8')).toBe('unverified but owned work');
    expect(await fs.readFile(stage + '.wal', 'utf8')).toBe('native recovery evidence');
  },
);

it('scopes the retention marker to its own locked branch slot', async () => {
  const branch = path.join(root, 'branches', 'feature');
  await fs.mkdir(branch, { recursive: true });
  await fs.writeFile(path.join(branch, 'analysis-publication.json'), '{');
  const name = `lbug.staging.${randomUUID()}`;
  await fs.writeFile(path.join(branch, name), 'branch work');
  await fs.writeFile(path.join(root, name), 'flat orphan');
  sweepStagingArtifacts(root);
  sweepStagingArtifacts(branch);
  await expect(fs.stat(path.join(root, name))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(path.join(branch, name), 'utf8')).toBe('branch work');
});
