/** Durable graph publication. Native verification/close and metadata ownership
 * are supplied by the coordinator, which holds the index-directory write lock. */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { RepoMeta } from '../storage/repo-meta.js';
import { INDEX_METADATA_FILE, LEGACY_METADATA_FILE } from '../storage/storage-constants.js';
import { preserveVectorCoverage } from '../storage/vector-generation.js';
import { embeddingJobDirectory, syncEmbeddingJobDirectory } from '../storage/embedding-job.js';
import { readProcStartTime } from '../storage/index-lock.js';
import {
  getAnalysisWriterProbeTimeoutMs,
  isAnalysisWriterBirth,
  readAnalysisWriterBirth,
  type AnalysisWriterBirth,
} from './analysis-writer-identity.js';
import { reclaimAnalysisArtifacts } from '../storage/analysis-artifact-cleanup.js';

const RECEIPT = 'analysis-publication.json';
const GENERATION = /^[a-f0-9]{32}$/;
const PRIVATE_GRAPH = /^lbug\.generation\.[a-f0-9]{32}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const STAGING = /^lbug(?:\.generation\.[a-f0-9]{32})?\.staging\.[a-f0-9-]{36}$/;
const MAX_RECEIPT_BYTES = 4096;
const MAX_METADATA_BYTES = 256 * 1024 * 1024;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
// Share the incarnation across loaders of this module within one process.
const INSTANCE_KEY = Symbol.for('gitnexus.analysis-publication.writer-instance');
const processIdentity = process as unknown as Record<symbol, string>;
const WRITER_INSTANCE = (processIdentity[INSTANCE_KEY] ??= randomUUID().replaceAll('-', ''));

export interface PreparedAnalysisPublication {
  version: 2;
  mode: 'staged' | 'in-place';
  id: string;
  /** Source basename; also names the existing file for in-place writes. */
  stagingFile: string;
  graphFile: string;
  metadataFile: string;
  metadataBytes: number;
  metadataDigest: string;
  /** Exact prior metadata, or absence, observed under the slot's write lock. */
  priorMetadataDigest: string | null;
  /** Permitted intermediate state while retiring a canonical legacy graph. */
  redirectedMetadataDigest?: string;
  /** Exit-only callers may not publish while this process is still alive. */
  writerPid?: number;
  writerStartTime?: string;
  /** Tagged OS process birth identity; absent in older v2 receipts. */
  writerBirth?: AnalysisWriterBirth;
  writerInstance?: string;
  /** A hard-link destination for the previous legacy graph; never copied. */
  legacyGraphFile?: string;
}

export type AnalysisPublicationOptions = (
  | { mode?: 'staged' }
  | { mode: 'in-place'; attemptId: string }
) & { waitForProcessExit?: boolean };

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
    r.version !== 2 ||
    !GENERATION.test(r.id) ||
    !PRIVATE_GRAPH.test(r.graphFile) ||
    (r.mode === 'staged'
      ? !STAGING.test(r.stagingFile) || r.graphFile !== `lbug.generation.${r.id}`
      : r.mode !== 'in-place' ||
        (r.stagingFile === 'lbug'
          ? r.graphFile !== `lbug.generation.${r.id}`
          : !PRIVATE_GRAPH.test(r.stagingFile) || r.graphFile !== r.stagingFile)) ||
    r.metadataFile !== `analysis-meta-${r.id}.json` ||
    (r.priorMetadataDigest !== null && !DIGEST.test(r.priorMetadataDigest)) ||
    (r.redirectedMetadataDigest !== undefined &&
      (!r.legacyGraphFile || !DIGEST.test(r.redirectedMetadataDigest))) ||
    (r.writerPid !== undefined && (!Number.isSafeInteger(r.writerPid) || r.writerPid < 1)) ||
    (r.writerStartTime !== undefined && (!r.writerPid || !/^\d{1,32}$/.test(r.writerStartTime))) ||
    (r.writerBirth !== undefined && (!r.writerPid || !isAnalysisWriterBirth(r.writerBirth))) ||
    (r.writerInstance !== undefined && (!r.writerPid || !GENERATION.test(r.writerInstance))) ||
    (r.legacyGraphFile !== undefined &&
      (r.mode !== 'staged' ||
        !PRIVATE_GRAPH.test(r.legacyGraphFile) ||
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
  const handle = await fs.open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = await handle.stat();
    const entry = await fs.lstat(file);
    if (!entry.isFile() || entry.isSymbolicLink())
      throw new Error('Publication artifact must be an owned regular file');
    if (stat.dev !== entry.dev || stat.ino !== entry.ino)
      throw new Error('Publication artifact changed while opening');
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

async function readSlotMetadata(root: string): Promise<RepoMeta | null> {
  try {
    let bytes: Buffer;
    try {
      bytes = await boundedRead(path.join(root, INDEX_METADATA_FILE), MAX_METADATA_BYTES);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      bytes = await boundedRead(path.join(root, LEGACY_METADATA_FILE), MAX_METADATA_BYTES);
    }
    const metadata: RepoMeta = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!metadata || typeof metadata.repoPath !== 'string')
      throw new Error('Invalid graph slot metadata; artifacts retained');
    return metadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

const metadataDigest = (metadata: RepoMeta | null): string | null =>
  metadata === null ? null : hash(JSON.stringify(metadata));

/** Replaces the existing pre-write dirty stamp, never an extra post-write stamp.
 * The coordinator holds the slot lock and must await this before mutating native
 * data. An interrupted in-place attempt requires the usual dirty-graph rebuild.
 */
export async function beginInPlaceAnalysis(
  directory: string,
  metadata: RepoMeta,
  saveMetadata: AnalysisPublicationActions['saveMetadata'],
): Promise<RepoMeta> {
  const root = await embeddingJobDirectory(directory);
  if (
    !metadata.incrementalInProgress ||
    (metadata.graphPath !== undefined && !PRIVATE_GRAPH.test(metadata.graphPath))
  )
    throw new Error('In-place publication requires a private graph and a dirty write plan');
  if (await readPreparedAnalysis(root))
    throw new Error('Recover the pending graph publication before starting another');
  // Refuse an aliased native target before the caller can perform its first write.
  await regularFile(path.join(root, metadata.graphPath ?? 'lbug'));
  const prior = await readSlotMetadata(root);
  if (prior && prior.repoPath !== metadata.repoPath)
    throw new Error('Graph slot belongs to another repository');
  const attemptId = randomUUID().replaceAll('-', '');
  const dirty: RepoMeta = {
    ...metadata,
    vectorGeneration: preserveVectorCoverage(metadata, attemptId),
    incrementalInProgress: {
      ...metadata.incrementalInProgress,
      writePlan: 'in-place',
      attemptId,
    },
  };
  delete dirty.graphGeneration;
  await saveMetadata(dirty);
  await syncPublishedMetadata(root, dirty);
  return dirty;
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
  options: AnalysisPublicationOptions = {},
): Promise<PreparedAnalysisPublication> {
  const root = await embeddingJobDirectory(directory);
  if (
    !DIGEST.test(coveredContent) ||
    !metadata.repoPath ||
    !metadata.runnerIdentity ||
    metadata.incrementalInProgress ||
    metadata.graphWriteCollapsed
  )
    throw new Error('Graph publication requires verified source and analyzer metadata');
  const mode = options.mode ?? 'staged';
  const sourceFile = path.basename(buildPath);
  if (
    (await fs.realpath(path.dirname(buildPath))) !== root ||
    (mode === 'staged'
      ? !STAGING.test(sourceFile)
      : sourceFile !== 'lbug' && !PRIVATE_GRAPH.test(sourceFile))
  )
    throw new Error('Graph build is outside its owned staging directory');
  if (!(await regularFile(buildPath))) throw new Error('Graph build is missing');
  if (await regularFile(path.join(root, RECEIPT)))
    throw new Error('Recover the pending graph publication before preparing another');
  const prior = await readSlotMetadata(root);
  if (prior && prior.repoPath !== metadata.repoPath)
    throw new Error('Graph slot belongs to another repository');
  if (
    options.mode === 'in-place' &&
    (!GENERATION.test(options.attemptId) ||
      prior?.incrementalInProgress?.attemptId !== options.attemptId ||
      (prior.graphPath ?? 'lbug') !== sourceFile ||
      prior.graphGeneration)
  )
    throw new Error('In-place graph attempt is missing or superseded; artifacts retained');
  const id = options.mode === 'in-place' ? options.attemptId : randomUUID().replaceAll('-', '');
  const graphFile =
    mode === 'in-place' && sourceFile !== 'lbug' ? sourceFile : `lbug.generation.${id}`;
  const metadataFile = `analysis-meta-${id}.json`;
  const preparedMeta: RepoMeta = {
    ...metadata,
    vectorGeneration: preserveVectorCoverage(metadata, id),
    graphPath: graphFile,
    graphGeneration: { version: 1, id, coveredContent },
  };
  const bytes = Buffer.from(JSON.stringify(preparedMeta));
  if (bytes.length > MAX_METADATA_BYTES)
    throw new Error('Graph metadata exceeds the supported publication size');
  const receipt: PreparedAnalysisPublication = {
    version: 2,
    mode,
    id,
    stagingFile: path.basename(buildPath),
    graphFile,
    metadataFile,
    metadataBytes: bytes.length,
    metadataDigest: hash(bytes),
    priorMetadataDigest: metadataDigest(prior),
    ...(options.waitForProcessExit
      ? {
          writerPid: process.pid,
          writerInstance: WRITER_INSTANCE,
          writerStartTime: readProcStartTime(process.pid) ?? undefined,
          writerBirth: await readAnalysisWriterBirth(process.pid),
        }
      : {}),
    ...(mode === 'staged' && (await regularFile(path.join(root, 'lbug')))
      ? { legacyGraphFile: `lbug.generation.${randomUUID().replaceAll('-', '')}` }
      : {}),
  };
  if (receipt.legacyGraphFile && prior && !prior.graphPath)
    receipt.redirectedMetadataDigest = hash(
      JSON.stringify({ ...prior, graphPath: receipt.legacyGraphFile }),
    );
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
  previous: RepoMeta | null,
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
  if (previous && previous.repoPath !== metadata.repoPath)
    throw new Error('Legacy graph belongs to another repository');
  if (previous && !previous.graphPath) {
    const redirected = { ...previous, graphPath: receipt.legacyGraphFile };
    await actions.saveMetadata(redirected);
    await syncPublishedMetadata(root, redirected);
  }
  try {
    await fs.unlink(legacy);
  } catch (error) {
    if (['EBUSY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? ''))
      throw new Error(
        'Cannot retire the legacy graph while a reader holds it. Stop older MCP/serve processes and rerun analyze; the prepared graph and embeddings are retained.',
        { cause: error },
      );
    throw error;
  }
  await syncEmbeddingJobDirectory(root);
}

/** Also recovers crashes after rename or metadata publication. Every attempt
 * re-verifies the owned native artifact; a generation identifier is not proof.
 * Staged writes retain the prior reader artifact. In-place writes have already
 * invalidated it and publish a new logical generation on the same private file.
 */
export async function publishPreparedAnalysis(
  directory: string,
  actions: AnalysisPublicationActions,
): Promise<RepoMeta | undefined> {
  const root = await embeddingJobDirectory(directory);
  const receipt = await readPreparedAnalysis(root);
  if (!receipt) return undefined;
  if (receipt.writerPid !== undefined) {
    const deadline =
      performance.now() +
      Math.max(2000, receipt.writerBirth ? getAnalysisWriterProbeTimeoutMs() : 0);
    for (;;) {
      // A live, recycled PID is not the process that prepared this receipt.
      if (
        receipt.writerPid === process.pid &&
        receipt.writerInstance &&
        receipt.writerInstance !== WRITER_INSTANCE
      )
        break;
      const started = readProcStartTime(receipt.writerPid);
      if (receipt.writerStartTime && started && receipt.writerStartTime !== started) break;
      if (receipt.writerBirth && performance.now() < deadline) {
        const birth = await readAnalysisWriterBirth(
          receipt.writerPid,
          deadline - performance.now(),
        );
        if (birth?.kind === receipt.writerBirth.kind && birth.value !== receipt.writerBirth.value)
          break;
      }
      try {
        process.kill(receipt.writerPid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') break;
        throw new Error(
          `Cannot verify graph writer PID ${receipt.writerPid}: ${error instanceof Error ? error.message : String(error)}. Run analyze as the original index owner after that process exits; artifacts retained.`,
          { cause: error },
        );
      }
      if (performance.now() >= deadline)
        throw new Error(
          `Graph writer PID ${receipt.writerPid} has not exited; publication must wait for physical release. Stop that analysis process and retry; artifacts retained.`,
        );
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
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
  const previous = await readSlotMetadata(root);
  const currentDigest = metadataDigest(previous);
  if (
    currentDigest !== receipt.priorMetadataDigest &&
    currentDigest !== receipt.redirectedMetadataDigest &&
    currentDigest !== receipt.metadataDigest
  )
    throw new Error(
      'Prepared graph publication was superseded; artifacts retained; retry analysis',
    );
  const staged = path.join(root, receipt.stagingFile);
  const published = path.join(root, receipt.graphFile);
  const stagedExists = await regularFile(staged);
  const publishedExists = await regularFile(published);
  const retainedInPlace = staged === published;
  if (retainedInPlace ? !publishedExists : stagedExists === publishedExists)
    throw new Error('Prepared publication has missing or conflicting graph artifacts');
  const source = stagedExists ? staged : published;
  await actions.verify(source, metadata);
  if (stagedExists && !retainedInPlace) {
    await fs.rename(staged, published);
    await syncEmbeddingJobDirectory(root);
  }
  await retireLegacyGraph(root, receipt, metadata, actions, previous);
  await actions.saveMetadata(metadata);
  // The canonical pointer must be durable before callers start paid work.
  await syncPublishedMetadata(root, metadata);
  await fs.unlink(path.join(root, RECEIPT));
  // Persist removal of the recovery pointer before removing what it names.
  // A power loss must not resurrect a receipt whose metadata is already gone.
  await syncEmbeddingJobDirectory(root);
  await fs.unlink(path.join(root, receipt.metadataFile));
  await syncEmbeddingJobDirectory(root);
  await reclaimAnalysisArtifacts(root, metadata, previous?.graphPath ?? receipt.legacyGraphFile);
  return metadata;
}
