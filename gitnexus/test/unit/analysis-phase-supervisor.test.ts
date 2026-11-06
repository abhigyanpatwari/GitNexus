import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  projectPreparedAnalysisHandoff,
  publishAnalysisAfterProcessExit,
  type AnalysisPhasePublicationActions,
  type PreparedAnalysisHandoff,
} from '../../src/core/analysis-phase-supervisor.js';
import { waitForAnalysisProcessExit } from '../helpers/analysis-process-exit.js';
import {
  readPreparedAnalysis,
  publishPreparedAnalysis,
} from '../../src/core/analysis-publication.js';
import { acquireIndexLock } from '../../src/storage/index-lock.js';
import { loadMeta, saveMeta } from '../../src/storage/repo-manager.js';
import type { RepoMeta } from '../../src/storage/repo-meta.js';

const roots: string[] = [];
const children: { child: ChildProcess; exited: Promise<void> }[] = [];
afterEach(async () => {
  for (const { child, exited } of children.splice(0)) {
    if (child.connected) child.send({ exitCode: 0 });
    await exited.catch(() => {});
  }
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gn-phase-')));
  roots.push(root);
  const repoPath = path.join(root, 'repo');
  await fs.mkdir(repoPath);
  const commit = 'a'.repeat(40);
  const metadata: RepoMeta = {
    repoPath,
    lastCommit: commit,
    indexedAt: '2026-11-04T00:00:00Z',
    runnerIdentity: { schemaVersion: 4 } as RepoMeta['runnerIdentity'],
  };
  await saveMeta(root, metadata);
  await fs.writeFile(path.join(root, 'lbug'), 'old graph');
  const stage = path.join(root, `lbug.staging.${randomUUID()}`);
  await fs.writeFile(stage, 'new graph');
  const target = {
    repoPath,
    storagePath: root,
    metadataDirectory: root,
    repoName: 'fixture',
    commit,
  };
  const moduleUrl = new URL('../../dist/core/analysis-publication.js', import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { prepareAnalysisPublication } from ${JSON.stringify(moduleUrl)};
    process.once('message', async ({ root, stage, metadata, target }) => {
      const receipt = await prepareAnalysisPublication(root, stage, metadata, 'b'.repeat(64), { waitForProcessExit: true });
      process.once('message', ({ exitCode }) => { process.exitCode = exitCode; process.disconnect(); });
      process.send({ ...target, version: 1, publicationId: receipt.id });
    });
  `,
    ],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
  );
  const exited = waitForAnalysisProcessExit(child);
  // Keep rejection observed even when an assertion fails before awaiting it.
  void exited.catch(() => {});
  children.push({ child, exited });
  const writerPid = child.pid;
  if (writerPid === undefined) throw new Error('Graph fixture did not spawn');
  const prepared = new Promise<PreparedAnalysisHandoff>((resolve) =>
    child.once('message', (value) => {
      resolve(projectPreparedAnalysisHandoff(value));
    }),
  );
  child.send({ root, stage, metadata, target });
  const handoff = await Promise.race([
    prepared,
    exited.then(() => {
      throw new Error('Writer exited before preparation');
    }),
  ]);
  const actions: AnalysisPhasePublicationActions = {
    resolveTarget: vi.fn(async () => ({ ...target })),
    saveMetadata: (value) => saveMeta(root, value),
    verify: vi.fn(async (file) => {
      expect(await fs.readFile(file, 'utf8')).toBe('new graph');
    }),
    finalizeGraph: vi.fn(async (value) => value),
  };
  const release = (exitCode = 0) => child.send({ exitCode });
  const finish = async () => {
    await exited;
    return publishAnalysisAfterProcessExit(handoff, writerPid, actions);
  };
  return { root, child, writerPid, exited, handoff, metadata, target, actions, release, finish };
}

describe('graph process handoff', () => {
  it('continues when a waiting writer already recovered the exact publication', async () => {
    const f = await fixture();
    f.release();
    await f.exited;
    const recovered = await publishPreparedAnalysis(f.root, f.actions);
    expect(await readPreparedAnalysis(f.root)).toBeUndefined();
    expect((await f.finish()).graphGeneration).toEqual(recovered?.graphGeneration);
    expect(f.actions.finalizeGraph).toHaveBeenCalledOnce();
    expect(f.actions.verify).toHaveBeenCalledOnce();
  });

  it.each(['foreign', 'dirty', 'collapsed', 'commit'] as const)(
    'rejects a %s publication without a receipt',
    async (state) => {
      const f = await fixture();
      f.release();
      await f.exited;
      const recovered = await publishPreparedAnalysis(f.root, f.actions);
      if (!recovered) throw new Error('Missing publication');
      await saveMeta(f.root, {
        ...recovered,
        ...(state === 'foreign'
          ? { graphGeneration: { ...recovered.graphGeneration!, id: 'e'.repeat(32) } }
          : {}),
        ...(state === 'dirty' ? { incrementalInProgress: { startedAt: 1, toWriteCount: 1 } } : {}),
        ...(state === 'collapsed' ? { graphWriteCollapsed: { expected: 10, persisted: 1 } } : {}),
        ...(state === 'commit' ? { lastCommit: 'f'.repeat(40) } : {}),
      } as RepoMeta);
      await expect(f.finish()).rejects.toThrow('attempt changed');
      expect(f.actions.finalizeGraph).not.toHaveBeenCalled();
    },
  );
  it('keeps prepared nonterminal and publishes only after actual exit', async () => {
    const f = await fixture();
    const provider = vi.fn();
    const finishing = f.finish().then((metadata) => {
      provider();
      return metadata;
    });
    await new Promise(setImmediate);
    expect(f.child.exitCode).toBeNull();
    expect(f.actions.verify).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
    f.release();
    const published = await finishing;
    expect(published.graphGeneration?.id).toBe(f.handoff.publicationId);
    expect(f.actions.finalizeGraph).toHaveBeenCalledOnce();
    expect(f.actions.resolveTarget).toHaveBeenCalledTimes(3);
    expect(provider).toHaveBeenCalledOnce();
  });

  it('rejects an early caller independently of its process-exit waiter', async () => {
    const f = await fixture();
    await expect(
      publishAnalysisAfterProcessExit(f.handoff, f.writerPid, f.actions),
    ).rejects.toThrow('has not exited');
    expect(f.actions.verify).not.toHaveBeenCalled();
    expect(await readPreparedAnalysis(f.root)).toBeDefined();
  });

  it('retains artifacts when the child exits unsuccessfully after preparing', async () => {
    const f = await fixture();
    const finishing = f.finish();
    f.release(1);
    await expect(finishing).rejects.toThrow('unsuccessfully');
    expect(f.actions.verify).not.toHaveBeenCalled();
    expect(await readPreparedAnalysis(f.root)).toBeDefined();
  });

  it('waits for exit after cancellation and never admits a new phase', async () => {
    const f = await fixture();
    const controller = new AbortController();
    f.actions.signal = controller.signal;
    let settled = false;
    const finishing = f.finish().finally(() => {
      settled = true;
    });
    controller.abort(new Error('cancelled'));
    await new Promise(setImmediate);
    expect(settled).toBe(false);
    expect(f.child.exitCode).toBeNull();
    f.release();
    await expect(finishing).rejects.toThrow('cancelled');
    expect(f.actions.verify).not.toHaveBeenCalled();
    expect(await readPreparedAnalysis(f.root)).toBeDefined();
  });

  it.each(['repoName', 'metadataDirectory', 'storagePath', 'commit'] as const)(
    'rechecks %s after waiting for the existing slot lock',
    async (field) => {
      const f = await fixture();
      const held = await acquireIndexLock(f.root, { sweep: false });
      let startedWaiting!: () => void;
      const waiting = new Promise<void>((resolve) => {
        startedWaiting = resolve;
      });
      f.actions.onWaitStart = startedWaiting;
      const finishing = f.finish();
      try {
        f.release();
        await waiting;
        f.actions.resolveTarget = async () => ({
          ...f.target,
          [field]: f.target[field] + '-changed',
        });
      } finally {
        held.release();
      }
      await expect(finishing).rejects.toThrow('changed during');
      expect(f.actions.verify).not.toHaveBeenCalled();
      expect(await readPreparedAnalysis(f.root)).toBeDefined();
    },
  );

  it('rejects a superseding writer even when the target and commit did not change', async () => {
    const f = await fixture();
    f.release();
    await f.exited;
    await saveMeta(f.root, { ...f.metadata, indexedAt: 'newer writer' });
    await expect(f.finish()).rejects.toThrow('superseded');
    expect(f.actions.verify).not.toHaveBeenCalled();
    expect((await loadMeta(f.root))?.indexedAt).toBe('newer writer');
  });

  it('rejects a different attempt or writer before opening native resources', async () => {
    const f = await fixture();
    f.release();
    await f.exited;
    await expect(
      publishAnalysisAfterProcessExit(
        { ...f.handoff, publicationId: 'c'.repeat(32) },
        f.writerPid,
        f.actions,
      ),
    ).rejects.toThrow('attempt changed');
    await expect(
      publishAnalysisAfterProcessExit(f.handoff, f.writerPid + 1, f.actions),
    ).rejects.toThrow('attempt changed');
    expect(f.actions.verify).not.toHaveBeenCalled();
  });

  it('preserves the published graph when finalization fails', async () => {
    const f = await fixture();
    f.actions.finalizeGraph = async () => {
      throw new Error('registry unavailable');
    };
    f.release();
    await expect(f.finish()).rejects.toThrow('registry unavailable');
    const metadata = await loadMeta(f.root);
    expect(metadata?.graphGeneration?.id).toBe(f.handoff.publicationId);
    const graphFile = metadata?.graphPath;
    if (!graphFile) throw new Error('Published graph path is missing');
    expect(await fs.readFile(path.join(f.root, graphFile), 'utf8')).toBe('new graph');
  });

  it('finishes graph discoverability if cancellation arrives after publication', async () => {
    const f = await fixture();
    const controller = new AbortController();
    f.actions.signal = controller.signal;
    const finalized = vi.fn(async (metadata: RepoMeta) => {
      controller.abort(new Error('cancelled after publication'));
      return metadata;
    });
    f.actions.finalizeGraph = finalized;
    f.release();
    await expect(f.finish()).rejects.toThrow('cancelled after publication');
    expect(finalized).toHaveBeenCalledOnce();
    expect((await loadMeta(f.root))?.graphGeneration?.id).toBe(f.handoff.publicationId);
  });

  it('projects a bounded allowlist without traversing a live graph', async () => {
    const f = await fixture();
    const source = {
      ...f.handoff,
      get pipelineResult(): never {
        throw new Error('materialized graph');
      },
    };
    const projected = projectPreparedAnalysisHandoff(source);
    expect(projected).toEqual(f.handoff);
    expect(JSON.stringify(projected).length).toBeLessThan(2048);
    expect(() =>
      projectPreparedAnalysisHandoff({ ...f.handoff, repoName: 'x'.repeat(1025) }),
    ).toThrow('repoName');
    expect(() =>
      projectPreparedAnalysisHandoff({ ...f.handoff, metadataDirectory: '../foreign' }),
    ).toThrow();
  });
});
