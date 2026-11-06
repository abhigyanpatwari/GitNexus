/** Reclaim only unreferenced owned artifacts under the ordinary slot lock. */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { RepoMeta } from './repo-meta.js';
import { embeddingJobDirectory, readEmbeddingJobRecord } from './embedding-job.js';
import { readEmbeddingArtifactOwners } from './embedding-artifact.js';
import { readLegacyEmbeddingSource } from './legacy-embedding-source.js';
import { logger } from '../core/logger.js';

const GRAPH = /^lbug\.generation\.[a-f0-9]{32}$/;
const ID = /^[a-f0-9]{64}$/;

/** Keep the published and previous graph, all model spaces, pending jobs, and
 * their paid reuse sources. Windows busy files stay in place for the next run. */
export async function reclaimAnalysisArtifacts(
  directory: string,
  metadata: RepoMeta,
  previousGraph?: string,
  log?: (message: string) => void,
): Promise<void> {
  const warn = log ?? ((message: string) => logger.warn(message));
  try {
    const root = await embeddingJobDirectory(directory);
    const entries = await fs.readdir(root, { withFileTypes: true });
    if (entries.some((entry) => entry.name === 'analysis-publication.json')) return;
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
    if (metadata.legacyVectorSource) legacy.add(metadata.legacyVectorSource);
    for (const reference of [metadata.embeddingJob, metadata.vectorGeneration]) {
      if (!reference) continue;
      keepJob(reference.identity);
      keepJob(reference.artifactIdentity);
    }
    for (const owner of await readEmbeddingArtifactOwners(root)) {
      keepJob(owner.artifactIdentity);
      keepJob(owner.jobIdentity);
      keepJob(owner.fallbackArtifact);
      keepGraph(`lbug.generation.${owner.graphGeneration}`);
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
    const orphanJobs: string[] = [];
    for (const name of jobEntries) {
      if (typeof name !== 'string' || !ID.test(name) || jobs.has(name)) continue;
      const job = await embeddingJobDirectory(path.join(embeddingRoot, name));
      try {
        const receipt = (await readEmbeddingJobRecord(job, 'job.json')) as {
          version?: number;
          identity?: string;
        };
        if (receipt.version !== 1 || receipt.identity !== name)
          throw new Error('Unreferenced embedding job has unknown ownership');
        orphanJobs.push(job);
      } catch (error) {
        // An interrupted bootstrap has no paid work, but without a receipt we
        // leave it to explicit cleanup instead of guessing ownership.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const remove = async (file: string, recursive = false): Promise<boolean> => {
      try {
        await fs.rm(file, { force: true, recursive });
        return true;
      } catch (error) {
        warn(
          `Retained busy analysis artifact ${path.basename(file)}; cleanup will retry (${(error as Error).message}).`,
        );
        return false;
      }
    };
    for (const entry of entries) {
      if (!entry.isFile() || !GRAPH.test(entry.name) || graphs.has(entry.name)) continue;
      if (await remove(path.join(root, entry.name)))
        for (const suffix of ['.wal', '.shadow'])
          await remove(path.join(root, entry.name + suffix));
    }
    for (const job of orphanJobs) {
      // Keep the ownership receipt until every payload is gone. Recursive
      // removal of the whole directory can delete job.json before a busy
      // native file fails on Windows, making the next cleanup unverifiable.
      let removed = true;
      for (const name of await fs.readdir(job)) {
        if (name === 'job.json') continue;
        if (!(await remove(path.join(job, name), true))) {
          removed = false;
          break;
        }
      }
      if (removed && (await remove(path.join(job, 'job.json')))) await fs.rmdir(job);
    }
  } catch (error) {
    warn(
      `Retained analysis artifacts because ownership could not be verified (${(error as Error).message}).`,
    );
  }
}
