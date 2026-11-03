import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  prepareAnalysisPublication,
  publishPreparedAnalysis,
  readPreparedAnalysis,
} from '../../src/core/analysis-publication.js';
import { getStoragePaths, saveMeta } from '../../src/storage/repo-manager.js';
import { resolveGraphPath } from '../../src/storage/shared-store.js';
import type { RepoMeta } from '../../src/storage/repo-meta.js';

const directories: string[] = [];
const content = 'a'.repeat(64);
const metadata: RepoMeta = {
  repoPath: '/repo',
  lastCommit: 'abcdef',
  indexedAt: '2026-11-03T00:00:00Z',
  // Publication preserves the independently verified runner receipt verbatim.
  runnerIdentity: { schemaVersion: 4 } as RepoMeta['runnerIdentity'],
};
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gn-publication-')));
  directories.push(root);
  const stage = path.join(root, `lbug.staging.${randomUUID()}`);
  await fs.writeFile(stage, 'verified graph');
  await fs.writeFile(path.join(root, 'lbug'), 'previous graph');
  await saveMeta(root, metadata);
  const verify = vi.fn(async (file: string) => {
    expect(await fs.readFile(file, 'utf8')).toBe('verified graph');
  });
  const actions = { verify, saveMetadata: (meta: RepoMeta) => saveMeta(root, meta) };
  return { root, stage, actions };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

describe('durable graph publication', () => {
  it('publishes a verified generation and keeps the previous reader artifact', async () => {
    const { root, stage, actions } = await fixture();
    const receipt = await prepareAnalysisPublication(root, stage, metadata, content);
    expect(resolveGraphPath(root)).toBe(path.join(root, 'lbug'));
    const published = await publishPreparedAnalysis(root, actions);
    expect(published?.graphGeneration).toEqual({
      version: 1,
      id: receipt.id,
      coveredContent: content,
    });
    expect(actions.verify).toHaveBeenCalledOnce();
    expect(resolveGraphPath(root)).toBe(path.join(root, receipt.graphFile));
    if (!receipt.legacyGraphFile) throw new Error('Expected a retained legacy graph');
    expect(await fs.readFile(path.join(root, receipt.legacyGraphFile), 'utf8')).toBe(
      'previous graph',
    );
    await expect(fs.stat(path.join(root, 'lbug'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readPreparedAnalysis(root)).toBeUndefined();
    expect(await publishPreparedAnalysis(root, actions)).toBeUndefined();
    expect(await fs.readdir(root)).not.toContain(receipt.metadataFile);
  });

  it.each(['before-rename', 'after-rename', 'after-metadata'] as const)(
    'recovers a crash %s and re-verifies the native artifact',
    async (point) => {
      const { root, stage, actions } = await fixture();
      const receipt = await prepareAnalysisPublication(root, stage, metadata, content);
      if (point === 'before-rename') {
        await expect(
          publishPreparedAnalysis(root, {
            ...actions,
            verify: async () => {
              throw new Error('crash');
            },
          }),
        ).rejects.toThrow('crash');
      } else {
        await expect(
          publishPreparedAnalysis(root, {
            ...actions,
            saveMetadata: async (meta) => {
              if (point === 'after-metadata') await actions.saveMetadata(meta);
              throw new Error('crash');
            },
          }),
        ).rejects.toThrow('crash');
      }
      expect(await readPreparedAnalysis(root)).toEqual(receipt);
      actions.verify.mockClear();
      await publishPreparedAnalysis(root, actions);
      expect(actions.verify).toHaveBeenCalledOnce();
      expect(resolveGraphPath(root)).toBe(path.join(root, receipt.graphFile));
      expect(await readPreparedAnalysis(root)).toBeUndefined();
    },
  );

  it('retains recovery evidence when the metadata writer fails to publish the exact receipt', async () => {
    const { root, stage, actions } = await fixture();
    const receipt = await prepareAnalysisPublication(root, stage, metadata, content);
    await expect(
      publishPreparedAnalysis(root, { ...actions, saveMetadata: async () => {} }),
    ).rejects.toThrow('does not match');
    expect(await readPreparedAnalysis(root)).toEqual(receipt);
    await publishPreparedAnalysis(root, actions);
    expect(resolveGraphPath(root)).toBe(path.join(root, receipt.graphFile));
  });

  it('keeps a completed publication usable when redundant metadata cleanup fails', async () => {
    const { root, stage, actions } = await fixture();
    const receipt = await prepareAnalysisPublication(root, stage, metadata, content);
    const unlink = fs.unlink.bind(fs);
    vi.spyOn(fs, 'unlink').mockImplementation(async (file) => {
      if (String(file) === path.join(root, receipt.metadataFile)) throw new Error('cleanup failed');
      await unlink(file);
    });
    await expect(publishPreparedAnalysis(root, actions)).rejects.toThrow('cleanup failed');
    expect(await readPreparedAnalysis(root)).toBeUndefined();
    expect(resolveGraphPath(root)).toBe(path.join(root, receipt.graphFile));
    expect(await publishPreparedAnalysis(root, actions)).toBeUndefined();
  });

  it.each(['receipt', 'metadata', 'graph'] as const)(
    'rejects corrupted %s without publishing',
    async (artifact) => {
      const { root, stage, actions } = await fixture();
      const receipt = await prepareAnalysisPublication(root, stage, metadata, content);
      const file =
        artifact === 'receipt'
          ? 'analysis-publication.json'
          : artifact === 'metadata'
            ? receipt.metadataFile
            : receipt.stagingFile;
      await fs.writeFile(path.join(root, file), 'corrupt');
      await expect(publishPreparedAnalysis(root, actions)).rejects.toThrow();
      expect(resolveGraphPath(root)).toBe(path.join(root, 'lbug'));
      expect(await fs.readdir(root)).toContain('analysis-publication.json');
    },
  );

  it('refuses missing or conflicting graph artifacts', async () => {
    const { root, stage, actions } = await fixture();
    const receipt = await prepareAnalysisPublication(root, stage, metadata, content);
    await fs.writeFile(path.join(root, receipt.graphFile), 'conflict');
    await expect(publishPreparedAnalysis(root, actions)).rejects.toThrow('conflicting');
    await fs.unlink(path.join(root, receipt.graphFile));
    await fs.unlink(stage);
    await expect(publishPreparedAnalysis(root, actions)).rejects.toThrow('missing');
    expect(actions.verify).not.toHaveBeenCalled();
  });

  it('rejects outside paths, symlinks and a second uncommitted publication', async () => {
    const { root, stage } = await fixture();
    await expect(
      prepareAnalysisPublication(
        root,
        path.join(root, '..', path.basename(stage)),
        metadata,
        content,
      ),
    ).rejects.toThrow('outside');
    const link = path.join(root, `lbug.staging.${randomUUID()}`);
    await fs.symlink(stage, link);
    await expect(prepareAnalysisPublication(root, link, metadata, content)).rejects.toThrow(
      'regular file',
    );
    await prepareAnalysisPublication(root, stage, metadata, content);
    await expect(prepareAnalysisPublication(root, stage, metadata, content)).rejects.toThrow(
      'Recover',
    );
  });

  it('resolves private generations in branch slots and never falls back from a missing published file', async () => {
    const { root } = await fixture();
    const slot = path.dirname(getStoragePaths('/repo', 'feature', root).metaPath);
    const graphPath = `lbug.generation.${'b'.repeat(32)}`;
    await saveMeta(slot, { ...metadata, graphPath });
    expect(getStoragePaths('/repo', 'feature', root).lbugPath).toBe(path.join(slot, graphPath));
    await fs.symlink(path.join(root, 'lbug'), path.join(slot, graphPath));
    expect(() => getStoragePaths('/repo', 'feature', root)).toThrow('regular file');
  });
});
