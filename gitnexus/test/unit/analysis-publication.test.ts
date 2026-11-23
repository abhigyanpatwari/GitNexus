import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import * as indexLock from '../../src/storage/index-lock.js';
import * as writerIdentity from '../../src/core/analysis-writer-identity.js';
import { recordLegacyEmbeddingSource } from '../../src/storage/legacy-embedding-source.js';
import { reclaimAnalysisArtifacts } from '../../src/storage/analysis-artifact-cleanup.js';
import { adoptEmbeddingArtifact } from '../../src/storage/embedding-artifact.js';
import { writeEmbeddingJobRecord } from '../../src/storage/embedding-job.js';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beginInPlaceAnalysis,
  prepareAnalysisPublication,
  publishPreparedAnalysis,
  readPreparedAnalysis,
} from '../../src/core/analysis-publication.js';
import { getStoragePaths, loadMeta, saveMeta } from '../../src/storage/repo-manager.js';
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
  it('makes metadata durable before publishing the recovery receipt', async () => {
    const { root, stage } = await fixture();
    const events: string[] = [];
    const open = fs.open.bind(fs);
    const rename = fs.rename.bind(fs);
    const label = (file: string) =>
      file === root
        ? 'directory'
        : path.basename(file).includes('analysis-meta-')
          ? 'metadata'
          : 'receipt';
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        await sync();
        events.push(`sync:${label(String(args[0]))}`);
      });
      return handle;
    });
    vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      await rename(...args);
      events.push(`rename:${label(String(args[1]))}`);
    });
    await prepareAnalysisPublication(root, stage, metadata, content);
    const directorySync = process.platform === 'win32' ? [] : ['sync:directory'];
    expect(events).toEqual([
      'sync:metadata',
      'rename:metadata',
      ...directorySync,
      'sync:receipt',
      'rename:receipt',
      ...directorySync,
    ]);
  });

  it('bounds superseded graph generations across repeated staged publications', async () => {
    const { root, actions } = await fixture();
    for (let i = 0; i < 5; i++) {
      const stage = path.join(root, `lbug.staging.${randomUUID()}`);
      await fs.writeFile(stage, 'verified graph');
      await prepareAnalysisPublication(root, stage, (await loadMeta(root))!, content);
      await publishPreparedAnalysis(root, actions);
    }
    const graphs = (await fs.readdir(root)).filter((name) =>
      /^lbug\.generation\.[a-f0-9]{32}$/.test(name),
    );
    expect(graphs).toHaveLength(2);
    expect(graphs).toContain((await loadMeta(root))?.graphPath);
  });

  it('reclaims attempt metadata orphaned before its publication receipt was written', async () => {
    const { root, stage } = await fixture();
    const rename = fs.rename.bind(fs);
    const interrupted = vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      if (path.basename(String(target)) === 'analysis-publication.json')
        throw new Error('Interrupted before receipt');
      await rename(source, target);
    });
    await expect(prepareAnalysisPublication(root, stage, metadata, content)).rejects.toThrow(
      'Interrupted before receipt',
    );
    interrupted.mockRestore();
    const orphan = (await fs.readdir(root)).find((name) =>
      /^analysis-meta-[a-f0-9]{32}\.json$/.test(name),
    );
    expect(orphan).toBeDefined();
    await fs.writeFile(path.join(root, 'analysis-meta-not-owned.json'), 'keep');
    await reclaimAnalysisArtifacts(root, metadata);
    expect(await fs.readdir(root)).not.toContain(orphan);
    expect(await fs.readFile(path.join(root, 'analysis-meta-not-owned.json'), 'utf8')).toBe('keep');
    expect(await loadMeta(root)).toEqual(metadata);

    const pending = await prepareAnalysisPublication(root, stage, metadata, content);
    await reclaimAnalysisArtifacts(root, metadata);
    expect(await readPreparedAnalysis(root)).toEqual(pending);
    expect(await fs.readFile(path.join(root, pending.metadataFile), 'utf8')).toContain(content);
  });

  it('retains paid vectors when an ownership space was renamed', async () => {
    const { root } = await fixture();
    const identity = 'a'.repeat(64);
    const job = path.join(root, 'embeddings', identity);
    await fs.mkdir(job, { recursive: true });
    await writeEmbeddingJobRecord(job, 'job.json', { version: 1, identity });
    await fs.writeFile(path.join(job, 'vectors'), 'paid vectors');
    const record = await adoptEmbeddingArtifact(
      root,
      {
        vectorIdentity: 'b'.repeat(64),
        inputIdentity: 'c'.repeat(64),
        dimensions: 4,
        schema: 'fixture',
      },
      null,
      {
        artifactIdentity: identity,
        jobIdentity: identity,
        graphGeneration: 'd'.repeat(32),
        sourceIdentity: 'e'.repeat(64),
        manifestDigest: 'f'.repeat(64),
        phase: 'pending',
        revalidateInputs: false,
      },
      async () => {},
    );
    const parent = path.join(root, 'embeddings', 'spaces');
    await fs.rename(path.join(parent, record.spaceKey), path.join(parent, 'renamed-space'));
    const warn = vi.fn();
    await reclaimAnalysisArtifacts(root, metadata, undefined, warn);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Unexpected embedding space entry'));
    expect(await fs.readFile(path.join(job, 'vectors'), 'utf8')).toBe('paid vectors');
    expect(await fs.readFile(path.join(job, 'job.json'), 'utf8')).toContain(identity);
    await expect(
      reclaimAnalysisArtifacts(root, metadata, undefined, undefined, true),
    ).rejects.toThrow('Unexpected embedding space entry');
    expect(await fs.readFile(path.join(job, 'vectors'), 'utf8')).toBe('paid vectors');
  });

  it.each(['pending', 'sealed'] as const)(
    'reclaims unreferenced jobs and obsolete graphs for a %s model owner',
    async (phase) => {
      const { root } = await fixture();
      const current = 'a'.repeat(64),
        fallback = 'b'.repeat(64),
        orphan = 'c'.repeat(64);
      const ownerGraph = path.join(root, `lbug.generation.${'f'.repeat(32)}`);
      await fs.writeFile(ownerGraph, 'old owner graph');
      for (const id of [current, fallback, orphan]) {
        const directory = path.join(root, 'embeddings', id);
        await fs.mkdir(directory, { recursive: true });
        await writeEmbeddingJobRecord(directory, 'job.json', { version: 1, identity: id });
        await fs.writeFile(path.join(directory, 'vectors'), 'paid vectors');
      }
      await adoptEmbeddingArtifact(
        root,
        {
          vectorIdentity: 'd'.repeat(64),
          inputIdentity: 'e'.repeat(64),
          dimensions: 4,
          schema: 'fixture',
        },
        null,
        {
          artifactIdentity: current,
          jobIdentity: current,
          fallbackArtifact: fallback,
          graphGeneration: 'f'.repeat(32),
          sourceIdentity: '1'.repeat(64),
          manifestDigest: '2'.repeat(64),
          phase,
          revalidateInputs: false,
        },
        async () => {},
      );
      await reclaimAnalysisArtifacts(root, metadata);
      if (phase === 'pending')
        expect(await fs.readFile(ownerGraph, 'utf8')).toBe('old owner graph');
      else await expect(fs.stat(ownerGraph)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readFile(path.join(root, 'embeddings', current, 'vectors'), 'utf8')).toBe(
        'paid vectors',
      );
      expect(await fs.readFile(path.join(root, 'embeddings', fallback, 'vectors'), 'utf8')).toBe(
        'paid vectors',
      );
      await expect(fs.stat(path.join(root, 'embeddings', orphan))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      // An explicit drop ignores owners but keeps their receipts until busy
      // payloads can be removed. A later attempt completes the same operation.
      const remove = fs.rm.bind(fs);
      const vectors = path.join(root, 'embeddings', current, 'vectors');
      const busy = vi.spyOn(fs, 'rm').mockImplementation(async (file, options) => {
        if (String(file) === vectors) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        return remove(file, options);
      });
      await expect(
        reclaimAnalysisArtifacts(root, metadata, undefined, undefined, true),
      ).rejects.toMatchObject({ code: 'EBUSY' });
      expect(
        await fs.readFile(path.join(root, 'embeddings', current, 'job.json'), 'utf8'),
      ).toContain(current);
      expect(await fs.readdir(path.join(root, 'embeddings', 'spaces'))).toHaveLength(1);
      busy.mockRestore();
      await reclaimAnalysisArtifacts(root, metadata, undefined, undefined, true);
      expect(await fs.readdir(path.join(root, 'embeddings'))).toEqual([]);
    },
  );

  it.each([
    { receiptName: 'job.json', prefix: '' },
    { receiptName: 'artifact.json', prefix: '' },
    { receiptName: 'retained.json', prefix: '' },
    { receiptName: 'retained.json', prefix: '.retain-' },
  ])(
    'retains $receiptName with prefix "$prefix" until its busy vector file can be removed',
    async ({ receiptName, prefix }) => {
      const { root } = await fixture();
      const identity = 'e'.repeat(64);
      const job = path.join(root, 'embeddings', prefix + identity);
      await fs.mkdir(job, { recursive: true });
      await writeEmbeddingJobRecord(job, receiptName, { version: 1, identity });
      const vectors = path.join(job, 'vectors');
      await fs.writeFile(vectors, 'obsolete vectors');
      if (prefix) {
        await reclaimAnalysisArtifacts(root, {
          ...metadata,
          embeddingJob: { identity } as NonNullable<RepoMeta['embeddingJob']>,
        });
        expect(await fs.readFile(vectors, 'utf8')).toBe('obsolete vectors');
      }
      const remove = fs.rm.bind(fs);
      const busy = vi.spyOn(fs, 'rm').mockImplementation(async (file, options) => {
        if (String(file) === vectors) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        return remove(file, options);
      });
      const warn = vi.fn();
      await reclaimAnalysisArtifacts(root, metadata, undefined, warn);
      expect(await fs.readFile(path.join(job, receiptName), 'utf8')).toContain(identity);
      expect(await fs.readFile(vectors, 'utf8')).toBe('obsolete vectors');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('cleanup will retry'));
      busy.mockRestore();
      await reclaimAnalysisArtifacts(root, metadata);
      await expect(fs.stat(job)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('keeps the only legacy vector source while a model-space job references it', async () => {
    const { root } = await fixture();
    const sourceFile = `lbug.generation.${'c'.repeat(32)}`;
    await fs.writeFile(path.join(root, sourceFile), 'paid legacy vectors');
    const legacy = await recordLegacyEmbeddingSource(
      root,
      { sourceFile, schemaFingerprint: 'fixture' },
      [],
    );
    await adoptEmbeddingArtifact(
      root,
      {
        vectorIdentity: 'd'.repeat(64),
        inputIdentity: 'e'.repeat(64),
        dimensions: 4,
        schema: 'fixture',
      },
      null,
      {
        artifactIdentity: 'a'.repeat(64),
        jobIdentity: 'a'.repeat(64),
        fallbackLegacy: legacy,
        graphGeneration: 'f'.repeat(32),
        sourceIdentity: '1'.repeat(64),
        manifestDigest: '2'.repeat(64),
        phase: 'pending',
        revalidateInputs: false,
      },
      async () => {},
    );
    await reclaimAnalysisArtifacts(root, metadata);
    expect(await fs.readFile(path.join(root, sourceFile), 'utf8')).toBe('paid legacy vectors');
  });

  it.each([true, false])(
    'explicitly drops legacy receipts and exclusions after source retirement (source exists=%s)',
    async (exists) => {
      const { root } = await fixture();
      const sourceFile = `lbug.generation.${'c'.repeat(32)}`;
      await fs.writeFile(path.join(root, sourceFile), 'legacy vectors');
      const identity = await recordLegacyEmbeddingSource(
        root,
        { sourceFile, schemaFingerprint: 'fixture' },
        ['Function:a.ts:excluded'],
      );
      if (!exists) await fs.unlink(path.join(root, sourceFile));
      const directory = path.join(root, 'embeddings', 'legacy', identity);
      const excluded = path.join(directory, 'excluded.jsonl');
      const remove = fs.rm.bind(fs);
      const busy = vi.spyOn(fs, 'rm').mockImplementation(async (file, options) => {
        if (String(file) === excluded) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        return remove(file, options);
      });
      await expect(
        reclaimAnalysisArtifacts(root, metadata, undefined, undefined, true),
      ).rejects.toMatchObject({ code: 'EBUSY' });
      expect(await fs.readFile(path.join(directory, 'legacy.json'), 'utf8')).toContain(sourceFile);
      busy.mockRestore();
      await reclaimAnalysisArtifacts(root, metadata, undefined, undefined, true);
      expect(await fs.readdir(path.join(root, 'embeddings'))).toEqual([]);
    },
  );

  it('retains everything when an ownership receipt is corrupt and retries busy files later', async () => {
    const { root } = await fixture();
    const graph = path.join(root, `lbug.generation.${'b'.repeat(32)}`);
    await fs.writeFile(graph, 'previous graph');
    const space = path.join(root, 'embeddings', 'spaces', 'a'.repeat(64));
    await fs.mkdir(space, { recursive: true });
    await fs.writeFile(path.join(space, 'space.json'), '{}');
    const log = vi.fn();
    await reclaimAnalysisArtifacts(root, metadata, undefined, log);
    expect(await fs.readFile(graph, 'utf8')).toBe('previous graph');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ownership could not be verified'));
    await fs.rm(space, { recursive: true });
    const remove = fs.rm.bind(fs);
    const blocked = vi.spyOn(fs, 'rm').mockImplementation(async (file, options) => {
      if (String(file) === graph) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      await remove(file, options);
    });
    await reclaimAnalysisArtifacts(root, metadata, undefined, log);
    expect(await fs.readFile(graph, 'utf8')).toBe('previous graph');
    blocked.mockRestore();
    await reclaimAnalysisArtifacts(root, metadata, undefined, log);
    await expect(fs.stat(graph)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['.wal', '.shadow'])(
    'retries a busy orphan %s after deleting its graph',
    async (suffix) => {
      const { root } = await fixture();
      const graph = path.join(root, `lbug.generation.${'b'.repeat(32)}`);
      await fs.writeFile(graph, 'retired graph');
      await fs.writeFile(graph + suffix, 'busy sidecar');
      const remove = fs.rm.bind(fs);
      const blocked = vi.spyOn(fs, 'rm').mockImplementation(async (file, options) => {
        if (String(file) === graph + suffix)
          throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        await remove(file, options);
      });
      await reclaimAnalysisArtifacts(root, metadata, undefined, vi.fn());
      await expect(fs.stat(graph)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readFile(graph + suffix, 'utf8')).toBe('busy sidecar');
      blocked.mockRestore();
      await reclaimAnalysisArtifacts(root, metadata);
      await expect(fs.stat(graph + suffix)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('rejects a publication receipt replaced after its descriptor is opened', async () => {
    const { root, stage } = await fixture();
    await prepareAnalysisPublication(root, stage, metadata, content);
    const receipt = path.join(root, 'analysis-publication.json');
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]) === receipt) {
        await fs.rename(receipt, receipt + '.retained');
        await fs.writeFile(receipt, 'foreign replacement');
      }
      return handle;
    });
    await expect(readPreparedAnalysis(root)).rejects.toThrow('changed while opening');
    expect(await fs.readFile(receipt, 'utf8')).toBe('foreign replacement');
  });

  it('recovers a prior process incarnation even when its PID is now this process', async () => {
    const { root, stage, actions } = await fixture();
    const receipt = await prepareAnalysisPublication(root, stage, metadata, content, {
      waitForProcessExit: true,
    });
    const payload = { ...receipt, writerInstance: 'f'.repeat(32) };
    await fs.writeFile(
      path.join(root, 'analysis-publication.json'),
      JSON.stringify({
        payload,
        checksum: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
      }),
    );
    expect((await publishPreparedAnalysis(root, actions))?.graphGeneration?.id).toBe(receipt.id);
  });

  it('does not wait for an unrelated process that reused the writer PID', async () => {
    const { root, stage, actions } = await fixture();
    const start = vi.spyOn(indexLock, 'readProcStartTime').mockReturnValue('123');
    const receipt = await prepareAnalysisPublication(root, stage, metadata, content, {
      waitForProcessExit: true,
    });
    start.mockReturnValue('456');
    expect((await publishPreparedAnalysis(root, actions))?.graphGeneration?.id).toBe(receipt.id);
  });

  it.each(['darwin-lstart', 'win32-ticks'] as const)(
    'recovers a reused non-current PID using %s',
    async (kind) => {
      const { root, stage, actions } = await fixture();
      const before = kind === 'darwin-lstart' ? 'Sat Nov 7 13:02:03 2026' : '12345';
      const after = kind === 'darwin-lstart' ? 'Sat Nov 7 13:02:04 2026' : '12346';
      vi.spyOn(indexLock, 'readProcStartTime').mockReturnValue(null);
      const birth = vi
        .spyOn(writerIdentity, 'readAnalysisWriterBirth')
        .mockResolvedValue({ kind, value: before });
      const receipt = await prepareAnalysisPublication(root, stage, metadata, content, {
        waitForProcessExit: true,
      });
      const payload = { ...receipt, writerPid: process.pid + 100000 };
      await fs.writeFile(
        path.join(root, 'analysis-publication.json'),
        JSON.stringify({
          payload,
          checksum: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
        }),
      );
      birth.mockResolvedValue({ kind, value: after });
      const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
      expect((await publishPreparedAnalysis(root, actions))?.graphGeneration?.id).toBe(receipt.id);
      expect(kill).not.toHaveBeenCalled();
    },
  );

  it('allows a slow Windows birth probe within the recovery deadline', async () => {
    const { root, stage, actions } = await fixture();
    vi.spyOn(os, 'platform').mockReturnValue('win32');
    vi.spyOn(indexLock, 'readProcStartTime').mockReturnValue(null);
    const birth = vi
      .spyOn(writerIdentity, 'readAnalysisWriterBirth')
      .mockResolvedValue({ kind: 'win32-ticks', value: '12345' });
    const receipt = await prepareAnalysisPublication(root, stage, metadata, content, {
      waitForProcessExit: true,
    });
    const payload = { ...receipt, writerPid: process.pid + 100000 };
    await fs.writeFile(
      path.join(root, 'analysis-publication.json'),
      JSON.stringify({
        payload,
        checksum: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
      }),
    );
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    birth.mockImplementation(async (_pid, remainingMs) => {
      now = 2500;
      return remainingMs !== undefined && remainingMs > now
        ? { kind: 'win32-ticks', value: '12346' }
        : undefined;
    });
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    expect((await publishPreparedAnalysis(root, actions))?.graphGeneration?.id).toBe(receipt.id);
    expect(kill).not.toHaveBeenCalled();
    expect(birth.mock.lastCall?.[1]).toBeLessThanOrEqual(5000);
  });

  it.each(['equal', 'unknown', 'different-platform', 'legacy'] as const)(
    'retains a live writer when birth identity is %s',
    async (state) => {
      const { root, stage, actions } = await fixture();
      vi.spyOn(indexLock, 'readProcStartTime').mockReturnValue(null);
      const birth = vi
        .spyOn(writerIdentity, 'readAnalysisWriterBirth')
        .mockResolvedValue(
          state === 'legacy' ? undefined : { kind: 'win32-ticks', value: '12345' },
        );
      const receipt = await prepareAnalysisPublication(root, stage, metadata, content, {
        waitForProcessExit: true,
      });
      if (state === 'unknown') birth.mockResolvedValue(undefined);
      if (state === 'different-platform')
        birth.mockResolvedValue({ kind: 'linux-proc', value: '999' });
      vi.spyOn(process, 'kill').mockReturnValue(true);
      let now = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => (now += 500));
      await expect(publishPreparedAnalysis(root, actions)).rejects.toThrow('has not exited');
      expect(actions.verify).not.toHaveBeenCalled();
      expect(await readPreparedAnalysis(root)).toEqual(receipt);
    },
  );

  it('publishes through a symlinked parent while validating the real slot', async () => {
    const { root, stage } = await fixture();
    const slot = path.join(root, 'slot');
    await fs.mkdir(slot);
    await fs.rename(stage, path.join(slot, path.basename(stage)));
    const alias = path.join(root, 'parent-alias');
    await fs.symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const aliasedSlot = path.join(alias, 'slot');
    await saveMeta(aliasedSlot, metadata);
    const receipt = await prepareAnalysisPublication(
      aliasedSlot,
      path.join(aliasedSlot, path.basename(stage)),
      metadata,
      content,
    );
    const published = await publishPreparedAnalysis(aliasedSlot, {
      verify: async (file) => {
        expect(await fs.readFile(file, 'utf8')).toBe('verified graph');
      },
      saveMetadata: (meta) => saveMeta(aliasedSlot, meta),
    });
    expect(published?.graphGeneration?.id).toBe(receipt.id);
  });

  it('publishes only after the real preparing process exits', async () => {
    const { root, stage, actions } = await fixture();
    const moduleUrl = new URL('../../dist/core/analysis-publication.js', import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { prepareAnalysisPublication } from ${JSON.stringify(moduleUrl)};
      process.once('message', async ({ root, stage, metadata, content }) => {
        await prepareAnalysisPublication(root, stage, metadata, content, { waitForProcessExit: true });
        process.once('message', () => process.disconnect());
        process.send('prepared');
      });
    `,
      ],
      { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
    );
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    const prepared = new Promise((resolve) => child.once('message', resolve));
    try {
      child.send({ root, stage, metadata, content });
      await Promise.race([
        prepared,
        exited.then(() => {
          throw new Error('Writer exited before preparation');
        }),
      ]);
      expect(child.exitCode).toBeNull();
      await expect(publishPreparedAnalysis(root, actions)).rejects.toThrow('has not exited');
      expect(actions.verify).not.toHaveBeenCalled();
      child.send('release');
      expect(await exited).toBe(0);
      const published = await publishPreparedAnalysis(root, actions);
      expect(published?.graphGeneration).toBeDefined();
      expect(actions.verify).toHaveBeenCalledOnce();
    } finally {
      if (child.connected) child.send('release');
      await exited;
    }
  });

  it('waits for an exit-only writer even after it has prepared the graph', async () => {
    const { root, stage, actions } = await fixture();
    const receipt = await prepareAnalysisPublication(root, stage, metadata, content, {
      waitForProcessExit: true,
    });
    expect(receipt.writerPid).toBe(process.pid);
    await expect(publishPreparedAnalysis(root, actions)).rejects.toThrow('has not exited');
    expect(actions.verify).not.toHaveBeenCalled();
    expect(await readPreparedAnalysis(root)).toEqual(receipt);
    const probe = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('exited'), { code: 'ESRCH' });
    });
    await publishPreparedAnalysis(root, actions);
    expect(probe).toHaveBeenCalledWith(process.pid, 0);
    expect(actions.verify).toHaveBeenCalledOnce();
  });

  it('retains a prepared graph when process liveness cannot be established', async () => {
    const { root, stage, actions } = await fixture();
    await prepareAnalysisPublication(root, stage, metadata, content, { waitForProcessExit: true });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
    });
    await expect(publishPreparedAnalysis(root, actions)).rejects.toThrow('permission denied');
    expect(actions.verify).not.toHaveBeenCalled();
    expect(await fs.readFile(stage, 'utf8')).toBe('verified graph');
  });

  it('rejects a superseded attempt before verifying or moving its graph', async () => {
    const { root, stage, actions } = await fixture();
    const receipt = await prepareAnalysisPublication(root, stage, metadata, content);
    const newer = { ...metadata, lastCommit: 'newer-writer' };
    await saveMeta(root, newer);
    await expect(publishPreparedAnalysis(root, actions)).rejects.toThrow('superseded');
    expect(actions.verify).not.toHaveBeenCalled();
    expect(await loadMeta(root)).toEqual(newer);
    expect(await fs.readFile(stage, 'utf8')).toBe('verified graph');
    expect(await readPreparedAnalysis(root)).toEqual(receipt);
  });

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

describe('logical in-place generations', () => {
  it('invalidates readiness before writes and retains one physical file across generations', async () => {
    const { root, actions } = await fixture();
    let previous = metadata;
    let file = path.join(root, 'lbug');
    const before = await fs.stat(file);
    const generations: string[] = [];
    for (let iteration = 0; iteration < 3; iteration++) {
      const dirty = await beginInPlaceAnalysis(
        root,
        {
          ...previous,
          incrementalInProgress: { startedAt: Date.now(), toWriteCount: 1 },
        },
        actions.saveMetadata,
      );
      expect((await loadMeta(root))?.graphGeneration).toBeUndefined();
      const attemptId = dirty.incrementalInProgress?.attemptId;
      if (!attemptId) throw new Error('Expected an in-place attempt');
      expect((await loadMeta(root))?.incrementalInProgress?.attemptId).toBe(attemptId);
      // Simulate the delta write only after the dirty stamp is durable.
      await fs.writeFile(file, 'verified graph');
      const receipt = await prepareAnalysisPublication(root, file, previous, content, {
        mode: 'in-place',
        attemptId,
      });
      const published = await publishPreparedAnalysis(root, actions);
      if (!published) throw new Error('Expected a published generation');
      file = resolveGraphPath(root);
      expect((await fs.stat(file)).ino).toBe(before.ino);
      expect(receipt.legacyGraphFile).toBeUndefined();
      expect(published.incrementalInProgress).toBeUndefined();
      expect(published.graphGeneration?.id).toBe(attemptId);
      generations.push(attemptId);
      previous = published;
    }
    expect(new Set(generations).size).toBe(3);
    expect(
      (await fs.readdir(root)).filter((name) => /^lbug\.generation\.[a-f0-9]{32}$/.test(name)),
    ).toHaveLength(1);
    await expect(fs.stat(path.join(root, 'lbug'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['before-rename', 'after-rename', 'after-metadata'] as const)(
    'recovers in-place publication %s without restoring a false old generation',
    async (point) => {
      const { root, actions } = await fixture();
      const dirty = await beginInPlaceAnalysis(
        root,
        {
          ...metadata,
          incrementalInProgress: { startedAt: 1, toWriteCount: 1 },
        },
        actions.saveMetadata,
      );
      const attemptId = dirty.incrementalInProgress?.attemptId;
      if (!attemptId) throw new Error('Expected an in-place attempt');
      await fs.writeFile(path.join(root, 'lbug'), 'verified graph');
      const receipt = await prepareAnalysisPublication(
        root,
        path.join(root, 'lbug'),
        metadata,
        content,
        {
          mode: 'in-place',
          attemptId,
        },
      );
      await expect(
        publishPreparedAnalysis(root, {
          verify:
            point === 'before-rename'
              ? async () => {
                  throw new Error('crash');
                }
              : actions.verify,
          saveMetadata: async (meta) => {
            if (point === 'after-metadata') await actions.saveMetadata(meta);
            throw new Error('crash');
          },
        }),
      ).rejects.toThrow('crash');
      expect(await readPreparedAnalysis(root)).toEqual(receipt);
      if (point !== 'after-metadata') {
        expect((await loadMeta(root))?.graphGeneration).toBeUndefined();
        expect((await loadMeta(root))?.incrementalInProgress?.attemptId).toBe(attemptId);
      }
      const published = await publishPreparedAnalysis(root, actions);
      expect(published?.graphGeneration?.id).toBe(attemptId);
      expect(published?.incrementalInProgress).toBeUndefined();
    },
  );

  it('requires a durable matching attempt and rejects another writer before preparation', async () => {
    const { root, actions } = await fixture();
    const file = path.join(root, 'lbug');
    await expect(
      prepareAnalysisPublication(root, file, metadata, content, {
        mode: 'in-place',
        attemptId: 'a'.repeat(32),
      }),
    ).rejects.toThrow('missing or superseded');
    const dirty = await beginInPlaceAnalysis(
      root,
      {
        ...metadata,
        incrementalInProgress: { startedAt: 1, toWriteCount: 1 },
      },
      actions.saveMetadata,
    );
    const attemptId = dirty.incrementalInProgress?.attemptId;
    if (!attemptId) throw new Error('Expected an in-place attempt');
    await saveMeta(root, { ...metadata, lastCommit: 'newer' });
    await expect(
      prepareAnalysisPublication(root, file, metadata, content, {
        mode: 'in-place',
        attemptId,
      }),
    ).rejects.toThrow('missing or superseded');
    expect(await readPreparedAnalysis(root)).toBeUndefined();
  });

  it('rejects a shared pointer, missing dirty plan and an outstanding prepared publication', async () => {
    const { root, stage, actions } = await fixture();
    await expect(beginInPlaceAnalysis(root, metadata, actions.saveMetadata)).rejects.toThrow(
      'dirty',
    );
    const dirty = { ...metadata, incrementalInProgress: { startedAt: 1, toWriteCount: 1 } };
    await expect(
      beginInPlaceAnalysis(root, { ...dirty, graphPath: '/shared/lbug' }, actions.saveMetadata),
    ).rejects.toThrow('private');
    await prepareAnalysisPublication(root, stage, metadata, content);
    await expect(beginInPlaceAnalysis(root, dirty, actions.saveMetadata)).rejects.toThrow(
      'Recover',
    );
  });

  it('rejects an aliased target or foreign slot before changing its dirty marker', async () => {
    const { root, stage, actions } = await fixture();
    const dirty = { ...metadata, incrementalInProgress: { startedAt: 1, toWriteCount: 1 } };
    await expect(
      beginInPlaceAnalysis(root, { ...dirty, repoPath: '/other-repo' }, actions.saveMetadata),
    ).rejects.toThrow('another repository');
    await fs.unlink(path.join(root, 'lbug'));
    await fs.symlink(stage, path.join(root, 'lbug'));
    await expect(beginInPlaceAnalysis(root, dirty, actions.saveMetadata)).rejects.toThrow(
      'regular file',
    );
    expect(await loadMeta(root)).toEqual(metadata);
  });
});
