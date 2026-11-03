/** An exclusively owned vector artifact; never opens the graph singleton. */
import lbug, { type LbugValue } from '@ladybugdb/core';
import fs from 'node:fs/promises';
import path from 'node:path';
import { openLbugConnection, type LbugConnectionHandle } from './lbug-config.js';
import { ExtensionManager } from './extension-loader.js';
import { assertValidGraphNodeId } from '../graph/node-identity.js';
import { embeddingJobDirectory } from '../../storage/embedding-job.js';
import { getExactScanLimit } from '../platform/capabilities.js';

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
export type VectorWriteChunk = StoredVectorChunk & VectorNodeInput;
export interface VectorStoreOptions {
  directory: string;
  identity: string;
  dimensions: number;
  bufferPoolBytes: number;
  threads: number;
  mode: 'create' | 'resume' | 'read';
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
  private poisoned = false;
  private sealed = false;

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
    for (const suffix of ['', '.wal', '.lock']) {
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
      if (options.mode === 'create') {
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

  /** Replay replaces the entire old group, using PKs rather than repeated table scans. */
  async beginNode(nodeId: string, contentHash: string): Promise<void> {
    return this.beginNodes([{ nodeId, contentHash }]);
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
          await this.transaction(async () => {
            await this.query('UNWIND $ids AS id MATCH (e:CodeEmbedding {id:id}) DELETE e', { ids });
          });
          ids = [];
        };
        for (const receipt of previous.values())
          for (let i = 0; i < receipt.chunks; i++) {
            ids.push(`${receipt.nodeId}:${i}`);
            if (ids.length === BLOCK_ROWS) await remove();
          }
        await remove();
      }
      await this.transaction(async () => {
        for (const { nodeId, contentHash, sourceStartLine = 0, sourceEndLine = 0 } of nodes) {
          if (previous.has(nodeId))
            await this.query(
              'MATCH (n:EmbeddingNodeReceipt {nodeId:$nodeId}) SET n.contentHash=$contentHash, n.chunks=0, n.sourceStartLine=$sourceStartLine, n.sourceEndLine=$sourceEndLine',
              { nodeId, contentHash, sourceStartLine, sourceEndLine },
            );
          else
            await this.query(
              'CREATE (:EmbeddingNodeReceipt {nodeId:$nodeId, contentHash:$contentHash, chunks:0, complete:false, sourceStartLine:$sourceStartLine, sourceEndLine:$sourceEndLine})',
              { nodeId, contentHash, sourceStartLine, sourceEndLine },
            );
        }
      });
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
        for (const chunk of chunks)
          await this.query(
            'CREATE (:CodeEmbedding {id:$id, nodeId:$nodeId, chunkIndex:$chunkIndex, startLine:$startLine, endLine:$endLine, embedding:$embedding, contentHash:$contentHash})',
            { id: `${chunk.nodeId}:${chunk.chunkIndex}`, ...chunk },
          );
        for (const receipt of receipts.values())
          await this.query('MATCH (n:EmbeddingNodeReceipt {nodeId:$nodeId}) SET n.chunks=$chunks', {
            nodeId: receipt.nodeId,
            chunks: receipt.chunks,
          });
      });
    }, true);
  }

  private async verify(receipt: VectorNodeReceipt): Promise<void> {
    for (let start = 0; start < receipt.chunks; start += BLOCK_ROWS) {
      const ids = Array.from(
        { length: Math.min(BLOCK_ROWS, receipt.chunks - start) },
        (_, i) => `${receipt.nodeId}:${start + i}`,
      );
      const rows = await this.query(
        'UNWIND $ids AS id MATCH (e:CodeEmbedding {id:id}) RETURN e.id AS id, e.nodeId AS nodeId, e.chunkIndex AS chunkIndex, e.contentHash AS contentHash',
        { ids },
      );
      const seen = new Set<string>();
      for (const row of rows) {
        const i = count(row.chunkIndex);
        if (
          row.nodeId !== receipt.nodeId ||
          row.contentHash !== receipt.contentHash ||
          i < start ||
          i >= start + ids.length ||
          row.id !== `${receipt.nodeId}:${i}` ||
          seen.has(String(row.id))
        )
          throw new Error('Vector node has an invalid chunk set');
        seen.add(String(row.id));
      }
      if (seen.size !== ids.length) throw new Error('Vector node is missing chunks');
    }
  }

  async finishNode(
    nodeId: string,
    contentHash: string,
    chunks: number,
  ): Promise<VectorNodeReceipt> {
    return (await this.finishNodes([{ nodeId, contentHash, chunks }]))[0];
  }

  async finishNodes(
    nodes: readonly (VectorNodeInput & { chunks: number })[],
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
          node.chunks < 1
        )
          throw new Error('Vector node coverage does not match its generated chunks');
        await this.verify(receipt);
        verified.push(receipt);
      }
      await this.query(
        'UNWIND $ids AS id MATCH (n:EmbeddingNodeReceipt {nodeId:id}) SET n.complete=true',
        { ids: nodes.map((n) => n.nodeId) },
      );
      return verified.map((receipt) => ({ ...receipt, complete: true }));
    }, true);
  }

  async reusable(nodeId: string, contentHash: string): Promise<VectorNodeReceipt | null> {
    return this.exclusive(async () => {
      const receipt = await this.receipt(nodeId);
      if (!receipt?.complete || receipt.contentHash !== contentHash || receipt.chunks < 1)
        return null;
      await this.verify(receipt);
      return receipt;
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

  /** Durability must precede the filesystem journal's acknowledgement. */
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
      // An already sealed artifact has a durable final checkpoint. Recovery may
      // rebuild a damaged filesystem cursor using its verified complete groups.
      if (this.sealed) return;
      try {
        await this.query('CHECKPOINT');
      } catch (error) {
        this.poisoned = true;
        throw error;
      }
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
        }
      }
      if (kind === 'hnsw') {
        try {
          await this.verifyVectorIndex();
        } catch {
          kind = 'exact';
        }
      }
      // Large exact scans are deliberately unavailable to readers. Keep this
      // complete work unpublished and writable so a later run can retry ANN
      // without a single new provider request.
      if (kind === 'exact' && totalChunks > getExactScanLimit()) return kind;
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
    if (this.closed) return;
    if (this.busy) throw new Error('Cannot close an active vector operation');
    this.closed = true;
    this.prepared.clear();
    try {
      await this.handle.conn.close();
    } finally {
      await this.handle.db.close();
    }
  }
}
