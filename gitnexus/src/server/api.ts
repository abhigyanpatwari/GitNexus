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

const buildGraph = async (tablesToInclude?: string[], enableLogging = false): Promise<{ nodes: GraphNode[]; relationships: GraphRelationship[] }> => {
  const nodes: GraphNode[] = [];
  const tables = tablesToInclude || NODE_TABLES;
  for (const table of tables) {
    try {
      const tableStartTime = Date.now();
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
      const tableEndTime = Date.now();
      if (enableLogging) {
        console.log(`[buildGraph] ${table}: queried ${rows.length} nodes in ${tableEndTime - tableStartTime}ms`);
      }
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
  const relStartTime = Date.now();

  // For summary graph, only include structural relationships
  // CONTAINS: Folder -> File
  // MEMBER_OF: Symbol -> Community (needed for community expansion)
  // STEP_IN_PROCESS: Step -> Process
  const structuralTypes = tablesToInclude ? ['CONTAINS', 'MEMBER_OF', 'STEP_IN_PROCESS'] : null;
  const relQuery = structuralTypes
    ? `MATCH (a)-[r:CodeRelation]->(b) WHERE r.type IN ['${structuralTypes.join("','")}'] RETURN a.id AS sourceId, b.id AS targetId, r.type AS type, r.confidence AS confidence, r.reason AS reason, r.step AS step`
    : `MATCH (a)-[r:CodeRelation]->(b) RETURN a.id AS sourceId, b.id AS targetId, r.type AS type, r.confidence AS confidence, r.reason AS reason, r.step AS step`;

  const relRows = await executeQuery(relQuery);
  const relEndTime = Date.now();
  if (enableLogging) {
    console.log(`[buildGraph] Relationships: queried ${relRows.length} edges in ${relEndTime - relStartTime}ms`);
  }

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
      const lbugPath = path.join(entry.storagePath, 'lbug');
      const graph = await withLbugDb(lbugPath, async () => buildGraph());
      res.json(graph);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to build graph' });
    }
  });

  // Get graph summary (Community, File, Folder, Process, Section only)
  app.get('/api/graph-summary', async (req, res) => {
    const requestStartTime = Date.now();
    console.log('[/api/graph-summary] Request started');
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      const lbugPath = path.join(entry.storagePath, 'lbug');
      const SUMMARY_TABLES = ['Community', 'File', 'Folder', 'Process', 'Section'];
      const graph = await withLbugDb(lbugPath, async () => {
        // Step 1: Build graph (with logging enabled)
        const buildStartTime = Date.now();
        const { nodes, relationships } = await buildGraph(SUMMARY_TABLES, true);
        const buildEndTime = Date.now();
        console.log(`[/api/graph-summary] buildGraph completed: ${nodes.length} nodes, ${relationships.length} edges in ${buildEndTime - buildStartTime}ms`);

        // Step 2: Remove file content from File nodes to reduce response size
        const cleanupStartTime = Date.now();
        let removedContentCount = 0;
        nodes.forEach(node => {
          if (node.label === 'File') {
            const props = node.properties as any;
            if (props.content) {
              delete props.content;
              removedContentCount++;
            }
          }
        });
        const cleanupEndTime = Date.now();
        console.log(`[/api/graph-summary] Removed content from ${removedContentCount} File nodes in ${cleanupEndTime - cleanupStartTime}ms`);

        // Step 3: Skip inter-community aggregation for now (too slow, not essential for initial view)
        // Users can expand communities to see detailed connections
        console.log(`[/api/graph-summary] Skipping cross-community aggregation (not needed for summary view)`);

        console.log(`[/api/graph-summary] Final graph: ${nodes.length} nodes, ${relationships.length} edges`);
        return { nodes, relationships };
      });

      // Step 4: JSON serialization (measured by response time)
      const jsonStartTime = Date.now();
      const jsonStr = JSON.stringify(graph);
      const jsonEndTime = Date.now();
      const jsonSizeMB = (jsonStr.length / 1024 / 1024).toFixed(2);
      console.log(`[/api/graph-summary] JSON serialization: ${jsonSizeMB}MB in ${jsonEndTime - jsonStartTime}ms`);

      const requestEndTime = Date.now();
      console.log(`[/api/graph-summary] Total request time: ${requestEndTime - requestStartTime}ms`);

      res.json(graph);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to build graph summary' });
    }
  });

  // Get community members
  app.get('/api/community-members/:id', async (req, res) => {
    try {
      const communityId = req.params.id;
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      const lbugPath = path.join(entry.storagePath, 'lbug');

      const result = await withLbugDb(lbugPath, async () => {
        // Query member nodes
        const memberQuery = `
          MATCH (n)-[:CodeRelation {type: 'MEMBER_OF'}]->(c:Community {id: '${communityId.replace(/'/g, "''")}'})
          RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine, n.content AS content, labels(n)[0] AS label
        `;

        const memberRows = await executeQuery(memberQuery);
        const nodes: GraphNode[] = memberRows.map(row => ({
          id: row.id,
          label: row.label as GraphNode['label'],
          properties: {
            name: row.name,
            filePath: row.filePath,
            startLine: row.startLine,
            endLine: row.endLine,
            content: row.content
          } as GraphNode['properties']
        }));

        // Get member IDs
        const memberIds = nodes.map(n => n.id);

        if (memberIds.length === 0) {
          return { communityId, nodes: [], relationships: [] };
        }

        // Query internal relationships
        const relQuery = `
          MATCH (a)-[r:CodeRelation]->(b)
          WHERE a.id IN [${memberIds.map(id => `'${id.replace(/'/g, "''")}'`).join(',')}]
            AND b.id IN [${memberIds.map(id => `'${id.replace(/'/g, "''")}'`).join(',')}]
            AND r.type <> 'MEMBER_OF'
          RETURN a.id AS sourceId, b.id AS targetId, r.type AS type, r.confidence AS confidence, r.reason AS reason
        `;

        const relRows = await executeQuery(relQuery);
        const relationships: GraphRelationship[] = relRows.map(row => ({
          id: `${row.sourceId}_${row.type}_${row.targetId}`,
          type: row.type,
          sourceId: row.sourceId,
          targetId: row.targetId,
          confidence: row.confidence,
          reason: row.reason,
          step: null
        }));

        return { communityId, nodes, relationships };
      });

      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to fetch community members' });
    }
  });

  // Get file content by file path
  app.get('/api/file-content', async (req, res) => {
    try {
      const filePath = req.query.path as string;
      if (!filePath) {
        res.status(400).json({ error: 'Missing "path" query parameter' });
        return;
      }

      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      const lbugPath = path.join(entry.storagePath, 'lbug');

      const result = await withLbugDb(lbugPath, async () => {
        const query = `
          MATCH (n:File {filePath: '${filePath.replace(/'/g, "''")}'})
          RETURN n.content AS content
        `;
        const rows = await executeQuery(query);

        if (rows.length === 0) {
          return null;
        }

        return rows[0].content;
      });

      if (result === null) {
        res.status(404).json({ error: 'File not found' });
      } else {
        res.json({ content: result });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to fetch file content' });
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
      const lbugPath = path.join(entry.storagePath, 'lbug');
      const result = await withLbugDb(lbugPath, () => executeQuery(cypher));
      res.json({ result });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Query failed' });
    }
  });

  // Get nodes by IDs (for visualizing query results)
  app.post('/api/nodes-by-ids', async (req, res) => {
    try {
      const nodeIds = req.body.nodeIds as string[];
      if (!nodeIds || !Array.isArray(nodeIds) || nodeIds.length === 0) {
        res.status(400).json({ error: 'Missing or invalid "nodeIds" array' });
        return;
      }

      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      const lbugPath = path.join(entry.storagePath, 'lbug');

      const result = await withLbugDb(lbugPath, async () => {
        // Escape single quotes in node IDs
        const escapedIds = nodeIds.map(id => `'${id.replace(/'/g, "''")}'`);

        // Query nodes by IDs
        const nodeQuery = `
          MATCH (n)
          WHERE n.id IN [${escapedIds.join(',')}]
          RETURN n.id AS id, labels(n)[0] AS label, n.name AS name, n.filePath AS filePath,
                 n.startLine AS startLine, n.endLine AS endLine, n.content AS content,
                 n.heuristicLabel AS heuristicLabel, n.cohesion AS cohesion, n.symbolCount AS symbolCount
        `;

        const nodeRows = await executeQuery(nodeQuery);
        const nodes: GraphNode[] = nodeRows.map(row => ({
          id: row.id,
          label: row.label as GraphNode['label'],
          properties: {
            name: row.name ?? row.heuristicLabel ?? row.id,
            filePath: row.filePath ?? '',
            startLine: row.startLine,
            endLine: row.endLine,
            heuristicLabel: row.heuristicLabel,
            cohesion: row.cohesion,
            symbolCount: row.symbolCount,
          } as GraphNode['properties']
        }));

        // Query relationships between these nodes
        const relQuery = `
          MATCH (a)-[r:CodeRelation]->(b)
          WHERE a.id IN [${escapedIds.join(',')}] AND b.id IN [${escapedIds.join(',')}]
          RETURN a.id AS sourceId, b.id AS targetId, r.type AS type, r.confidence AS confidence, r.reason AS reason, r.step AS step
        `;

        const relRows = await executeQuery(relQuery);
        const relationships: GraphRelationship[] = relRows.map(row => ({
          id: `${row.sourceId}_${row.type}_${row.targetId}`,
          type: row.type,
          sourceId: row.sourceId,
          targetId: row.targetId,
          confidence: row.confidence ?? 1.0,
          reason: row.reason ?? '',
          step: row.step,
        }));

        return { nodes, relationships };
      });

      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to fetch nodes' });
    }
  });

  // Get node neighbors (all connected nodes and relationships)
  app.get('/api/node-neighbors/:id', async (req, res) => {
    try {
      const nodeId = req.params.id;
      if (!nodeId) {
        res.status(400).json({ error: 'Missing node ID' });
        return;
      }

      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      const lbugPath = path.join(entry.storagePath, 'lbug');

      const result = await withLbugDb(lbugPath, async () => {
        const escapedId = nodeId.replace(/'/g, "''");

        // Query all neighbors (both incoming and outgoing)
        const neighborQuery = `
          MATCH (center {id: '${escapedId}'})
          OPTIONAL MATCH (center)-[r1:CodeRelation]->(out)
          OPTIONAL MATCH (in)-[r2:CodeRelation]->(center)
          WITH center,
               collect(DISTINCT out) as outgoing,
               collect(DISTINCT in) as incoming,
               collect(DISTINCT r1) as outRels,
               collect(DISTINCT r2) as inRels
          UNWIND (outgoing + incoming + [center]) as n
          WITH DISTINCT n, outRels, inRels
          RETURN n.id AS id, labels(n)[0] AS label, n.name AS name, n.filePath AS filePath,
                 n.startLine AS startLine, n.endLine AS endLine,
                 n.heuristicLabel AS heuristicLabel, n.cohesion AS cohesion, n.symbolCount AS symbolCount,
                 outRels, inRels
        `;

        const rows = await executeQuery(neighborQuery);

        if (rows.length === 0) {
          return { nodes: [], relationships: [] };
        }

        // Build nodes
        const nodeMap = new Map<string, GraphNode>();
        let allOutRels: any[] = [];
        let allInRels: any[] = [];

        for (const row of rows) {
          if (row.id) {
            nodeMap.set(row.id, {
              id: row.id,
              label: row.label as GraphNode['label'],
              properties: {
                name: row.name ?? row.heuristicLabel ?? row.id,
                filePath: row.filePath ?? '',
                startLine: row.startLine,
                endLine: row.endLine,
                heuristicLabel: row.heuristicLabel,
                cohesion: row.cohesion,
                symbolCount: row.symbolCount,
              } as GraphNode['properties']
            });
          }
          if (row.outRels) allOutRels = allOutRels.concat(row.outRels);
          if (row.inRels) allInRels = allInRels.concat(row.inRels);
        }

        // Build relationships
        const relationships: GraphRelationship[] = [];
        const relSet = new Set<string>();

        const processRel = (rel: any) => {
          if (!rel || !rel.type) return;
          const key = `${rel.sourceId ?? rel.start}_${rel.type}_${rel.targetId ?? rel.end}`;
          if (relSet.has(key)) return;
          relSet.add(key);

          relationships.push({
            id: key,
            type: rel.type,
            sourceId: rel.sourceId ?? rel.start,
            targetId: rel.targetId ?? rel.end,
            confidence: rel.confidence ?? 1.0,
            reason: rel.reason ?? '',
            step: rel.step,
          });
        };

        allOutRels.filter(r => r).forEach(processRel);
        allInRels.filter(r => r).forEach(processRel);

        // Fallback: if Cypher didn't return relationships properly, query them directly
        if (relationships.length === 0) {
          const nodeIds = Array.from(nodeMap.keys());
          const escapedIds = nodeIds.map(id => `'${id.replace(/'/g, "''")}'`);

          const relQuery = `
            MATCH (a)-[r:CodeRelation]->(b)
            WHERE (a.id IN [${escapedIds.join(',')}] OR b.id IN [${escapedIds.join(',')}])
              AND a.id IN [${escapedIds.join(',')}]
              AND b.id IN [${escapedIds.join(',')}]
            RETURN a.id AS sourceId, b.id AS targetId, r.type AS type, r.confidence AS confidence, r.reason AS reason, r.step AS step
          `;

          const relRows = await executeQuery(relQuery);
          relRows.forEach(row => {
            const key = `${row.sourceId}_${row.type}_${row.targetId}`;
            if (!relSet.has(key)) {
              relSet.add(key);
              relationships.push({
                id: key,
                type: row.type,
                sourceId: row.sourceId,
                targetId: row.targetId,
                confidence: row.confidence ?? 1.0,
                reason: row.reason ?? '',
                step: row.step,
              });
            }
          });
        }

        return {
          nodes: Array.from(nodeMap.values()),
          relationships
        };
      });

      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to fetch node neighbors' });
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
