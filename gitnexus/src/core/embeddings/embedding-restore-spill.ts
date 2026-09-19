/**
 * Disk-backed restore cache for CodeEmbedding rows (#3306).
 *
 * `loadCachedEmbeddings` used to `getAll()` the table and `map(Number)` every
 * vector into a JS `number[]`. On a large already-indexed repo that single
 * structure OOMs the V8 heap during "Caching embeddings..." even when the
 * incremental diff is a handful of nodes.
 *
 * This module keeps metadata in RAM and writes vectors to a temp Float32
 * spill. Restore materializes only the rows that Phase 3.5 will re-insert,
 * in the existing 200-row batches.
 */
import { closeSync, openSync, readSync, unlinkSync, writeSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { CachedEmbedding } from './types.js';

/** In-RAM vector copies stay below this row count; larger tables use the spill. */
export const DEFAULT_EMBEDDING_CACHE_IN_MEMORY_ROW_LIMIT = 2048;

const SPILL_MAGIC = 'GNXE';
const SPILL_VERSION = 1;
const SPILL_HEADER_BYTES = 12;

export interface CachedEmbeddingMeta {
  nodeId: string;
  chunkIndex: number;
  startLine: number;
  endLine: number;
  contentHash?: string;
  /** Row order in the spill file (and in `embeddings` when in-memory). */
  vectorIndex: number;
}

export interface EmbeddingVectorSpill {
  path: string;
  dims: number;
  rowCount: number;
}

export interface CachedEmbeddingsSnapshot {
  embeddingNodeIds: Set<string>;
  /** Populated only when the table is at or under the in-memory row limit. */
  embeddings: CachedEmbedding[];
  rows: CachedEmbeddingMeta[];
  spill?: EmbeddingVectorSpill;
}

export interface LoadCachedEmbeddingsOptions {
  /**
   * Keep full `number[]` vectors in RAM at or below this many rows.
   * `0` always spills. Default {@link DEFAULT_EMBEDDING_CACHE_IN_MEMORY_ROW_LIMIT}
   * or `GITNEXUS_EMBEDDING_CACHE_IN_MEMORY_LIMIT`.
   */
  inMemoryRowLimit?: number;
  /** Directory for the spill file (default `os.tmpdir()`). */
  spillDir?: string;
}

export interface CachedEmbeddingsBuilder {
  embeddingNodeIds: Set<string>;
  rows: CachedEmbeddingMeta[];
  /** Float32 vectors kept in RAM until the in-memory row limit is exceeded. */
  inMemory: Float32Array[] | null;
  inMemoryRowLimit: number;
  writer: EmbeddingSpillWriter;
}

export function emptyCachedEmbeddingsSnapshot(): CachedEmbeddingsSnapshot {
  return { embeddingNodeIds: new Set(), embeddings: [], rows: [] };
}

export function resolveEmbeddingCacheInMemoryRowLimit(override?: number): number {
  if (override !== undefined) {
    if (!Number.isFinite(override) || override < 0) {
      return DEFAULT_EMBEDDING_CACHE_IN_MEMORY_ROW_LIMIT;
    }
    return Math.floor(override);
  }
  const raw = process.env.GITNEXUS_EMBEDDING_CACHE_IN_MEMORY_LIMIT;
  if (raw === undefined || raw === '') return DEFAULT_EMBEDDING_CACHE_IN_MEMORY_ROW_LIMIT;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_EMBEDDING_CACHE_IN_MEMORY_ROW_LIMIT;
}

export function normalizeCachedEmbeddings(raw: {
  embeddingNodeIds?: Set<string>;
  embeddings?: CachedEmbedding[];
  rows?: CachedEmbeddingMeta[];
  spill?: EmbeddingVectorSpill;
}): CachedEmbeddingsSnapshot {
  const embeddings = raw.embeddings ?? [];
  const embeddingNodeIds = raw.embeddingNodeIds ?? new Set(embeddings.map((row) => row.nodeId));
  const rows =
    raw.rows ??
    embeddings.map((row, vectorIndex) => ({
      nodeId: row.nodeId,
      chunkIndex: row.chunkIndex,
      startLine: row.startLine,
      endLine: row.endLine,
      contentHash: row.contentHash,
      vectorIndex,
    }));
  return { embeddingNodeIds, embeddings, rows, spill: raw.spill };
}

export function cacheRowCount(snapshot: CachedEmbeddingsSnapshot): number {
  return snapshot.rows.length > 0 ? snapshot.rows.length : snapshot.embeddings.length;
}

export function snapshotEmbeddingDims(snapshot: CachedEmbeddingsSnapshot): number | undefined {
  if (snapshot.spill && snapshot.spill.dims > 0) return snapshot.spill.dims;
  const dims = snapshot.embeddings[0]?.embedding.length;
  return dims && dims > 0 ? dims : undefined;
}

export function coerceEmbeddingToFloat32(embedding: unknown): Float32Array | null {
  if (embedding == null) return null;
  if (embedding instanceof Float32Array) {
    return embedding.length > 0 ? embedding : null;
  }
  if (ArrayBuffer.isView(embedding) && !(embedding instanceof DataView)) {
    const view = embedding as Exclude<ArrayBufferView, DataView> & { length: number };
    if (view.length === 0) return null;
    return Float32Array.from({ length: view.length }, (_, i) => Number(view[i]));
  }
  if (
    typeof embedding === 'object' &&
    typeof (embedding as Iterable<unknown>)[Symbol.iterator] === 'function'
  ) {
    const arr = Array.isArray(embedding)
      ? (embedding as unknown[])
      : Array.from(embedding as Iterable<unknown>);
    if (arr.length === 0) return null;
    return Float32Array.from(arr, (value) => Number(value));
  }
  return null;
}

export function float32ToNumberArray(vec: Float32Array): number[] {
  const out = new Array<number>(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i]!;
  return out;
}

/**
 * `fs.writeSync` can return a short byte count. Loop until the whole buffer
 * lands, matching `sync-csv-writer.ts`, so a partial write never advances
 * `rowCount` on a truncated vector.
 */
function writeAllSync(fd: number, data: Uint8Array): void {
  let offset = 0;
  while (offset < data.length) {
    const n = writeSync(fd, data, offset, data.length - offset);
    if (n <= 0) {
      throw new Error(`embedding spill short write: wrote ${n} of ${data.length - offset} bytes`);
    }
    offset += n;
  }
}

function unlinkBestEffort(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    /* ENOENT or already removed */
  }
}

const liveSpillPaths = new Set<string>();
const spillScope = new AsyncLocalStorage<Set<string>>();
let spillExitHookInstalled = false;

function trackLiveSpillPath(filePath: string): void {
  liveSpillPaths.add(filePath);
  spillScope.getStore()?.add(filePath);
  if (!spillExitHookInstalled) {
    spillExitHookInstalled = true;
    process.on('exit', () => {
      for (const spillPath of liveSpillPaths) {
        unlinkBestEffort(spillPath);
      }
    });
  }
}

function untrackLiveSpillPath(filePath: string): void {
  liveSpillPaths.delete(filePath);
}

/** Best-effort unlink of every tracked spill. Safe to call more than once. */
export function discardLiveEmbeddingSpills(): void {
  for (const spillPath of [...liveSpillPaths]) {
    unlinkBestEffort(spillPath);
    liveSpillPaths.delete(spillPath);
  }
}

/** Run `fn` so later {@link discardScopedEmbeddingSpills} only unlinks this run. */
export function withEmbeddingSpillScope<T>(fn: () => T): T {
  return spillScope.run(new Set(), fn);
}

/** Unlink spills created inside the current {@link withEmbeddingSpillScope}. */
export function discardScopedEmbeddingSpills(): void {
  const owned = spillScope.getStore();
  if (!owned) return;
  for (const spillPath of [...owned]) {
    unlinkBestEffort(spillPath);
    liveSpillPaths.delete(spillPath);
    owned.delete(spillPath);
  }
}

export class EmbeddingSpillWriter {
  readonly path: string;
  dims = 0;
  rowCount = 0;
  private fd: number | null = null;
  private closed = false;

  constructor(dir: string) {
    this.path = path.join(
      dir,
      `gitnexus-embed-restore-${process.pid}-${randomBytes(8).toString('hex')}.bin`,
    );
  }

  append(vec: Float32Array): void {
    if (this.closed) {
      throw new Error('embedding spill writer already closed');
    }
    if (this.fd === null) {
      this.dims = vec.length;
      this.fd = openSync(this.path, 'wx', 0o600);
      trackLiveSpillPath(this.path);
      const header = Buffer.alloc(SPILL_HEADER_BYTES);
      header.write(SPILL_MAGIC, 0, 4, 'ascii');
      header.writeUInt8(SPILL_VERSION, 4);
      header.writeUInt32LE(this.dims, 5);
      writeAllSync(this.fd, header);
    } else if (vec.length !== this.dims) {
      throw new Error(
        `embedding dim mismatch while spilling: got ${vec.length}, expected ${this.dims}`,
      );
    }
    writeAllSync(this.fd, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
    this.rowCount++;
  }

  finish(): EmbeddingVectorSpill | undefined {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
    this.closed = true;
    if (this.rowCount === 0) {
      this.unlinkQuiet();
      return undefined;
    }
    return { path: this.path, dims: this.dims, rowCount: this.rowCount };
  }

  abort(): void {
    const opened = this.fd !== null;
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        /* already closed */
      }
      this.fd = null;
    }
    this.closed = true;
    if (opened || this.rowCount > 0) {
      this.unlinkQuiet();
    }
  }

  private unlinkQuiet(): void {
    unlinkBestEffort(this.path);
    untrackLiveSpillPath(this.path);
  }
}

/** Validates the spill header once and reads vectors without reopening the file. */
export class EmbeddingSpillReader {
  private fd: number | null = null;
  private readonly bytesPerVec: number;
  readonly dims: number;
  readonly rowCount: number;

  constructor(spill: EmbeddingVectorSpill) {
    this.rowCount = spill.rowCount;
    const fd = openSync(spill.path, 'r');
    try {
      const header = Buffer.alloc(SPILL_HEADER_BYTES);
      const headerRead = readSync(fd, header, 0, SPILL_HEADER_BYTES, 0);
      if (headerRead !== SPILL_HEADER_BYTES || header.toString('ascii', 0, 4) !== SPILL_MAGIC) {
        throw new Error(`invalid embedding spill header: ${spill.path}`);
      }
      if (header.readUInt8(4) !== SPILL_VERSION) {
        throw new Error(`unsupported embedding spill version in ${spill.path}`);
      }
      const dims = header.readUInt32LE(5);
      if (dims !== spill.dims) {
        throw new Error(`embedding spill dim mismatch: file ${dims}, expected ${spill.dims}`);
      }
      this.dims = dims;
      this.bytesPerVec = dims * 4;
      this.fd = fd;
    } catch (err) {
      closeSync(fd);
      throw err;
    }
  }

  read(indices: readonly number[]): Float32Array[] {
    if (this.fd === null) {
      throw new Error('embedding spill reader already closed');
    }
    const out: Float32Array[] = [];
    for (const index of indices) {
      if (!Number.isInteger(index) || index < 0 || index >= this.rowCount) {
        throw new Error(`embedding spill index out of range: ${index}`);
      }
      const offset = SPILL_HEADER_BYTES + index * this.bytesPerVec;
      const copy = new Float32Array(this.dims);
      const bytes = new Uint8Array(copy.buffer, copy.byteOffset, this.bytesPerVec);
      const n = readSync(this.fd, bytes, 0, this.bytesPerVec, offset);
      if (n !== this.bytesPerVec) {
        throw new Error(`short embedding spill read at index ${index}`);
      }
      out.push(copy);
    }
    return out;
  }

  close(): void {
    if (this.fd === null) return;
    closeSync(this.fd);
    this.fd = null;
  }
}

export function readSpillVectors(
  spill: EmbeddingVectorSpill,
  indices: readonly number[],
): Float32Array[] {
  const reader = new EmbeddingSpillReader(spill);
  try {
    return reader.read(indices);
  } finally {
    reader.close();
  }
}

export function disposeEmbeddingSpill(spill?: EmbeddingVectorSpill): void {
  if (!spill?.path) return;
  unlinkBestEffort(spill.path);
  untrackLiveSpillPath(spill.path);
}

export function createCachedEmbeddingsBuilder(
  options?: LoadCachedEmbeddingsOptions,
): CachedEmbeddingsBuilder {
  const inMemoryRowLimit = resolveEmbeddingCacheInMemoryRowLimit(options?.inMemoryRowLimit);
  return {
    embeddingNodeIds: new Set(),
    rows: [],
    inMemory: inMemoryRowLimit <= 0 ? null : [],
    inMemoryRowLimit,
    writer: new EmbeddingSpillWriter(options?.spillDir ?? os.tmpdir()),
  };
}

export function ingestCachedEmbeddingRow(
  builder: CachedEmbeddingsBuilder,
  row: Record<string, unknown> | unknown[],
  hasContentHash: boolean,
): void {
  const rec = row as Record<string, unknown> & unknown[];
  const nodeId = String(rec.nodeId ?? rec[0] ?? '');
  if (!nodeId) return;
  const embedding = rec.embedding ?? rec[4];
  const f32 = coerceEmbeddingToFloat32(embedding);
  if (!f32) return;

  builder.embeddingNodeIds.add(nodeId);
  const meta: CachedEmbeddingMeta = {
    nodeId,
    chunkIndex: Number(rec.chunkIndex ?? rec[1] ?? 0),
    startLine: Number(rec.startLine ?? rec[2] ?? 0),
    endLine: Number(rec.endLine ?? rec[3] ?? 0),
    contentHash: hasContentHash
      ? ((rec.contentHash ?? rec[5] ?? undefined) as string | undefined)
      : undefined,
    vectorIndex: builder.rows.length,
  };
  builder.rows.push(meta);

  if (builder.inMemory && builder.rows.length <= builder.inMemoryRowLimit) {
    builder.inMemory.push(f32);
    return;
  }

  if (builder.inMemory) {
    for (const prior of builder.inMemory) {
      builder.writer.append(prior);
    }
    builder.inMemory = null;
  }
  builder.writer.append(f32);
}

export function finalizeCachedEmbeddingsSnapshot(
  builder: CachedEmbeddingsBuilder,
): CachedEmbeddingsSnapshot {
  const inMemory = builder.inMemory;
  if (inMemory) {
    builder.writer.abort();
    return {
      embeddingNodeIds: builder.embeddingNodeIds,
      embeddings: builder.rows.map((meta, i) => ({
        nodeId: meta.nodeId,
        chunkIndex: meta.chunkIndex,
        startLine: meta.startLine,
        endLine: meta.endLine,
        contentHash: meta.contentHash,
        embedding: float32ToNumberArray(inMemory[i]!),
      })),
      rows: builder.rows,
    };
  }
  return {
    embeddingNodeIds: builder.embeddingNodeIds,
    embeddings: [],
    rows: builder.rows,
    spill: builder.writer.finish(),
  };
}

export function abortCachedEmbeddingsBuilder(builder: CachedEmbeddingsBuilder): void {
  builder.writer.abort();
}

export function materializeCachedEmbeddings(
  snapshot: CachedEmbeddingsSnapshot,
  metas: readonly CachedEmbeddingMeta[],
  spillReader?: EmbeddingSpillReader,
): CachedEmbedding[] {
  if (metas.length === 0) return [];
  if (snapshot.spill && snapshot.embeddings.length === 0) {
    const indices = metas.map((meta) => meta.vectorIndex);
    const vectors = spillReader
      ? spillReader.read(indices)
      : readSpillVectors(snapshot.spill, indices);
    return metas.map((meta, i) => ({
      nodeId: meta.nodeId,
      chunkIndex: meta.chunkIndex,
      startLine: meta.startLine,
      endLine: meta.endLine,
      contentHash: meta.contentHash,
      embedding: float32ToNumberArray(vectors[i]!),
    }));
  }
  if (snapshot.embeddings.length === 0) return [];
  const byKey = new Map(
    snapshot.embeddings.map((row) => [`${row.nodeId}:${row.chunkIndex}`, row] as const),
  );
  return metas.map((meta) => {
    const hit =
      byKey.get(`${meta.nodeId}:${meta.chunkIndex}`) ?? snapshot.embeddings[meta.vectorIndex];
    if (!hit) {
      throw new Error(`missing cached embedding ${meta.nodeId}:${meta.chunkIndex}`);
    }
    return hit;
  });
}
