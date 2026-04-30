import { writeSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  findRepo,
  readRegistry,
  resolveRegistryEntry,
  type RegistryEntry,
} from '../storage/repo-manager.js';
import {
  copyWithAwsCli,
  createContextSnapshot,
  defaultContextLakeDir,
  readLocalSnapshot,
  snapshotFileName,
  verifyContextSnapshot,
  writeLocalSnapshot,
} from '../core/context-lake/snapshot.js';

interface ContextLakeOptions {
  repo?: string;
  backend?: 'local' | 's3';
  output?: string;
  maxNodes?: string;
  maxEdges?: string;
  redact?: string[];
  signingHook?: string;
  endpointUrl?: string;
  json?: boolean;
}

const output = (data: unknown): void => {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  writeSync(1, `${text}\n`);
};

async function resolveContextRepo(repoParam?: string): Promise<RegistryEntry> {
  const registry = await readRegistry();
  if (repoParam) return resolveRegistryEntry(registry, repoParam);

  const found = await findRepo(process.cwd());
  if (found) {
    const entry = registry.find((item) => path.resolve(item.path) === path.resolve(found.repoPath));
    if (entry) return entry;
    return {
      name: path.basename(found.repoPath),
      path: found.repoPath,
      storagePath: found.storagePath,
      indexedAt: found.meta.indexedAt,
      lastCommit: found.meta.lastCommit,
      remoteUrl: found.meta.remoteUrl,
      stats: found.meta.stats,
    };
  }

  throw new Error('No indexed repository found. Pass --repo <name-or-path> or run from a repo with .gitnexus.');
}

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  const n = value ? Number.parseInt(value, 10) : fallback;
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const isS3Target = (value: string | undefined, backend: string | undefined): boolean =>
  backend === 's3' || !!value?.startsWith('s3://');

export const contextPushCommand = async (
  destination?: string,
  options: ContextLakeOptions = {},
): Promise<void> => {
  try {
    const repo = await resolveContextRepo(options.repo);
    const snapshot = await createContextSnapshot(repo, {
      maxNodes: parsePositiveInt(options.maxNodes, 250),
      maxEdges: parsePositiveInt(options.maxEdges, 500),
      redact: options.redact ?? [],
      signingHook: options.signingHook,
    });

    let writtenPath = '';
    const wantsS3 = isS3Target(destination, options.backend);
    if (wantsS3) {
      if (!destination) throw new Error('S3 push requires a destination like s3://bucket/path/');
      const tmpPath = path.join(os.tmpdir(), snapshotFileName(snapshot));
      await fs.writeFile(tmpPath, JSON.stringify(snapshot, null, 2), 'utf-8');
      const target = destination.endsWith('/') ? `${destination}${path.basename(tmpPath)}` : destination;
      await copyWithAwsCli(tmpPath, target, options.endpointUrl);
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      writtenPath = target;
    } else {
      const targetDir = destination ?? path.join(defaultContextLakeDir(), repo.name);
      writtenPath = await writeLocalSnapshot(targetDir, snapshot);
    }

    const summary = {
      action: 'push',
      repo: snapshot.repo.name,
      destination: writtenPath,
      checksum: snapshot.checksum,
      nodes: snapshot.graph.nodes.length,
      edges: snapshot.graph.edges.length,
      runtime: snapshot.runtime ? 'included' : 'none',
      semanticAnchors: snapshot.semanticAnchors.status,
    };

    if (options.json) output(summary);
    else {
      output(
        [
          `Context snapshot pushed for ${summary.repo}`,
          `  destination: ${summary.destination}`,
          `  checksum: ${summary.checksum}`,
          `  graph: ${summary.nodes} nodes, ${summary.edges} edges`,
          `  runtime: ${summary.runtime}`,
          `  semantic anchors: ${summary.semanticAnchors}`,
        ].join('\n'),
      );
    }
  } catch (err) {
    process.stderr.write(`Context push failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
};

export const contextPullCommand = async (
  source?: string,
  options: ContextLakeOptions = {},
): Promise<void> => {
  try {
    const wantsS3 = isS3Target(source, options.backend);
    let localSource = source ?? defaultContextLakeDir();
    let s3TempPath = '';

    if (wantsS3) {
      if (!source) throw new Error('S3 pull requires a source like s3://bucket/snapshot.context.json');
      s3TempPath = path.join(os.tmpdir(), `nexusforge-pull-${Date.now()}.context.json`);
      await copyWithAwsCli(source, s3TempPath, options.endpointUrl);
      localSource = s3TempPath;
    }

    const { path: snapshotPath, snapshot } = await readLocalSnapshot(localSource);
    const verified = verifyContextSnapshot(snapshot);
    if (!verified) {
      throw new Error(`Checksum verification failed for ${snapshotPath}`);
    }

    const outputTarget =
      options.output ?? path.join(defaultContextLakeDir(), 'imports', snapshot.repo.name);
    const writtenPath = await writeLocalSnapshot(outputTarget, snapshot);
    if (s3TempPath) await fs.rm(s3TempPath, { force: true }).catch(() => {});

    const summary = {
      action: 'pull',
      repo: snapshot.repo.name,
      source: source ?? snapshotPath,
      destination: writtenPath,
      checksum: snapshot.checksum,
      verified,
      commit: snapshot.repo.commit,
    };

    if (options.json) output(summary);
    else {
      output(
        [
          `Context snapshot pulled for ${summary.repo}`,
          `  source: ${summary.source}`,
          `  destination: ${summary.destination}`,
          `  checksum: ${summary.checksum}`,
          `  verified: ${summary.verified}`,
          `  commit: ${summary.commit ?? 'unknown'}`,
        ].join('\n'),
      );
    }
  } catch (err) {
    process.stderr.write(`Context pull failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
};
