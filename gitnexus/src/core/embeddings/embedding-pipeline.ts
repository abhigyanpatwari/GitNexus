/**
 * Embedding Pipeline Module
 *
 * Orchestrates the background embedding process:
 * 1. Query embeddable nodes from LadybugDB
 * 2. Generate text representations with enriched metadata
 * 3. Chunk long nodes, batch embed
 * 4. Update LadybugDB with chunk-aware embeddings
 * 5. Create vector index for semantic search
 */

import { createHash } from 'crypto';
import {
  initEmbedder,
  embedBatch,
  embedText,
  embeddingToArray,
  isEmbedderReady,
} from './embedder.js';
import { generateEmbeddingText } from './text-generator.js';
import { chunkNode, characterChunk } from './chunker.js';
import { extractStructuralNames } from './structural-extractor.js';
import {
  type EmbeddingProgress,
  type EmbeddingConfig,
  type EmbeddableNode,
  type SemanticSearchResult,
  type ModelProgress,
  type EmbeddingContext,
  DEFAULT_EMBEDDING_CONFIG,
  EMBEDDABLE_LABELS,
  isShortLabel,
  LABEL_METHOD,
  LABELS_WITH_EXPORTED,
  STRUCTURAL_LABELS,
  collectBestChunks,
} from './types.js';
import {
  EMBEDDING_TABLE_NAME,
  EMBEDDING_INDEX_NAME,
  CREATE_VECTOR_INDEX_QUERY,
  STALE_HASH_SENTINEL,
} from '../lbug/schema.js';
import { loadVectorExtension } from '../lbug/lbug-adapter.js';

const isDev = process.env.NODE_ENV === 'development';
/**
 * Bump this when the embedding text template changes in a way that should
 * invalidate existing vectors, such as metadata/header shape changes,
 * structural container context changes, or preceding-context formatting rules.
 */
export const EMBEDDING_TEXT_VERSION = 'v2';

/**
 * Compute a stable content fingerprint for an embeddable node.
 * Used to detect when the underlying text has changed so stale vectors
 * can be replaced (DELETE-then-INSERT, the Kuzu-sanctioned pattern for
 * vector-indexed rows).
 */
export const contentHashForNode = (
  node: EmbeddableNode,
  config: Partial<EmbeddingConfig> = {},
): string => {
  // Hash must be deterministic across runs, so exclude methodNames/fieldNames
  // which are populated during the batch loop via AST extraction.
  // Using only node.content ensures the hash stays stable.
  // NOTE: A change to extractStructuralNames behavior requires bumping EMBEDDING_TEXT_VERSION.
  const text = generateEmbeddingText(
    { ...node, methodNames: undefined, fieldNames: undefined },
    node.content,
    config,
  );
  return createHash('sha1').update(EMBEDDING_TEXT_VERSION).update('\n').update(text).digest('hex');
};

/**
 * Progress callback type
 */
export type EmbeddingProgressCallback = (progress: EmbeddingProgress) => void;

/**
 * Query all embeddable nodes from LadybugDB
 * Uses table-specific queries for different label types
 */
const queryEmbeddableNodes = async (
  executeQuery: (cypher: string) => Promise<any[]>,
): Promise<EmbeddableNode[]> => {
  const allNodes: EmbeddableNode[] = [];

  for (const label of EMBEDDABLE_LABELS) {
    try {
      let query: string;

      if (label === LABEL_METHOD) {
        // Method has parameterCount and returnType
        query = `
          MATCH (n:Method)
          RETURN n.id AS id, n.name AS name, 'Method' AS label,
                 n.filePath AS filePath, n.content AS content,
                 n.startLine AS startLine, n.endLine AS endLine,
                 n.isExported AS isExported, n.description AS description,
                 n.parameterCount AS parameterCount, n.returnType AS returnType
        `;
      } else if (LABELS_WITH_EXPORTED.has(label)) {
        // Function, Class, Interface have isExported and description
        query = `
          MATCH (n:\`${label}\`)
          RETURN n.id AS id, n.name AS name, '${label}' AS label,
                 n.filePath AS filePath, n.content AS content,
                 n.startLine AS startLine, n.endLine AS endLine,
                 n.isExported AS isExported, n.description AS description
        `;
      } else {
        // Multi-language tables (Struct, Enum, etc.) — have description but no isExported
        query = `
          MATCH (n:\`${label}\`)
          RETURN n.id AS id, n.name AS name, '${label}' AS label,
                 n.filePath AS filePath, n.content AS content,
                 n.startLine AS startLine, n.endLine AS endLine,
                 n.description AS description
        `;
      }

      const rows = await executeQuery(query);
      for (const row of rows) {
        const hasExportedColumn = label === LABEL_METHOD || LABELS_WITH_EXPORTED.has(label);
        allNodes.push({
          id: row.id ?? row[0],
          name: row.name ?? row[1],
          label: row.label ?? row[2],
          filePath: row.filePath ?? row[3],
          content: row.content ?? row[4] ?? '',
          startLine: row.startLine ?? row[5],
          endLine: row.endLine ?? row[6],
          isExported: hasExportedColumn ? (row.isExported ?? row[7]) : undefined,
          description: row.description ?? (hasExportedColumn ? row[8] : row[7]),
          ...(label === LABEL_METHOD
            ? {
                parameterCount: row.parameterCount ?? row[9],
                returnType: row.returnType ?? row[10],
              }
            : {}),
        });
      }
    } catch (error) {
      if (isDev) {
        console.warn(`Query for ${label} nodes failed:`, error);
      }
    }
  }

  return allNodes;
};

/**
 * Batch INSERT chunk-aware embeddings into CodeEmbedding table
 */
export const batchInsertEmbeddings = async (
  executeWithReusedStatement: (
    cypher: string,
    paramsList: Array<Record<string, any>>,
  ) => Promise<void>,
  updates: Array<{
    nodeId: string;
    chunkIndex: number;
    startLine: number;
    endLine: number;
    embedding: number[];
    contentHash?: string;
  }>,
): Promise<void> => {
  const cypher = `CREATE (e:${EMBEDDING_TABLE_NAME} {id: $id, nodeId: $nodeId, chunkIndex: $chunkIndex, startLine: $startLine, endLine: $endLine, embedding: $embedding, contentHash: $contentHash})`;
  const paramsList = updates.map((u) => ({
    id: `${u.nodeId}:${u.chunkIndex}`,
    nodeId: u.nodeId,
    chunkIndex: u.chunkIndex,
    startLine: u.startLine,
    endLine: u.endLine,
    embedding: u.embedding,
    contentHash: u.contentHash ?? STALE_HASH_SENTINEL,
  }));
  await executeWithReusedStatement(cypher, paramsList);
};

/**
 * Create the vector index for semantic search

 * Now indexes the separate CodeEmbedding table.
 * Delegates extension loading to lbug-adapter's loadVectorExtension(),
 * which owns the VECTOR extension lifecycle and state tracking.

 */
const createVectorIndex = async (
  executeQuery: (cypher: string) => Promise<any[]>,
): Promise<void> => {
  // Delegate to the adapter which tracks loaded state and handles DB reconnect resets.
  // If the optional VECTOR extension cannot be loaded, semantic search degrades gracefully.
  if (!(await loadVectorExtension())) {
    return;
  }

  try {
    await executeQuery(CREATE_VECTOR_INDEX_QUERY);
  } catch (error) {
    if (isDev) {
      console.warn('Vector index creation warning:', error);
    }
  }
};

/**
 * Run the embedding pipeline
 *
 * @param executeQuery - Function to execute Cypher queries against LadybugDB
 * @param executeWithReusedStatement - Function to execute with reused prepared statement
 * @param onProgress - Callback for progress updates
 * @param config - Optional configuration override
 * @param skipNodeIds - Optional set of node IDs that already have embeddings (incremental mode)
 * @param context - Optional repo/server context for metadata enrichment
 * @param existingEmbeddings - Optional map of nodeId → contentHash for incremental mode.
 *        Nodes whose hash matches are skipped; nodes with a changed hash are DELETE'd
 *        and re-embedded; nodes not in the map are embedded fresh.

 */
export const runEmbeddingPipeline = async (
  executeQuery: (cypher: string) => Promise<any[]>,
  executeWithReusedStatement: (
    cypher: string,
    paramsList: Array<Record<string, any>>,
  ) => Promise<void>,
  onProgress: EmbeddingProgressCallback,
  config: Partial<EmbeddingConfig> = {},
  skipNodeIds?: Set<string>,
  context?: EmbeddingContext,
  existingEmbeddings?: Map<string, string>,
): Promise<void> => {
  const finalConfig = { ...DEFAULT_EMBEDDING_CONFIG, ...config };

  try {
    // Phase 1: Load embedding model
    onProgress({
      phase: 'loading-model',
      percent: 0,
      modelDownloadPercent: 0,
    });

    if (!isEmbedderReady()) {
      await initEmbedder((modelProgress: ModelProgress) => {
        const downloadPercent = modelProgress.progress ?? 0;
        onProgress({
          phase: 'loading-model',
          percent: Math.round(downloadPercent * 0.2),
          modelDownloadPercent: downloadPercent,
        });
      }, finalConfig);
    }

    onProgress({
      phase: 'loading-model',
      percent: 20,
      modelDownloadPercent: 100,
    });

    if (isDev) {
      console.log('🔍 Querying embeddable nodes...');
    }

    // Phase 2: Query embeddable nodes
    let nodes = await queryEmbeddableNodes(executeQuery);

    // Apply context metadata
    if (context?.repoName) {
      for (const node of nodes) {
        node.repoName = context.repoName;
        node.serverName = context.serverName;
      }
    }

    // Incremental mode: compare content hashes, delete stale rows, skip fresh ones.
    // Computed hashes for stale nodes are cached so batchInsertEmbeddings can reuse them
    // (avoids double computation).
    const computedStaleHashes = new Map<string, string>();
    if (existingEmbeddings && existingEmbeddings.size > 0) {
      const beforeCount = nodes.length;
      const staleNodeIds: string[] = [];
      nodes = nodes.filter((n) => {
        const existingHash = existingEmbeddings.get(n.id);
        if (existingHash === undefined) {
          // New node — needs embedding
          return true;
        }
        const currentHash = contentHashForNode(n, finalConfig);
        if (currentHash !== existingHash) {
          // Content changed — cache hash for reuse during insert, mark for DELETE + re-embed
          computedStaleHashes.set(n.id, currentHash);
          staleNodeIds.push(n.id);
          return true;
        }
        // Hash matches — skip (fresh); no need to cache hash for skipped nodes
        return false;
      });

      // DELETE stale embedding rows so they can be re-inserted
      // (Kuzu forbids SET on vector-indexed properties; DELETE-then-INSERT is the sanctioned pattern)
      if (staleNodeIds.length > 0) {
        if (isDev) {
          console.log(`🔄 Deleting ${staleNodeIds.length} stale embedding rows for re-embed`);
        }
        try {
          await executeWithReusedStatement(
            `MATCH (e:${EMBEDDING_TABLE_NAME} {nodeId: $nodeId}) DELETE e`,
            staleNodeIds.map((nodeId) => ({ nodeId })),
          );
        } catch (err) {
          // "does not exist" = rows already gone — safe to proceed.
          // All other errors risk vector-index corruption (Kuzu requires DELETE-before-INSERT
          // for vector-indexed properties) — propagate so the pipeline aborts cleanly.
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes('does not exist')) {
            throw new Error(
              `[embed] Failed to delete stale embedding rows — aborting to prevent vector-index corruption: ${msg}`,
            );
          }
        }
      }

      if (isDev) {
        console.log(
          `📦 Incremental embeddings: ${beforeCount} total, ${existingEmbeddings.size} cached, ${staleNodeIds.length} stale, ${nodes.length} to embed`,
        );
      }
    }

    const totalNodes = nodes.length;

    if (isDev) {
      console.log(`📊 Found ${totalNodes} embeddable nodes`);
    }

    if (totalNodes === 0) {
      // Ensure the vector index exists even when no new nodes need embedding.
      // A prior crash or first-time incremental run may have left CodeEmbedding
      // rows without ever reaching index creation.
      await createVectorIndex(executeQuery);

      onProgress({
        phase: 'ready',
        percent: 100,
        nodesProcessed: 0,
        totalNodes: 0,
      });
      return;
    }

    // Phase 3: Chunk + embed nodes
    const batchSize = finalConfig.batchSize;
    const chunkSize = finalConfig.chunkSize;
    const overlap = finalConfig.overlap;
    let processedNodes = 0;
    let totalChunks = 0;

    onProgress({
      phase: 'embedding',
      percent: 20,
      nodesProcessed: 0,
      totalNodes,
      currentBatch: 0,
      totalBatches: Math.ceil(totalNodes / batchSize),
    });

    // Process in batches of nodes
    for (let batchIndex = 0; batchIndex < totalNodes; batchIndex += batchSize) {
      const batch = nodes.slice(batchIndex, batchIndex + batchSize);

      // Chunk each node and generate text
      const allTexts: string[] = [];
      const allUpdates: Array<{
        nodeId: string;
        chunkIndex: number;
        startLine: number;
        endLine: number;
        contentHash: string;
      }> = [];

      for (const node of batch) {
        const isShort = isShortLabel(node.label);
        const startLine = node.startLine ?? 0;
        const endLine = node.endLine ?? 0;

        // Extract structural names for class-like nodes via AST extractors
        if (!isShort && STRUCTURAL_LABELS.has(node.label)) {
          try {
            const names = await extractStructuralNames(node.content, node.filePath);
            node.methodNames = names.methodNames;
            node.fieldNames = names.fieldNames;
          } catch {
            // AST extraction failed — names stay undefined, text-generator handles gracefully
          }
        }

        // Compute content hash once per node (re-use cached value for stale nodes)
        const hash = computedStaleHashes.get(node.id) ?? contentHashForNode(node, finalConfig);

        let chunks: Array<{ text: string; chunkIndex: number; startLine: number; endLine: number }>;
        if (isShort) {
          chunks = [{ text: node.content, chunkIndex: 0, startLine, endLine }];
        } else {
          try {
            chunks = await chunkNode(
              node.label,
              node.content,
              node.filePath,
              startLine,
              endLine,
              chunkSize,
              overlap,
            );
          } catch (chunkErr) {
            if (isDev) {
              console.warn(
                `⚠️ AST chunking failed for ${node.label} "${node.name}" (${node.filePath}), falling back to character-based chunking:`,
                chunkErr,
              );
            }
            chunks = characterChunk(node.content, startLine, endLine, chunkSize, overlap);
          }
        }

        let prevTail = '';
        for (const chunk of chunks) {
          const text = generateEmbeddingText(
            node,
            chunk.text,
            finalConfig,
            chunk.chunkIndex,
            prevTail,
          );
          allTexts.push(text);
          allUpdates.push({
            nodeId: node.id,
            chunkIndex: chunk.chunkIndex,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            contentHash: hash,
          });
          prevTail = overlap > 0 ? chunk.text.slice(-overlap) : '';
        }
      }

      // Embed chunk texts in sub-batches to control memory
      const EMBED_SUB_BATCH = 8;
      for (let si = 0; si < allTexts.length; si += EMBED_SUB_BATCH) {
        const subTexts = allTexts.slice(si, si + EMBED_SUB_BATCH);
        const subUpdates = allUpdates.slice(si, si + EMBED_SUB_BATCH);

        let embeddings: Float32Array[];
        try {
          embeddings = await embedBatch(subTexts);
        } catch (embedErr) {
          console.error(
            `❌ embedBatch failed for ${subTexts.length} texts (first: "${subTexts[0]?.substring(0, 80)}..."):`,
            embedErr,
          );
          throw embedErr;
        }

        const dbUpdates = subUpdates.map((u, i) => ({
          ...u,
          embedding: embeddingToArray(embeddings[i]),
        }));

        await batchInsertEmbeddings(executeWithReusedStatement, dbUpdates);
      }

      processedNodes += batch.length;
      totalChunks += allUpdates.length;

      const embeddingProgress = 20 + (processedNodes / totalNodes) * 70;
      onProgress({
        phase: 'embedding',
        percent: Math.round(embeddingProgress),
        nodesProcessed: processedNodes,
        totalNodes,
        currentBatch: Math.floor(batchIndex / batchSize) + 1,
        totalBatches: Math.ceil(totalNodes / batchSize),
      });
    }

    // Phase 4: Create vector index
    onProgress({
      phase: 'indexing',
      percent: 90,
      nodesProcessed: totalNodes,
      totalNodes,
    });

    if (isDev) {
      console.log('📇 Creating vector index...');
    }

    await createVectorIndex(executeQuery);

    onProgress({
      phase: 'ready',
      percent: 100,
      nodesProcessed: totalNodes,
      totalNodes,
    });

    if (isDev) {
      console.log(
        `✅ Embedding pipeline complete! (${totalChunks} chunks from ${totalNodes} nodes)`,
      );
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (isDev) {
      console.error('❌ Embedding pipeline error:', error);
    }

    onProgress({
      phase: 'error',
      percent: 0,
      error: errorMessage,
    });

    throw error;
  }
};

/**
 * Perform semantic search using the vector index with chunk deduplication
 */
export const semanticSearch = async (
  executeQuery: (cypher: string) => Promise<any[]>,
  query: string,
  k: number = 10,
  maxDistance: number = 0.5,
): Promise<SemanticSearchResult[]> => {
  if (!isEmbedderReady()) {
    throw new Error('Embedding model not initialized. Run embedding pipeline first.');
  }

  const queryEmbedding = await embedText(query);
  const queryVec = embeddingToArray(queryEmbedding);
  const queryVecStr = `[${queryVec.join(',')}]`;

  const bestChunks = await collectBestChunks(k, async (fetchLimit) => {
    const vectorQuery = `
      CALL QUERY_VECTOR_INDEX('${EMBEDDING_TABLE_NAME}', '${EMBEDDING_INDEX_NAME}',
        CAST(${queryVecStr} AS FLOAT[${queryVec.length}]), ${fetchLimit})
      YIELD node AS emb, distance
      WITH emb, distance
      WHERE distance < ${maxDistance}
      RETURN emb.nodeId AS nodeId, emb.chunkIndex AS chunkIndex,
             emb.startLine AS startLine, emb.endLine AS endLine, distance
      ORDER BY distance
    `;

    const embResults = await executeQuery(vectorQuery);
    return embResults.map((row) => ({
      nodeId: row.nodeId ?? row[0],
      chunkIndex: row.chunkIndex ?? row[1] ?? 0,
      startLine: row.startLine ?? row[2] ?? 0,
      endLine: row.endLine ?? row[3] ?? 0,
      distance: row.distance ?? row[4],
    }));
  });

  if (bestChunks.size === 0) {
    return [];
  }

  // Group results by label for batched metadata queries
  const byLabel = new Map<
    string,
    Array<{ nodeId: string; distance: number } & Record<string, any>>
  >();
  for (const [nodeId, chunk] of Array.from(bestChunks.entries()).slice(0, k)) {
    const labelEndIdx = nodeId.indexOf(':');
    const label = labelEndIdx > 0 ? nodeId.substring(0, labelEndIdx) : 'Unknown';
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label)!.push({ nodeId, ...chunk });
  }

  // Batch-fetch metadata per label
  const results: SemanticSearchResult[] = [];

  for (const [label, items] of byLabel) {
    const idList = items.map((i) => `'${i.nodeId.replace(/'/g, "''")}'`).join(', ');
    try {
      const nodeQuery = `
        MATCH (n:\`${label}\`) WHERE n.id IN [${idList}]
        RETURN n.id AS id, n.name AS name, n.filePath AS filePath,
               n.startLine AS startLine, n.endLine AS endLine
      `;
      const nodeRows = await executeQuery(nodeQuery);
      const rowMap = new Map<string, any>();
      for (const row of nodeRows) {
        const id = row.id ?? row[0];
        rowMap.set(id, row);
      }
      for (const item of items) {
        const nodeRow = rowMap.get(item.nodeId);
        if (nodeRow) {
          results.push({
            nodeId: item.nodeId,
            name: nodeRow.name ?? nodeRow[1] ?? '',
            label,
            filePath: nodeRow.filePath ?? nodeRow[2] ?? '',
            distance: item.distance,
            startLine: item.startLine,
            endLine: item.endLine,
          });
        }
      }
    } catch {
      // Table might not exist, skip
    }
  }

  results.sort((a, b) => a.distance - b.distance);

  return results;
};

/**
 * Semantic search with graph expansion (flattened results)
 */
export const semanticSearchWithContext = async (
  executeQuery: (cypher: string) => Promise<any[]>,
  query: string,
  k: number = 5,
  _hops: number = 1,
): Promise<any[]> => {
  const results = await semanticSearch(executeQuery, query, k, 0.5);

  return results.map((r) => ({
    matchId: r.nodeId,
    matchName: r.name,
    matchLabel: r.label,
    matchPath: r.filePath,
    distance: r.distance,
    connectedId: null,
    connectedName: null,
    connectedLabel: null,
    relationType: null,
  }));
};
