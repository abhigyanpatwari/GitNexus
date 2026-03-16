import * as Comlink from 'comlink';
import { runIngestionPipeline, runPipelineFromFiles } from '../core/ingestion/pipeline';
import { PipelineProgress, SerializablePipelineResult, serializePipelineResult } from '../types/pipeline';
import { FileEntry } from '../services/zip';
import {
  runEmbeddingPipeline,
  semanticSearch as doSemanticSearch,
  semanticSearchWithContext as doSemanticSearchWithContext,
  type EmbeddingProgressCallback,
} from '../core/embeddings/embedding-pipeline';
import { isEmbedderReady, disposeEmbedder } from '../core/embeddings/embedder';
import type { EmbeddingProgress, SemanticSearchResult } from '../core/embeddings/types';
import type { ProviderConfig, AgentStreamChunk } from '../core/llm/types';
import { createGraphRAGAgent, streamAgentResponse, type AgentMessage, createChatModel } from '../core/llm/agent';
import { SystemMessage } from '@langchain/core/messages';
import { enrichClustersBatch, ClusterMemberInfo, ClusterEnrichment } from '../core/ingestion/cluster-enricher';
import { CommunityNode } from '../core/ingestion/community-processor';
import { PipelineResult } from '../types/pipeline';
import { buildCodebaseContext, type CodebaseContext } from '../core/llm/context-builder';
import { 
  buildBM25Index, 
  searchBM25, 
  isBM25Ready, 
  getBM25Stats,
  mergeWithRRF,
  type HybridSearchResult,
} from '../core/search';

// Lazy import for LadybugDB to avoid breaking worker if SharedArrayBuffer unavailable
let lbugAdapter: typeof import('../core/lbug/lbug-adapter') | null = null;
const getLbugAdapter = async () => {
  if (!lbugAdapter) {
    lbugAdapter = await import('../core/lbug/lbug-adapter');
  }
  return lbugAdapter;
};

// Embedding state
let embeddingProgress: EmbeddingProgress | null = null;
let isEmbeddingComplete = false;

// File contents state - stores full file contents for grep/read tools
let storedFileContents: Map<string, string> = new Map();

// Agent state
let currentAgent: ReturnType<typeof createGraphRAGAgent> | null = null;
let currentProviderConfig: ProviderConfig | null = null;
let currentGraphResult: PipelineResult | null = null;

// Pending enrichment config (for background processing)
let pendingEnrichmentConfig: ProviderConfig | null = null;
let enrichmentCancelled = false;

// Chat cancellation flag
let chatCancelled = false;

// ============================================================
// HTTP helpers for backend mode
// ============================================================

const httpFetchWithTimeout = async (
  url: string,
  init: RequestInit = {},
  timeoutMs: number = 30_000,
): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

const createHttpExecuteQuery = (backendUrl: string, repo: string) => {
  return async (cypher: string): Promise<any[]> => {
    const response = await httpFetchWithTimeout(`${backendUrl}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cypher, repo }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Backend query failed: ${response.status}`);
    }
    const body = await response.json();
    return (body.result ?? body) as any[];
  };
};

/**
 * Create a search function that calls the backend's /api/search endpoint,
 * which runs full hybrid search (BM25 + semantic + RRF) on the server.
 * Results are flattened from the process-grouped response into the flat
 * array format expected by createGraphRAGTools.
 */
const createHttpHybridSearch = (backendUrl: string, repo: string) => {
  return async (query: string, k: number = 15): Promise<any[]> => {
    try {
      const response = await httpFetchWithTimeout(`${backendUrl}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, limit: k, repo }),
      });
      if (!response.ok) {
        return [];
      }
      const body = await response.json();
      const data = body.results ?? body;

      // Flatten process_symbols + definitions into a single ranked list
      const symbols: any[] = (data.process_symbols ?? []).map((s: any, i: number) => ({
        nodeId: s.id,
        id: s.id,
        name: s.name,
        label: s.type,
        filePath: s.filePath,
        startLine: s.startLine,
        endLine: s.endLine,
        content: s.content ?? '',
        sources: ['bm25', 'semantic'],
        score: 1 - (i * 0.02),
      }));

      const defs: any[] = (data.definitions ?? []).map((d: any, i: number) => ({
        id: d.name,
        name: d.name,
        label: d.type || 'File',
        filePath: d.filePath,
        content: '',
        sources: ['bm25'],
        score: 0.5 - (i * 0.02),
      }));

      return [...symbols, ...defs].slice(0, k);
    } catch {
      return [];
    }
  };
};

/**
 * Worker API exposed via Comlink
 * 
 * Note: The onProgress callback is passed as a Comlink.proxy() from the main thread,
 * allowing it to be called from the worker and have it execute on the main thread.
 */
const workerApi = {
  /**
   * Run the ingestion pipeline in the worker thread
   * @param file - The ZIP file to process
   * @param onProgress - Proxied callback for progress updates (runs on main thread)
   * @returns Serializable result (nodes, relationships, fileContents as object)
   */
  async runPipeline(
    file: File,
    onProgress: (progress: PipelineProgress) => void,
    clusteringConfig?: ProviderConfig
  ): Promise<SerializablePipelineResult> {
    // Debug logging
    console.log('🔧 runPipeline called with clusteringConfig:', !!clusteringConfig);
    // Run the actual pipeline
    const result = await runIngestionPipeline(file, onProgress);
    currentGraphResult = result;
    
    // Store file contents for grep/read tools (full content, not truncated)
    storedFileContents = result.fileContents;
    
    // Build BM25 index for keyword search (instant, ~100ms)
    const bm25DocCount = buildBM25Index(storedFileContents);
    if (import.meta.env.DEV) {
      console.log(`🔍 BM25 index built: ${bm25DocCount} documents`);
    }
    
    // Load graph into LadybugDB for querying (optional - gracefully degrades)
    try {
      onProgress({
        phase: 'complete',
        percent: 98,
        message: 'Loading into LadybugDB...',
        stats: {
          filesProcessed: result.graph.nodeCount,
          totalFiles: result.graph.nodeCount,
          nodesCreated: result.graph.nodeCount,
        },
      });

      const lbug = await getLbugAdapter();
      await lbug.loadGraphToLbug(result.graph, result.fileContents);

      if (import.meta.env.DEV) {
        const stats = await lbug.getLbugStats();
        console.log('LadybugDB loaded:', stats);
        console.log('📁 Stored', storedFileContents.size, 'files for grep/read tools');
      }
    } catch {
      // LadybugDB is optional - silently continue without it
    }

    // Store clustering config for background enrichment (runs after graph loads)
    if (clusteringConfig) {
      pendingEnrichmentConfig = clusteringConfig;
      console.log('📋 Clustering config saved for background enrichment');
    }

    // Convert to serializable format for transfer back to main thread
    return serializePipelineResult(result);
  },

  /**
   * Execute a Cypher query against the LadybugDB database
   * @param cypher - The Cypher query string
   * @returns Query results as an array of objects
   */
  async runQuery(cypher: string): Promise<any[]> {
    const lbug = await getLbugAdapter();
    if (!lbug.isLbugReady()) {
      throw new Error('Database not ready. Please load a repository first.');
    }
    return lbug.executeQuery(cypher);
  },

  /**
   * Check if the database is ready for queries
   */
  async isReady(): Promise<boolean> {
    try {
      const lbug = await getLbugAdapter();
      return lbug.isLbugReady();
    } catch {
      return false;
    }
  },

  /**
   * Get database statistics
   */
  async getStats(): Promise<{ nodes: number; edges: number }> {
    try {
      const lbug = await getLbugAdapter();
      return lbug.getLbugStats();
    } catch {
      return { nodes: 0, edges: 0 };
    }
  },

  /**
   * Run the ingestion pipeline from pre-extracted files (e.g., from git clone)
   * @param files - Array of file entries with path and content
   * @param onProgress - Proxied callback for progress updates
   * @returns Serializable result
   */
  async runPipelineFromFiles(
    files: FileEntry[],
    onProgress: (progress: PipelineProgress) => void,
    clusteringConfig?: ProviderConfig
  ): Promise<SerializablePipelineResult> {
    // Skip extraction phase, start from 15%
    onProgress({
      phase: 'extracting',
      percent: 15,
      message: 'Files ready',
      stats: { filesProcessed: 0, totalFiles: files.length, nodesCreated: 0 },
    });

    // Run the pipeline
    const result = await runPipelineFromFiles(files, onProgress);
    currentGraphResult = result;
    
    // Store file contents for grep/read tools (full content, not truncated)
    storedFileContents = result.fileContents;
    
    // Build BM25 index for keyword search (instant, ~100ms)
    const bm25DocCount = buildBM25Index(storedFileContents);
    if (import.meta.env.DEV) {
      console.log(`🔍 BM25 index built: ${bm25DocCount} documents`);
    }
    
    // Load graph into LadybugDB for querying (optional - gracefully degrades)
    try {
      onProgress({
        phase: 'complete',
        percent: 98,
        message: 'Loading into LadybugDB...',
        stats: {
          filesProcessed: result.graph.nodeCount,
          totalFiles: result.graph.nodeCount,
          nodesCreated: result.graph.nodeCount,
        },
      });

      const lbug = await getLbugAdapter();
      await lbug.loadGraphToLbug(result.graph, result.fileContents);

      if (import.meta.env.DEV) {
        const stats = await lbug.getLbugStats();
        console.log('LadybugDB loaded:', stats);
        console.log('📁 Stored', storedFileContents.size, 'files for grep/read tools');
      }
    } catch {
      // LadybugDB is optional - silently continue without it
    }
    
    // Store clustering config for background enrichment (runs after graph loads)
    if (clusteringConfig) {
      pendingEnrichmentConfig = clusteringConfig;
      console.log('📋 Clustering config saved for background enrichment');
    }
    
    // Convert to serializable format for transfer back to main thread
    return serializePipelineResult(result);
  },

  // ============================================================
  // Embedding Pipeline Methods
  // ============================================================

  /**
   * Start the embedding pipeline in the background
   * Generates embeddings for all embeddable nodes and creates vector index
   * @param onProgress - Proxied callback for embedding progress updates
   * @param forceDevice - Force a specific device ('webgpu' or 'wasm')
   */
  async startEmbeddingPipeline(
    onProgress: (progress: EmbeddingProgress) => void,
    forceDevice?: 'webgpu' | 'wasm'
  ): Promise<void> {
    const lbug = await getLbugAdapter();
    if (!lbug.isLbugReady()) {
      throw new Error('Database not ready. Please load a repository first.');
    }

    // Reset state
    embeddingProgress = null;
    isEmbeddingComplete = false;

    const progressCallback: EmbeddingProgressCallback = (progress) => {
      embeddingProgress = progress;
      if (progress.phase === 'ready') {
        isEmbeddingComplete = true;
      }
      onProgress(progress);
    };

    await runEmbeddingPipeline(
      lbug.executeQuery,
      lbug.executeWithReusedStatement,
      progressCallback,
      forceDevice ? { device: forceDevice } : {}
    );
  },

  /**
   * Start background cluster enrichment (if pending)
   * Called after graph loads, runs in background like embeddings
   * @param onProgress - Progress callback
   */
  async startBackgroundEnrichment(
    onProgress?: (current: number, total: number) => void
  ): Promise<{ enriched: number; skipped: boolean }> {
    if (!pendingEnrichmentConfig) {
      console.log('⏭️ No pending enrichment config, skipping');
      return { enriched: 0, skipped: true };
    }
    
    console.log('✨ Starting background LLM enrichment...');
    try {
      await workerApi.enrichCommunities(
        pendingEnrichmentConfig,
        onProgress ?? (() => {})
      );
      pendingEnrichmentConfig = null; // Clear after running
      console.log('✅ Background enrichment completed');
      return { enriched: 1, skipped: false };
    } catch (err) {
      console.error('❌ Background enrichment failed:', err);
      pendingEnrichmentConfig = null;
      return { enriched: 0, skipped: false };
    }
  },

  /**
   * Cancel the current enrichment operation
   */
  async cancelEnrichment(): Promise<void> {
    enrichmentCancelled = true;
    pendingEnrichmentConfig = null;
    console.log('⏸️ Enrichment cancelled by user');
  },

  /**
   * Perform semantic search on the codebase
   * @param query - Natural language search query
   * @param k - Number of results to return (default: 10)
   * @param maxDistance - Maximum distance threshold (default: 0.5)
   * @returns Array of search results ordered by relevance
   */
  async semanticSearch(
    query: string,
    k: number = 10,
    maxDistance: number = 0.5
  ): Promise<SemanticSearchResult[]> {
    const lbug = await getLbugAdapter();
    if (!lbug.isLbugReady()) {
      throw new Error('Database not ready. Please load a repository first.');
    }
    if (!isEmbeddingComplete) {
      throw new Error('Embeddings not ready. Please wait for embedding pipeline to complete.');
    }

    return doSemanticSearch(lbug.executeQuery, query, k, maxDistance);
  },

  /**
   * Perform semantic search with graph expansion
   * Finds similar nodes AND their connections
   * @param query - Natural language search query
   * @param k - Number of initial results (default: 5)
   * @param hops - Number of graph hops to expand (default: 2)
   * @returns Search results with connected nodes
   */
  async semanticSearchWithContext(
    query: string,
    k: number = 5,
    hops: number = 2
  ): Promise<any[]> {
    const lbug = await getLbugAdapter();
    if (!lbug.isLbugReady()) {
      throw new Error('Database not ready. Please load a repository first.');
    }
    if (!isEmbeddingComplete) {
      throw new Error('Embeddings not ready. Please wait for embedding pipeline to complete.');
    }

    return doSemanticSearchWithContext(lbug.executeQuery, query, k, hops);
  },

  /**
   * Perform hybrid search combining BM25 (keyword) and semantic (embedding) search
   * Uses Reciprocal Rank Fusion (RRF) to merge results
   * 
   * @param query - Search query
   * @param k - Number of results to return (default: 10)
   * @returns Hybrid search results with RRF scores
   */
  async hybridSearch(
    query: string,
    k: number = 10
  ): Promise<HybridSearchResult[]> {
    if (!isBM25Ready()) {
      throw new Error('Search index not ready. Please load a repository first.');
    }
    
    // Get BM25 results (always available after ingestion)
    const bm25Results = searchBM25(query, k * 3);  // Get more for better RRF merge
    
    // Get semantic results if embeddings are ready
    let semanticResults: SemanticSearchResult[] = [];
    if (isEmbeddingComplete) {
      try {
        const lbug = await getLbugAdapter();
        if (lbug.isLbugReady()) {
          semanticResults = await doSemanticSearch(lbug.executeQuery, query, k * 3, 0.5);
        }
      } catch {
        // Semantic search failed, continue with BM25 only
      }
    }
    
    // Merge with RRF
    return mergeWithRRF(bm25Results, semanticResults, k);
  },

  /**
   * Check if BM25 search index is ready
   */
  isBM25Ready(): boolean {
    return isBM25Ready();
  },

  /**
   * Get BM25 index statistics
   */
  getBM25Stats(): { documentCount: number; termCount: number } {
    return getBM25Stats();
  },

  /**
   * Check if the embedding model is loaded and ready
   */
  isEmbeddingModelReady(): boolean {
    return isEmbedderReady();
  },

  /**
   * Check if embeddings are fully generated and indexed
   */
  isEmbeddingComplete(): boolean {
    return isEmbeddingComplete;
  },

  /**
   * Get current embedding progress
   */
  getEmbeddingProgress(): EmbeddingProgress | null {
    return embeddingProgress;
  },

  /**
   * Cleanup embedding model resources
   */
  async disposeEmbeddingModel(): Promise<void> {
    await disposeEmbedder();
    isEmbeddingComplete = false;
    embeddingProgress = null;
  },

  /**
   * Test if LadybugDB supports array parameters in prepared statements
   * This is a diagnostic function
   */
  async testArrayParams(): Promise<{ success: boolean; error?: string }> {
    const lbug = await getLbugAdapter();
    if (!lbug.isLbugReady()) {
      return { success: false, error: 'Database not ready' };
    }
    return lbug.testArrayParams();
  },

  // ============================================================
  // Graph RAG Agent Methods
  // ============================================================

  /**
   * Initialize the Graph RAG agent with a provider configuration
   * Must be called before using chat methods
   * @param config - Provider configuration (Azure OpenAI or Gemini)
   * @param projectName - Name of the loaded project/repository
   */
  async initializeAgent(config: ProviderConfig, projectName?: string): Promise<{ success: boolean; error?: string }> {
    try {
      const lbug = await getLbugAdapter();
      if (!lbug.isLbugReady()) {
        return { success: false, error: 'Database not ready. Please load a repository first.' };
      }

      // Create semantic search wrappers that handle embedding state
      const semanticSearchWrapper = async (query: string, k?: number, maxDistance?: number) => {
        if (!isEmbeddingComplete) {
          throw new Error('Embeddings not ready');
        }
        return doSemanticSearch(lbug.executeQuery, query, k, maxDistance);
      };

      const semanticSearchWithContextWrapper = async (query: string, k?: number, hops?: number) => {
        if (!isEmbeddingComplete) {
          throw new Error('Embeddings not ready');
        }
        return doSemanticSearchWithContext(lbug.executeQuery, query, k, hops);
      };

      // Hybrid search wrapper - combines BM25 + semantic
      const hybridSearchWrapper = async (query: string, k?: number) => {
        // Get BM25 results (always available after ingestion)
        const bm25Results = searchBM25(query, (k ?? 10) * 3);

        // Get semantic results if embeddings are ready
        let semanticResults: any[] = [];
        if (isEmbeddingComplete) {
          try {
            semanticResults = await doSemanticSearch(lbug.executeQuery, query, (k ?? 10) * 3, 0.5);
          } catch {
            // Semantic search failed, continue with BM25 only
          }
        }

        // Merge with RRF
        return mergeWithRRF(bm25Results, semanticResults, k ?? 10);
      };

      // Use provided projectName, or fallback to 'project' if not provided
      const resolvedProjectName = projectName || 'project';
      if (import.meta.env.DEV) {
        console.log('📛 Project name received:', { provided: projectName, resolved: resolvedProjectName });
      }
      
      let codebaseContext;
      try {
        codebaseContext = await buildCodebaseContext(lbug.executeQuery, resolvedProjectName);
        if (import.meta.env.DEV) {
          console.log('📊 Codebase context built:', {
            files: codebaseContext.stats.fileCount,
            functions: codebaseContext.stats.functionCount,
            hotspots: codebaseContext.hotspots.length,
          });
        }
      } catch (err) {
        console.warn('Failed to build codebase context, proceeding without:', err);
      }

      currentAgent = createGraphRAGAgent(
        config,
        lbug.executeQuery,
        semanticSearchWrapper,
        semanticSearchWithContextWrapper,
        hybridSearchWrapper,
        () => isEmbeddingComplete,
        () => isBM25Ready(),
        storedFileContents,
        codebaseContext
      );
      currentProviderConfig = config;

      if (import.meta.env.DEV) {
        console.log('🤖 Graph RAG Agent initialized with provider:', config.provider);
      }

      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (import.meta.env.DEV) {
        console.error('❌ Agent initialization failed:', error);
      }
      return { success: false, error: message };
    }
  },

  /**
   * Initialize the Graph RAG agent in backend mode (HTTP-backed tools).
   * Uses HTTP wrappers instead of local LadybugDB for all tool queries.
   * @param config - Provider configuration for the LLM
   * @param backendUrl - Base URL of the gitnexus serve backend
   * @param repoName - Repository name on the backend
   * @param fileContentsEntries - File contents as [path, content][] (Comlink can't transfer Maps)
   * @param projectName - Display name for the project
   */
  async initializeBackendAgent(
    config: ProviderConfig,
    backendUrl: string,
    repoName: string,
    fileContentsEntries: [string, string][],
    projectName?: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Rebuild Map from serializable entries (Comlink can't transfer Maps)
      const contents = new Map<string, string>(fileContentsEntries);
      storedFileContents = contents;

      // Create HTTP-based tool wrappers
      const executeQuery = createHttpExecuteQuery(backendUrl, repoName);
      const hybridSearch = createHttpHybridSearch(backendUrl, repoName);

      // Build codebase context (uses Cypher queries — works via HTTP)
      let codebaseContext: CodebaseContext | undefined;
      try {
        codebaseContext = await buildCodebaseContext(executeQuery, projectName || repoName);
      } catch {
        // Non-fatal — agent works without context
      }

      // Create agent with HTTP-backed tools.
      // hybridSearch calls /api/search which runs full BM25 + semantic + RRF on the server.
      // isEmbeddingReady is false — no local embedding model is loaded in backend mode.
      // isBM25Ready is true — BM25 is available via the server's hybrid search.
      currentAgent = createGraphRAGAgent(
        config,
        executeQuery,          // Cypher via HTTP
        hybridSearch,          // semanticSearch → server hybrid search
        hybridSearch,          // semanticSearchWithContext → same
        hybridSearch,          // hybridSearch → server hybrid search
        () => false,           // isEmbeddingReady → no local embedder
        () => true,            // isBM25Ready → available via server
        contents,              // fileContents Map
        codebaseContext,
      );

      currentProviderConfig = config;

      if (import.meta.env.DEV) {
        console.log('🤖 Backend agent initialized with provider:', config.provider);
      }

      return { success: true };
    } catch (err: any) {
      if (import.meta.env.DEV) {
        console.error('❌ Backend agent initialization failed:', err);
      }
      return { success: false, error: err.message || 'Failed to initialize backend agent' };
    }
  },

  /**
   * Check if the agent is initialized
   */
  isAgentReady(): boolean {
    return currentAgent !== null;
  },

  /**
   * Get current provider info
   */
  getAgentProvider(): { provider: string; model: string } | null {
    if (!currentProviderConfig) return null;
    return {
      provider: currentProviderConfig.provider,
      model: currentProviderConfig.model,
    };
  },

  /**
   * Chat with the Graph RAG agent (streaming)
   * Sends response chunks via the onChunk callback
   * @param messages - Conversation history
   * @param onChunk - Proxied callback for streaming chunks (runs on main thread)
   */
  async chatStream(
    messages: AgentMessage[],
    onChunk: (chunk: AgentStreamChunk) => void
  ): Promise<void> {
    if (!currentAgent) {
      onChunk({ type: 'error', error: 'Agent not initialized. Please configure an LLM provider first.' });
      return;
    }

    chatCancelled = false;

    try {
      for await (const chunk of streamAgentResponse(currentAgent, messages)) {
        if (chatCancelled) {
          onChunk({ type: 'done' });
          break;
        }
        onChunk(chunk);
      }
    } catch (error) {
      if (chatCancelled) {
        // Swallow errors from cancellation
        onChunk({ type: 'done' });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      onChunk({ type: 'error', error: message });
    }
  },

  /**
   * Stop the current chat stream
   */
  stopChat(): void {
    chatCancelled = true;
  },

  /**
   * Dispose of the current agent
   */
  disposeAgent(): void {
    currentAgent = null;
    currentProviderConfig = null;
  },

  /**
   * Enrich community clusters using LLM
   */
  async enrichCommunities(
    providerConfig: ProviderConfig,
    onProgress: (current: number, total: number) => void
  ): Promise<{ enrichments: Record<string, ClusterEnrichment>, tokensUsed: number }> {
    if (!currentGraphResult) {
      throw new Error('No graph loaded. Please ingest a repository first.');
    }

    const { graph } = currentGraphResult;
    
    // Filter for community nodes
    const communityNodes = graph.nodes
      .filter(n => n.label === 'Community')
      .map(n => ({
        id: n.id,
        label: 'Community',
        heuristicLabel: n.properties.heuristicLabel,
        cohesion: n.properties.cohesion,
        symbolCount: n.properties.symbolCount
      } as CommunityNode));

    if (communityNodes.length === 0) {
      return { enrichments: {}, tokensUsed: 0 };
    }

    // Build member map: CommunityID -> Member Info
    const memberMap = new Map<string, ClusterMemberInfo[]>();
    
    // Initialize map
    communityNodes.forEach(c => memberMap.set(c.id, []));
    
    // Find all MEMBER_OF edges
    graph.relationships.forEach(rel => {
      if (rel.type === 'MEMBER_OF') {
        const communityId = rel.targetId;
        const memberId = rel.sourceId; // MEMBER_OF goes Member -> Community
        
        if (memberMap.has(communityId)) {
          // Find member node details
          const memberNode = graph.nodes.find(n => n.id === memberId);
          if (memberNode) {
            memberMap.get(communityId)?.push({
              name: memberNode.properties.name,
              filePath: memberNode.properties.filePath,
              type: memberNode.label
            });
          }
        }
      }
    });

    // Create LLM client adapter for LangChain model
    const chatModel = createChatModel(providerConfig);
    const llmClient = {
      generate: async (prompt: string): Promise<string> => {
        const response = await chatModel.invoke([
          new SystemMessage('You are a helpful code analysis assistant.'),
          { role: 'user', content: prompt }
        ]);
        return response.content as string;
      }
    };

    // Run enrichment
    const { enrichments, tokensUsed } = await enrichClustersBatch(
      communityNodes,
      memberMap,
      llmClient,
      5, // Batch size
      onProgress
    );

    if (import.meta.env.DEV) {
      console.log(`✨ Enriched ${enrichments.size} clusters using ~${Math.round(tokensUsed)} tokens`);
    }

    // Update graph nodes with enrichment data
    graph.nodes.forEach(node => {
      if (node.label === 'Community' && enrichments.has(node.id)) {
        const enrichment = enrichments.get(node.id)!;
        node.properties.name = enrichment.name; // Update display label
        node.properties.keywords = enrichment.keywords;
        node.properties.description = enrichment.description;
        node.properties.enrichedBy = 'llm';
      }
    });

    // Update LadybugDB with new data
    try {
      const lbug = await getLbugAdapter();
        
      onProgress(enrichments.size, enrichments.size); // Done
      
      // Update one by one via Cypher (simplest for now)
      for (const [id, enrichment] of enrichments.entries()) {
         // Escape strings for Cypher - replace backslash first, then quotes
         const escapeCypher = (str: string) => str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
         
         const keywordsStr = JSON.stringify(enrichment.keywords);
         const descStr = escapeCypher(enrichment.description);
         const nameStr = escapeCypher(enrichment.name);
         const escapedId = escapeCypher(id);
         
         const query = `
           MATCH (c:Community {id: "${escapedId}"})
           SET c.label = "${nameStr}", 
               c.keywords = ${keywordsStr}, 
               c.description = "${descStr}",
               c.enrichedBy = "llm"
         `;
         
         await lbug.executeQuery(query);
      }

    } catch (err) {
      console.error('Failed to update LadybugDB with enrichment:', err);
    }
    
    // Convert Map to Record for serialization
    const enrichmentsRecord: Record<string, ClusterEnrichment> = {};
    for (const [id, val] of enrichments.entries()) {
      enrichmentsRecord[id] = val;
    }
     
    return { enrichments: enrichmentsRecord, tokensUsed };
  
  },
};

// Expose the worker API to the main thread
Comlink.expose(workerApi);

// TypeScript type for the exposed API (used by the hook)
export type IngestionWorkerApi = typeof workerApi;

