/**
 * HTTP API Server
 *
 * REST API for browser-based clients to query the local .gitnexus/ index.
 * Also hosts the MCP server over StreamableHTTP for remote AI tool access.
 *
 * Security: binds to 127.0.0.1 by default (use --host to override).
 * CORS is restricted to localhost and the deployed site.
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs/promises';
import { loadMeta, listRegisteredRepos } from '../storage/repo-manager.js';
import { executeQuery, closeKuzu, withKuzuDb } from '../core/kuzu/kuzu-adapter.js';
import { NODE_TABLES } from '../core/kuzu/schema.js';
import { GraphNode, GraphRelationship } from '../core/graph/types.js';
import { searchFTSFromKuzu } from '../core/search/bm25-index.js';
import { hybridSearch } from '../core/search/hybrid-search.js';
// Embedding imports are lazy (dynamic import) to avoid loading onnxruntime-node
// at server startup — crashes on unsupported Node ABI versions (#89)
import { LocalBackend } from '../mcp/local/local-backend.js';
import { mountMCPEndpoints } from './mcp-http.js';

const buildGraph = async (): Promise<{ nodes: GraphNode[]; relationships: GraphRelationship[] }> => {
  const nodes: GraphNode[] = [];
  for (const table of NODE_TABLES) {
    try {
      let query = '';
      if (table === 'File') {
        query = `MATCH (n:File) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.content AS content`;
      } else if (table === 'Folder') {
        query = `MATCH (n:Folder) RETURN n.id AS id, n.name AS name, n.filePath AS filePath`;
      } else if (table === 'Community') {
        query = `MATCH (n:Community) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.cohesion AS cohesion, n.symbolCount AS symbolCount`;
      } else if (table === 'Process') {
        query = `MATCH (n:Process) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.processType AS processType, n.stepCount AS stepCount, n.communities AS communities, n.entryPointId AS entryPointId, n.terminalId AS terminalId`;
      } else {
        query = `MATCH (n:${table}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine, n.content AS content`;
      }

      const rows = await executeQuery(query);
      for (const row of rows) {
        nodes.push({
          id: row.id ?? row[0],
          label: table as GraphNode['label'],
          properties: {
            name: row.name ?? row.label ?? row[1],
            filePath: row.filePath ?? row[2],
            startLine: row.startLine,
            endLine: row.endLine,
            content: row.content,
            heuristicLabel: row.heuristicLabel,
            cohesion: row.cohesion,
            symbolCount: row.symbolCount,
            processType: row.processType,
            stepCount: row.stepCount,
            communities: row.communities,
            entryPointId: row.entryPointId,
            terminalId: row.terminalId,
          } as GraphNode['properties'],
        });
      }
    } catch {
      // ignore empty tables
    }
  }

  const relationships: GraphRelationship[] = [];
  const relRows = await executeQuery(
    `MATCH (a)-[r:CodeRelation]->(b) RETURN a.id AS sourceId, b.id AS targetId, r.type AS type, r.confidence AS confidence, r.reason AS reason, r.step AS step`
  );
  for (const row of relRows) {
    relationships.push({
      id: `${row.sourceId}_${row.type}_${row.targetId}`,
      type: row.type,
      sourceId: row.sourceId,
      targetId: row.targetId,
      confidence: row.confidence,
      reason: row.reason,
      step: row.step,
    });
  }

  return { nodes, relationships };
};

const statusFromError = (err: any): number => {
  const msg = String(err?.message ?? '');
  if (msg.includes('No indexed repositories') || msg.includes('not found')) return 404;
  if (msg.includes('Multiple repositories')) return 400;
  return 500;
};

const requestedRepo = (req: express.Request): string | undefined => {
  const fromQuery = typeof req.query.repo === 'string' ? req.query.repo : undefined;
  if (fromQuery) return fromQuery;

  if (req.body && typeof req.body === 'object' && typeof req.body.repo === 'string') {
    return req.body.repo;
  }

  return undefined;
};

export const createServer = async (port: number, host: string = '127.0.0.1') => {
  const app = express();

  // CORS: only allow localhost origins and the deployed site.
  // Non-browser requests (curl, server-to-server) have no origin and are allowed.
  app.use(cors({
    origin: (origin, callback) => {
      if (
        !origin
        || origin.startsWith('http://localhost:')
        || origin.startsWith('http://127.0.0.1:')
        || origin === 'https://gitnexus.vercel.app'
      ) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    }
  }));
  app.use(express.json({ limit: '10mb' }));

  // Initialize MCP backend (multi-repo, shared across all MCP sessions)
  const backend = new LocalBackend();
  await backend.init();
  const cleanupMcp = mountMCPEndpoints(app, backend);

  // Helper: resolve a repo by name from the global registry, or default to first
  const resolveRepo = async (repoName?: string) => {
    const repos = await listRegisteredRepos();
    if (repos.length === 0) return null;
    if (repoName) return repos.find(r => r.name === repoName) || null;
    return repos[0]; // default to first
  };

  // List all registered repos
  app.get('/api/repos', async (_req, res) => {
    try {
      const repos = await listRegisteredRepos();
      res.json(repos.map(r => ({
        name: r.name, path: r.path, indexedAt: r.indexedAt,
        lastCommit: r.lastCommit, stats: r.stats,
      })));
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to list repos' });
    }
  });

  // Get repo info
  app.get('/api/repo', async (req, res) => {
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found. Run: gitnexus analyze' });
        return;
      }
      const meta = await loadMeta(entry.storagePath);
      res.json({
        name: entry.name,
        repoPath: entry.path,
        indexedAt: meta?.indexedAt ?? entry.indexedAt,
        stats: meta?.stats ?? entry.stats ?? {},
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to get repo info' });
    }
  });

  // Get full graph
  app.get('/api/graph', async (req, res) => {
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      const kuzuPath = path.join(entry.storagePath, 'kuzu');
      const graph = await withKuzuDb(kuzuPath, async () => buildGraph());
      res.json(graph);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to build graph' });
    }
  });

  // Execute Cypher query
  app.post('/api/query', async (req, res) => {
    try {
      const cypher = req.body.cypher as string;
      if (!cypher) {
        res.status(400).json({ error: 'Missing "cypher" in request body' });
        return;
      }

      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      const kuzuPath = path.join(entry.storagePath, 'kuzu');
      const result = await withKuzuDb(kuzuPath, () => executeQuery(cypher));
      res.json({ result });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Query failed' });
    }
  });

  // Search
  app.post('/api/search', async (req, res) => {
    try {
      const query = (req.body.query ?? '').trim();
      if (!query) {
        res.status(400).json({ error: 'Missing "query" in request body' });
        return;
      }

      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      const kuzuPath = path.join(entry.storagePath, 'kuzu');
      const parsedLimit = Number(req.body.limit ?? 10);
      const limit = Number.isFinite(parsedLimit)
        ? Math.max(1, Math.min(100, Math.trunc(parsedLimit)))
        : 10;

      const results = await withKuzuDb(kuzuPath, async () => {
        const { isEmbedderReady } = await import('../core/embeddings/embedder.js');
        if (isEmbedderReady()) {
          const { semanticSearch } = await import('../core/embeddings/embedding-pipeline.js');
          return hybridSearch(query, limit, executeQuery, semanticSearch);
        }
        // FTS-only fallback when embeddings aren't loaded
        return searchFTSFromKuzu(query, limit);
      });
      res.json({ results });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Search failed' });
    }
  });

  // Read file — with path traversal guard
  app.get('/api/file', async (req, res) => {
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      const filePath = req.query.path as string;
      if (!filePath) {
        res.status(400).json({ error: 'Missing path' });
        return;
      }

      // Prevent path traversal — resolve and verify the path stays within the repo root
      const repoRoot = path.resolve(entry.path);
      const fullPath = path.resolve(repoRoot, filePath);
      if (!fullPath.startsWith(repoRoot + path.sep) && fullPath !== repoRoot) {
        res.status(403).json({ error: 'Path traversal denied' });
        return;
      }

      const content = await fs.readFile(fullPath, 'utf-8');
      res.json({ content });
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        res.status(404).json({ error: 'File not found' });
      } else {
        res.status(500).json({ error: err.message || 'Failed to read file' });
      }
    }
  });

  // List all processes
  app.get('/api/processes', async (req, res) => {
    try {
      const result = await backend.queryProcesses(requestedRepo(req));
      res.json(result);
    } catch (err: any) {
      res.status(statusFromError(err)).json({ error: err.message || 'Failed to query processes' });
    }
  });

  // Process detail
  app.get('/api/process', async (req, res) => {
    try {
      const name = String(req.query.name ?? '').trim();
      if (!name) {
        res.status(400).json({ error: 'Missing "name" query parameter' });
        return;
      }

      const result = await backend.queryProcessDetail(name, requestedRepo(req));
      if (result?.error) {
        res.status(404).json({ error: result.error });
        return;
      }
      res.json(result);
    } catch (err: any) {
      res.status(statusFromError(err)).json({ error: err.message || 'Failed to query process detail' });
    }
  });

  // List all clusters
  app.get('/api/clusters', async (req, res) => {
    try {
      const result = await backend.queryClusters(requestedRepo(req));
      res.json(result);
    } catch (err: any) {
      res.status(statusFromError(err)).json({ error: err.message || 'Failed to query clusters' });
    }
  });

  // Cluster detail
  app.get('/api/cluster', async (req, res) => {
    try {
      const name = String(req.query.name ?? '').trim();
      if (!name) {
        res.status(400).json({ error: 'Missing "name" query parameter' });
        return;
      }

      const result = await backend.queryClusterDetail(name, requestedRepo(req));
      if (result?.error) {
        res.status(404).json({ error: result.error });
        return;
      }
      res.json(result);
    } catch (err: any) {
      res.status(statusFromError(err)).json({ error: err.message || 'Failed to query cluster detail' });
    }
  });

  // Load a Langfuse trace and map its spans to graph node IDs
  app.post('/api/trace', async (req, res) => {
    try {
      const { trace_id, langfuse_host, public_key, secret_key } = req.body;
      if (!trace_id || !public_key || !secret_key) {
        res.status(400).json({ error: 'Missing required fields: trace_id, public_key, secret_key' });
        return;
      }

      const host = (langfuse_host || 'https://us.cloud.langfuse.com').replace(/\/$/, '');
      const auth = Buffer.from(`${public_key}:${secret_key}`).toString('base64');

      // Fetch trace from Langfuse
      const langfuseRes = await fetch(`${host}/api/public/traces/${trace_id}`, {
        headers: { Authorization: `Basic ${auth}` },
      });
      if (!langfuseRes.ok) {
        const body = await langfuseRes.json().catch(() => ({}));
        res.status(langfuseRes.status).json({ error: (body as any).message || `Langfuse returned ${langfuseRes.status}` });
        return;
      }
      const traceData = await langfuseRes.json() as any;

      // Extract scores
      const scores: Record<string, number> = {};
      for (const s of (traceData.scores ?? [])) {
        if (s.name) scores[s.name] = s.value ?? s.score ?? 0;
      }

      const observations: any[] = traceData.observations ?? [];

      // Load span→symbol mapping from the repo's .gitnexus/trace-config.json
      const entry = await resolveRepo(requestedRepo(req));
      let spanMappings: Record<string, string[]> = {};
      if (entry) {
        try {
          const configPath = path.join(entry.path, '.gitnexus', 'trace-config.json');
          const raw = await fs.readFile(configPath, 'utf-8');
          spanMappings = JSON.parse(raw).span_mappings ?? {};
        } catch {
          // No trace-config.json — proceed with no mappings
        }
      }

      // Split into exact matches and wildcard prefixes
      const wildcardPrefixes: Array<{ prefix: string; symbols: string[] }> = [];
      for (const [pattern, symbols] of Object.entries(spanMappings)) {
        if (pattern.includes('*')) {
          wildcardPrefixes.push({ prefix: pattern.replace(/\*/g, ''), symbols: symbols as string[] });
        }
      }

      // Resolve each span to symbol names
      const allSymbolNames = new Set<string>();
      const spanSymbols: string[][] = [];
      for (const obs of observations) {
        const spanName: string = obs.name ?? '';
        let matched: string[] = spanMappings[spanName] ?? [];
        if (matched.length === 0) {
          for (const { prefix, symbols } of wildcardPrefixes) {
            if (spanName.startsWith(prefix)) { matched = symbols; break; }
          }
        }
        spanSymbols.push(matched);
        for (const s of matched) allSymbolNames.add(s);
      }

      // Resolve symbol names → node IDs via KuzuDB (one withKuzuDb call)
      const symbolToIds = new Map<string, string[]>();
      if (entry && allSymbolNames.size > 0) {
        const kuzuPath = path.join(entry.storagePath, 'kuzu');
        const nameList = [...allSymbolNames]
          .map(n => `'${n.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`)
          .join(', ');
        const symbolTables = ['Function', 'Class', 'Method', 'Interface', 'CodeElement'];
        await withKuzuDb(kuzuPath, async () => {
          for (const table of symbolTables) {
            try {
              const rows = await executeQuery(
                `MATCH (n:${table}) WHERE n.name IN [${nameList}] RETURN n.id AS id, n.name AS name`
              );
              for (const row of rows) {
                const id = row.id ?? row[0];
                const name = row.name ?? row[1];
                if (id && name) {
                  const existing = symbolToIds.get(name) ?? [];
                  existing.push(id);
                  symbolToIds.set(name, existing);
                }
              }
            } catch { /* ignore empty tables */ }
          }
        });
      }

      // Build result
      const hitNodeIds = new Set<string>();
      const failedNodeIds = new Set<string>();
      const spans: any[] = [];

      for (let i = 0; i < observations.length; i++) {
        const obs = observations[i];
        const level: string = obs.level ?? 'DEFAULT';
        const startMs = obs.startTime ? new Date(obs.startTime).getTime() : 0;
        const endMs = obs.endTime ? new Date(obs.endTime).getTime() : startMs;
        const latency_ms = Math.max(0, endMs - startMs);

        const nodeIds: string[] = [];
        for (const sym of spanSymbols[i] ?? []) {
          for (const id of symbolToIds.get(sym) ?? []) nodeIds.push(id);
        }

        if (level === 'ERROR') {
          for (const id of nodeIds) failedNodeIds.add(id);
        } else {
          for (const id of nodeIds) hitNodeIds.add(id);
        }

        const rawUsage = obs.usage ?? obs.usageDetails;
        let usageFallback = rawUsage;
        if (!usageFallback && obs.output && typeof obs.output === 'object') {
          const out = obs.output as Record<string, any>;
          if (out.input_tokens != null || out.output_tokens != null) {
            usageFallback = {
              input: out.input_tokens ?? 0,
              output: out.output_tokens ?? 0,
              total: (out.input_tokens ?? 0) + (out.output_tokens ?? 0),
            };
          }
        }
        spans.push({
          name: obs.name ?? '',
          level,
          latency_ms,
          mapped_nodes: nodeIds,
          status_message: obs.statusMessage ?? undefined,
          type: obs.type ?? 'SPAN',
          model: obs.model ?? undefined,
          input: obs.input ?? undefined,
          output: obs.output ?? undefined,
          metadata: obs.metadata ?? undefined,
          usage: usageFallback ? {
            input: usageFallback.input ?? usageFallback.promptTokens ?? 0,
            output: usageFallback.output ?? usageFallback.completionTokens ?? 0,
            total: usageFallback.total ?? usageFallback.totalTokens ?? 0,
          } : undefined,
          start_time: obs.startTime ?? undefined,
        });
      }

      res.json({
        hit_node_ids: [...hitNodeIds],
        failed_node_ids: [...failedNodeIds],
        spans,
        scores,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Trace overlay failed' });
    }
  });

  // Global error handler — catch anything the route handlers miss
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  const server = app.listen(port, host, () => {
    console.log(`GitNexus server running on http://${host}:${port}`);
  });

  // Graceful shutdown — close Express + KuzuDB cleanly
  const shutdown = async () => {
    server.close();
    await cleanupMcp();
    await closeKuzu();
    await backend.disconnect();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
};
