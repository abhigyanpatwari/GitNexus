/** Bounded, read-only reuse of verified legacy monolithic embedding groups. */
import lbug, { type LbugValue } from '@ladybugdb/core';
import fs from 'node:fs/promises';
import {
  openLbugConnection,
  closeLbugConnection,
  type LbugConnectionHandle,
} from './lbug-config.js';
import {
  VectorStore,
  type LegacyVectorGroup,
  type VectorNodeReceipt,
  type StoredVectorChunk,
} from './vector-store.js';
import { assertValidGraphNodeId } from '../graph/node-identity.js';
import type { EmbeddingIdentity } from '../embeddings/embedding-identity.js';
import { resolveEmbeddingConfig } from '../embeddings/config.js';
import {
  iterateEmbeddingInputs,
  type EmbeddingReuseOptions,
} from '../embeddings/embedding-inputs.js';
import { isShortLabel, type EmbeddableNode, type EmbeddingConfig } from '../embeddings/types.js';

export interface LegacyVectorSourceOptions {
  /** Caller validates ownership and holds the slot lock. WAL recovery and
   * checkpointing must already have completed in the graph process. */
  path: string;
  sourceIdentity: string;
  recordedIdentity?: Partial<EmbeddingIdentity>;
  expectedIdentity: EmbeddingIdentity;
  /** Optional historical input receipt; never synthesized from current config. */
  recordedInputIdentity?: string;
  expectedInputIdentity: string;
  config?: Partial<EmbeddingConfig>;
  bufferPoolBytes: number;
  threads: number;
  batchBytes: number;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

/** A row hash does not identify its provider. Never fill missing historical
 * fields from today's configuration, including for a mere file relocation. */
export function legacyVectorCompatibility(
  recorded: Partial<EmbeddingIdentity> | undefined,
  expected: EmbeddingIdentity,
): string | undefined {
  if (
    !recorded ||
    typeof recorded.provider !== 'string' ||
    !/^(local|http:[a-f0-9]{64})$/.test(recorded.provider) ||
    typeof recorded.model !== 'string' ||
    !recorded.model ||
    !Number.isSafeInteger(recorded.dimensions) ||
    !recorded.dimensions ||
    recorded.dimensions < 1
  )
    return 'Legacy embedding provider/model/dimensions provenance is unknown; source retained.';
  if (
    recorded.provider !== expected.provider ||
    recorded.model !== expected.model ||
    recorded.dimensions !== expected.dimensions
  )
    return 'Legacy embedding provider/model/dimensions differ from this request; source retained.';
  return undefined;
}

const count = (value: unknown): number => {
  if (typeof value !== 'number' && typeof value !== 'bigint')
    throw new Error('Invalid legacy vector count');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid legacy vector count');
  return n;
};
type Row = Record<string, unknown>;
function single(result: lbug.QueryResult | lbug.QueryResult[]): lbug.QueryResult {
  if (!Array.isArray(result)) return result;
  if (result.length === 1) return result[0];
  for (const part of result) part.close();
  throw new Error('Unexpected legacy query result count');
}

export class LegacyVectorSource {
  readonly requiresInputValidation = true;
  private readonly statements = new Map<string, lbug.PreparedStatement>();
  private readonly config: EmbeddingConfig;
  private active = false;
  private closed = false;
  private closing?: Promise<void>;
  private constructor(
    readonly options: LegacyVectorSourceOptions,
    private readonly handle: LbugConnectionHandle,
    private readonly index: VectorStore,
  ) {
    this.config = resolveEmbeddingConfig(options.config);
  }

  static async open(
    options: LegacyVectorSourceOptions,
    index: VectorStore,
    excluded: () => AsyncIterable<string> | Iterable<string>,
  ): Promise<LegacyVectorSource> {
    const incompatible = legacyVectorCompatibility(
      options.recordedIdentity,
      options.expectedIdentity,
    );
    if (incompatible) throw new Error(incompatible);
    if (
      !/^[a-f0-9]{64}$/.test(options.sourceIdentity) ||
      !/^[a-f0-9]{64}$/.test(options.expectedInputIdentity) ||
      options.expectedIdentity.dimensions !== index.options.dimensions ||
      !Number.isSafeInteger(options.batchBytes) ||
      options.batchBytes < 1024
    )
      throw new Error('Invalid legacy vector reuse reservation');
    if (
      options.recordedInputIdentity !== undefined &&
      options.recordedInputIdentity !== options.expectedInputIdentity
    )
      throw new Error(
        'Legacy embedding input provenance differs from this request; source retained.',
      );
    if (!options.recordedInputIdentity)
      options.log?.(
        'Legacy multi-chunk input provenance is unknown (chunk size/overlap); source retained and those groups require regeneration.',
      );
    options.signal?.throwIfAborted();
    const stat = await fs.lstat(options.path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('Legacy vectors require an owned regular database');
    const source = new LegacyVectorSource(
      options,
      await openLbugConnection(lbug, options.path, {
        readOnly: true,
        bufferPoolBytes: options.bufferPoolBytes,
        threads: options.threads,
      }),
      index,
    );
    try {
      await index.prepareLegacyReuseIndex(
        options.sourceIdentity,
        () => source.groups(),
        excluded,
        options.signal,
      );
      return source;
    } catch (error) {
      await source.close();
      throw error;
    }
  }

  private acquire(): void {
    if (this.active || this.closed) throw new Error('Legacy vector source is closed or active');
    this.options.signal?.throwIfAborted();
    this.active = true;
  }
  private async result(sql: string, params?: Record<string, LbugValue>): Promise<lbug.QueryResult> {
    if (!params) return single(await this.handle.conn.query(sql));
    let prepared = this.statements.get(sql);
    if (!prepared) {
      prepared = await this.handle.conn.prepare(sql);
      if (!prepared.isSuccess()) throw new Error(prepared.getErrorMessage());
      this.statements.set(sql, prepared);
    }
    return single(await this.handle.conn.execute(prepared, params));
  }

  private async *groups(): AsyncGenerator<LegacyVectorGroup> {
    this.acquire();
    let result: lbug.QueryResult | undefined;
    try {
      // Native sorting is charged to this explicit pool; JS retains one group
      // and never fetches vector payloads while building the receipt index.
      result = await this.result(
        'MATCH (e:CodeEmbedding) RETURN e.id AS id, e.nodeId AS nodeId, e.chunkIndex AS chunkIndex, e.contentHash AS contentHash, e.startLine AS startLine, e.endLine AS endLine ORDER BY e.nodeId, e.chunkIndex',
      );
      let group: LegacyVectorGroup | undefined;
      let valid = true;
      while (result.hasNext()) {
        this.options.signal?.throwIfAborted();
        const row = result.getNextSync();
        if (typeof row.nodeId !== 'string') throw new Error('Invalid legacy node identity');
        assertValidGraphNodeId(row.nodeId, 'Legacy vector source');
        if (group?.nodeId !== row.nodeId) {
          if (group && valid) yield group;
          group = {
            nodeId: row.nodeId,
            contentHash: typeof row.contentHash === 'string' ? row.contentHash : '',
            chunks: 0,
            sourceStartLine: count(row.startLine),
            sourceEndLine: count(row.endLine),
          };
          valid = Boolean(group.contentHash);
        }
        if (!group) throw new Error('Missing legacy group');
        const ordinal = count(row.chunkIndex),
          start = count(row.startLine),
          end = count(row.endLine);
        if (
          ordinal !== group.chunks ||
          row.id !== `${group.nodeId}:${ordinal}` ||
          row.contentHash !== group.contentHash ||
          end < start
        )
          valid = false;
        group.chunks++;
        group.sourceEndLine = Math.max(group.sourceEndLine, end);
      }
      if (group && valid) yield group;
    } finally {
      try {
        result?.close();
      } finally {
        this.active = false;
      }
    }
  }

  private async rows(
    receipt: VectorNodeReceipt,
    start: number,
    length: number,
    vectors: boolean,
  ): Promise<Row[]> {
    const result = await this.result(
      `UNWIND $ids AS id MATCH (e:CodeEmbedding {id:id}) RETURN e.nodeId AS nodeId, e.chunkIndex AS chunkIndex, e.startLine AS startLine, e.endLine AS endLine, e.contentHash AS contentHash${vectors ? ', e.embedding AS embedding' : ''}`,
      {
        ids: Array.from({ length }, (_, i) => `${receipt.nodeId}:${start + i}`),
      },
    );
    const rows: Row[] = [];
    try {
      while (result.hasNext()) {
        if (rows.length >= length) throw new Error('Legacy query exceeded its bounded result size');
        rows.push(result.getNextSync());
      }
    } finally {
      result.close();
    }
    rows.sort((a, b) => count(a.chunkIndex) - count(b.chunkIndex));
    if (
      rows.length !== length ||
      rows.some(
        (row, i) =>
          row.nodeId !== receipt.nodeId ||
          row.contentHash !== receipt.contentHash ||
          count(row.chunkIndex) !== start + i,
      )
    )
      throw new Error('Legacy complete group changed; source retained');
    return rows;
  }

  /** Legacy hashes did not record chunk-size/overlap. Multiple chunks may have
   * identical line spans but different character boundaries, so their layout
   * cannot replace an input receipt. Short labels ignore those settings; a
   * complete single-chunk group covers its full input without overlap. */
  async reusable(
    nodeId: string,
    contentHash: string,
    options: EmbeddingReuseOptions,
  ): Promise<VectorNodeReceipt | null> {
    const { node, prepareInputValidation, inputs, matchesHash } = options;
    this.acquire();
    const originalMethods = node.methodNames,
      originalFields = node.fieldNames;
    try {
      const group = await this.index.legacyReuseGroup(this.options.sourceIdentity, nodeId);
      if (!group || node.id !== nodeId) return null;
      const sourceAware = /^[a-f0-9]{40}:[a-f0-9]{40}$/.test(group.contentHash);
      if (group.contentHash !== contentHash && !(await matchesHash?.(group.contentHash)))
        return null;
      if (
        !this.options.recordedInputIdentity &&
        !sourceAware &&
        !isShortLabel(node.label) &&
        group.chunks > 1
      ) {
        return null;
      }
      await prepareInputValidation?.();
      const receipt: VectorNodeReceipt = { ...group, complete: true };
      const rowBytes = 512 + 8 * nodeId.length;
      if (rowBytes > this.options.batchBytes)
        throw new Error('Legacy metadata does not fit its reservation');
      const blockSize = Math.min(
        64,
        Math.max(1, Math.floor(Math.min(32768, this.options.batchBytes) / rowBytes)),
      );
      let block: Row[] = [],
        ordinal = 0,
        delta: number | undefined;
      for await (const span of inputs ? inputs() : this.inputSpans(node)) {
        if (ordinal >= group.chunks) return null;
        if (ordinal % blockSize === 0)
          block = await this.rows(
            receipt,
            ordinal,
            Math.min(blockSize, group.chunks - ordinal),
            false,
          );
        const row = block[ordinal % blockSize];
        const start = count(row.startLine),
          end = count(row.endLine);
        delta ??= span.startLine - start;
        if (start + delta !== span.startLine || end + delta !== span.endLine) return null;
        ordinal++;
      }
      if (ordinal !== group.chunks || delta === undefined || (node.startLine ?? 0) - delta < 0)
        return null;
      // Legacy rows recorded chunk ranges, not the original node's end.
      // Do not let the copy path clamp the final chunk to an invented range.
      return {
        ...receipt,
        sourceStartLine: (node.startLine ?? 0) - delta,
        sourceEndLine: undefined,
      };
    } finally {
      node.methodNames = originalMethods;
      node.fieldNames = originalFields;
      this.active = false;
    }
  }

  private async *inputSpans(
    node: EmbeddableNode,
  ): AsyncGenerator<{ startLine: number; endLine: number }> {
    yield* iterateEmbeddingInputs(node, this.config, { signal: this.options.signal });
  }

  async readChunks(
    receipt: VectorNodeReceipt,
    start: number,
    length: number,
  ): Promise<StoredVectorChunk[]> {
    if (
      !Number.isSafeInteger(start) ||
      start < 0 ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > 256 ||
      start + length > receipt.chunks ||
      length * (32 * this.options.expectedIdentity.dimensions + 1024 + 4 * receipt.nodeId.length) >
        this.options.batchBytes
    )
      throw new Error('Invalid legacy vector read batch');
    this.acquire();
    try {
      return (await this.rows(receipt, start, length, true)).map((row) => {
        if (
          !Array.isArray(row.embedding) ||
          row.embedding.length !== this.options.expectedIdentity.dimensions ||
          row.embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value))
        )
          throw new Error('Invalid legacy vector dimensions or values');
        const startLine = count(row.startLine),
          endLine = count(row.endLine);
        if (endLine < startLine) throw new Error('Invalid legacy vector lines');
        return {
          chunkIndex: count(row.chunkIndex),
          startLine,
          endLine,
          embedding: row.embedding as number[],
        };
      });
    } finally {
      this.active = false;
    }
  }
  async close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.active) throw new Error('Cannot close an active legacy vector read');
    this.closed = true;
    this.statements.clear();
    this.closing = closeLbugConnection(this.handle, {
      strict: true,
      databasePath: this.options.path,
    });
    try {
      await this.closing;
    } catch (error) {
      this.closing = undefined;
      throw error;
    }
  }
}
