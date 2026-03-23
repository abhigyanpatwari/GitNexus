/**
 * HTTP API Server
 *
 * REST API for browser-based clients to query the local .gitnexus/ index.
 * Also hosts the MCP server over StreamableHTTP for remote AI tool access.
 *
 * Security: binds to 127.0.0.1 by default (use --host to override).
 * CORS is restricted to localhost, private/LAN networks, and the deployed site.
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs/promises';
import { loadMeta, listRegisteredRepos } from '../storage/repo-manager.js';
import { executeQuery, closeLbug, withLbugDb } from '../core/lbug/lbug-adapter.js';
import { NODE_TABLES } from '../core/lbug/schema.js';
import { GraphNode, GraphRelationship } from '../core/graph/types.js';
import { searchFTSFromLbug } from '../core/search/bm25-index.js';
import { hybridSearch } from '../core/search/hybrid-search.js';
// Embedding imports are lazy (dynamic import) to avoid loading onnxruntime-node
// at server startup — crashes on unsupported Node ABI versions (#89)
import { LocalBackend } from '../mcp/local/local-backend.js';
import { mountMCPEndpoints } from './mcp-http.js';
import { signToken } from './auth.js';
import { authenticateOptional } from './middleware/authenticate.js';

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
    origin.startsWith('http://localhost:')
    || origin === 'http://localhost'
    || origin.startsWith('http://127.0.0.1:')
    || origin === 'http://127.0.0.1'
    || origin.startsWith('http://[::1]:')
    || origin === 'http://[::1]'
    || origin === 'https://gitnexus.vercel.app'
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
  if (octets.length !== 4 || octets.some(o => !Number.isInteger(o) || o < 0 || o > 255)) {
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

// ---------------------------------------------------------------------------
// T025: Active Agent Work registry (in-memory, no persistence)
// ---------------------------------------------------------------------------

interface AgentWorkEntry {
  agentId: string;
  nodeId: string;
  status: 'reading' | 'writing';
  avatar?: string;
  updatedAt: number;
}

/** Stale timeout: entries older than 30 seconds are removed automatically */
const AGENT_STALE_MS = 30_000;

const activeAgentWork = new Map<string, AgentWorkEntry>();

function getActiveAgents(): AgentWorkEntry[] {
  const now = Date.now();
  for (const [key, entry] of activeAgentWork) {
    if (now - entry.updatedAt > AGENT_STALE_MS) activeAgentWork.delete(key);
  }
  return Array.from(activeAgentWork.values());
}

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

// ── T023: In-memory presence store ─────────────────────────────────────────
// Lightweight, no persistence — presence is ephemeral.

interface PresenceEntry {
  userId: string;
  displayName: string;
  focusedNodeId?: string;
  selectedNodeIds?: string[];
  color: string;
  updatedAt: number;
}

/** Round-robin color palette (8 distinct colors matching the frontend palette). */
const PRESENCE_COLORS = [
  '#f59e0b', '#10b981', '#3b82f6', '#ec4899',
  '#8b5cf6', '#14b8a6', '#f97316', '#6366f1',
];
let _presenceColorIdx = 0;

const presenceStore = new Map<string, PresenceEntry>();

/** Remove entries older than 60 seconds. */
const prunePresence = () => {
  const cutoff = Date.now() - 60_000;
  for (const [id, entry] of presenceStore.entries()) {
    if (entry.updatedAt < cutoff) presenceStore.delete(id);
  }
};

// Run pruning every 30 s to keep the map lean.
setInterval(prunePresence, 30_000);

export const createServer = async (port: number, host: string = '127.0.0.1') => {
  const app = express();

  // CORS: allow localhost, private/LAN networks, and the deployed site.
  // Non-browser requests (curl, server-to-server) have no origin and are allowed.
  app.use(cors({
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) {
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

  // ── Token issuance (dev/local) ──────────────────────────────────────────────
  // In production, replace with proper identity provider integration.
  app.post('/api/token', (req, res) => {
    const { apiKey } = req.body as { apiKey?: string };
    if (!apiKey || apiKey !== process.env.GITNEXUS_API_KEY) {
      res.status(401).json({ error: 'Invalid API key' });
      return;
    }
    const token = signToken('api-client', 'analyst');
    res.json({ token, expiresIn: process.env.GITNEXUS_TOKEN_TTL ?? '24h' });
  });

  // ── T023: Multiplayer Presence ─────────────────────────────────────────────

  /** GET /api/presence — list all non-expired presence entries */
  app.get('/api/presence', authenticateOptional, (_req, res) => {
    prunePresence();
    res.json(Array.from(presenceStore.values()));
  });

  /** POST /api/presence — upsert a presence entry (60s TTL on each upsert) */
  app.post('/api/presence', authenticateOptional, (req, res) => {
    const body = req.body as {
      userId?: string;
      displayName?: string;
      focusedNodeId?: string;
      selectedNodeIds?: string[];
      color?: string;
    };

    if (!body.userId || typeof body.userId !== 'string') {
      res.status(400).json({ error: 'Missing required field: userId' });
      return;
    }
    if (!body.displayName || typeof body.displayName !== 'string') {
      res.status(400).json({ error: 'Missing required field: displayName' });
      return;
    }

    // Reuse the user's existing color on updates; assign a new one on first insert.
    const existing = presenceStore.get(body.userId);
    const color = body.color ?? existing?.color
      ?? PRESENCE_COLORS[(_presenceColorIdx++) % PRESENCE_COLORS.length];

    const entry: PresenceEntry = {
      userId:          body.userId,
      displayName:     body.displayName,
      focusedNodeId:   body.focusedNodeId,
      selectedNodeIds: Array.isArray(body.selectedNodeIds) ? body.selectedNodeIds : undefined,
      color,
      updatedAt: Date.now(),
    };
    presenceStore.set(body.userId, entry);
    res.status(200).json(entry);
  });

  /** DELETE /api/presence/:userId — remove a user's presence entry */
  app.delete('/api/presence/:userId', authenticateOptional, (req, res) => {
    const { userId } = req.params;
    if (presenceStore.has(userId)) {
      presenceStore.delete(userId);
      res.status(204).send();
    } else {
      res.status(404).json({ error: 'Presence entry not found' });
    }
  });

  // List all registered repos

  /** GET /api/swarm-state — list all active agent locks read from .gitnexus/locks/ */
  app.get('/api/swarm-state', authenticateOptional, async (_req, res) => {
    const lockDir = path.join(process.cwd(), '.gitnexus', 'locks');
    let locks: { file: string; agent: string }[] = [];
    try {
      const files = await fs.readdir(lockDir);
      locks = (
        await Promise.all(
          files.map(async f => {
            try {
              const agent = (await fs.readFile(path.join(lockDir, f), 'utf8')).trim() || 'unknown';
              return { file: f.replace(/__/g, '/'), agent };
            } catch {
              return null;
            }
          }),
        )
      ).filter((x): x is { file: string; agent: string } => x !== null);
    } catch {
      // lockDir does not exist yet — return empty array
    }
    res.json({ locks });
  });

  /** POST /api/swarm-state — Broadcast a lock update */
  app.post('/api/swarm-state', authenticateOptional, (req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/repos', authenticateOptional, async (_req, res) => {
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
  app.get('/api/repo', authenticateOptional, async (req, res) => {
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
  app.get('/api/graph', authenticateOptional, async (req, res) => {
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      const lbugPath = path.join(entry.storagePath, 'lbug');
      const graph = await withLbugDb(lbugPath, async () => buildGraph());
      res.json(graph);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to build graph' });
    }
  });

  // Execute Cypher query
  app.post('/api/query', authenticateOptional, async (req, res) => {
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
      const lbugPath = path.join(entry.storagePath, 'lbug');
      const result = await withLbugDb(lbugPath, () => executeQuery(cypher));
      res.json({ result });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Query failed' });
    }
  });

  // Search
  app.post('/api/search', authenticateOptional, async (req, res) => {
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

      const results = await withLbugDb(lbugPath, async () => {
        const { isEmbedderReady } = await import('../core/embeddings/embedder.js');
        if (isEmbedderReady()) {
          const { semanticSearch } = await import('../core/embeddings/embedding-pipeline.js');
          return hybridSearch(query, limit, executeQuery, semanticSearch);
        }
        // FTS-only fallback when embeddings aren't loaded
        return searchFTSFromLbug(query, limit);
      });
      res.json({ results });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Search failed' });
    }
  });

  // Read file — with path traversal guard
  app.get('/api/file', authenticateOptional, async (req, res) => {
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
  app.get('/api/processes', authenticateOptional, async (req, res) => {
    try {
      const result = await backend.queryProcesses(requestedRepo(req));
      res.json(result);
    } catch (err: any) {
      res.status(statusFromError(err)).json({ error: err.message || 'Failed to query processes' });
    }
  });

  // Process detail
  app.get('/api/process', authenticateOptional, async (req, res) => {
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
  app.get('/api/clusters', authenticateOptional, async (req, res) => {
    try {
      const result = await backend.queryClusters(requestedRepo(req));
      res.json(result);
    } catch (err: any) {
      res.status(statusFromError(err)).json({ error: err.message || 'Failed to query clusters' });
    }
  });

  // Cluster detail
  app.get('/api/cluster', authenticateOptional, async (req, res) => {
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

  // ── T025: Active Agent Work endpoints ───────────────────────────────────────

  // GET /api/agents/active — returns JSON array of currently active agent work
  app.get('/api/agents/active', (_req, res) => {
    res.json(getActiveAgents());
  });

  // POST /api/agents/active — register or update an agent's work on a node
  // Body: { agentId: string, nodeId: string, status: 'reading' | 'writing', avatar?: string }
  app.post('/api/agents/active', (req, res) => {
    const { agentId, nodeId, status, avatar } = req.body as {
      agentId?: string;
      nodeId?: string;
      status?: string;
      avatar?: string;
    };
    if (!agentId || !nodeId || (status !== 'reading' && status !== 'writing')) {
      res.status(400).json({ error: 'agentId, nodeId, and status (reading|writing) are required' });
      return;
    }
    activeAgentWork.set(agentId, { agentId, nodeId, status, avatar, updatedAt: Date.now() });
    res.json({ ok: true });
  });

  // DELETE /api/agents/active/:agentId — remove an agent's active work entry
  app.delete('/api/agents/active/:agentId', (req, res) => {
    activeAgentWork.delete(req.params.agentId);
    res.json({ ok: true });
  });

  // ── T016: Historical PR Analysis ────────────────────────────────────────────

  /**
   * GET /api/pr-history/:nodeId
   * Returns all PRs that modified the given code node (by file path).
   * Query params:
   *   - repo: optional repository path override
   */
  app.get('/api/pr-history/:nodeId', authenticateOptional, async (req, res) => {
    const { nodeId } = req.params;
    const { repo } = req.query as { repo?: string };

    try {
      const { execSync } = await import('child_process');
      const repoPath = repo || requestedRepo(req) || process.cwd();

      // Get git log of merge commits that touched this file
      const gitLog = execSync(
        `git log --merges --format="%H|%s|%ai|%an" -- "${nodeId}" 2>/dev/null | head -20`,
        { cwd: repoPath, encoding: 'utf-8' }
      ).trim();

      const prHistory = gitLog
        ? gitLog
            .split('\n')
            .map((line) => {
              const [sha, subject, date, author] = line.split('|');
              // Extract PR number from merge commit message e.g. "Merge pull request #42 from ..."
              const prMatch = subject?.match(/#(\d+)/);
              if (!prMatch) return null;
              return {
                sha: sha?.slice(0, 7),
                prNumber: parseInt(prMatch[1], 10),
                subject,
                date,
                author,
              };
            })
            .filter(Boolean)
        : [];

      res.json({ nodeId, prHistory });
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  /**
   * GET /api/pr-nodes
   * Returns all PR nodes derived from git merge history in the repository.
   * Query params:
   *   - repo: optional repository path override
   *   - limit: max PRs to return (default 50)
   */
  app.get('/api/pr-nodes', authenticateOptional, async (req, res) => {
    const { repo, limit = '50' } = req.query as { repo?: string; limit?: string };

    try {
      const { execSync } = await import('child_process');
      const repoPath = repo || requestedRepo(req) || process.cwd();
      const n = Math.min(parseInt(limit, 10) || 50, 200);

      const gitLog = execSync(
        `git log --merges --format="%H|%s|%ai|%an" -n ${n} 2>/dev/null`,
        { cwd: repoPath, encoding: 'utf-8' }
      ).trim();

      const prNodes = gitLog
        ? gitLog
            .split('\n')
            .map((line) => {
              const [sha, subject, date, author] = line.split('|');
              const prMatch = subject?.match(/#(\d+)/);
              if (!prMatch) return null;
              const prNumber = parseInt(prMatch[1], 10);
              // Strip "Merge pull request #N from owner/branch " prefix for cleaner title
              const title =
                subject
                  ?.replace(/^Merge pull request #\d+ from \S+\s*/, '')
                  .trim() || subject;
              return {
                id: `pr-${prNumber}`,
                label: 'PR' as const,
                properties: {
                  prNumber,
                  title,
                  url: '',
                  sha: sha?.slice(0, 7),
                  mergedAt: date,
                  author,
                  state: 'merged' as const,
                },
              };
            })
            .filter(Boolean)
        : [];

      res.json({ prNodes });
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  /**
   * GET /api/file-pr-map
   * Returns a mapping of file paths to the PR numbers that modified them,
   * derived from recent git merge commits.
   * Query params:
   *   - repo: optional repository path override
   *   - limit: number of recent merge commits to scan (default 10, max 50)
   */
  app.get('/api/file-pr-map', authenticateOptional, async (req, res) => {
    const { repo, limit = '10' } = req.query as { repo?: string; limit?: string };

    try {
      const { execSync } = await import('child_process');
      const repoPath = repo || requestedRepo(req) || process.cwd();
      const n = Math.min(parseInt(limit, 10) || 10, 50);

      const mergeLines = execSync(
        `git log --merges --format="%H|%s" -n ${n} 2>/dev/null`,
        { cwd: repoPath, encoding: 'utf-8' }
      )
        .trim()
        .split('\n')
        .filter(Boolean);

      const fileMap: Record<string, number[]> = {};

      for (const line of mergeLines) {
        const [sha, subject] = line.split('|');
        const prMatch = subject?.match(/#(\d+)/);
        if (!prMatch || !sha) continue;

        const prNumber = parseInt(prMatch[1], 10);
        const files = execSync(
          `git diff-tree --no-commit-id -r --name-only "${sha}" 2>/dev/null`,
          { cwd: repoPath, encoding: 'utf-8' }
        )
          .trim()
          .split('\n')
          .filter(Boolean);

        for (const file of files) {
          if (!fileMap[file]) fileMap[file] = [];
          if (!fileMap[file].includes(prNumber)) {
            fileMap[file].push(prNumber);
          }
        }
      }

      res.json({ fileMap });
    } catch (err: any) {
      res.status(500).json({ error: err.message || String(err) });
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

  // Graceful shutdown — close Express + LadybugDB cleanly
  const shutdown = async () => {
    server.close();
    await cleanupMcp();
    await closeLbug();
    await backend.disconnect();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
};
