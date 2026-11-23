/** Retain a completed, immutable vector file in another owned slot.
 * Caller holds the source/destination locks (or the shared publish lock).
 * Pending artifacts, manifests, journals and mutable ownership never move. */
import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  embeddingJobDirectory,
  readEmbeddingJobRecord,
  syncEmbeddingJobDirectory,
  writeEmbeddingJobRecord,
} from './embedding-job.js';
import {
  assertOwnedVectorGeneration,
  embeddingGenerationDirectory,
  type PublishedVectorGeneration,
} from './vector-generation.js';

type FileIdentity = { dev: string; ino: string; size: string; mtimeNs: string };
interface RetentionReceipt {
  version: 1;
  identity?: string;
  signature: string;
  source: FileIdentity;
  /** Absent until the entire retained file is durable. */
  file?: FileIdentity;
}
const facts = (stat: BigIntStats): FileIdentity => ({
  dev: String(stat.dev),
  ino: String(stat.ino),
  size: String(stat.size),
  mtimeNs: String(stat.mtimeNs),
});
const sameFile = (a: FileIdentity | undefined, b: FileIdentity): boolean =>
  !!a && (['dev', 'ino', 'size', 'mtimeNs'] as const).every((key) => a[key] === b[key]);

async function completedFile(file: string): Promise<FileIdentity> {
  const stat = await fs.lstat(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error('Retained vectors must be an owned regular file');
  for (const suffix of ['.wal', '.shadow']) {
    try {
      const sidecar = await fs.lstat(file + suffix);
      if (!sidecar.isFile() || sidecar.isSymbolicLink() || sidecar.size)
        throw new Error('Cannot retain vectors with unfinished native writes');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return facts(stat);
}

async function receipt(directory: string, signature: string): Promise<RetentionReceipt> {
  const value = (await readEmbeddingJobRecord(directory, 'retained.json')) as RetentionReceipt;
  if (!value || value.version !== 1 || value.signature !== signature || !value.source)
    throw new Error('Unverified vector retention receipt; artifacts retained');
  return value;
}

/** A crash can leave the directory before its first atomic receipt rename.
 * Only unpublished receipt temporaries are ours to discard in that state. */
async function recoverEmptyPreparation(directory: string): Promise<void> {
  await embeddingJobDirectory(directory);
  const temporary = /^\.retained\.json\.[a-f0-9-]{36}\.tmp$/;
  for await (const entry of await fs.opendir(directory)) {
    const stat = await fs.lstat(path.join(directory, entry.name));
    if (!temporary.test(entry.name) || !stat.isFile() || stat.isSymbolicLink())
      throw new Error('Unverified vector preparation directory; artifacts retained');
  }
  // Validate the whole directory before removing anything; stream both passes
  // so repeated interrupted attempts cannot require an unbounded entry array.
  for await (const entry of await fs.opendir(directory)) {
    await fs.unlink(path.join(directory, entry.name));
  }
}

/** Hard links pin the inode independently of source cleanup. Cross-device
 * copies are allowed only for initial local-index adoption, never rebases.
 * A directly named preparation directory makes an interrupted copy resumable
 * without scanning old jobs or overwriting an unverified existing artifact. */
export async function retainSharedVectorArtifact(
  sourceRoot: string,
  destinationRoot: string,
  generation: PublishedVectorGeneration,
  allowCopy = false,
): Promise<void> {
  const artifact = generation.artifactIdentity ?? generation.identity;
  const source = await assertOwnedVectorGeneration(sourceRoot, artifact);
  const sourceIdentity = await completedFile(source);
  const root = await embeddingJobDirectory(destinationRoot);
  const directory = embeddingGenerationDirectory(root, artifact);
  const parent = path.dirname(directory);
  try {
    await fs.mkdir(parent, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  await embeddingJobDirectory(parent);
  await syncEmbeddingJobDirectory(root);
  const signature = createHash('sha256')
    .update(
      JSON.stringify([
        artifact,
        generation.vectorIdentity,
        generation.inputIdentity,
        generation.dimensions,
        generation.nodes,
        generation.chunks,
        generation.indexKind,
      ]),
    )
    .digest('hex');

  let present = false;
  try {
    await fs.lstat(directory);
    present = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (present) {
    const file = await assertOwnedVectorGeneration(root, artifact);
    const identity = await completedFile(file);
    if (
      file === source ||
      (sourceIdentity.dev !== '0' &&
        sourceIdentity.ino !== '0' &&
        sameFile(identity, sourceIdentity))
    ) {
      await syncEmbeddingJobDirectory(parent);
      return;
    }
    const retained = await receipt(directory, signature);
    if (!sameFile(retained.file, identity))
      throw new Error('Retained vector file changed; artifacts retained');
    await syncEmbeddingJobDirectory(parent);
    return;
  }

  const preparing = path.join(parent, `.retain-${artifact}`);
  let intent: RetentionReceipt;
  try {
    await fs.mkdir(preparing, { mode: 0o700 });
    intent = { version: 1, identity: artifact, signature, source: sourceIdentity };
    await writeEmbeddingJobRecord(preparing, 'retained.json', intent);
    await syncEmbeddingJobDirectory(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    try {
      intent = await receipt(preparing, signature);
    } catch (readError) {
      if ((readError as NodeJS.ErrnoException).code !== 'ENOENT') throw readError;
      await recoverEmptyPreparation(preparing);
      intent = { version: 1, identity: artifact, signature, source: sourceIdentity };
      await writeEmbeddingJobRecord(preparing, 'retained.json', intent);
      await syncEmbeddingJobDirectory(parent);
    }
    if (!sameFile(intent.source, sourceIdentity))
      throw new Error('Vector retention source changed; artifacts retained');
  }
  const target = path.join(preparing, 'vectors');
  if (intent.file) {
    if (!sameFile(intent.file, await completedFile(target)))
      throw new Error('Prepared vector file changed; artifacts retained');
  } else {
    // A verified intent owns only this unacknowledged preparation file.
    // Its immutable source remains available even if a copy was interrupted.
    try {
      await completedFile(target);
      await fs.unlink(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      await fs.link(source, target);
    } catch (error) {
      if (!allowCopy || (error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      await fs.copyFile(source, target, constants.COPYFILE_EXCL);
      const handle = await fs.open(target, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    if (!sameFile(sourceIdentity, await completedFile(source)))
      throw new Error('Vector source changed during retention; artifacts retained');
    intent = { ...intent, file: await completedFile(target) };
    await writeEmbeddingJobRecord(preparing, 'retained.json', intent);
  }
  await fs.rename(preparing, directory);
  await syncEmbeddingJobDirectory(parent);
}
