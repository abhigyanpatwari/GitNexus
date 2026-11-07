/** Filesystem-only provenance for one retired, immutable legacy database.
 * The caller holds the slot lock and retires/checkpoints the source before
 * recording it. No current configuration is used to fill historical fields. */
import { createHash, randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { EmbeddingIdentity } from '../core/embeddings/embedding-identity.js';
import { assertValidGraphNodeId } from '../core/graph/node-identity.js';
import {
  embeddingJobDirectory,
  openEmbeddingJobFile,
  readEmbeddingJobRecord,
  writeEmbeddingJobRecord,
  syncEmbeddingJobDirectory,
} from './embedding-job.js';

const DIGEST = /^[a-f0-9]{64}$/;
const SOURCE =
  /^lbug\.generation\.[a-f0-9]{32}$|^lbug(?:\.generation\.[a-f0-9]{32})?\.staging\.[a-f0-9-]{36}$/;
const IO_BYTES = 64 * 1024;
const MAX_ID_BYTES = 1024 * 1024;
const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export interface LegacyEmbeddingSourceRecord {
  version: 1;
  sourceFile: string;
  schemaFingerprint: string;
  recordedIdentity?: Partial<EmbeddingIdentity>;
  recordedInputIdentity?: string;
  /** Descriptor attributes detect replacement/mutation. Ownership and provider
   * provenance come from the retired slot and record, never these attributes. */
  file: { dev: string; ino: string; size: string; mtimeNs: string; ctimeNs: string };
  excluded: { digest: string; bytes: number; nodes: number };
}
export interface ResolvedLegacyEmbeddingSource extends LegacyEmbeddingSourceRecord {
  identity: string;
  path: string;
  excludedIds: () => AsyncIterable<string>;
}

function identityFields(
  value: Partial<EmbeddingIdentity> | undefined,
): Partial<EmbeddingIdentity> | undefined {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== 'object' ||
    (value.provider !== undefined && !/^(local|http:[a-f0-9]{64})$/.test(value.provider)) ||
    (value.model !== undefined &&
      (typeof value.model !== 'string' || !value.model || value.model.length > 2048)) ||
    (value.dimensions !== undefined && (!count(value.dimensions) || !value.dimensions))
  )
    throw new Error('Invalid recorded legacy embedding identity');
  return {
    ...(value.provider === undefined ? {} : { provider: value.provider }),
    ...(value.model === undefined ? {} : { model: value.model }),
    ...(value.dimensions === undefined ? {} : { dimensions: value.dimensions }),
  };
}
function record(value: unknown): LegacyEmbeddingSourceRecord {
  const r = value as LegacyEmbeddingSourceRecord;
  if (
    !r ||
    r.version !== 1 ||
    typeof r.sourceFile !== 'string' ||
    !SOURCE.test(r.sourceFile) ||
    typeof r.schemaFingerprint !== 'string' ||
    !r.schemaFingerprint ||
    r.schemaFingerprint.length > 2048 ||
    (r.recordedInputIdentity !== undefined && !DIGEST.test(r.recordedInputIdentity)) ||
    !r.file ||
    ![r.file.dev, r.file.ino, r.file.size, r.file.mtimeNs, r.file.ctimeNs].every(
      (v) => typeof v === 'string' && /^\d+$/.test(v),
    ) ||
    !r.excluded ||
    !DIGEST.test(r.excluded.digest) ||
    !count(r.excluded.bytes) ||
    !count(r.excluded.nodes)
  )
    throw new Error('Invalid legacy source receipt; source retained');
  const recordedIdentity = identityFields(r.recordedIdentity);
  return {
    version: 1,
    sourceFile: r.sourceFile,
    schemaFingerprint: r.schemaFingerprint,
    ...(recordedIdentity === undefined ? {} : { recordedIdentity }),
    ...(r.recordedInputIdentity === undefined
      ? {}
      : { recordedInputIdentity: r.recordedInputIdentity }),
    file: {
      dev: r.file.dev,
      ino: r.file.ino,
      size: r.file.size,
      mtimeNs: r.file.mtimeNs,
      ctimeNs: r.file.ctimeNs,
    },
    excluded: { digest: r.excluded.digest, bytes: r.excluded.bytes, nodes: r.excluded.nodes },
  };
}
function fileIdentity(stat: BigIntStats): LegacyEmbeddingSourceRecord['file'] {
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error('Legacy source must be an owned regular file');
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  };
}
async function sourceFile(root: string, r: LegacyEmbeddingSourceRecord): Promise<string> {
  const file = path.join(root, r.sourceFile);
  if (
    JSON.stringify(fileIdentity(await fs.lstat(file, { bigint: true }))) !== JSON.stringify(r.file)
  )
    throw new Error('Legacy source changed after retirement; artifacts retained');
  // A read-only migration cannot recover an interrupted native write. Its
  // graph-phase owner must checkpoint/recover it before writing this receipt.
  for (const suffix of ['.wal', '.shadow']) {
    try {
      const stat = await fs.lstat(file + suffix);
      if (!stat.isFile() || stat.size)
        throw new Error('Legacy source needs native recovery before reuse');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return file;
}
async function legacyRoot(root: string, create: boolean): Promise<string> {
  let directory = await embeddingJobDirectory(root);
  for (const part of ['embeddings', 'legacy']) {
    const next = path.join(directory, part);
    if (create) {
      try {
        await fs.mkdir(next, { mode: 0o700 });
        await syncEmbeddingJobDirectory(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    directory = await embeddingJobDirectory(next);
  }
  return directory;
}

/** Streams checkpoint exclusions once. The small receipt is published last,
 * after the spool is durable. The native source is never copied or modified. */
export async function recordLegacyEmbeddingSource(
  root: string,
  input: Pick<
    LegacyEmbeddingSourceRecord,
    'sourceFile' | 'schemaFingerprint' | 'recordedIdentity' | 'recordedInputIdentity'
  >,
  excluded: AsyncIterable<string> | Iterable<string>,
  signal?: AbortSignal,
): Promise<string> {
  root = await embeddingJobDirectory(root);
  if (!SOURCE.test(input.sourceFile))
    throw new Error('Legacy source must be a retired owned graph');
  const file = fileIdentity(await fs.lstat(path.join(root, input.sourceFile), { bigint: true }));
  const parent = await legacyRoot(root, true);
  const temporary = path.join(parent, `.prepare-${randomUUID()}`);
  await fs.mkdir(temporary, { mode: 0o700 });
  try {
    const handle = await fs.open(path.join(temporary, 'excluded.jsonl'), 'wx', 0o600);
    const checksum = createHash('sha256');
    let bytes = 0,
      nodes = 0,
      pending = '',
      pendingBytes = 0;
    try {
      for await (const id of excluded) {
        signal?.throwIfAborted();
        assertValidGraphNodeId(id, 'Legacy checkpoint');
        const line = JSON.stringify(id) + '\n';
        const length = Buffer.byteLength(line);
        if (length > MAX_ID_BYTES || !Number.isSafeInteger(bytes + length))
          throw new Error('Legacy exclusion exceeds its bounded size');
        checksum.update(line);
        bytes += length;
        nodes++;
        pending += line;
        pendingBytes += length;
        if (pendingBytes >= IO_BYTES) {
          await handle.writeFile(pending);
          pending = '';
          pendingBytes = 0;
        }
      }
      if (pendingBytes) await handle.writeFile(pending);
      await handle.sync();
    } finally {
      await handle.close();
    }
    signal?.throwIfAborted();
    const receipt = record({
      version: 1,
      ...input,
      file,
      excluded: { digest: checksum.digest('hex'), bytes, nodes },
    });
    await sourceFile(root, receipt);
    const identity = hash(receipt);
    await writeEmbeddingJobRecord(temporary, 'legacy.json', receipt);
    const destination = path.join(parent, identity);
    try {
      await fs.rename(temporary, destination);
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? ''))
        throw error;
      // An identical request is idempotent, but a corrupt prior spool is not
      // silently replaced. Fully validate it before trusting the same name.
      const prior = await readLegacyEmbeddingSource(root, identity);
      for await (const _id of prior.excludedIds()) signal?.throwIfAborted();
    }
    await syncEmbeddingJobDirectory(parent);
    return identity;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function* exclusions(
  directory: string,
  expected: LegacyEmbeddingSourceRecord['excluded'],
): AsyncGenerator<string> {
  const file = path.join(directory, 'excluded.jsonl');
  const { handle, stat } = await openEmbeddingJobFile(file);
  try {
    if (stat.size !== expected.bytes) throw new Error('Legacy exclusions size mismatch');
    const buffer = Buffer.alloc(IO_BYTES),
      checksum = createHash('sha256');
    let pending = Buffer.alloc(0),
      bytes = 0,
      nodes = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, bytes);
      if (!bytesRead) break;
      bytes += bytesRead;
      checksum.update(buffer.subarray(0, bytesRead));
      const data = pending.length
        ? Buffer.concat([pending, buffer.subarray(0, bytesRead)])
        : buffer.subarray(0, bytesRead);
      let offset = 0;
      for (;;) {
        const end = data.indexOf(10, offset);
        if (end < 0) break;
        if (end - offset + 1 > MAX_ID_BYTES)
          throw new Error('Legacy exclusion exceeds its bounded size');
        const id: unknown = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(offset, end)),
        );
        assertValidGraphNodeId(id, 'Legacy checkpoint');
        nodes++;
        yield id;
        offset = end + 1;
      }
      pending = Buffer.from(data.subarray(offset));
      if (pending.length >= MAX_ID_BYTES || bytes > expected.bytes)
        throw new Error('Legacy exclusions exceed their bounds');
    }
    if (
      pending.length ||
      bytes !== expected.bytes ||
      nodes !== expected.nodes ||
      checksum.digest('hex') !== expected.digest
    )
      throw new Error('Legacy exclusions checksum mismatch; source retained');
  } finally {
    await handle.close();
  }
}

/** Validate receipt ownership independently of a source that may already be reclaimed. */
export async function readLegacyEmbeddingSourceReceipt(
  root: string,
  identity: string,
): Promise<LegacyEmbeddingSourceRecord> {
  if (!DIGEST.test(identity)) throw new Error('Invalid legacy source identity');
  const directory = await embeddingJobDirectory(path.join(await legacyRoot(root, false), identity));
  const receipt = record(await readEmbeddingJobRecord(directory, 'legacy.json'));
  if (hash(receipt) !== identity)
    throw new Error('Legacy source identity mismatch; source retained');
  return receipt;
}

export async function readLegacyEmbeddingSource(
  root: string,
  identity: string,
): Promise<ResolvedLegacyEmbeddingSource> {
  root = await embeddingJobDirectory(root);
  const receipt = await readLegacyEmbeddingSourceReceipt(root, identity);
  const directory = path.join(root, 'embeddings', 'legacy', identity);
  return {
    ...receipt,
    identity,
    path: await sourceFile(root, receipt),
    excludedIds: () => exclusions(directory, receipt.excluded),
  };
}
