/** An exclusively owned vector artifact; never opens the graph singleton. */
import lbug, { type LbugValue } from '@ladybugdb/core';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  closeLbugConnection,
  openLbugConnection,
  type LbugConnectionHandle,
} from './lbug-config.js';
import { ExtensionManager } from './extension-loader.js';
import { assertValidGraphNodeId } from '../graph/node-identity.js';
import { embeddingJobDirectory } from '../../storage/embedding-job.js';
import { getExactScanLimit } from '../platform/capabilities.js';
import type { EmbeddingReuseOptions } from '../embeddings/embedding-inputs.js';
import { logger } from '../logger.js';

export const VECTOR_STORE_SCHEMA = 'gitnexus-vector-store-v2';
const BLOCK_ROWS = 256;
const MAX_CHUNKS = 2147483647;

export interface StoredVectorChunk {
  chunkIndex: number;
  startLine: number;
  endLine: number;
  embedding: number[];
}
export interface VectorNodeReceipt {
  nodeId: string;
  contentHash: string;
  chunks: number;
  complete: boolean;
  sourceStartLine?: number;
  sourceEndLine?: number;
}
export interface VectorNodeInput {
  nodeId: string;
  contentHash: string;
  sourceStartLine?: number;
  sourceEndLine?: number;
}
/** A complete legacy group, outside every interrupted checkpoint window.
 * This is a lookup proof only; it is never counted as current paid coverage. */
export interface LegacyVectorGroup {
  nodeId: string;
  contentHash: string;
  chunks: number;
  sourceStartLine: number;
  sourceEndLine: number;
}
export type VectorWriteChunk = StoredVectorChunk & VectorNodeInput;
export interface VectorStoreOptions {
  directory: string;
  identity: string;
  dimensions: number;
  bufferPoolBytes: number;
  threads: number;
  mode: 'create' | 'resume' | 'read';
  /** Only before a scheduling journal exists: an interrupted initial DDL
   * transaction may leave an owned database with a verified empty catalog. */
  recoverEmptyBootstrap?: boolean;
  /** Maximum JS vector batch retained by the caller and passed into native. */
  batchBytes: number;
}

type Row = Record<string, unknown>;
const nonnegative = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const count = (value: unknown): number => {
  if (typeof value !== 'number' && typeof value !== 'bigint')
    throw new Error('Invalid vector-store count');
  const n = Number(value);
  if (!nonnegative(n)) throw new Error('Invalid vector-store count');
  return n;
};

export class VectorStore {
  private readonly prepared = new Map<string, lbug.PreparedStatement>();
  private busy = false;
  private closed = false;
  private closing?: Promise<void>;
  private poisoned = false;
  private sealed = false;
  private selectionReady = false;

  get isSealed(): boolean {
    return this.sealed;
  }

  private constructor(
    private readonly handle: LbugConnectionHandle,
    readonly options: Readonly<VectorStoreOptions>,
  ) {}

  static async open(options: VectorStoreOptions): Promise<VectorStore> {
    if (
      !/^[a-f0-9]{64}$/.test(options.identity) ||
      !Number.isSafeInteger(options.dimensions) ||
      options.dimensions < 1 ||
      !Number.isSafeInteger(options.batchBytes) ||
      options.batchBytes < options.dimensions * 16 ||
      !Number.isSafeInteger(options.bufferPoolBytes) ||
      options.bufferPoolBytes < 8 * 1024 * 1024 ||
      !Number.isSafeInteger(options.threads) ||
      options.threads < 1 ||
      !['create', 'resume', 'read'].includes(options.mode)
    )
      throw new Error('Invalid vector-store resource reservation or identity');
    const directory = await embeddingJobDirectory(options.directory);
    const file = path.join(directory, 'vectors');
    for (const suffix of ['', '.wal', '.shadow', '.lock']) {
      try {
        const stat = await fs.lstat(file + suffix);
        if (!stat.isFile() || stat.isSymbolicLink())
          throw new Error('Vector artifact must be an owned regular file');
        if (suffix === '' && options.mode === 'create')
          throw new Error('Vector artifact already exists');
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
          (suffix === '' && options.mode !== 'create')
        )
          throw error;
      }
    }
    const handle = await openLbugConnection(lbug, file, {
      readOnly: options.mode === 'read',
      bufferPoolBytes: options.bufferPoolBytes,
      threads: options.threads,
    });
    const store = new VectorStore(handle, Object.freeze({ ...options, directory }));
    try {
      const emptyBootstrap =
        options.mode === 'resume' &&
        options.recoverEmptyBootstrap === true &&
        (await store.query('CALL show_tables() RETURN *')).length === 0;
      if (options.mode === 'create' || emptyBootstrap) {
        // DDL is transactional in LadybugDB. A crash must expose either the
        // complete schema/identity or an empty catalog, never half a bootstrap.
        await store.transaction(async () => {
          await store.query(
            `CREATE NODE TABLE CodeEmbedding (id STRING, nodeId STRING, chunkIndex INT32, startLine INT64, endLine INT64, embedding FLOAT[${options.dimensions}], contentHash STRING, PRIMARY KEY(id))`,
          );
          await store.query(
            'CREATE NODE TABLE EmbeddingNodeReceipt (nodeId STRING, contentHash STRING, chunks INT64, complete BOOL, sourceStartLine INT64, sourceEndLine INT64, PRIMARY KEY(nodeId))',
          );
          await store.query(
            'CREATE NODE TABLE EmbeddingArtifact (id STRING, identity STRING, schema STRING, dimensions INT64, complete BOOL, indexKind STRING, PRIMARY KEY(id))',
          );
          await store.query(
            "CREATE (:EmbeddingArtifact {id:'artifact', identity:$identity, schema:$schema, dimensions:$dimensions, complete:false, indexKind:'pending'})",
            {
              identity: options.identity,
              schema: VECTOR_STORE_SCHEMA,
              dimensions: options.dimensions,
            },
          );
        });
        await store.query('CHECKPOINT');
      } else {
        const rows = await store.query(
          "MATCH (a:EmbeddingArtifact {id:'artifact'}) RETURN a.identity AS identity, a.schema AS schema, a.dimensions AS dimensions, a.complete AS complete",
        );
        if (
          rows.length !== 1 ||
          rows[0].identity !== options.identity ||
          rows[0].schema !== VECTOR_STORE_SCHEMA ||
          count(rows[0].dimensions) !== options.dimensions
        )
          throw new Error('Vector artifact identity mismatch; artifacts retained');
        store.sealed = rows[0].complete === true;
        if (options.mode === 'read' && !store.sealed)
          throw new Error('Vector artifact is not complete');
        if (options.mode === 'resume' && !store.sealed) {
          const indexes = await store.query('CALL SHOW_INDEXES() RETURN *');
          if (indexes.some((index) => index.index_name === 'code_embedding_idx')) {
            const manager = new ExtensionManager();
            if (
              !(await manager.ensure((sql) => store.query(sql), 'vector', 'vector resume', {
                policy: 'load-only',
              }))
            )
              throw new Error(
                'Cannot load VECTOR for the retained index; artifacts preserved. Restore the extension before retrying.',
              );
          }
        }
      }
      return store;
    } catch (error) {
      await store.close().catch(() => {});
      throw error;
    }
  }

  private async exclusive<T>(action: () => Promise<T>, write = false): Promise<T> {
    if (this.closed || this.poisoned) throw new Error('Vector store must be reopened');
    if (this.busy) throw new Error('Concurrent vector-store access is not allowed');
    if (write && (this.options.mode === 'read' || this.sealed))
      throw new Error('Published vector artifact is immutable');
    this.busy = true;
    try {
      return await action();
    } finally {
      this.busy = false;
    }
  }

  private async query(sql: string, parameters?: Record<string, LbugValue>): Promise<Row[]> {
    let result: lbug.QueryResult | lbug.QueryResult[];
    if (parameters) {
      let statement = this.prepared.get(sql);
      if (!statement) {
        statement = await this.handle.conn.prepare(sql);
        if (!statement.isSuccess()) throw new Error(statement.getErrorMessage());
        this.prepared.set(sql, statement);
      }
      result = await this.handle.conn.execute(statement, parameters);
    } else result = await this.handle.conn.query(sql);
    const results = Array.isArray(result) ? result : [result];
    const rows: Row[] = [];
    try {
      for (const part of results)
        while (part.hasNext()) {
          if (rows.length >= BLOCK_ROWS)
            throw new Error('Vector query exceeded its bounded result size');
          rows.push(part.getNextSync());
        }
      return rows;
    } finally {
      for (const part of results) part.close();
    }
  }

  private async transaction(action: () => Promise<void>): Promise<void> {
    await this.query('BEGIN TRANSACTION');
    try {
      await action();
      await this.query('COMMIT');
    } catch (error) {
      await this.query('ROLLBACK').catch(() => {
        this.poisoned = true;
      });
      throw error;
    }
  }

  private async receipt(nodeId: string): Promise<VectorNodeReceipt | null> {
    return (await this.receipts([nodeId])).get(nodeId) ?? null;
  }

  private async receipts(ids: readonly string[]): Promise<Map<string, VectorNodeReceipt>> {
    const wanted = new Set(ids);
    const rows = await this.query(
      'UNWIND $ids AS id MATCH (n:EmbeddingNodeReceipt {nodeId:id}) RETURN n.nodeId AS nodeId, n.contentHash AS contentHash, n.chunks AS chunks, n.complete AS complete, n.sourceStartLine AS sourceStartLine, n.sourceEndLine AS sourceEndLine',
      { ids: [...ids] },
    );
    const receipts = new Map<string, VectorNodeReceipt>();
    for (const row of rows) {
      const chunks = count(row.chunks);
      if (
        typeof row.nodeId !== 'string' ||
        !wanted.has(row.nodeId) ||
        receipts.has(row.nodeId) ||
        typeof row.contentHash !== 'string' ||
        !row.contentHash ||
        chunks > MAX_CHUNKS ||
        typeof row.complete !== 'boolean'
      )
        throw new Error('Corrupt vector node receipt');
      receipts.set(row.nodeId, {
        nodeId: row.nodeId,
        contentHash: row.contentHash,
        chunks,
        complete: row.complete,
        sourceStartLine: count(row.sourceStartLine),
        sourceEndLine: count(row.sourceEndLine),
      });
    }
    return receipts;
  }

  /** Reuse a complete group in the pending writer after validating its CURRENT
   * input. Relocation updates only line metadata, with no vector round trip.
   * One transaction makes an interrupted relocation safe to retry.
   * resolveHash permits a caller-verified exact-input match after the source
   * snapshot changed. Verification and hash/range replacement are atomic. */
  async reuseNode(
    input: VectorNodeInput,
    resolveHash?: (stored: string) => Promise<string | undefined>,
  ): Promise<VectorNodeReceipt | null> {
    assertValidGraphNodeId(input.nodeId, 'Vector store');
    const startLine = input.sourceStartLine ?? 0;
    const endLine = input.sourceEndLine ?? 0;
    if (
      !input.contentHash ||
      !nonnegative(startLine) ||
      !nonnegative(endLine) ||
      endLine < startLine
    )
      throw new Error('Invalid reusable embedding input');
    return this.exclusive(async () => {
      const previous = await this.receipt(input.nodeId);
      if (!previous?.complete || previous.chunks < 1) return null;
      const contentHash =
        previous.contentHash === input.contentHash
          ? input.contentHash
          : await resolveHash?.(previous.contentHash);
      if (!contentHash) return null;
      await this.verify(previous);
      if (
        previous.sourceStartLine === startLine &&
        previous.sourceEndLine === endLine &&
        previous.contentHash === contentHash
      )
        return previous;
      const delta = startLine - (previous.sourceStartLine ?? 0);
      await this.transaction(async () => {
        for (let start = 0; start < previous.chunks; start += BLOCK_ROWS) {
          const ids = Array.from(
            { length: Math.min(BLOCK_ROWS, previous.chunks - start) },
            (_, i) => `${input.nodeId}:${start + i}`,
          );
          await this.query(
            'UNWIND $ids AS id MATCH (e:CodeEmbedding {id:id}) SET e.contentHash=$contentHash, e.startLine=e.startLine+$delta, e.endLine=CASE WHEN e.endLine=$oldEnd THEN $endLine ELSE e.endLine+$delta END',
            {
              ids,
              delta,
              oldEnd: previous.sourceEndLine ?? 0,
              endLine,
              contentHash,
            },
          );
          const invalid = await this.query(
            'UNWIND $ids AS id MATCH (e:CodeEmbedding {id:id}) WHERE e.startLine < 0 OR e.endLine < e.startLine RETURN count(e) AS invalid',
            { ids },
          );
          if (count(invalid[0].invalid)) throw new Error('Invalid relocated vector lines');
        }
        await this.query(
          'MATCH (n:EmbeddingNodeReceipt {nodeId:$nodeId}) SET n.contentHash=$contentHash, n.sourceStartLine=$startLine, n.sourceEndLine=$endLine',
          { nodeId: input.nodeId, startLine, endLine, contentHash },
        );
      });
      return {
        ...previous,
        contentHash,
        sourceStartLine: startLine,
        sourceEndLine: endLine,
      };
    }, true);
  }

  private async ensureSelectionTable(): Promise<void> {
    if (this.selectionReady) return;
    // Auxiliary scheduling data leaves the vector/input schema unchanged.
    await this.query(
      'CREATE NODE TABLE IF NOT EXISTS EmbeddingSelection (nodeId STRING, job STRING, PRIMARY KEY(nodeId))',
    );
    this.selectionReady = true;
  }

  /** Mark only verified complete groups, before the unit checkpoint and cursor.
   * Native selection rows replace an unbounded JS set of current node IDs. */
  async markSelected(job: string, ids: readonly string[]): Promise<void> {
    if (
      !/^[a-f0-9]{64}$/.test(job) ||
      !ids.length ||
      ids.length > 64 ||
      new Set(ids).size !== ids.length
    )
      throw new Error('Invalid vector selection unit');
    for (const id of ids) assertValidGraphNodeId(id, 'Vector selection');
    await this.exclusive(async () => {
      const receipts = await this.receipts(ids);
      if (
        receipts.size !== ids.length ||
        [...receipts.values()].some((r) => !r.complete || r.chunks < 1)
      )
        throw new Error('Cannot select an incomplete vector group');
      await this.ensureSelectionTable();
      await this.query(
        'UNWIND $ids AS id MERGE (s:EmbeddingSelection {nodeId:id}) SET s.job=$job',
        { ids: [...ids], job },
      );
    }, true);
  }

  /** Called only after the new manifest is fully acknowledged. Counts must
   * match before deletion, and native joins keep pruning independent of JS RAM. */
  async pruneUnselected(job: string, totalNodes: number): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(job) || !nonnegative(totalNodes))
      throw new Error('Invalid vector selection coverage');
    await this.exclusive(async () => {
      await this.ensureSelectionTable();
      const selected = await this.query(
        'MATCH (s:EmbeddingSelection) WHERE s.job=$job RETURN count(s) AS nodes',
        { job },
      );
      if (count(selected[0].nodes) !== totalNodes)
        throw new Error('Vector selection coverage is incomplete; no groups pruned');
      await this.transaction(async () => {
        await this.query(
          'MATCH (e:CodeEmbedding) WHERE NOT EXISTS { MATCH (s:EmbeddingSelection) WHERE s.nodeId=e.nodeId AND s.job=$job } DELETE e',
          { job },
        );
        await this.query(
          'MATCH (n:EmbeddingNodeReceipt) WHERE NOT EXISTS { MATCH (s:EmbeddingSelection) WHERE s.nodeId=n.nodeId AND s.job=$job } DELETE n',
          { job },
        );
        await this.query('MATCH (s:EmbeddingSelection) WHERE s.job<>$job DELETE s', { job });
      });
    }, true);
  }

  /** Replay replaces the entire old group, using PKs rather than repeated table scans. */
  async beginNode(nodeId: string, contentHash: string): Promise<void> {
    return this.beginNodes([{ nodeId, contentHash }]);
  }

  /** The durable journal owns the three-attempt exclusion proof. Remove only
   * those rejected nodes' partial rows and checkpoint before acknowledging. */
  async excludeNodes(ids: readonly string[]): Promise<void> {
    await this.beginNodes(ids.map((nodeId) => ({ nodeId, contentHash: 'input-rejected' })));
    await this.exclusive(async () => {
      await this.query('UNWIND $ids AS id MATCH (n:EmbeddingNodeReceipt {nodeId:id}) DELETE n', {
        ids: [...ids],
      });
      try {
        await this.query('CHECKPOINT');
      } catch (error) {
        this.poisoned = true;
        throw error;
      }
    }, true);
  }

  async beginNodes(nodes: readonly VectorNodeInput[]): Promise<void> {
    if (
      !nodes.length ||
      nodes.length > 64 ||
      new Set(nodes.map((n) => n.nodeId)).size !== nodes.length
    )
      throw new Error('Invalid vector node unit');
    for (const node of nodes) {
      assertValidGraphNodeId(node.nodeId, 'Vector store');
      if (typeof node.contentHash !== 'string' || !node.contentHash)
        throw new Error('Missing embedding input hash');
      if (
        !nonnegative(node.sourceStartLine ?? 0) ||
        !nonnegative(node.sourceEndLine ?? 0) ||
        (node.sourceEndLine ?? 0) < (node.sourceStartLine ?? 0)
      )
        throw new Error('Invalid embedding source lines');
    }
    await this.exclusive(async () => {
      const previous = await this.receipts(nodes.map((n) => n.nodeId));
      if (previous.size) {
        // Clear the proof before deleting any row. The old high-water mark is
        // retained until every old chunk has been removed, including on crash.
        await this.query(
          'UNWIND $ids AS id MATCH (n:EmbeddingNodeReceipt {nodeId:id}) SET n.complete=false',
          { ids: [...previous.keys()] },
        );
        let ids: string[] = [];
        const remove = async () => {
          if (!ids.length) return;
          await this.query('UNWIND $ids AS id MATCH (e:CodeEmbedding {id:id}) DELETE e', { ids });
          ids = [];
        };
        for (const receipt of previous.values())
          for (let i = 0; i < receipt.chunks; i++) {
            ids.push(`${receipt.nodeId}:${i}`);
            if (ids.length === BLOCK_ROWS) await remove();
          }
        await remove();
      }
      await this.query(
        'UNWIND range(1, size($ids)) AS i MERGE (n:EmbeddingNodeReceipt {nodeId:$ids[i]}) SET n.contentHash=$hashes[i], n.chunks=0, n.complete=false, n.sourceStartLine=$firstLines[i], n.sourceEndLine=$lastLines[i]',
        {
          ids: nodes.map((node) => node.nodeId),
          hashes: nodes.map((node) => node.contentHash),
          firstLines: nodes.map((node) => node.sourceStartLine ?? 0),
          lastLines: nodes.map((node) => node.sourceEndLine ?? 0),
        },
      );
    }, true);
  }

  async append(
    nodeId: string,
    contentHash: string,
    chunks: readonly StoredVectorChunk[],
  ): Promise<void> {
    return this.appendBatch(chunks.map((chunk) => ({ ...chunk, nodeId, contentHash })));
  }

  async appendBatch(chunks: readonly VectorWriteChunk[]): Promise<void> {
    if (
      !chunks.length ||
      chunks.length > BLOCK_ROWS ||
      chunks.reduce(
        (bytes, chunk) =>
          bytes +
          this.options.dimensions * 16 +
          128 +
          2 * (chunk.nodeId.length + chunk.contentHash.length),
        0,
      ) > this.options.batchBytes
    )
      throw new Error('Vector write exceeds its byte/row reservation');
    for (const chunk of chunks) {
      assertValidGraphNodeId(chunk.nodeId, 'Vector store');
      if (
        !nonnegative(chunk.chunkIndex) ||
        chunk.chunkIndex >= MAX_CHUNKS ||
        !nonnegative(chunk.startLine) ||
        !nonnegative(chunk.endLine) ||
        chunk.endLine < chunk.startLine ||
        chunk.embedding.length !== this.options.dimensions ||
        chunk.embedding.some((n) => !Number.isFinite(n) || Math.abs(n) > 3.4028234663852886e38)
      )
        throw new Error('Invalid embedding chunk identity, lines, or vector');
    }
    await this.exclusive(async () => {
      const ids = [...new Set(chunks.map((chunk) => chunk.nodeId))];
      if (ids.length > 64) throw new Error('Vector write crosses its node unit');
      const receipts = await this.receipts(ids);
      for (const chunk of chunks) {
        const receipt = receipts.get(chunk.nodeId);
        if (
          !receipt ||
          receipt.complete ||
          receipt.contentHash !== chunk.contentHash ||
          chunk.chunkIndex !== receipt.chunks
        )
          throw new Error('Vector chunks do not extend the active node contiguously');
        receipt.chunks++;
      }
      await this.transaction(async () => {
        await this.query(
          'UNWIND range(1, size($ids)) AS i CREATE (:CodeEmbedding {id:$ids[i], nodeId:$nodeIds[i], chunkIndex:$ordinals[i], startLine:$firstLines[i], endLine:$lastLines[i], embedding:$vectors[i], contentHash:$hashes[i]})',
          {
            ids: chunks.map((chunk) => `${chunk.nodeId}:${chunk.chunkIndex}`),
            nodeIds: chunks.map((chunk) => chunk.nodeId),
            ordinals: chunks.map((chunk) => chunk.chunkIndex),
            firstLines: chunks.map((chunk) => chunk.startLine),
            lastLines: chunks.map((chunk) => chunk.endLine),
            vectors: chunks.map((chunk) => chunk.embedding),
            hashes: chunks.map((chunk) => chunk.contentHash),
          },
        );
        await this.query(
          'UNWIND range(1, size($ids)) AS i MATCH (n:EmbeddingNodeReceipt {nodeId:$ids[i]}) SET n.chunks=$chunks[i]',
          {
            ids: [...receipts.keys()],
            chunks: [...receipts.values()].map((receipt) => receipt.chunks),
          },
        );
      });
    }, true);
  }

  private async verify(input: VectorNodeReceipt | readonly VectorNodeReceipt[]): Promise<void> {
    const receipts = 'nodeId' in input ? [input] : input;
    const expected = new Map<string, { receipt: VectorNodeReceipt; ordinal: number }>();
    const flush = async () => {
      if (!expected.size) return;
      const rows = await this.query(
        'UNWIND $ids AS id MATCH (e:CodeEmbedding {id:id}) RETURN e.id AS id, e.nodeId AS nodeId, e.chunkIndex AS chunkIndex, e.contentHash AS contentHash',
        { ids: [...expected.keys()] },
      );
      const seen = new Set<string>();
      for (const row of rows) {
        const entry = typeof row.id === 'string' ? expected.get(row.id) : undefined;
        if (
          !entry ||
          row.nodeId !== entry.receipt.nodeId ||
          row.contentHash !== entry.receipt.contentHash ||
          count(row.chunkIndex) !== entry.ordinal ||
          seen.has(String(row.id))
        )
          throw new Error('Vector node has an invalid chunk set');
        seen.add(String(row.id));
      }
      if (seen.size !== expected.size) throw new Error('Vector node is missing chunks');
      expected.clear();
    };
    // Most groups contain one chunk. Fill each bounded PK query across groups
    // rather than paying a native round trip for every node in a unit.
    for (const receipt of receipts)
      for (let ordinal = 0; ordinal < receipt.chunks; ordinal++) {
        expected.set(`${receipt.nodeId}:${ordinal}`, { receipt, ordinal });
        if (expected.size === BLOCK_ROWS) await flush();
      }
    await flush();
  }

  async finishNode(
    nodeId: string,
    contentHash: string,
    chunks: number,
  ): Promise<VectorNodeReceipt> {
    return (await this.finishNodes([{ nodeId, contentHash, chunks }]))[0];
  }

  async finishNodes(
    nodes: readonly (VectorNodeInput & { chunks: number; inputsDigest?: string })[],
  ): Promise<VectorNodeReceipt[]> {
    if (
      !nodes.length ||
      nodes.length > 64 ||
      new Set(nodes.map((n) => n.nodeId)).size !== nodes.length
    )
      throw new Error('Invalid vector completion unit');
    return this.exclusive(async () => {
      const receipts = await this.receipts(nodes.map((n) => n.nodeId));
      const verified: VectorNodeReceipt[] = [];
      for (const node of nodes) {
        const receipt = receipts.get(node.nodeId);
        if (
          !receipt ||
          receipt.contentHash !== node.contentHash ||
          receipt.chunks !== node.chunks ||
          node.chunks < 1 ||
          (node.inputsDigest !== undefined &&
            (!/^[a-f0-9]{40}$/.test(node.inputsDigest) || !/^[a-f0-9]{40}$/.test(node.contentHash)))
        )
          throw new Error('Vector node coverage does not match its generated chunks');
        verified.push(receipt);
      }
      await this.verify(verified);
      const finalize = async () => {
        let ids: string[] = [];
        let hashes: string[] = [];
        const flush = async () => {
          if (!ids.length) return;
          await this.query(
            'UNWIND range(1, size($ids)) AS i MATCH (e:CodeEmbedding {id:$ids[i]}) SET e.contentHash=$hashes[i]',
            { ids, hashes },
          );
          ids = [];
          hashes = [];
        };
        for (let i = 0; i < nodes.length; i++) {
          const node = nodes[i];
          if (!node.inputsDigest) continue;
          const contentHash = `${node.contentHash}:${node.inputsDigest}`;
          for (let ordinal = 0; ordinal < node.chunks; ordinal++) {
            ids.push(`${node.nodeId}:${ordinal}`);
            hashes.push(contentHash);
            if (ids.length === BLOCK_ROWS) await flush();
          }
          verified[i] = { ...verified[i], contentHash };
        }
        await flush();
        await this.query(
          'UNWIND range(1, size($ids)) AS i MATCH (n:EmbeddingNodeReceipt {nodeId:$ids[i]}) SET n.contentHash=$hashes[i], n.complete=true',
          {
            ids: verified.map((receipt) => receipt.nodeId),
            hashes: verified.map((receipt) => receipt.contentHash),
          },
        );
      };
      if (nodes.some((node) => node.inputsDigest)) await this.transaction(finalize);
      else
        await this.query(
          'UNWIND $ids AS id MATCH (n:EmbeddingNodeReceipt {nodeId:id}) SET n.complete=true',
          { ids: nodes.map((node) => node.nodeId) },
        );
      return verified.map((receipt) => ({ ...receipt, complete: true }));
    }, true);
  }

  async reusable(
    nodeId: string,
    contentHash: string,
    options?: Pick<EmbeddingReuseOptions, 'matchesHash'>,
  ): Promise<VectorNodeReceipt | null> {
    const matchesHash = options?.matchesHash;
    return this.exclusive(async () => {
      const receipt = await this.receipt(nodeId);
      if (
        !receipt?.complete ||
        receipt.chunks < 1 ||
        (receipt.contentHash !== contentHash && !(await matchesHash?.(receipt.contentHash)))
      )
        return null;
      await this.verify(receipt);
      return receipt;
    });
  }

  /** One bounded metadata pass builds PK lookups beside the pending writer.
   * No extra native pool, vector copy, or corpus-sized JS receipt map. A failed
   * build leaves complete=false; retry replaces only this auxiliary index. */
  async prepareLegacyReuseIndex(
    source: string,
    groups: () => AsyncIterable<LegacyVectorGroup>,
    excluded: () => AsyncIterable<string> | Iterable<string>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(source)) throw new Error('Invalid legacy source identity');
    await this.exclusive(async () => {
      signal?.throwIfAborted();
      await this.query(
        'CREATE NODE TABLE IF NOT EXISTS LegacyEmbeddingGroup (nodeId STRING, contentHash STRING, chunks INT64, sourceStartLine INT64, sourceEndLine INT64, PRIMARY KEY(nodeId))',
      );
      await this.query(
        'CREATE NODE TABLE IF NOT EXISTS LegacyEmbeddingIndex (id STRING, source STRING, complete BOOL, PRIMARY KEY(id))',
      );
      const state = await this.query(
        "MATCH (s:LegacyEmbeddingIndex {id:'source'}) RETURN s.source AS source, s.complete AS complete",
      );
      if (state.length === 1 && state[0].source === source && state[0].complete === true) return;
      await this.query(
        "MERGE (s:LegacyEmbeddingIndex {id:'source'}) SET s.source=$source, s.complete=false",
        { source },
      );
      await this.query('MATCH (g:LegacyEmbeddingGroup) DELETE g');
      let batch: LegacyVectorGroup[] = [];
      let bytes = 0;
      const flush = async () => {
        if (!batch.length) return;
        signal?.throwIfAborted();
        await this.query(
          'UNWIND range(1, size($ids)) AS i CREATE (:LegacyEmbeddingGroup {nodeId:$ids[i], contentHash:$hashes[i], chunks:$chunks[i], sourceStartLine:$firstLines[i], sourceEndLine:$lastLines[i]})',
          {
            ids: batch.map((g) => g.nodeId),
            hashes: batch.map((g) => g.contentHash),
            chunks: batch.map((g) => g.chunks),
            firstLines: batch.map((g) => g.sourceStartLine),
            lastLines: batch.map((g) => g.sourceEndLine),
          },
        );
        batch = [];
        bytes = 0;
      };
      for await (const group of groups()) {
        signal?.throwIfAborted();
        assertValidGraphNodeId(group.nodeId, 'Legacy vector group');
        const size = 256 + 8 * (group.nodeId.length + group.contentHash.length);
        if (
          !group.contentHash ||
          !nonnegative(group.chunks) ||
          !group.chunks ||
          group.chunks > MAX_CHUNKS ||
          !nonnegative(group.sourceStartLine) ||
          !nonnegative(group.sourceEndLine) ||
          group.sourceEndLine < group.sourceStartLine ||
          size > this.options.batchBytes
        )
          throw new Error('Invalid or oversized legacy group receipt');
        if (batch.length === 64 || bytes + size > this.options.batchBytes) await flush();
        batch.push(group);
        bytes += size;
      }
      await flush();
      let unsafe: string[] = [];
      const remove = async () => {
        if (!unsafe.length) return;
        signal?.throwIfAborted();
        await this.query('UNWIND $ids AS id MATCH (g:LegacyEmbeddingGroup {nodeId:id}) DELETE g', {
          ids: unsafe,
        });
        unsafe = [];
        bytes = 0;
      };
      for await (const id of excluded()) {
        signal?.throwIfAborted();
        assertValidGraphNodeId(id, 'Legacy unsafe window');
        const size = 256 + 8 * id.length;
        if (size > this.options.batchBytes) throw new Error('Oversized legacy exclusion');
        if (unsafe.length === 64 || bytes + size > this.options.batchBytes) await remove();
        unsafe.push(id);
        bytes += size;
      }
      await remove();
      signal?.throwIfAborted();
      await this.query("MATCH (s:LegacyEmbeddingIndex {id:'source'}) SET s.complete=true");
      try {
        await this.query('CHECKPOINT');
      } catch (error) {
        this.poisoned = true;
        throw error;
      }
    }, true);
  }

  async legacyReuseGroup(source: string, nodeId: string): Promise<LegacyVectorGroup | null> {
    if (!/^[a-f0-9]{64}$/.test(source)) throw new Error('Invalid legacy source identity');
    assertValidGraphNodeId(nodeId, 'Legacy vector group');
    return this.exclusive(async () => {
      const rows = await this.query(
        "MATCH (s:LegacyEmbeddingIndex {id:'source'}), (g:LegacyEmbeddingGroup {nodeId:$nodeId}) WHERE s.source=$source AND s.complete=true RETURN g.contentHash AS contentHash, g.chunks AS chunks, g.sourceStartLine AS sourceStartLine, g.sourceEndLine AS sourceEndLine",
        { source, nodeId },
      );
      if (!rows.length) return null;
      if (rows.length !== 1 || typeof rows[0].contentHash !== 'string' || !rows[0].contentHash)
        throw new Error('Corrupt legacy group receipt');
      const group = {
        nodeId,
        contentHash: rows[0].contentHash,
        chunks: count(rows[0].chunks),
        sourceStartLine: count(rows[0].sourceStartLine),
        sourceEndLine: count(rows[0].sourceEndLine),
      };
      if (!group.chunks || group.chunks > MAX_CHUNKS || group.sourceEndLine < group.sourceStartLine)
        throw new Error('Corrupt legacy group receipt');
      return group;
    });
  }

  /** Same immutable job identity: completed groups need no source/model work. */
  async completedNodes(ids: readonly string[]): Promise<Map<string, VectorNodeReceipt>> {
    if (ids.length > 64 || new Set(ids).size !== ids.length)
      throw new Error('Invalid vector receipt unit');
    return this.exclusive(async () => {
      const receipts = await this.receipts(ids);
      for (const [id, receipt] of receipts) {
        if (!receipt.complete || receipt.chunks < 1) receipts.delete(id);
        else await this.verify(receipt);
      }
      return receipts;
    });
  }

  /** Bounded copy from a compatible complete artifact; never materializes a node's vectors. */
  async readChunks(
    receipt: VectorNodeReceipt,
    start: number,
    length: number,
  ): Promise<StoredVectorChunk[]> {
    if (
      !nonnegative(start) ||
      !nonnegative(length) ||
      !length ||
      length > BLOCK_ROWS ||
      start + length > receipt.chunks ||
      length * (this.options.dimensions * 16 + 128) > this.options.batchBytes
    )
      throw new Error('Invalid vector read batch');
    return this.exclusive(async () => {
      const rows = await this.query(
        'UNWIND $ids AS id MATCH (e:CodeEmbedding {id:id}) RETURN e.chunkIndex AS chunkIndex, e.startLine AS startLine, e.endLine AS endLine, e.embedding AS embedding, e.contentHash AS contentHash',
        { ids: Array.from({ length }, (_, i) => `${receipt.nodeId}:${start + i}`) },
      );
      if (rows.length !== length) throw new Error('Incomplete vector copy');
      const chunks = rows
        .map((row) => {
          if (
            row.contentHash !== receipt.contentHash ||
            !Array.isArray(row.embedding) ||
            row.embedding.length !== this.options.dimensions
          )
            throw new Error('Invalid vector copy');
          return {
            chunkIndex: count(row.chunkIndex),
            startLine: count(row.startLine),
            endLine: count(row.endLine),
            embedding: row.embedding as number[],
          };
        })
        .sort((a, b) => a.chunkIndex - b.chunkIndex);
      if (chunks.some((chunk, i) => chunk.chunkIndex !== start + i))
        throw new Error('Invalid vector copy sequence');
      return chunks;
    });
  }

  /** Verify committed coverage before the filesystem journal acknowledges it. */
  async checkpointUnit(nodes: readonly VectorNodeReceipt[]): Promise<void> {
    if (
      !nodes.length ||
      nodes.length > 64 ||
      new Set(nodes.map((n) => n.nodeId)).size !== nodes.length
    )
      throw new Error('Invalid vector durability unit');
    await this.exclusive(async () => {
      const receipts = await this.receipts(nodes.map((n) => n.nodeId));
      for (const node of nodes) {
        const stored = receipts.get(node.nodeId);
        if (
          !stored?.complete ||
          stored.contentHash !== node.contentHash ||
          stored.chunks !== node.chunks ||
          stored.chunks < 1
        )
          throw new Error('Cannot acknowledge incomplete vector unit');
      }
      // Ladybug commits fsync the WAL and its directory before returning:
      // https://github.com/LadybugDB/ladybug/blob/v0.22.0/src/storage/wal/wal.cpp
      // Rewriting the database after every unit adds no durability. Native
      // automatic checkpoints bound the WAL; seal() checkpoints before readers
      // can open the published artifact without WAL replay.
    }, !this.sealed);
  }

  /** Runs only once all manifest and failed units have complete coverage. */
  async seal(totalNodes: number, totalChunks: number): Promise<'hnsw' | 'exact'> {
    if (!nonnegative(totalNodes) || !nonnegative(totalChunks))
      throw new Error('Invalid vector coverage totals');
    return this.exclusive(async () => {
      const nodes = await this.query(
        'MATCH (n:EmbeddingNodeReceipt) RETURN count(n) AS nodes, sum(n.chunks) AS chunks, sum(CASE WHEN n.complete THEN 0 ELSE 1 END) AS pending',
      );
      const vectors = await this.query('MATCH (e:CodeEmbedding) RETURN count(e) AS chunks');
      if (
        count(nodes[0].nodes) !== totalNodes ||
        count(nodes[0].chunks ?? 0) !== totalChunks ||
        count(nodes[0].pending ?? 0) !== 0 ||
        count(vectors[0].chunks) !== totalChunks
      )
        throw new Error('Vector artifact coverage is incomplete');
      if (this.sealed) {
        const rows = await this.query(
          "MATCH (a:EmbeddingArtifact {id:'artifact'}) RETURN a.indexKind AS kind",
        );
        if (rows[0]?.kind !== 'hnsw' && rows[0]?.kind !== 'exact')
          throw new Error('Invalid vector index receipt');
        if (rows[0].kind === 'hnsw') {
          const manager = new ExtensionManager();
          if (
            !(await manager.ensure((sql) => this.query(sql), 'vector', 'vector publication', {
              policy: 'load-only',
            }))
          )
            throw new Error('Cannot verify the published vector index');
          await this.verifyVectorIndex();
        }
        return rows[0].kind;
      }
      const manager = new ExtensionManager();
      let kind: 'hnsw' | 'exact' = 'exact';
      if (
        totalChunks &&
        (await manager.ensure((sql) => this.query(sql), 'vector', 'vector search'))
      ) {
        try {
          await this.query(
            "CALL CREATE_VECTOR_INDEX('CodeEmbedding', 'code_embedding_idx', 'embedding', metric := 'cosine')",
          );
          kind = 'hnsw';
        } catch (error) {
          // A complete artifact may be searched exactly if optional ANN fails.
          // Native corruption/durability errors still surface at checkpoint.
          if (/already exists/i.test(String(error))) kind = 'hnsw';
          else
            logger.warn(
              { err: error, chunks: totalChunks, bufferPoolBytes: this.options.bufferPoolBytes },
              'Vector index build failed; completed vectors retained',
            );
        }
      }
      if (kind === 'hnsw') {
        try {
          await this.verifyVectorIndex();
        } catch (error) {
          logger.warn(
            { err: error },
            'Vector index verification failed; dropping the unpublished index for retry',
          );
          await this.query("CALL DROP_VECTOR_INDEX('CodeEmbedding', 'code_embedding_idx')");
          kind = 'exact';
        }
      }
      // Large exact scans are deliberately unavailable to readers. Keep this
      // complete work unpublished and writable so a later run can retry ANN
      // without a single new provider request.
      if (kind === 'exact' && totalChunks > getExactScanLimit()) {
        logger.warn(
          { chunks: totalChunks, bufferPoolBytes: this.options.bufferPoolBytes },
          'Vector index is pending beyond the exact-scan limit. Increase --resource-budget and retry; completed vectors will be reused.',
        );
        return kind;
      }
      await this.query(
        "MATCH (a:EmbeddingArtifact {id:'artifact'}) SET a.complete=true, a.indexKind=$kind",
        { kind },
      );
      try {
        await this.query('CHECKPOINT');
      } catch (error) {
        this.poisoned = true;
        throw error;
      }
      this.sealed = true;
      return kind;
    }, !this.sealed);
  }

  private async verifyVectorIndex(): Promise<void> {
    // determinism: probe — any stored vector can verify index availability; its identity does not affect publication.
    const sample = await this.query(
      'MATCH (e:CodeEmbedding) RETURN e.embedding AS embedding LIMIT 1',
    );
    if (sample.length !== 1 || !Array.isArray(sample[0].embedding))
      throw new Error('Vector index has no probe row');
    const hits = await this.query(
      "CALL QUERY_VECTOR_INDEX('CodeEmbedding', 'code_embedding_idx', $vector, 1) YIELD node AS emb, distance RETURN emb.id AS id",
      { vector: sample[0].embedding as number[] },
    );
    if (hits.length !== 1 || typeof hits[0].id !== 'string')
      throw new Error('Vector index cannot retrieve a stored row');
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.busy) throw new Error('Cannot close an active vector operation');
    this.closed = true;
    this.prepared.clear();
    this.closing = closeLbugConnection(this.handle, {
      strict: true,
      databasePath: path.join(this.options.directory, 'vectors'),
    });
    try {
      await this.closing;
    } catch (error) {
      this.closing = undefined;
      throw error;
    }
  }
}
