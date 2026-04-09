/**
 * HTTP API Server
 *
 * REST API for browser-based clients to query the local .gitnexus/ index.
 * Also hosts the MCP server over StreamableHTTP for remote AI tool access.
 *
 * Security: binds to localhost by default (use --host to override).
 * CORS is restricted to localhost, private/LAN networks, and the deployed site.
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs/promises';
import { createRequire } from 'node:module';
import { loadMeta, listRegisteredRepos, getStoragePath } from '../storage/repo-manager.js';
import {
  executeQuery,
  executePrepared,
  executeWithReusedStatement,
  streamQuery,
  closeLbug,
  withLbugDb,
} from '../core/lbug/lbug-adapter.js';
import { isWriteQuery } from '../core/lbug/pool-adapter.js';
import { NODE_TABLES, type GraphNode, type GraphRelationship } from 'gitnexus-shared';
import { searchFTSFromLbug } from '../core/search/bm25-index.js';
import { hybridSearch } from '../core/search/hybrid-search.js';
// Embedding imports are lazy (dynamic import) to avoid loading onnxruntime-node
// at server startup — crashes on unsupported Node ABI versions (#89)
import { LocalBackend } from '../mcp/local/local-backend.js';
import { mountMCPEndpoints } from './mcp-http.js';
import { fork } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { JobManager } from './analyze-job.js';
import { extractRepoName, getCloneDir, cloneOrPull } from './git-clone.js';

const _require = createRequire(import.meta.url);
const pkg = _require('../../package.json');

/**
 * Determine whether an HTTP Origin header value is allowed by CORS policy.
 *
 * Permitted origins:
 * - No origin (non-browser requests such as curl or server-to-server calls)
 * - http://localhost:<port> — local development
 * - http://127.0.0.1:<port> — loopback alias
 * - RFC 1918 private/LAN networks (any port):
 *     10.0.0.0/8      → 10.x.x.x
 *     172.16.0.0/12   → 172.16.x.x – 172.31.x.x
 *     192.168.0.0/16  → 192.168.x.x
 * - https://gitnexus.vercel.app — the deployed GitNexus web UI
 *
 * @param origin - The value of the HTTP `Origin` request header, or `undefined`
 *                 when the header is absent (non-browser request).
 * @returns `true` if the origin is allowed, `false` otherwise.
 */
export const isAllowedOrigin = (origin: string | undefined): boolean => {
  if (origin === undefined) {
    // Non-browser requests (curl, server-to-server) have no Origin header
    return true;
  }

  if (
    origin.startsWith('http://localhost:') ||
    origin === 'http://localhost' ||
    origin.startsWith('http://127.0.0.1:') ||
    origin === 'http://127.0.0.1' ||
    origin.startsWith('http://[::1]:') ||
    origin === 'http://[::1]' ||
    origin === 'https://gitnexus.vercel.app'
  ) {
    return true;
  }

  // RFC 1918 private network ranges — allow any port on these hosts.
  // We parse the hostname out of the origin URL and check against each range.
  let hostname: string;
  let protocol: string;
  try {
    const parsed = new URL(origin);
    hostname = parsed.hostname;
    protocol = parsed.protocol;
  } catch {
    // Malformed origin — reject
    return false;
  }

  // Only allow HTTP(S) origins — reject ftp://, file://, etc.
  if (protocol !== 'http:' && protocol !== 'https:') return false;

  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    return false;
  }

  const [a, b] = octets;

  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12  →  172.16.x.x – 172.31.x.x
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;

  return false;
};

type GraphStreamRecord =
  | { type: 'node'; data: GraphNode }
  | { type: 'relationship'; data: GraphRelationship }
  | { type: 'error'; error: string };

export class ClientDisconnectedError extends Error {
  constructor() {
    super('Client disconnected during graph stream');
    this.name = 'ClientDisconnectedError';
  }
}

export const isIgnorableGraphQueryError = (err: unknown): boolean => {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('does not exist') ||
    message.includes('not found') ||
    message.includes('No table named')
  );
};

const ensureStreamIsWritable = (res: express.Response, signal?: AbortSignal): void => {
  if (signal?.aborted || res.destroyed || res.writableEnded) {
    throw new ClientDisconnectedError();
  }
};

const waitForDrain = async (res: express.Response, signal?: AbortSignal): Promise<void> => {
  ensureStreamIsWritable(res, signal);

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      signal?.removeEventListener('abort', onAbort);
    };

    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new ClientDisconnectedError());
    };
    const onAbort = () => {
      cleanup();
      reject(new ClientDisconnectedError());
    };

    res.once('drain', onDrain);
    res.once('close', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });

    if (signal?.aborted || res.destroyed || res.writableEnded) {
      onAbort();
    }
  });

  ensureStreamIsWritable(res, signal);
};

const isClientDisconnectWriteError = (err: unknown): boolean => {
  if (!(err instanceof Error)) return false;
  return (
    (err as NodeJS.ErrnoException).code === 'ERR_STREAM_DESTROYED' ||
    (err as NodeJS.ErrnoException).code === 'EPIPE' ||
    (err as NodeJS.ErrnoException).code === 'ECONNRESET' ||
    err.message.includes('write after end')
  );
};

export const writeNdjsonRecord = async (
  res: express.Response,
  record: GraphStreamRecord,
  signal?: AbortSignal,
): Promise<void> => {
  ensureStreamIsWritable(res, signal);

  try {
    const canContinue = res.write(JSON.stringify(record) + '\n');
    if (!canContinue) {
      await waitForDrain(res, signal);
    }
  } catch (err) {
    if (isClientDisconnectWriteError(err)) {
      throw new ClientDisconnectedError();
    }
    throw err;
  }
};

const buildGraph = async (
  includeContent = false,
): Promise<{ nodes: GraphNode[]; relationships: GraphRelationship[] }> => {
  const nodes: GraphNode[] = [];
  for (const table of NODE_TABLES) {
    try {
      const rows = await executeQuery(getNodeQuery(table, includeContent));
      for (const row of rows) {
        nodes.push(mapGraphNodeRow(table, row, includeContent));
      }
    } catch (err) {
      if (!isIgnorableGraphQueryError(err)) {
        throw err;
      }
    }
  }

  const relationships: GraphRelationship[] = [];
  const relRows = await executeQuery(GRAPH_RELATIONSHIP_QUERY);
  for (const row of relRows) {
    relationships.push(mapGraphRelationshipRow(row));
  }

  return { nodes, relationships };
};

const GRAPH_RELATIONSHIP_QUERY =
  `MATCH (a)-[r:CodeRelation]->(b) RETURN a.id AS sourceId, b.id AS targetId, ` +
  `r.type AS type, r.confidence AS confidence, r.reason AS reason, r.step AS step`;

const quoteNodeTable = (table: string): string => `\`${table.replace(/`/g, '``')}\``;

const getNodeQuery = (table: string, includeContent: boolean): string => {
  const tableLabel = quoteNodeTable(table);

  if (table === 'File') {
    return includeContent
      ? `MATCH (n:${tableLabel}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.content AS content`
      : `MATCH (n:${tableLabel}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath`;
  }
  if (table === 'Folder') {
    return `MATCH (n:${tableLabel}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath`;
  }
  if (table === 'Community') {
    return `MATCH (n:${tableLabel}) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.cohesion AS cohesion, n.symbolCount AS symbolCount`;
  }
  if (table === 'Process') {
    return `MATCH (n:${tableLabel}) RETURN n.id AS id, n.label AS label, n.heuristicLabel AS heuristicLabel, n.processType AS processType, n.stepCount AS stepCount, n.communities AS communities, n.entryPointId AS entryPointId, n.terminalId AS terminalId`;
  }
  if (table === 'Route') {
    return `MATCH (n:${tableLabel}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.responseKeys AS responseKeys, n.errorKeys AS errorKeys, n.middleware AS middleware`;
  }
  if (table === 'Tool') {
    return `MATCH (n:${tableLabel}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.description AS description`;
  }
  return includeContent
    ? `MATCH (n:${tableLabel}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine, n.content AS content`
    : `MATCH (n:${tableLabel}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine`;
};

const mapGraphNodeRow = (table: string, row: any, includeContent: boolean): GraphNode => ({
  id: row.id ?? row[0],
  label: table as GraphNode['label'],
  properties: {
    name: row.name ?? row.label ?? row[1],
    filePath: row.filePath ?? row[2],
    startLine: row.startLine,
    endLine: row.endLine,
    content: includeContent ? row.content : undefined,
    responseKeys: row.responseKeys,
    errorKeys: row.errorKeys,
    middleware: row.middleware,
    heuristicLabel: row.heuristicLabel,
    cohesion: row.cohesion,
    symbolCount: row.symbolCount,
    description: row.description,
    processType: row.processType,
    stepCount: row.stepCount,
    communities: row.communities,
    entryPointId: row.entryPointId,
    terminalId: row.terminalId,
  } as GraphNode['properties'],
});

const mapGraphRelationshipRow = (row: any): GraphRelationship => ({
  id: `${row.sourceId}_${row.type}_${row.targetId}`,
  type: row.type,
  sourceId: row.sourceId,
  targetId: row.targetId,
  confidence: row.confidence,
  reason: row.reason,
  step: row.step,
});

export const streamGraphNdjson = async (
  res: express.Response,
  includeContent = false,
  signal?: AbortSignal,
): Promise<void> => {
  for (const table of NODE_TABLES) {
    try {
      await streamQuery(getNodeQuery(table, includeContent), async (row) => {
        await writeNdjsonRecord(
          res,
          {
            type: 'node',
            data: mapGraphNodeRow(table, row, includeContent),
          },
          signal,
        );
      });
    } catch (err) {
      if (!isIgnorableGraphQueryError(err)) {
        throw err;
      }
    }
  }

  await streamQuery(GRAPH_RELATIONSHIP_QUERY, async (row) => {
    await writeNdjsonRecord(
      res,
      {
        type: 'relationship',
        data: mapGraphRelationshipRow(row),
      },
      signal,
    );
  });
};

/**
 * Mount an SSE progress endpoint for a JobManager.
 * Handles: initial state, terminal events, heartbeat, event IDs, client disconnect.
 */
const mountSSEProgress = (app: express.Express, routePath: string, jm: JobManager) => {
  app.get(routePath, (req, res) => {
    const job = jm.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    let eventId = 0;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Send current state immediately
    eventId++;
    res.write(`id: ${eventId}\ndata: ${JSON.stringify(job.progress)}\n\n`);

    // If already terminal, send event and close
    if (job.status === 'complete' || job.status === 'failed') {
      eventId++;
      res.write(
        `id: ${eventId}\nevent: ${job.status}\ndata: ${JSON.stringify({
          repoName: job.repoName,
          error: job.error,
        })}\n\n`,
      );
      res.end();
      return;
    }

    // Heartbeat to detect zombie connections
    const heartbeat = setInterval(() => {
      try {
        res.write(':heartbeat\n\n');
      } catch {
        clearInterval(heartbeat);
        unsubscribe();
      }
    }, 30_000);

    // Subscribe to progress updates
    const unsubscribe = jm.onProgress(job.id, (progress) => {
      try {
        eventId++;
        if (progress.phase === 'complete' || progress.phase === 'failed') {
          const eventJob = jm.getJob(req.params.jobId);
          res.write(
            `id: ${eventId}\nevent: ${progress.phase}\ndata: ${JSON.stringify({
              repoName: eventJob?.repoName,
              error: eventJob?.error,
            })}\n\n`,
          );
          clearInterval(heartbeat);
          res.end();
          unsubscribe();
        } else {
          res.write(`id: ${eventId}\ndata: ${JSON.stringify(progress)}\n\n`);
        }
      } catch {
        clearInterval(heartbeat);
        unsubscribe();
      }
    });

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
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
  app.disable('x-powered-by');

  // CORS: allow localhost, private/LAN networks, and the deployed site.
  // Non-browser requests (curl, server-to-server) have no origin and are allowed.
  // Disallowed origins get the response without Access-Control-Allow-Origin,
  // so the browser blocks it. We pass `false` instead of throwing an Error to
  // avoid crashing into Express's default error handler (which returned 500).
  app.use(
    cors({
      origin: (origin, callback) => {
        callback(null, isAllowedOrigin(origin));
      },
    }),
  );
  app.use(express.json({ limit: '10mb' }));

  // Support Chromium Private Network Access (required since Chrome 130+).
  // Without this header, Chrome/Edge/Brave/Arc block public->loopback requests
  // which breaks bridge mode entirely.
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    next();
  });

  // Handle PNA preflight: Chromium sends Access-Control-Request-Private-Network
  // on OPTIONS requests and expects the allow header in the response.
  // Note: the actual Allow-Private-Network header is already set by the global
  // middleware above, so we just need to call next() here.
  app.options('*', (_req, res, next) => {
    next();
  });

  // Initialize MCP backend (multi-repo, shared across all MCP sessions)
  const backend = new LocalBackend();
  await backend.init();
  const cleanupMcp = mountMCPEndpoints(app, backend);
  const jobManager = new JobManager();

  // Shared repo lock — prevents concurrent analyze + embed on the same repo path,
  // which would corrupt LadybugDB (analyze calls closeLbug + initLbug while embed has queries in flight).
  const activeRepoPaths = new Set<string>();

  const acquireRepoLock = (repoPath: string): string | null => {
    if (activeRepoPaths.has(repoPath)) {
      return `Another job is already active for this repository`;
    }
    activeRepoPaths.add(repoPath);
    return null;
  };

  const releaseRepoLock = (repoPath: string): void => {
    activeRepoPaths.delete(repoPath);
  };

  // Helper: resolve a repo by name from the global registry, or default to first
  const resolveRepo = async (repoName?: string) => {
    const repos = await listRegisteredRepos();
    if (repos.length === 0) return null;
    if (repoName) return repos.find((r) => r.name === repoName) || null;
    return repos[0]; // default to first
  };

  // SSE heartbeat — clients connect to detect server liveness instantly.
  // When the server shuts down, the TCP connection drops and the client's
  // EventSource fires onerror immediately (no polling delay).
  app.get('/api/heartbeat', (_req, res) => {
    // Use res.set() instead of res.writeHead() to preserve CORS headers from middleware
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();
    // Send initial ping so the client knows it connected
    res.write(':ok\n\n');

    // Keep-alive ping every 15s to prevent proxy/firewall timeout
    const interval = setInterval(() => res.write(':ping\n\n'), 15_000);

    _req.on('close', () => clearInterval(interval));
  });

  // Server info: version and launch context (npx / global / local dev)
  app.get('/api/info', (_req, res) => {
    const execPath = process.env.npm_execpath ?? '';
    const argv0 = process.argv[1] ?? '';
    let launchContext: 'npx' | 'global' | 'local';
    if (
      execPath.includes('npx') ||
      argv0.includes('_npx') ||
      process.env.npm_config_prefix?.includes('_npx')
    ) {
      launchContext = 'npx';
    } else if (argv0.includes('node_modules')) {
      launchContext = 'local';
    } else {
      launchContext = 'global';
    }
    res.json({ version: pkg.version, launchContext, nodeVersion: process.version });
  });

  // List all registered repos
  app.get('/api/repos', async (_req, res) => {
    try {
      const repos = await listRegisteredRepos();
      res.json(
        repos.map((r) => ({
          name: r.name,
          path: r.path,
          indexedAt: r.indexedAt,
          lastCommit: r.lastCommit,
          stats: r.stats,
        })),
      );
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

  // Delete a repo — removes index, clone dir (if any), and unregisters it
  app.delete('/api/repo', async (req, res) => {
    try {
      const repoName = requestedRepo(req);
      if (!repoName) {
        res.status(400).json({ error: 'Missing repo name' });
        return;
      }
      const entry = await resolveRepo(repoName);
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }

      // Acquire repo lock — prevents deleting while analyze/embed is in flight
      const lockKey = getStoragePath(entry.path);
      const lockErr = acquireRepoLock(lockKey);
      if (lockErr) {
        res.status(409).json({ error: lockErr });
        return;
      }

      try {
        // Close any open LadybugDB handle before deleting files
        try {
          await closeLbug();
        } catch {}

        // 1. Delete the .gitnexus index/storage directory
        const storagePath = getStoragePath(entry.path);
        await fs.rm(storagePath, { recursive: true, force: true }).catch(() => {});

        // 2. Delete the cloned repo dir if it lives under ~/.gitnexus/repos/
        const cloneDir = getCloneDir(entry.name);
        try {
          const stat = await fs.stat(cloneDir);
          if (stat.isDirectory()) {
            await fs.rm(cloneDir, { recursive: true, force: true });
          }
        } catch {
          /* clone dir may not exist (local repos) */
        }

        // 3. Unregister from the global registry
        const { unregisterRepo } = await import('../storage/repo-manager.js');
        await unregisterRepo(entry.path);

        // 4. Reinitialize backend to reflect the removal
        await backend.init().catch(() => {});

        res.json({ deleted: entry.name });
      } finally {
        releaseRepoLock(lockKey);
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to delete repo' });
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
      const lbugPath = path.join(entry.storagePath, 'lbug');
      const includeContent = req.query.includeContent === 'true';
      const stream = req.query.stream === 'true';

      if (stream) {
        const abortController = new AbortController();
        let responseFinished = false;
        const markFinished = () => {
          responseFinished = true;
        };
        const abortStreaming = () => {
          if (!responseFinished) {
            abortController.abort();
          }
        };

        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.flushHeaders();

        req.once('aborted', abortStreaming);
        res.once('finish', markFinished);
        res.once('close', abortStreaming);

        try {
          await withLbugDb(lbugPath, async () =>
            streamGraphNdjson(res, includeContent, abortController.signal),
          );
          if (!abortController.signal.aborted && !res.writableEnded) {
            res.end();
          }
        } finally {
          req.off('aborted', abortStreaming);
          res.off('finish', markFinished);
          res.off('close', abortStreaming);
        }
        return;
      }

      const graph = await withLbugDb(lbugPath, async () => buildGraph(includeContent));
      res.json(graph);
    } catch (err: any) {
      if (err instanceof ClientDisconnectedError) {
        return;
      }
      const message = err.message || 'Failed to build graph';
      if (res.headersSent) {
        try {
          res.write(JSON.stringify({ type: 'error', error: message }) + '\n');
        } catch {
          // Best-effort only after streaming has started.
        }
        res.end();
        return;
      }
      res.status(500).json({ error: message });
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

      if (isWriteQuery(cypher)) {
        res.status(403).json({ error: 'Write queries are not allowed via the HTTP API' });
        return;
      }

      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      const lbugPath = path.join(entry.storagePath, 'lbug');
      const result = await withLbugDb(lbugPath, () => executeQuery(cypher));
      res.json({ result });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Query failed' });
    }
  });

  // Search (supports mode: 'hybrid' | 'semantic' | 'bm25', and optional enrichment)
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
      const lbugPath = path.join(entry.storagePath, 'lbug');
      const parsedLimit = Number(req.body.limit ?? 10);
      const limit = Number.isFinite(parsedLimit)
        ? Math.max(1, Math.min(100, Math.trunc(parsedLimit)))
        : 10;
      const mode: string = req.body.mode ?? 'hybrid';
      const enrich: boolean = req.body.enrich !== false; // default true

      const results = await withLbugDb(lbugPath, async () => {
        let searchResults: any[];

        if (mode === 'semantic') {
          const { isEmbedderReady } = await import('../core/embeddings/embedder.js');
          if (!isEmbedderReady()) {
            return [] as any[];
          }
          const { semanticSearch: semSearch } =
            await import('../core/embeddings/embedding-pipeline.js');
          searchResults = await semSearch(executeQuery, query, limit);
          // Normalize semantic results to HybridSearchResult shape
          searchResults = searchResults.map((r: any, i: number) => ({
            ...r,
            score: r.score ?? 1 - (r.distance ?? 0),
            rank: i + 1,
            sources: ['semantic'],
          }));
        } else if (mode === 'bm25') {
          searchResults = await searchFTSFromLbug(query, limit);
          searchResults = searchResults.map((r: any, i: number) => ({
            ...r,
            rank: i + 1,
            sources: ['bm25'],
          }));
        } else {
          // hybrid (default)
          const { isEmbedderReady } = await import('../core/embeddings/embedder.js');
          if (isEmbedderReady()) {
            const { semanticSearch: semSearch } =
              await import('../core/embeddings/embedding-pipeline.js');
            searchResults = await hybridSearch(query, limit, executeQuery, semSearch);
          } else {
            searchResults = await searchFTSFromLbug(query, limit);
          }
        }

        if (!enrich) return searchResults;

        // Server-side enrichment: add connections, cluster, processes per result
        // Uses parameterized queries to prevent Cypher injection via nodeId
        const validLabel = (label: string): boolean =>
          (NODE_TABLES as readonly string[]).includes(label);

        const enriched = await Promise.all(
          searchResults.slice(0, limit).map(async (r: any) => {
            const nodeId: string = r.nodeId || r.id || '';
            const nodeLabel = nodeId.split(':')[0];
            const enrichment: { connections?: any; cluster?: string; processes?: any[] } = {};

            if (!nodeId || !validLabel(nodeLabel)) return { ...r, ...enrichment };

            // Run connections, cluster, and process queries in parallel
            // Label is validated against NODE_TABLES (compile-time safe identifiers);
            // nodeId uses $nid parameter binding to prevent injection
            const [connRes, clusterRes, procRes] = await Promise.all([
              executePrepared(
                `
              MATCH (n:${nodeLabel} {id: $nid})
              OPTIONAL MATCH (n)-[r1:CodeRelation]->(dst)
              OPTIONAL MATCH (src)-[r2:CodeRelation]->(n)
              RETURN
                collect(DISTINCT {name: dst.name, type: r1.type, confidence: r1.confidence}) AS outgoing,
                collect(DISTINCT {name: src.name, type: r2.type, confidence: r2.confidence}) AS incoming
              LIMIT 1
            `,
                { nid: nodeId },
              ).catch(() => []),
              executePrepared(
                `
              MATCH (n:${nodeLabel} {id: $nid})
              MATCH (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community)
              RETURN c.label AS label, c.description AS description
              LIMIT 1
            `,
                { nid: nodeId },
              ).catch(() => []),
              executePrepared(
                `
              MATCH (n:${nodeLabel} {id: $nid})
              MATCH (n)-[rel:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
              RETURN p.id AS id, p.label AS label, rel.step AS step, p.stepCount AS stepCount
              ORDER BY rel.step
            `,
                { nid: nodeId },
              ).catch(() => []),
            ]);

            if (connRes.length > 0) {
              const row = connRes[0];
              const outgoing = (Array.isArray(row) ? row[0] : row.outgoing || [])
                .filter((c: any) => c?.name)
                .slice(0, 5);
              const incoming = (Array.isArray(row) ? row[1] : row.incoming || [])
                .filter((c: any) => c?.name)
                .slice(0, 5);
              enrichment.connections = { outgoing, incoming };
            }

            if (clusterRes.length > 0) {
              const row = clusterRes[0];
              enrichment.cluster = Array.isArray(row) ? row[0] : row.label;
            }

            if (procRes.length > 0) {
              enrichment.processes = procRes
                .map((row: any) => ({
                  id: Array.isArray(row) ? row[0] : row.id,
                  label: Array.isArray(row) ? row[1] : row.label,
                  step: Array.isArray(row) ? row[2] : row.step,
                  stepCount: Array.isArray(row) ? row[3] : row.stepCount,
                }))
                .filter((p: any) => p.id && p.label);
            }

            return { ...r, ...enrichment };
          }),
        );

        return enriched;
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

      const raw = await fs.readFile(fullPath, 'utf-8');

      // Optional line-range support: ?startLine=10&endLine=50
      // Returns only the requested slice (0-indexed), plus metadata.
      const startLine = req.query.startLine !== undefined ? Number(req.query.startLine) : undefined;
      const endLine = req.query.endLine !== undefined ? Number(req.query.endLine) : undefined;

      if (startLine !== undefined && Number.isFinite(startLine)) {
        const lines = raw.split('\n');
        const start = Math.max(0, startLine);
        const end =
          endLine !== undefined && Number.isFinite(endLine)
            ? Math.min(lines.length, endLine + 1)
            : lines.length;
        res.json({
          content: lines.slice(start, end).join('\n'),
          startLine: start,
          endLine: end - 1,
          totalLines: lines.length,
        });
      } else {
        res.json({ content: raw, totalLines: raw.split('\n').length });
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        res.status(404).json({ error: 'File not found' });
      } else {
        res.status(500).json({ error: err.message || 'Failed to read file' });
      }
    }
  });

  // Grep — regex search across file contents in the indexed repo
  // Uses filesystem-based search for memory efficiency (never loads all files into memory)
  app.get('/api/grep', async (req, res) => {
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      const pattern = req.query.pattern as string;
      if (!pattern) {
        res.status(400).json({ error: 'Missing "pattern" query parameter' });
        return;
      }

      // ReDoS protection: reject overly long or dangerous patterns
      if (pattern.length > 200) {
        res.status(400).json({ error: 'Pattern too long (max 200 characters)' });
        return;
      }

      // Validate regex syntax
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, 'gim');
      } catch {
        res.status(400).json({ error: 'Invalid regex pattern' });
        return;
      }

      const parsedLimit = Number(req.query.limit ?? 50);
      const limit = Number.isFinite(parsedLimit)
        ? Math.max(1, Math.min(200, Math.trunc(parsedLimit)))
        : 50;

      const results: { filePath: string; line: number; text: string }[] = [];
      const repoRoot = path.resolve(entry.path);

      // Get file paths from the graph (lightweight — no content loaded)
      const lbugPath = path.join(entry.storagePath, 'lbug');
      const fileRows = await withLbugDb(lbugPath, () =>
        executeQuery(`MATCH (n:File) WHERE n.content IS NOT NULL RETURN n.filePath AS filePath`),
      );

      // Search files on disk one at a time (constant memory)
      for (const row of fileRows) {
        if (results.length >= limit) break;
        const filePath: string = row.filePath || '';
        const fullPath = path.resolve(repoRoot, filePath);

        // Path traversal guard
        if (!fullPath.startsWith(repoRoot + path.sep) && fullPath !== repoRoot) continue;

        let content: string;
        try {
          content = await fs.readFile(fullPath, 'utf-8');
        } catch {
          continue; // File may have been deleted since indexing
        }

        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (results.length >= limit) break;
          if (regex.test(lines[i])) {
            results.push({ filePath, line: i + 1, text: lines[i].trim().slice(0, 200) });
          }
          regex.lastIndex = 0;
        }
      }

      res.json({ results });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Grep failed' });
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
      res
        .status(statusFromError(err))
        .json({ error: err.message || 'Failed to query process detail' });
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
      res
        .status(statusFromError(err))
        .json({ error: err.message || 'Failed to query cluster detail' });
    }
  });

  // ── Analyze API ──────────────────────────────────────────────────────

  // POST /api/analyze — start a new analysis job
  app.post('/api/analyze', async (req, res) => {
    try {
      const { url: repoUrl, path: repoLocalPath, force, embeddings } = req.body;

      // Input type validation
      if (repoUrl !== undefined && typeof repoUrl !== 'string') {
        res.status(400).json({ error: '"url" must be a string' });
        return;
      }
      if (repoLocalPath !== undefined && typeof repoLocalPath !== 'string') {
        res.status(400).json({ error: '"path" must be a string' });
        return;
      }

      if (!repoUrl && !repoLocalPath) {
        res.status(400).json({ error: 'Provide "url" (git URL) or "path" (local path)' });
        return;
      }

      // Path validation: require absolute path, reject traversal (e.g. /tmp/../etc/passwd)
      if (repoLocalPath) {
        if (!path.isAbsolute(repoLocalPath)) {
          res.status(400).json({ error: '"path" must be an absolute path' });
          return;
        }
        if (path.normalize(repoLocalPath) !== path.resolve(repoLocalPath)) {
          res.status(400).json({ error: '"path" must not contain traversal sequences' });
          return;
        }
      }

      const job = jobManager.createJob({ repoUrl, repoPath: repoLocalPath });

      // If job was already running (dedup), just return its id
      if (job.status !== 'queued') {
        res.status(202).json({ jobId: job.id, status: job.status });
        return;
      }

      // Mark as active synchronously to prevent race with concurrent requests
      jobManager.updateJob(job.id, { status: 'cloning' });

      // Start async work — don't await
      (async () => {
        let targetPath = repoLocalPath;
        try {
          // Clone if URL provided
          if (repoUrl && !repoLocalPath) {
            const repoName = extractRepoName(repoUrl);
            targetPath = getCloneDir(repoName);

            jobManager.updateJob(job.id, {
              status: 'cloning',
              repoName,
              progress: { phase: 'cloning', percent: 0, message: `Cloning ${repoUrl}...` },
            });

            await cloneOrPull(repoUrl, targetPath, (progress) => {
              jobManager.updateJob(job.id, {
                progress: { phase: progress.phase, percent: 5, message: progress.message },
              });
            });
          }

          if (!targetPath) {
            throw new Error('No target path resolved');
          }

          // Acquire shared repo lock (keyed on storagePath to match embed handler)
          const analyzeLockKey = getStoragePath(targetPath);
          const lockErr = acquireRepoLock(analyzeLockKey);
          if (lockErr) {
            jobManager.updateJob(job.id, { status: 'failed', error: lockErr });
            return;
          }

          jobManager.updateJob(job.id, { repoPath: targetPath, status: 'analyzing' });

          // ── Worker fork with auto-retry ──────────────────────────────
          //
          // Forks a child process with 8GB heap. If the worker crashes
          // (OOM, native addon segfault, etc.), it retries up to
          // MAX_WORKER_RETRIES times with exponential backoff before
          // marking the job as permanently failed.
          //
          // In dev mode (tsx), registers the tsx ESM hook via a file://
          // URL so the child can compile TypeScript on-the-fly.

          const MAX_WORKER_RETRIES = 2;
          const callerPath = fileURLToPath(import.meta.url);
          const isDev = callerPath.endsWith('.ts');
          const workerFile = isDev ? 'analyze-worker.ts' : 'analyze-worker.js';
          const workerPath = path.join(path.dirname(callerPath), workerFile);
          const tsxHookArgs: string[] = isDev
            ? ['--import', pathToFileURL(_require.resolve('tsx/esm')).href]
            : [];

          const forkWorker = () => {
            const currentJob = jobManager.getJob(job.id);
            if (!currentJob || currentJob.status === 'complete' || currentJob.status === 'failed')
              return;

            const child = fork(workerPath, [], {
              execArgv: [...tsxHookArgs, '--max-old-space-size=8192'],
              stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            });

            // Capture stderr for crash diagnostics
            let stderrChunks = '';
            child.stderr?.on('data', (chunk: Buffer) => {
              stderrChunks += chunk.toString();
              if (stderrChunks.length > 4096) stderrChunks = stderrChunks.slice(-4096);
            });

            child.on('message', (msg: any) => {
              if (msg.type === 'progress') {
                jobManager.updateJob(job.id, {
                  status: 'analyzing',
                  progress: { phase: msg.phase, percent: msg.percent, message: msg.message },
                });
              } else if (msg.type === 'complete') {
                releaseRepoLock(analyzeLockKey);
                // Reinitialize backend BEFORE marking complete — ensures the new
                // repo is queryable when the client receives the SSE complete event.
                backend
                  .init()
                  .then(() => {
                    jobManager.updateJob(job.id, {
                      status: 'complete',
                      repoName: msg.result.repoName,
                    });
                  })
                  .catch((err) => {
                    console.error('backend.init() failed after analyze:', err);
                    jobManager.updateJob(job.id, {
                      status: 'failed',
                      error: 'Server failed to reload after analysis. Try again.',
                    });
                  });
              } else if (msg.type === 'error') {
                releaseRepoLock(analyzeLockKey);
                jobManager.updateJob(job.id, {
                  status: 'failed',
                  error: msg.message,
                });
              }
            });

            child.on('error', (err) => {
              releaseRepoLock(analyzeLockKey);
              jobManager.updateJob(job.id, {
                status: 'failed',
                error: `Worker process error: ${err.message}`,
              });
            });

            child.on('exit', (code) => {
              const j = jobManager.getJob(job.id);
              if (!j || j.status === 'complete' || j.status === 'failed') return;

              // Worker crashed — attempt retry if under the limit
              if (j.retryCount < MAX_WORKER_RETRIES) {
                j.retryCount++;
                const delay = 1000 * Math.pow(2, j.retryCount - 1); // 1s, 2s
                const lastErr = stderrChunks.trim().split('\n').pop() || '';
                console.warn(
                  `Analyze worker crashed (code ${code}), retry ${j.retryCount}/${MAX_WORKER_RETRIES} in ${delay}ms` +
                    (lastErr ? `: ${lastErr}` : ''),
                );
                jobManager.updateJob(job.id, {
                  status: 'analyzing',
                  progress: {
                    phase: 'retrying',
                    percent: j.progress.percent,
                    message: `Worker crashed, retrying (${j.retryCount}/${MAX_WORKER_RETRIES})...`,
                  },
                });
                stderrChunks = '';
                setTimeout(forkWorker, delay);
              } else {
                // Exhausted retries — permanent failure
                releaseRepoLock(analyzeLockKey);
                jobManager.updateJob(job.id, {
                  status: 'failed',
                  error: `Worker crashed ${MAX_WORKER_RETRIES + 1} times (code ${code})${stderrChunks ? ': ' + stderrChunks.trim().split('\n').pop() : ''}`,
                });
              }
            });

            // Register child for cancellation + timeout tracking
            jobManager.registerChild(job.id, child);

            // Send start command to child
            child.send({
              type: 'start',
              repoPath: targetPath,
              options: { force: !!force, embeddings: !!embeddings },
            });
          };

          forkWorker();
        } catch (err: any) {
          if (targetPath) releaseRepoLock(getStoragePath(targetPath));
          jobManager.updateJob(job.id, {
            status: 'failed',
            error: err.message || 'Analysis failed',
          });
        }
      })();

      res.status(202).json({ jobId: job.id, status: job.status });
    } catch (err: any) {
      if (err.message?.includes('already in progress')) {
        res.status(409).json({ error: err.message });
      } else {
        res.status(500).json({ error: err.message || 'Failed to start analysis' });
      }
    }
  });

  // GET /api/analyze/:jobId — poll job status
  app.get('/api/analyze/:jobId', (req, res) => {
    const job = jobManager.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    res.json({
      id: job.id,
      status: job.status,
      repoUrl: job.repoUrl,
      repoPath: job.repoPath,
      repoName: job.repoName,
      progress: job.progress,
      error: job.error,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
    });
  });

  // GET /api/analyze/:jobId/progress — SSE stream (shared helper)
  mountSSEProgress(app, '/api/analyze/:jobId/progress', jobManager);

  // DELETE /api/analyze/:jobId — cancel a running analysis job
  app.delete('/api/analyze/:jobId', (req, res) => {
    const job = jobManager.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    if (job.status === 'complete' || job.status === 'failed') {
      res.status(400).json({ error: `Job already ${job.status}` });
      return;
    }
    jobManager.cancelJob(req.params.jobId, 'Cancelled by user');
    res.json({ id: job.id, status: 'failed', error: 'Cancelled by user' });
  });

  // ── Embedding endpoints ────────────────────────────────────────────

  const embedJobManager = new JobManager();

  // POST /api/embed — trigger server-side embedding generation
  app.post('/api/embed', async (req, res) => {
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }

      // Check shared repo lock — prevent concurrent analyze + embed on same repo
      const repoLockPath = entry.storagePath;
      const lockErr = acquireRepoLock(repoLockPath);
      if (lockErr) {
        res.status(409).json({ error: lockErr });
        return;
      }

      const job = embedJobManager.createJob({ repoPath: entry.storagePath });
      embedJobManager.updateJob(job.id, {
        repoName: entry.name,
        status: 'analyzing' as any,
        progress: { phase: 'analyzing', percent: 0, message: 'Starting embedding generation...' },
      });

      // 30-minute timeout for embedding jobs (same as analyze jobs)
      const EMBED_TIMEOUT_MS = 30 * 60 * 1000;
      const embedTimeout = setTimeout(() => {
        const current = embedJobManager.getJob(job.id);
        if (current && current.status !== 'complete' && current.status !== 'failed') {
          releaseRepoLock(repoLockPath);
          embedJobManager.updateJob(job.id, {
            status: 'failed',
            error: 'Embedding timed out (30 minute limit)',
          });
        }
      }, EMBED_TIMEOUT_MS);

      // Run embedding pipeline asynchronously
      (async () => {
        try {
          const lbugPath = path.join(entry.storagePath, 'lbug');
          await withLbugDb(lbugPath, async () => {
            const { runEmbeddingPipeline } =
              await import('../core/embeddings/embedding-pipeline.js');
            await runEmbeddingPipeline(executeQuery, executeWithReusedStatement, (p) => {
              embedJobManager.updateJob(job.id, {
                progress: {
                  phase:
                    p.phase === 'ready' ? 'complete' : p.phase === 'error' ? 'failed' : p.phase,
                  percent: p.percent,
                  message:
                    p.phase === 'loading-model'
                      ? 'Loading embedding model...'
                      : p.phase === 'embedding'
                        ? `Embedding nodes (${p.percent}%)...`
                        : p.phase === 'indexing'
                          ? 'Creating vector index...'
                          : p.phase === 'ready'
                            ? 'Embeddings complete'
                            : `${p.phase} (${p.percent}%)`,
                },
              });
            });
          });

          clearTimeout(embedTimeout);
          releaseRepoLock(repoLockPath);
          // Don't overwrite 'failed' if the job was cancelled while the pipeline was running
          const current = embedJobManager.getJob(job.id);
          if (!current || current.status !== 'failed') {
            embedJobManager.updateJob(job.id, { status: 'complete' });
          }
        } catch (err: any) {
          clearTimeout(embedTimeout);
          releaseRepoLock(repoLockPath);
          const current = embedJobManager.getJob(job.id);
          if (!current || current.status !== 'failed') {
            embedJobManager.updateJob(job.id, {
              status: 'failed',
              error: err.message || 'Embedding generation failed',
            });
          }
        }
      })();

      res.status(202).json({ jobId: job.id, status: 'analyzing' });
    } catch (err: any) {
      if (err.message?.includes('already in progress')) {
        res.status(409).json({ error: err.message });
      } else {
        res.status(500).json({ error: err.message || 'Failed to start embedding generation' });
      }
    }
  });

  // GET /api/embed/:jobId — poll embedding job status
  app.get('/api/embed/:jobId', (req, res) => {
    const job = embedJobManager.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    res.json({
      id: job.id,
      status: job.status,
      repoName: job.repoName,
      progress: job.progress,
      error: job.error,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
    });
  });

  // GET /api/embed/:jobId/progress — SSE stream (shared helper)
  mountSSEProgress(app, '/api/embed/:jobId/progress', embedJobManager);

  // DELETE /api/embed/:jobId — cancel embedding job
  app.delete('/api/embed/:jobId', (req, res) => {
    const job = embedJobManager.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    if (job.status === 'complete' || job.status === 'failed') {
      res.status(400).json({ error: `Job already ${job.status}` });
      return;
    }
    embedJobManager.cancelJob(req.params.jobId, 'Cancelled by user');
    res.json({ id: job.id, status: 'failed', error: 'Cancelled by user' });
  });

  // Global error handler — catch anything the route handlers miss
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  // Wrap listen in a promise so errors (EADDRINUSE, EACCES, etc.) propagate
  // to the caller instead of crashing with an unhandled 'error' event.
  await new Promise<void>((resolve, reject) => {
    const server = app.listen(port, host, () => {
      const displayHost = host === '::' || host === '0.0.0.0' ? 'localhost' : host;
      console.log(`GitNexus server running on http://${displayHost}:${port}`);
      resolve();
    });
    server.on('error', (err) => reject(err));

    // Graceful shutdown — close Express + LadybugDB cleanly
    const shutdown = async () => {
      console.log('\nShutting down...');
      server.close();
      jobManager.dispose();
      embedJobManager.dispose();
      await cleanupMcp();
      await closeLbug();
      await backend.disconnect();
      process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
};
