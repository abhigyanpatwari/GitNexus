/** Reclaim only unreferenced owned artifacts under the ordinary slot lock. */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { RepoMeta } from './repo-meta.js';
import { embeddingJobDirectory, readEmbeddingJobRecord } from './embedding-job.js';
import { readEmbeddingArtifactOwners } from './embedding-artifact.js';
import {
  readLegacyEmbeddingSource,
  readLegacyEmbeddingSourceReceipt,
} from './legacy-embedding-source.js';
import { logger } from '../core/logger.js';

const GRAPH = /^lbug\.generation\.[a-f0-9]{32}$/;
const ATTEMPT_METADATA = /^analysis-meta-[a-f0-9]{32}\.json$/;
const ID = /^[a-f0-9]{64}$/;

/** Keep the published and previous graph, all model spaces, pending jobs, and
 * their paid reuse sources. Windows busy files stay in place for the next run.
 * Explicit dropping ignores vector references and fails if removal is incomplete;
 * ownership receipts remain until all validated payloads have been removed. */
export async function reclaimAnalysisArtifacts(
  directory: string,
  metadata: RepoMeta,
  previousGraph?: string,
  log?: (message: string) => void,
  dropEmbeddings = false,
): Promise<void> {
  const warn = log ?? ((message: string) => logger.warn(message));
  try {
    const root = await embeddingJobDirectory(directory);
    const entries = await fs.readdir(root, { withFileTypes: true });
    if (entries.some((entry) => entry.name === 'analysis-publication.json')) {
      if (dropEmbeddings) throw new Error('Recover the pending graph before dropping embeddings');
      return;
    }
    const graphs = new Set<string>();
    const jobs = new Set<string>();
    const legacy = new Set<string>();
    const keepGraph = (file: string | undefined) => {
      if (file && GRAPH.test(file)) graphs.add(file);
    };
    const keepJob = (id: string | undefined) => {
      if (!id) return;
      if (!ID.test(id)) throw new Error('Invalid referenced embedding identity');
      jobs.add(id);
    };
    keepGraph(metadata.graphPath);
    keepGraph(previousGraph);
    if (!dropEmbeddings && metadata.legacyVectorSource) legacy.add(metadata.legacyVectorSource);
    for (const reference of [metadata.embeddingJob, metadata.vectorGeneration]) {
      if (!reference || dropEmbeddings) continue;
      keepJob(reference.identity);
      keepJob(reference.artifactIdentity);
    }
    for (const owner of await readEmbeddingArtifactOwners(root)) {
      if (dropEmbeddings) continue;
      keepJob(owner.artifactIdentity);
      keepJob(owner.jobIdentity);
      keepJob(owner.fallbackArtifact);
      if (owner.phase === 'pending') keepGraph(`lbug.generation.${owner.graphGeneration}`);
      if (owner.fallbackLegacy) legacy.add(owner.fallbackLegacy);
    }
    // Validate every reference before the first deletion, including retired
    // legacy graphs that still contain the only copy of paid vectors.
    for (const identity of legacy) {
      const source = await readLegacyEmbeddingSource(root, identity);
      keepGraph(source.sourceFile);
    }
    const embeddingRoot = path.join(root, 'embeddings');
    let jobEntries: string[] = [];
    try {
      await embeddingJobDirectory(embeddingRoot);
      jobEntries = await fs.readdir(embeddingRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const spaces: string[] = [];
    if (dropEmbeddings && jobEntries.includes('spaces')) {
      for (const name of await fs.readdir(path.join(embeddingRoot, 'spaces'))) {
        const space = path.join(embeddingRoot, 'spaces', name);
        if ((await fs.readdir(space)).some((file) => !['space.json', 'rebase.json'].includes(file)))
          throw new Error('Unexpected embedding space payload; artifacts retained');
        spaces.push(space);
      }
    }
    const orphanJobs: Array<{ directory: string; receiptName: string }> = [];
    for (const name of jobEntries) {
      const preparation = /^\.retain-([a-f0-9]{64})$/.exec(name);
      const identity = preparation?.[1] ?? name;
      if (!ID.test(identity) || jobs.has(identity)) continue;
      const job = await embeddingJobDirectory(path.join(embeddingRoot, name));
      let owned = false;
      for (const receiptName of preparation
        ? ['retained.json']
        : ['job.json', 'artifact.json', 'retained.json']) {
        try {
          const receipt = (await readEmbeddingJobRecord(job, receiptName)) as {
            version?: number;
            identity?: string;
          };
          // Older retained copies have no identity in their receipt. Keep
          // those unverifiable directories, as with an interrupted bootstrap.
          if (receiptName === 'retained.json' && receipt.identity === undefined && !dropEmbeddings)
            break;
          if (receipt.version !== 1 || receipt.identity !== identity)
            throw new Error('Unreferenced embedding artifact has unknown ownership');
          orphanJobs.push({ directory: job, receiptName });
          owned = true;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      if (dropEmbeddings && !owned && (await fs.readdir(job)).length)
        throw new Error('Embedding artifact has no ownership receipt; artifacts retained');
    }
    if (dropEmbeddings && jobEntries.includes('legacy')) {
      const parent = await embeddingJobDirectory(path.join(embeddingRoot, 'legacy'));
      for (const identity of await fs.readdir(parent)) {
        await readLegacyEmbeddingSourceReceipt(root, identity);
        orphanJobs.push({ directory: path.join(parent, identity), receiptName: 'legacy.json' });
      }
    }
    const remove = async (file: string, recursive = false): Promise<boolean> => {
      try {
        await fs.rm(file, { force: true, recursive });
        return true;
      } catch (error) {
        if (dropEmbeddings) throw error;
        warn(
          `Retained busy analysis artifact ${path.basename(file)}; cleanup will retry (${(error as Error).message}).`,
        );
        return false;
      }
    };
    // Without a publication receipt, no attempt metadata is needed for recovery.
    for (const entry of entries)
      if (entry.isFile() && ATTEMPT_METADATA.test(entry.name))
        await remove(path.join(root, entry.name));
    // A busy sidecar may outlive its base graph; include it in the next sweep.
    const candidates = new Set(
      entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name.replace(/\.(wal|shadow)$/, '')),
    );
    for (const graph of candidates) {
      if (!GRAPH.test(graph) || graphs.has(graph)) continue;
      if (await remove(path.join(root, graph)))
        for (const suffix of ['.wal', '.shadow']) await remove(path.join(root, graph + suffix));
    }
    for (const { directory: job, receiptName } of orphanJobs) {
      // Keep the ownership receipt until every payload is gone. Recursive
      // removal of the whole directory can delete job.json before a busy
      // native file fails on Windows, making the next cleanup unverifiable.
      let removed = true;
      for (const name of await fs.readdir(job)) {
        if (name === receiptName) continue;
        if (!(await remove(path.join(job, name), true))) {
          removed = false;
          break;
        }
      }
      if (removed && (await remove(path.join(job, receiptName)))) await fs.rmdir(job);
    }
    if (dropEmbeddings) {
      if (jobEntries.includes('legacy')) await fs.rmdir(path.join(embeddingRoot, 'legacy'));
      // Every space was validated before deletion. Remove its ownership only
      // after payload removal succeeds, so a busy file can be retried safely.
      for (const space of spaces) {
        await fs.rm(path.join(space, 'rebase.json'), { force: true });
        await fs.rm(path.join(space, 'space.json'), { force: true });
        await fs.rmdir(space);
      }
      if (jobEntries.includes('spaces')) await fs.rmdir(path.join(embeddingRoot, 'spaces'));
    }
  } catch (error) {
    if (dropEmbeddings) throw error;
    warn(
      `Retained analysis artifacts because ownership could not be verified (${(error as Error).message}).`,
    );
  }
}
