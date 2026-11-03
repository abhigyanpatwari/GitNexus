/** Durable graph publication. Native verification/close and metadata ownership
 * are supplied by the coordinator, which holds the index-directory write lock. */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { RepoMeta } from '../storage/repo-meta.js';
import { INDEX_METADATA_FILE } from '../storage/storage-constants.js';
import { embeddingJobDirectory, syncEmbeddingJobDirectory } from '../storage/embedding-job.js';

const RECEIPT = 'analysis-publication.json';
const GENERATION = /^[a-f0-9]{32}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const STAGING = /^lbug(?:\.generation\.[a-f0-9]{32})?\.staging\.[a-f0-9-]{36}$/;
const MAX_RECEIPT_BYTES = 4096;
const MAX_METADATA_BYTES = 256 * 1024 * 1024;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export interface PreparedAnalysisPublication {
  version: 1;
  id: string;
  stagingFile: string;
  graphFile: string;
  metadataFile: string;
  metadataBytes: number;
  metadataDigest: string;
  /** A hard-link destination for the previous legacy graph; never copied. */
  legacyGraphFile?: string;
}

export interface AnalysisPublicationActions {
  /** Open read-only and verify graph/schema/FTS against the prepared metadata.
   * Must close the verification handle before returning (including on Windows).
   * Unknown counts/catalog state must reject, never certify an empty graph.
   */
  verify: (graphPath: string, metadata: RepoMeta) => Promise<void>;
  /** The normal metadata writer, including its compatibility mirror. */
  saveMetadata: (metadata: RepoMeta) => Promise<void>;
}

function validateReceipt(value: unknown): asserts value is PreparedAnalysisPublication {
  const r = value as PreparedAnalysisPublication;
  if (
    !r ||
    r.version !== 1 ||
    !GENERATION.test(r.id) ||
    !STAGING.test(r.stagingFile) ||
    r.graphFile !== `lbug.generation.${r.id}` ||
    r.metadataFile !== `analysis-meta-${r.id}.json` ||
    (r.legacyGraphFile !== undefined &&
      (!/^lbug\.generation\.[a-f0-9]{32}$/.test(r.legacyGraphFile) ||
        r.legacyGraphFile === r.graphFile)) ||
    !Number.isSafeInteger(r.metadataBytes) ||
    r.metadataBytes < 1 ||
    r.metadataBytes > MAX_METADATA_BYTES ||
    !DIGEST.test(r.metadataDigest)
  )
    throw new Error('Invalid prepared graph publication; artifacts retained');
}

async function regularFile(file: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('Publication artifact must be an owned regular file');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function boundedRead(file: string, maximum: number): Promise<Buffer> {
  if (!(await regularFile(file)))
    throw Object.assign(new Error('Publication artifact missing'), { code: 'ENOENT' });
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum)
      throw new Error('Publication artifact exceeds its receipt bound');
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await handle.read(buffer, size, buffer.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size !== stat.size) throw new Error('Publication artifact changed while reading');
    return buffer.subarray(0, size);
  } finally {
    await handle.close();
  }
}

async function writeDurable(directory: string, name: string, bytes: Buffer): Promise<void> {
  const temporary = path.join(directory, `.${name}.${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, path.join(directory, name));
    await syncEmbeddingJobDirectory(directory);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** Call after graph/FTS verification and a successful native checkpoint, before
 * native close. A close crash leaves the owned build and its publication intent.
 * No model or vector work may start until publishPreparedAnalysis completes.
 */
export async function prepareAnalysisPublication(
  directory: string,
  buildPath: string,
  metadata: RepoMeta,
  coveredContent: string,
): Promise<PreparedAnalysisPublication> {
  const root = await embeddingJobDirectory(directory);
  if (
    !DIGEST.test(coveredContent) ||
    !metadata.repoPath ||
    !metadata.runnerIdentity ||
    metadata.incrementalInProgress
  )
    throw new Error('Graph publication requires verified source and analyzer metadata');
  if (path.dirname(path.resolve(buildPath)) !== root || !STAGING.test(path.basename(buildPath)))
    throw new Error('Graph build is outside its owned staging directory');
  if (!(await regularFile(buildPath))) throw new Error('Graph build is missing');
  if (await regularFile(path.join(root, RECEIPT)))
    throw new Error('Recover the pending graph publication before preparing another');
  const id = randomUUID().replaceAll('-', '');
  const graphFile = `lbug.generation.${id}`;
  const metadataFile = `analysis-meta-${id}.json`;
  const preparedMeta: RepoMeta = {
    ...metadata,
    graphPath: graphFile,
    graphGeneration: { version: 1, id, coveredContent },
  };
  const bytes = Buffer.from(JSON.stringify(preparedMeta));
  if (bytes.length > MAX_METADATA_BYTES)
    throw new Error('Graph metadata exceeds the supported publication size');
  const receipt: PreparedAnalysisPublication = {
    version: 1,
    id,
    stagingFile: path.basename(buildPath),
    graphFile,
    metadataFile,
    metadataBytes: bytes.length,
    metadataDigest: hash(bytes),
    ...((await regularFile(path.join(root, 'lbug')))
      ? { legacyGraphFile: `lbug.generation.${randomUUID().replaceAll('-', '')}` }
      : {}),
  };
  validateReceipt(receipt);
  await writeDurable(root, metadataFile, bytes);
  const payload = JSON.stringify(receipt);
  await writeDurable(
    root,
    RECEIPT,
    Buffer.from(JSON.stringify({ checksum: hash(payload), payload: receipt })),
  );
  return receipt;
}

export async function readPreparedAnalysis(
  directory: string,
): Promise<PreparedAnalysisPublication | undefined> {
  const root = await embeddingJobDirectory(directory);
  let bytes: Buffer;
  try {
    bytes = await boundedRead(path.join(root, RECEIPT), MAX_RECEIPT_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const envelope: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    !('payload' in envelope) ||
    !('checksum' in envelope) ||
    hash(JSON.stringify(envelope.payload)) !== envelope.checksum
  )
    throw new Error('Prepared publication checksum mismatch; artifacts retained');
  validateReceipt(envelope.payload);
  return envelope.payload;
}

export async function syncPublishedMetadata(root: string, metadata: RepoMeta): Promise<void> {
  const metadataPath = path.join(root, INDEX_METADATA_FILE);
  const saved = await boundedRead(metadataPath, MAX_METADATA_BYTES);
  if (
    hash(JSON.stringify(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(saved)))) !==
    hash(JSON.stringify(metadata))
  )
    throw new Error(
      'Published graph metadata does not match the prepared generation; artifacts retained',
    );
  // Windows FlushFileBuffers requires a writable descriptor. The coordinator
  // owns the write lock; this opens the file without changing its contents.
  const handle = await fs.open(metadataPath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncEmbeddingJobDirectory(root);
}

/** Older binaries ignore private generation pointers. Remove the obsolete
 * canonical name before advancing metadata, retaining its inode for readers
 * and rollback. A hard-link failure leaves the old index readable and aborts;
 * relocating vectors must never trigger a full graph copy.
 */
async function retireLegacyGraph(
  root: string,
  receipt: PreparedAnalysisPublication,
  metadata: RepoMeta,
  actions: AnalysisPublicationActions,
): Promise<void> {
  const legacy = path.join(root, 'lbug');
  if (!receipt.legacyGraphFile) {
    if (await regularFile(legacy))
      throw new Error('Unexpected legacy graph appeared during publication');
    return;
  }
  const retired = path.join(root, receipt.legacyGraphFile);
  if (!(await regularFile(legacy))) {
    if (!(await regularFile(retired))) throw new Error('Legacy graph retirement artifact missing');
    return;
  }
  if (await regularFile(retired)) {
    const [before, after] = await Promise.all([fs.stat(legacy), fs.stat(retired)]);
    if (!before.ino || before.ino !== after.ino || before.dev !== after.dev)
      throw new Error('Conflicting legacy graph retirement artifact');
  } else {
    await fs.link(legacy, retired);
    await syncEmbeddingJobDirectory(root);
  }
  const previous = JSON.parse(
    (await boundedRead(path.join(root, INDEX_METADATA_FILE), MAX_METADATA_BYTES)).toString('utf8'),
  ) as RepoMeta;
  if (previous.repoPath !== metadata.repoPath)
    throw new Error('Legacy graph belongs to another repository');
  if (!previous.graphPath) {
    const redirected = { ...previous, graphPath: receipt.legacyGraphFile };
    await actions.saveMetadata(redirected);
    await syncPublishedMetadata(root, redirected);
  }
  await fs.unlink(legacy);
  await syncEmbeddingJobDirectory(root);
}

/** Also recovers crashes after rename or metadata publication. Every attempt
 * re-verifies the owned native artifact; a generation identifier is not proof.
 * Existing graph files remain untouched so readers can finish their snapshots.
 */
export async function publishPreparedAnalysis(
  directory: string,
  actions: AnalysisPublicationActions,
): Promise<RepoMeta | undefined> {
  const root = await embeddingJobDirectory(directory);
  const receipt = await readPreparedAnalysis(root);
  if (!receipt) return undefined;
  const bytes = await boundedRead(path.join(root, receipt.metadataFile), receipt.metadataBytes);
  if (bytes.length !== receipt.metadataBytes || hash(bytes) !== receipt.metadataDigest)
    throw new Error('Prepared graph metadata checksum mismatch; artifacts retained');
  const metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as RepoMeta;
  if (
    metadata.graphPath !== receipt.graphFile ||
    metadata.graphGeneration?.version !== 1 ||
    metadata.graphGeneration.id !== receipt.id ||
    !DIGEST.test(metadata.graphGeneration.coveredContent)
  )
    throw new Error('Prepared graph generation mismatch');
  const staged = path.join(root, receipt.stagingFile);
  const published = path.join(root, receipt.graphFile);
  const stagedExists = await regularFile(staged);
  const publishedExists = await regularFile(published);
  if (stagedExists === publishedExists)
    throw new Error('Prepared publication has missing or conflicting graph artifacts');
  const source = stagedExists ? staged : published;
  await actions.verify(source, metadata);
  if (stagedExists) {
    await fs.rename(staged, published);
    await syncEmbeddingJobDirectory(root);
  }
  await retireLegacyGraph(root, receipt, metadata, actions);
  await actions.saveMetadata(metadata);
  // The canonical pointer must be durable before callers start paid work.
  await syncPublishedMetadata(root, metadata);
  await fs.unlink(path.join(root, RECEIPT));
  // Persist removal of the recovery pointer before removing what it names.
  // A power loss must not resurrect a receipt whose metadata is already gone.
  await syncEmbeddingJobDirectory(root);
  await fs.unlink(path.join(root, receipt.metadataFile));
  await syncEmbeddingJobDirectory(root);
  return metadata;
}
