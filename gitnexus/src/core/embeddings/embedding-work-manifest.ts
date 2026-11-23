import { createHash } from 'node:crypto';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { assertValidGraphNodeId } from '../graph/node-identity.js';
import { EmbeddingByteBudget } from '../analysis-resource-budget.js';
import { EMBEDDABLE_LABELS, type EmbeddableNode } from './types.js';
import {
  embeddingJobDirectory,
  openEmbeddingJobFile,
  readEmbeddingJobRecord,
  syncEmbeddingJobDirectory,
  writeEmbeddingJobRecord,
} from '../../storage/embedding-job.js';

// Persisted unit identity must not depend on a retry's memory/batch settings.
const UNIT_NODES = 64;
const UNIT_SOURCE_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const IO_BYTES = 64 * 1024;
const LABELS = new Set<string>([...EMBEDDABLE_LABELS, 'File']);

export interface EmbeddingWorkKey {
  id: string;
  contentBytes: number;
  /** Upper bound for serialized persisted node metadata, including its ID. */
  metadataBytes: number;
}

export interface EmbeddingManifestSource {
  /** Key-only scan in UTF-8 ID order. File scans yield only eligible text files. */
  scan(label: string): AsyncIterable<EmbeddingWorkKey>;
  /** Bounded primary-key fetch against the same immutable graph generation. */
  fetch(label: string, ids: readonly string[]): Promise<EmbeddableNode[]>;
}

export interface EmbeddingWorkUnit {
  ordinal: number;
  label: string;
  nodes: EmbeddingWorkKey[];
  /** Source strings plus persisted metadata; excludes later text/vector queues. */
  retainedBytes: number;
}

export interface EmbeddingManifestReceipt {
  version: 1;
  sourceIdentity: string;
  digest: string;
  bytes: number;
  totalNodes: number;
  totalUnits: number;
  maximumUnitBytes: number;
}

export interface EmbeddingManifestCursor {
  unit: number;
  offset: number;
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function keyBytes(key: EmbeddingWorkKey): number {
  return 2 * (key.contentBytes + key.metadataBytes);
}

function validateKey(value: unknown): asserts value is EmbeddingWorkKey {
  if (!value || typeof value !== 'object' || !('id' in value))
    throw new Error('Malformed embedding manifest key');
  assertValidGraphNodeId(value.id, 'Embedding manifest');
  if (
    Buffer.from(value.id).toString('utf8') !== value.id ||
    !('contentBytes' in value) ||
    !count(value.contentBytes) ||
    !('metadataBytes' in value) ||
    !count(value.metadataBytes) ||
    value.metadataBytes < Buffer.byteLength(value.id)
  ) {
    throw new Error('Invalid embedding manifest key bounds');
  }
  if (!Number.isSafeInteger(2 * (value.contentBytes + value.metadataBytes)))
    throw new Error('Embedding key size exceeds safe accounting');
}

class BufferedLines {
  private pending: string[] = [];
  private size = 0;
  constructor(private readonly handle: FileHandle) {}
  async write(line: string): Promise<void> {
    const size = Buffer.byteLength(line);
    if (size > MAX_LINE_BYTES)
      throw new Error('Embedding manifest record exceeds its bounded size');
    this.pending.push(line);
    this.size += size;
    if (this.size >= IO_BYTES) await this.flush();
  }
  async flush(): Promise<void> {
    if (!this.size) return;
    await this.handle.writeFile(this.pending.join(''));
    this.pending = [];
    this.size = 0;
  }
}

/** Framing stays bounded even for a corrupt file without a newline. */
async function* lines(file: string, start = 0): AsyncGenerator<{ text: string; end: number }> {
  const { handle } = await openEmbeddingJobFile(file);
  try {
    const buffer = Buffer.alloc(IO_BYTES);
    let pending = Buffer.alloc(0);
    let position = start;
    let lineStart = start;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      const data = pending.length
        ? Buffer.concat([pending, buffer.subarray(0, bytesRead)])
        : buffer.subarray(0, bytesRead);
      let offset = 0;
      for (;;) {
        const end = data.indexOf(10, offset);
        if (end < 0) break;
        if (end - offset + 1 > MAX_LINE_BYTES)
          throw new Error('Embedding manifest record exceeds its bounded size');
        lineStart += end - offset + 1;
        yield {
          text: new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(offset, end)),
          end: lineStart,
        };
        offset = end + 1;
      }
      pending = Buffer.from(data.subarray(offset));
      if (pending.length >= MAX_LINE_BYTES)
        throw new Error('Embedding manifest record exceeds its bounded size');
    }
    if (pending.length) throw new Error('Embedding manifest has an incomplete trailing record');
  } finally {
    await handle.close();
  }
}

/** Merge label-key spools to detect cross-label duplicates without a corpus Set. */
async function verifyUniqueKeys(files: string[]): Promise<void> {
  const readers = files.map((file) => lines(file));
  const heads: Array<{ id: string; bytes: Buffer } | undefined> = [];
  const head = (text: string): { id: string; bytes: Buffer } => {
    const { id }: { id: string } = JSON.parse(text);
    return { id, bytes: Buffer.from(id) };
  };
  try {
    for (const reader of readers) {
      const next = await reader.next();
      heads.push(next.done ? undefined : head(next.value.text));
    }
    let previous: string | undefined;
    for (;;) {
      let selected = -1;
      let selectedHead: { id: string; bytes: Buffer } | undefined;
      for (let i = 0; i < heads.length; i++) {
        const candidate = heads[i];
        if (
          candidate &&
          (!selectedHead || Buffer.compare(candidate.bytes, selectedHead.bytes) < 0)
        ) {
          selected = i;
          selectedHead = candidate;
        }
      }
      if (!selectedHead) break;
      const id = selectedHead.id;
      if (id === previous)
        throw new Error(
          'Embedding read: duplicate graph node identity; rebuild with analyze --force',
        );
      previous = id;
      const next = await readers[selected].next();
      heads[selected] = next.done ? undefined : head(next.value.text);
    }
  } finally {
    await Promise.all(readers.map((reader) => reader.return(undefined)));
  }
}

/** Preflight and publish the complete selection before any provider/write work. */
export async function createEmbeddingWorkManifest(
  directory: string,
  sourceIdentity: string,
  source: EmbeddingManifestSource,
): Promise<EmbeddingManifestReceipt> {
  if (!sourceIdentity || Buffer.byteLength(sourceIdentity) > 512)
    throw new Error('Invalid manifest source identity');
  const canonical = await embeddingJobDirectory(directory);
  const pendingPath = path.join(canonical, 'manifest.pending');
  const handle = await fs.open(pendingPath, 'wx', 0o600);
  const output = new BufferedLines(handle);
  const hash = createHash('sha256');
  const keyFiles: string[] = [];
  let totalNodes = 0;
  let totalUnits = 0;
  let maximumUnitBytes = 0;
  let bytes = 0;
  try {
    const scanLabel = async (label: string): Promise<void> => {
      const keyPath = path.join(canonical, `keys-${keyFiles.length}.jsonl`);
      const keysHandle = await fs.open(keyPath, 'wx', 0o600);
      keyFiles.push(keyPath);
      const keyOutput = new BufferedLines(keysHandle);
      let previous: Buffer | undefined;
      let nodes: EmbeddingWorkKey[] = [];
      let retainedBytes = 0;
      let recordBytes = 0;
      const flush = async (): Promise<void> => {
        if (!nodes.length) return;
        const unit: EmbeddingWorkUnit = { ordinal: totalUnits++, label, nodes, retainedBytes };
        const line = `${JSON.stringify(unit)}\n`;
        await output.write(line);
        hash.update(line);
        bytes += Buffer.byteLength(line);
        maximumUnitBytes = Math.max(maximumUnitBytes, retainedBytes);
        nodes = [];
        retainedBytes = 0;
        recordBytes = 0;
      };
      try {
        for await (const key of source.scan(label)) {
          validateKey(key);
          const id = Buffer.from(key.id);
          if (previous && Buffer.compare(previous, id) >= 0)
            throw new Error(
              `Embedding ${label} key scan is unordered or contains duplicate identities`,
            );
          previous = id;
          const serialized = `${JSON.stringify(key)}\n`;
          const size = Buffer.byteLength(serialized);
          if (size + 1024 > MAX_LINE_BYTES)
            throw new Error('Embedding identity exceeds the manifest record budget');
          if (
            nodes.length &&
            (nodes.length === UNIT_NODES ||
              retainedBytes + keyBytes(key) > UNIT_SOURCE_BYTES ||
              recordBytes + size + 1024 > MAX_LINE_BYTES)
          )
            await flush();
          await keyOutput.write(serialized);
          nodes.push({
            id: key.id,
            contentBytes: key.contentBytes,
            metadataBytes: key.metadataBytes,
          });
          retainedBytes += keyBytes(key);
          recordBytes += size;
          totalNodes++;
        }
        await flush();
        await keyOutput.flush();
      } finally {
        await keysHandle.close();
      }
    };
    for (const label of EMBEDDABLE_LABELS) await scanLabel(label);
    if (totalNodes === 0) await scanLabel('File');
    await verifyUniqueKeys(keyFiles);
    await output.flush();
    await handle.sync();
  } finally {
    await handle.close();
  }
  const receipt: EmbeddingManifestReceipt = {
    version: 1,
    sourceIdentity,
    digest: hash.digest('hex'),
    bytes,
    totalNodes,
    totalUnits,
    maximumUnitBytes,
  };
  await fs.rename(pendingPath, path.join(canonical, 'manifest.jsonl'));
  await syncEmbeddingJobDirectory(canonical);
  await writeEmbeddingJobRecord(canonical, 'manifest.json', receipt);
  await Promise.all(keyFiles.map((file) => fs.unlink(file)));
  return receipt;
}

/** Validate the durable selection without re-reading graph content or keys. */
export async function loadEmbeddingWorkManifest(
  directory: string,
  sourceIdentity: string,
): Promise<EmbeddingManifestReceipt> {
  const value = await readEmbeddingJobRecord(directory, 'manifest.json');
  if (!value || typeof value !== 'object') throw new Error('Malformed embedding manifest receipt');
  const receipt = value as EmbeddingManifestReceipt;
  if (
    receipt.version !== 1 ||
    receipt.sourceIdentity !== sourceIdentity ||
    !/^[0-9a-f]{64}$/.test(receipt.digest) ||
    !count(receipt.bytes) ||
    !count(receipt.totalNodes) ||
    !count(receipt.totalUnits) ||
    !count(receipt.maximumUnitBytes)
  ) {
    throw new Error('Embedding manifest identity or version mismatch; artifacts retained');
  }
  const canonical = await embeddingJobDirectory(directory);
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const line of lines(path.join(canonical, 'manifest.jsonl'))) {
    hash.update(`${line.text}\n`);
    bytes = line.end;
    if (bytes > receipt.bytes) throw new Error('Embedding manifest size mismatch');
  }
  if (bytes !== receipt.bytes || hash.digest('hex') !== receipt.digest)
    throw new Error('Embedding manifest checksum mismatch; artifacts retained');
  return receipt;
}

export async function* readEmbeddingWorkUnits(
  directory: string,
  receipt: EmbeddingManifestReceipt,
  cursor: EmbeddingManifestCursor = { unit: 0, offset: 0 },
): AsyncGenerator<{ unit: EmbeddingWorkUnit; next: EmbeddingManifestCursor }> {
  if (
    !count(cursor.unit) ||
    cursor.unit > receipt.totalUnits ||
    !count(cursor.offset) ||
    cursor.offset > receipt.bytes
  )
    throw new Error('Invalid embedding manifest cursor');
  const canonical = await embeddingJobDirectory(directory);
  let ordinal = cursor.unit;
  for await (const line of lines(path.join(canonical, 'manifest.jsonl'), cursor.offset)) {
    const unit: EmbeddingWorkUnit = JSON.parse(line.text);
    if (
      unit.ordinal !== ordinal ||
      !LABELS.has(unit.label) ||
      !Array.isArray(unit.nodes) ||
      !unit.nodes.length ||
      unit.nodes.length > UNIT_NODES
    )
      throw new Error('Invalid embedding work unit');
    unit.nodes.forEach(validateKey);
    if (
      unit.retainedBytes !== unit.nodes.reduce((sum, key) => sum + keyBytes(key), 0) ||
      unit.retainedBytes > receipt.maximumUnitBytes
    )
      throw new Error('Invalid embedding unit byte accounting');
    ordinal++;
    yield { unit, next: { unit: ordinal, offset: line.end } };
  }
  if (ordinal !== receipt.totalUnits)
    throw new Error('Embedding manifest cursor does not cover the remaining units');
}

export async function fetchEmbeddingWorkUnit(
  source: EmbeddingManifestSource,
  unit: EmbeddingWorkUnit,
  budget: EmbeddingByteBudget,
): Promise<{ nodes: EmbeddableNode[]; release: () => void }> {
  const release = budget.reserve(unit.retainedBytes);
  try {
    const rows = await source.fetch(
      unit.label,
      unit.nodes.map((node) => node.id),
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    if (rows.length !== unit.nodes.length || byId.size !== rows.length)
      throw new Error('Embedding source returned missing or duplicate nodes');
    const nodes = unit.nodes.map((key) => {
      const node = byId.get(key.id);
      if (
        !node ||
        node.label !== unit.label ||
        typeof node.content !== 'string' ||
        Buffer.byteLength(node.content) !== key.contentBytes ||
        Buffer.byteLength(JSON.stringify({ ...node, content: undefined })) > key.metadataBytes
      )
        throw new Error('Embedding graph changed after manifest publication');
      return node;
    });
    return { nodes, release };
  } catch (error) {
    release();
    throw error;
  }
}
