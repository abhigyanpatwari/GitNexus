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
  flushWAL,
  closeLbug,
  withLbugDb,
  isReadOnlyDbError,
} from '../core/lbug/lbug-adapter.js';
import { isValidQueryParams } from '../core/lbug/query-params.js';
import { NODE_TABLES, type GraphNode, type GraphRelationship } from 'gitnexus-shared';
import { searchFTSFromLbug } from '../core/search/bm25-index.js';
import { hybridSearch } from '../core/search/hybrid-search.js';
import { LocalBackend } from '../mcp/local/local-backend.js';
import { mountMCPEndpoints } from './mcp-http.js';
import { fileURLToPath } from 'url';
import { JobManager } from './analyze-job.js';
import { assertString, escapeRegExp, BadRequestError, createRouteLimiter } from './validation.js';
import {
  extractRepoName,
  getCloneDir,
  cloneOrPull,
  warnIfInsecureAzureConfig,
  GITHUB_TOKEN_HOSTS,
} from './git-clone.js';
import { createAnalyzeUploadHandler } from './analyze-upload.js';
import { createLocalhostOriginGuard, normalizeBoundHost } from './middleware.js';
import { createLaunchAnalysisWorker } from './analyze-launch.js';
import { UPLOAD_ROOT } from './upload-paths.js';
import { sweepStaleUploads } from './upload-sweep.js';
import { isRfc1918PrivateIpv4 } from './private-ip.js';
import { logger, flushLoggerSync } from '../core/logger.js';

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

  return isRfc1918PrivateIpv4(hostname);
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

export const SPA_FALLBACK_REGEX = /^(?!\/api(?:\/|$))(?!.*\.\w{1,10}$).*/;

export const resolveWebDistDir = async (
  primaryDir: string,
  fallbackDir: string,
): Promise<string | null> => {
  const envDir = process.env.GITNEXUS_WEB_DIST;
  const dirs = envDir ? [envDir, primaryDir, fallbackDir] : [primaryDir, fallbackDir];
  for (const dir of dirs) {
    try {
      await fs.access(path.join(dir, 'index.html'));
      return dir;
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        logger.warn({ err: err.message }, `[serve] could not access web UI dir ${dir}:`);
      }
    }
  }
  return null;
};

export const landingPageHtml = (): string => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GitNexus</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Outfit,system-ui,-apple-system,sans-serif;background:#06060a;color:#e4e4ed;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5rem}
.card{background:#101018;border:1px solid #2a2a3a;border-radius:0.75rem;padding:2rem;max-width:480px;width:100%}
.logo{font-size:1.5rem;font-weight:700;color:#e4e4ed;letter-spacing:-0.02em;margin-bottom:0.25rem}
.subtitle{font-size:0.875rem;color:#8888a0;margin-bottom:1.5rem}
.section-title{font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:#5a5a70;margin-bottom:0.75rem}
.endpoint{margin:0.25rem 0;font-size:0.875rem}
.endpoint a{color:#7c3aed;text-decoration:none}
.endpoint a:hover{text-decoration:underline}
.endpoint code{background:#16161f;padding:0.15em 0.4em;border-radius:0.25rem;font-size:0.8rem;color:#8888a0}
.divider{height:1px;background:#1e1e2a;margin:1.25rem 0}
.terminal{background:#0a0a10;border:1px solid #1e1e2a;border-radius:0.5rem;padding:0.75rem 1rem;font-family:'SF Mono',SFMono-Regular,Consolas,'Liberation Mono',Menlo,monospace;font-size:0.8rem;color:#8888a0;margin-bottom:1rem;overflow-x:auto}
.terminal .prompt{color:#7c3aed;user-select:none}
.terminal .cmd{color:#e4e4ed}
.link-row{display:flex;align-items:center;gap:0.5rem;font-size:0.875rem;margin-top:0.5rem}
.link-row svg{flex-shrink:0}
a.ext{color:#7c3aed;text-decoration:none;display:inline-flex;align-items:center;gap:0.25rem}
a.ext:hover{text-decoration:underline}
</style>
</head>
<body>
<div class="card">
  <div class="logo">GitNexus</div>
  <div class="subtitle">API server is running</div>
  <div class="section-title">Endpoints</div>
  <p class="endpoint"><a href="/api/info">/api/info</a> <span style="color:#5a5a70">— Server version &amp; context</span></p>
  <p class="endpoint"><a href="/api/repos">/api/repos</a> <span style="color:#5a5a70">— Indexed repositories</span></p>
  <p class="endpoint"><code>/api/health</code> <span style="color:#5a5a70">— Docker/orchestrator healthcheck</span></p>
  <p class="endpoint"><code>/api/heartbeat</code> <span style="color:#5a5a70">— SSE heartbeat</span></p>
  <p class="endpoint"><code>/api/graph</code> <code>/api/query</code> <code>/api/search</code> <span style="color:#5a5a70">— Data</span></p>
  <p class="endpoint"><code>/api/mcp</code> <span style="color:#5a5a70">— MCP over StreamableHTTP</span></p>
  <div class="divider"></div>
  <div class="section-title">Web UI not found</div>
  <div class="terminal"><span class="prompt">$ </span><span class="cmd">cd gitnexus-web &amp;&amp; npm run build</span></div>
  <div class="link-row">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
    <a class="ext" href="https://gitnexus.vercel.app" target="_blank" rel="noopener noreferrer">gitnexus.vercel.app</a>
    <span style="color:#5a5a70">— connects to this server</span>
  </div>
</div>
</body>
</html>`;

export const staticCacheControlSetHeaders = (res: express.Response, filePath: string): void => {
  if (filePath.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-cache');
  } else {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
};

export const registerWebUI = (app: express.Express, staticDir: string | null): void => {
  if (staticDir) {
    app.use(
      express.static(staticDir, {
        setHeaders: staticCacheControlSetHeaders,
      }),
    );
    // ⚠ This must remain the LAST route before the global error handler.
    // The regex excludes /api paths AND paths with file extensions (.js, .css, etc.)
    // so missing assets get real 404s instead of the SPA HTML.
    // Adding routes below this will be unreachable for non-API, non-asset paths.
    // Rate-limited (CodeQL js/missing-rate-limiting): the SPA fallback
    // serves a constant index.html, but the FS access from a route handler
    // is enough to trip the analyzer. The limit is generous (300 rpm/IP =
    // 5 req/s sustained) so that multi-tab browser navigation, prefetch,
    // and service-worker revalidation do not produce 429s for legitimate
    // SPA users. At this rate, real browser navigation is extremely
    // unlikely to hit the limit in practice, so the cosmetic issue of
    // JSON-on-429 to a browser is a low-likelihood path. Content
    // negotiation on the 429 (returning the SPA shell to HTML clients
    // instead of `{ error: '...' }`) would require swapping
    // express-rate-limit's `message` for a `handler` function and is
    // deferred to keep this PR focused on closing the CodeQL alert.
    app.get(SPA_FALLBACK_REGEX, createRouteLimiter({ limit: 300 }), (_req, res) => {
      res.sendFile(path.join(staticDir, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => {
      res.type('html').send(landingPageHtml());
    });
  }
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

export const getNodeQuery = (table: string, includeContent: boolean): string => {
  const tableLabel = quoteNodeTable(table);

  if (table === 'BasicBlock') {
    // Taint/PDG substrate (issue #2080) — BasicBlock has no name/content
    // columns. Project only its declared columns: a default `n.name`
    // projection raises a Ladybug "Cannot find property name" binder error
    // (not matched by isIgnorableGraphQueryError), which would 500 the graph
    // endpoint the moment BasicBlock joins NODE_TABLES, even on an empty table.
    return `MATCH (n:${tableLabel}) RETURN n.id AS id, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine, n.text AS text`;
  }
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
    // `?? ''` keeps NodeProperties.name a `string` even for label rows that
    // project no name/label column (BasicBlock — taint/PDG substrate #2080).
    // Without it, BasicBlock rows carry name:undefined (masked by the cast
    // below) and the web layer (Header search, circles/tree layout) derefs
    // `.name` unguarded → TypeError once M1 emits blocks. `row.text` gives a
    // BasicBlock a sensible fallback name before the empty-string floor.
    name: row.name ?? row.label ?? row.text ?? row[1] ?? '',
    filePath: row.filePath ?? row[2],
    startLine: row.startLine,
    endLine: row.endLine,
    text: row.text,
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
    let jobId: string;
    try {
      jobId = assertString(req.params.jobId, 'jobId');
    } catch (err: any) {
      res.status(err.status ?? 400).json({ error: err.message });
      return;
    }
    const job = jm.getJob(jobId);
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
          const eventJob = jm.getJob(jobId);
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
  // Validation helpers throw BadRequestError / ForbiddenError with a typed
  // .status field — honor it before falling back to message-string matching.
  if (err instanceof BadRequestError) return err.status;
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

/**
 * Handle a GET /api/file request body. Extracted from createServer's route
 * registration so it can be unit-tested without spinning up an HTTP server
 * — calling app.get(...) inside a test triggers CodeQL's
 * js/missing-rate-limiting query, which is appropriate for production
 * route handlers but a false positive for tests of the handler logic.
 *
 * The function takes the express req and res (typed loosely so test code
 * can pass minimal mocks) plus the resolved repo path. All path-traversal
 * containment is done inline at the readFile sink with the canonical
 * path.relative idiom for CodeQL js/path-injection recognition.
 */
export const handleFileRequest = async (
  req: { query: any },
  res: {
    status: (code: number) => { json: (body: any) => void };
    json: (body: any) => void;
  },
  repoPath: string,
): Promise<void> => {
  try {
    // Type-confusion guard — req.query.path is `string | string[] | ParsedQs`.
    // Without this, an attacker could pass `?path=a&path=b` to bypass the
    // length-bound traversal check below (CodeQL js/type-confusion-through-
    // parameter-tampering, same class as the /api/grep critical fix).
    const rawFilePath = req.query.path;
    if (rawFilePath === undefined || rawFilePath === '') {
      res.status(400).json({ error: 'Missing path' });
      return;
    }
    const filePath = assertString(rawFilePath, 'path');

    // Path-injection containment — inline at the sink with the canonical
    // path.relative idiom that CodeQL's js/path-injection sanitizer
    // recognizes. assertSafePath in validation.ts performs the equivalent
    // check, but cross-module helpers are not followed by CodeQL's
    // interprocedural analysis for path-traversal sanitization in JS, so
    // the barrier must be visible inline at the readFile sink.
    const repoRoot = path.resolve(repoPath);
    const fullPath = path.resolve(repoRoot, filePath);
    const fullRel = path.relative(repoRoot, fullPath);
    if (fullRel.startsWith('..') || path.isAbsolute(fullRel)) {
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
      // statusFromError returns err.status for BadRequestError / ForbiddenError
      // (assertString → 400 on array-form ?path=a&path=b; ForbiddenError → 403
      // on traversal). Falls back to 500 for unrecognized failures.
      res.status(statusFromError(err)).json({ error: err.message || 'Failed to read file' });
    }
  }
};

export const handleQueryRequest = async (
  req: express.Request,
  res: express.Response,
  resolveRepo: (repoName?: string) => Promise<{ storagePath: string } | undefined>,
): Promise<void> => {
  try {
    const cypher = req.body.cypher as string;
    if (!cypher) {
      res.status(400).json({ error: 'Missing "cypher" in request body' });
      return;
    }
    const queryParams = req.body.params;
    if (queryParams !== undefined && !isValidQueryParams(queryParams)) {
      res.status(400).json({
        error: '"params" must be a plain object with scalar values (string/number/boolean/null)',
      });
      return;
    }

    const entry = await resolveRepo(requestedRepo(req));
    if (!entry) {
      res.status(404).json({ error: 'Repository not found' });
      return;
    }
    const lbugPath = path.join(entry.storagePath, 'lbug');
    const result = await withLbugDb(lbugPath, () => executePrepared(cypher, queryParams ?? {}), {
      readOnly: true,
    });
    res.json({ result });
  } catch (err: any) {
    if (isReadOnlyDbError(err)) {
      res.status(403).json({ error: 'Write queries are not allowed via the HTTP API' });
      return;
    }
    res.status(500).json({ error: err.message || 'Query failed' });
  }
};

/**
 * Validate the optional `token` field of POST /api/analyze. Returns an
 * { status, error } to send, or null when the token is absent or valid.
 *
 * The token is a GitHub PAT: charset-restricted (blocks CRLF header
 * smuggling), length-bounded (1–256), and bound to github.com using the SAME
 * GITHUB_TOKEN_HOSTS allowlist + hostname parse as resolveGitCredential, so a
 * token the API accepts is exactly the one buildGitEnv will inject — and one
 * it rejects is never sent off github.com.
 *
 * Exported for unit tests (the route validation is otherwise only reachable
 * by booting the server).
 */
export function validateAnalyzeToken(
  repoToken: unknown,
  repoUrl: unknown,
): { status: number; error: string } | null {
  if (repoToken === undefined) return null;
  if (typeof repoToken !== 'string') return { status: 400, error: '"token" must be a string' };
  if (repoToken.length === 0 || repoToken.length > 256)
    return { status: 400, error: '"token" length must be between 1 and 256' };
  if (!/^[A-Za-z0-9._~+/=-]+$/.test(repoToken))
    return { status: 400, error: '"token" contains invalid characters' };
  if (!repoUrl || typeof repoUrl !== 'string')
    return { status: 400, error: '"token" requires "url"' };
  let tokenHost: string;
  try {
    tokenHost = new URL(repoUrl).hostname.toLowerCase();
  } catch {
    return { status: 400, error: '"url" must be a valid URL when "token" is provided' };
  }
  if (!GITHUB_TOKEN_HOSTS.has(tokenHost))
    return { status: 400, error: '"token" is only supported for github.com URLs' };
  return null;
}

export const createServer = async (port: number, host: string = '127.0.0.1') => {
  // Surface a cleartext Azure DevOps PAT config at boot (operators rarely
  // read per-request logs). Warn-only — http:// self-hosted stays supported.
  warnIfInsecureAzureConfig();

  const app = express();
  app.disable('x-powered-by');

  // Trust X-Forwarded-* headers only when the connection comes from the
  // local loopback or RFC1918 private/link-local addresses — exactly the
  // origins the CORS allowlist accepts. Without this, every request behind
  // any reverse proxy / Docker bridge counts as the same `req.ip` and a
  // single user can trip the per-IP rate limiter for everyone.
  //
  // SCOPE: this setting is process-wide. Every middleware and route in this
  // Express app sees req.ip resolved from X-Forwarded-For when the upstream
  // hop is in the trusted set above — not just the rate-limited routes.
  // Future IP-based middleware (audit logging, IP-bound authz) inherits this
  // behavior.
  //
  // CLOUD-DEPLOY CAVEAT: a public cloud LB (AWS ALB, Cloudflare, Fly.io
  // edge, CGNAT 100.64/10) is NOT in the trusted set. In those topologies
  // req.ip will collapse to the LB hop IP for every request and the per-IP
  // rate limiter degrades to per-server. Add an explicit env-var override
  // and document the cloud-deploy story before binding to a non-loopback
  // host in those topologies (tracked as a follow-up; not blocking for the
  // local-bound default).
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');

  // Chromium Private Network Access (required since Chrome 130+). Must run before
  // cors: the cors middleware ends OPTIONS preflight responses, so this header
  // has to be set on res before cors writes the preflight reply.
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    next();
  });

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

  // Same-host origin guard for write routes. Only allows loopback and the
  // server's own bound host — scoped to prevent CSRF from other LAN devices.
  const requireLocalhostOrigin = createLocalhostOriginGuard(host);

  // A wildcard bind (`0.0.0.0`/`::`) has no single host identity for the
  // same-host check, so browser write routes accept only loopback origins.
  // Warn the operator so a remote-access deployment isn't silently write-blocked.
  if (host && normalizeBoundHost(host) === undefined) {
    logger.warn(
      { host },
      `[gitnexus serve] Bound to a wildcard address (${host}); browser write routes ` +
        `accept only loopback origins (localhost/127.0.0.1/[::1]). To allow writes from a ` +
        `specific LAN address, bind --host <that-address> instead of a wildcard.`,
    );
  }

  // No explicit OPTIONS route is registered. The Chromium Private Network
  // Access header is set by the global middleware above (pre-cors), and
  // `cors()` itself handles OPTIONS preflights for every path. Registering a
  // wildcard OPTIONS catchall here would throw under Express 5's stricter
  // path parser (the source of the original startup crash this branch fixed).

  // Initialize MCP backend (multi-repo, shared across all MCP sessions)
  const backend = new LocalBackend();
  await backend.init();
  const cleanupMcp = mountMCPEndpoints(app, backend);
  const jobManager = new JobManager();

  // Backstop: remove any upload staging dirs orphaned by a previous crash.
  void sweepStaleUploads().catch(() => {});

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

  // Launch the analyze worker for an already-resolved repo directory. Shared by
  // the JSON /api/analyze route and the multipart /api/analyze/upload route.
  const launchAnalysisWorker = createLaunchAnalysisWorker({
    jobManager,
    backend,
    acquireRepoLock,
    releaseRepoLock,
  });

  /**
   * Maximum time the hold-queue will wait for an active analysis job to complete.
   * Must stay in sync with the frontend's `fetchRepoInfo({ awaitAnalysis: true })` timeout.
   */
  const HOLD_QUEUE_TIMEOUT_SECS = 300; // 5 minutes

  // Helper: resolve a repo by name from the global registry, or default to first.
  // Pass `req` to enable early exit if the client disconnects during the hold-queue wait.
  const resolveRepo = async (repoName?: string, isRetry = false, req?: any): Promise<any> => {
    const repos = await listRegisteredRepos();
    let found = null;

    // Normalize: if a full path is passed, extract just the basename.
    // e.g. "C:\Users\LENOVO\.gitnexus\repos\todo.txt-cli" -> "todo.txt-cli"
    const normalizedName = repoName ? path.basename(repoName) : undefined;

    if (normalizedName) {
      found =
        repos.find((r) => r.name === normalizedName) ||
        repos.find((r) => r.name.toLowerCase() === normalizedName.toLowerCase()) ||
        null;
    } else if (repos.length > 0) {
      found = repos[0]; // default to first repo
    }

    // If not yet in the registry, check whether a background job is actively cloning or
    // analyzing this repo. Hold the connection open (up to 5 minutes) until it completes.
    // We only wait for in-progress jobs ('queued'|'cloning'|'analyzing') — a 'complete' job
    // whose repo is still missing means the registry sync failed; the fallback below handles it.
    if (!found && normalizedName) {
      const lower = normalizedName.toLowerCase();

      // Track client disconnect to cancel the wait early
      let clientGone = false;
      req?.on('close', () => {
        clientGone = true;
      });

      for (const job of jobManager.listJobs()) {
        const isMatch =
          job.repoName?.toLowerCase() === lower ||
          (job.repoUrl && path.basename(job.repoUrl).replace('.git', '').toLowerCase() === lower) ||
          (job.repoPath && path.basename(job.repoPath).toLowerCase() === lower);

        if (isMatch && ['queued', 'cloning', 'analyzing'].includes(job.status)) {
          if (process.env.DEBUG) {
            // Sanitize user-controlled values to prevent log injection (CodeQL js/log-injection).
            logger.debug(
              {
                jobId: String(job.id).replace(/[\r\n]/g, ' '),
                repoName: String(normalizedName).replace(/[\r\n]/g, ' '),
              },
              '[debug] resolveRepo waiting for active job',
            );
          }
          for (let wait = 0; wait < HOLD_QUEUE_TIMEOUT_SECS; wait++) {
            if (clientGone) return null; // client disconnected — stop polling
            const currentJob = jobManager.getJob(job.id);
            if (!currentJob || currentJob.status === 'failed') break;
            if (currentJob.status === 'complete') {
              await backend.init();
              const freshRepos = await listRegisteredRepos();
              return freshRepos.find((r) => r.name === normalizedName) || null;
            }
            await new Promise((r) => setTimeout(r, 1000));
          }
          // Timed out — signal to the caller with a specific message
          return { __timedOut: true, repoName: normalizedName };
        }
      }
    }

    // Emergency fallback: re-sync the registry to handle Windows file-system race conditions
    // (e.g. registry file not yet flushed after clone completes).
    if (!found && normalizedName && !isRetry) {
      if (process.env.DEBUG) {
        // Sanitize user-controlled values to prevent log injection (CodeQL js/log-injection).
        logger.debug(
          { repoName: String(normalizedName).replace(/[\r\n]/g, ' ') },
          '[debug] resolveRepo 404, triggering deep init',
        );
      }
      await backend.init();
      return await resolveRepo(normalizedName, true, req);
    }

    return found;
  };

  // Lightweight healthcheck for Docker/orchestrator probes (#1147).
  // Returns immediately so container managers do not confuse a long-lived
  // SSE stream with an unhealthy server.
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

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
      const entry = await resolveRepo(requestedRepo(req), false, req);
      if (!entry) {
        res.status(404).json({ error: 'Repository not found. Run: gitnexus analyze' });
        return;
      }
      // Timed out waiting for an active analysis job
      if (entry.__timedOut) {
        res.status(503).json({
          error: `Repository analysis for "${entry.repoName}" is taking longer than expected. Please try again in a moment.`,
        });
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
  // Rate-limited (CodeQL js/missing-rate-limiting): destructive operation
  // doing fs.rm of clone + storage dirs. Default 60 rpm/IP is generous for
  // delete; tighten if abuse is observed.
  app.delete('/api/repo', createRouteLimiter(), requireLocalhostOrigin, async (req, res) => {
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

        // 2. Delete the cloned repo dir if it lives under ~/.gitnexus/repos/.
        // getCloneDir now throws on names that are not filesystem-safe (e.g.
        // local repos registered with names like "my project" or "org/repo").
        // Such repos legitimately have no clone dir, so treat the rejection as
        // "nothing to clean up" rather than letting it fail the delete handler.
        let cloneDir: string | null = null;
        try {
          cloneDir = getCloneDir(entry.name);
        } catch {
          /* repo name not eligible for a clone dir (local repo) */
        }
        if (cloneDir) {
          try {
            const stat = await fs.stat(cloneDir);
            if (stat.isDirectory()) {
              await fs.rm(cloneDir, { recursive: true, force: true });
            }
          } catch {
            /* clone dir may not exist */
          }
        }

        // 2b. Delete the uploaded repo dir if entry.path lives under
        // UPLOAD_ROOT. Drive this off entry.path (not a name-rederived dir) so
        // a same-named clone is never affected.
        const resolvedEntry = path.resolve(entry.path);
        if (resolvedEntry === UPLOAD_ROOT || resolvedEntry.startsWith(UPLOAD_ROOT + path.sep)) {
          await fs.rm(resolvedEntry, { recursive: true, force: true }).catch(() => {});
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
          // Read-only open: /api/graph never writes. Write-mode opens engage
          // LadybugDB's checkpoint machinery (`.shadow` sidecar), which on
          // Windows races with the OS file handle release and trips
          // "Cannot open file ... lbug.shadow - Error 2". See pool-adapter.ts
          // which already opens read-only for the same reason, and the
          // /api/query precedent in PR #1655.
          await withLbugDb(
            lbugPath,
            async () => streamGraphNdjson(res, includeContent, abortController.signal),
            { readOnly: true },
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

      const graph = await withLbugDb(lbugPath, async () => buildGraph(includeContent), {
        readOnly: true,
      });
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
    await handleQueryRequest(req, res, resolveRepo);
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

      const results = await withLbugDb(
        lbugPath,
        async () => {
          let searchResults: any[];
          let ftsAvailable: boolean | undefined;

          if (mode === 'semantic') {
            const { isEmbedderReady } = await import('../core/embeddings/embedder.js');
            if (!isEmbedderReady()) {
              return { searchResults: [] as any[], ftsAvailable: undefined };
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
            const ftsResponse = await searchFTSFromLbug(query, limit);
            ftsAvailable = ftsResponse.ftsAvailable;
            searchResults = ftsResponse.results.map((r: any, i: number) => ({
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
              const ftsResponse = await searchFTSFromLbug(query, limit);
              ftsAvailable = ftsResponse.ftsAvailable;
              searchResults = ftsResponse.results;
            }
          }

          if (!enrich) return { searchResults, ftsAvailable };

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

          return { searchResults: enriched, ftsAvailable };
        },
        { readOnly: true },
      );
      const response: any = { results: results.searchResults ?? results };
      if (results.ftsAvailable === false) {
        response.warning =
          'FTS indexes missing — keyword search degraded. Run: gitnexus analyze --repair-fts (or gitnexus analyze --force) to rebuild indexes.';
      }
      res.json(response);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Search failed' });
    }
  });

  // Read file — with path traversal guard
  // Rate-limited (CodeQL js/missing-rate-limiting): per-request fs.readFile.
  app.get('/api/file', createRouteLimiter(), async (req, res) => {
    const entry = await resolveRepo(requestedRepo(req));
    if (!entry) {
      res.status(404).json({ error: 'Repository not found' });
      return;
    }
    await handleFileRequest(req, res, entry.path);
  });

  // Grep — regex search across file contents in the indexed repo
  // Uses filesystem-based search for memory efficiency (never loads all files into memory)
  // Rate-limited (CodeQL js/missing-rate-limiting): scans every file in
  // the indexed repo per request — heaviest I/O endpoint. Same default 60
  // rpm/IP for now; consider tightening if real-world load shows abuse.
  app.get('/api/grep', createRouteLimiter(), async (req, res) => {
    try {
      const entry = await resolveRepo(requestedRepo(req));
      if (!entry) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      // Type-confusion guard (CodeQL js/type-confusion-through-parameter-tampering):
      // req.query.pattern is `string | string[] | ParsedQs` — without an explicit
      // type check, the `.length` guard below counts array elements instead of
      // characters, allowing arbitrarily long patterns through.
      const rawPattern = req.query.pattern;
      if (rawPattern === undefined) {
        res.status(400).json({ error: 'Missing "pattern" query parameter' });
        return;
      }
      const pattern = assertString(rawPattern, 'pattern');
      if (pattern.length === 0) {
        res.status(400).json({ error: 'Missing "pattern" query parameter' });
        return;
      }

      // Length cap: applies to both literal and regex modes as a defense-in-depth
      // bound against pathological input.
      if (pattern.length > 200) {
        res.status(400).json({ error: 'Pattern too long (max 200 characters)' });
        return;
      }

      // Treat user input as a literal substring in all cases to prevent
      // regex-injection/ReDoS via attacker-controlled regex syntax.
      const effectivePattern = escapeRegExp(pattern);

      // Validate regex syntax (catches both opt-in user regex and any escapeRegExp bug)
      let regex: RegExp;
      try {
        regex = new RegExp(effectivePattern, 'gim');
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
      const fileRows = await withLbugDb(
        lbugPath,
        () =>
          executeQuery(`MATCH (n:File) WHERE n.content IS NOT NULL RETURN n.filePath AS filePath`),
        { readOnly: true },
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
      res.status(statusFromError(err)).json({ error: err.message || 'Grep failed' });
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
  app.post(
    '/api/analyze',
    createRouteLimiter({ limit: 10 }),
    requireLocalhostOrigin,
    async (req, res) => {
      try {
        const {
          url: repoUrl,
          path: repoLocalPath,
          force,
          embeddings,
          dropEmbeddings,
          token: repoToken,
        } = req.body;

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

        // Token: optional, restricted charset to prevent header smuggling
        // (CRLF), bound length, and bound to github.com (see validateAnalyzeToken).
        const tokenError = validateAnalyzeToken(repoToken, repoUrl);
        if (tokenError) {
          res.status(tokenError.status).json({ error: tokenError.error });
          return;
        }

        // Path validation. The previous `normalize !== resolve` guard was inert
        // (both collapse `..` identically) and only false-rejected trailing
        // slashes, so it is dropped. Analyzing a local path the operator names
        // is the tool's intended capability (same as the CLI); the dangerous
        // part was cross-origin reach, which is closed by requireLocalhostOrigin
        // on this route (scoped to the server's own bound host — other LAN
        // devices are NOT trusted). We only require an absolute path here and
        // let the analyze worker surface a clear error if it does not exist.
        // (We do NOT realpath/stat the path in-route: that would be a
        // user-controlled filesystem read — CodeQL js/path-injection — for no
        // security gain.)
        if (repoLocalPath && !path.isAbsolute(repoLocalPath)) {
          res.status(400).json({ error: '"path" must be an absolute path' });
          return;
        }

        const job = jobManager.createJob({ repoUrl, repoPath: repoLocalPath });

        // If job was already running (dedup), just return its id. The token is
        // not part of the dedup identity and is never stored on the job, so a
        // token on THIS request had no effect — the existing job already
        // cloned (or is cloning) with whatever credentials its originating
        // request supplied. Surface `tokenIgnored` so an authenticated caller
        // isn't misled into thinking their PAT took effect on a reused job.
        if (job.status !== 'queued') {
          const body: { jobId: string; status: string; tokenIgnored?: boolean } = {
            jobId: job.id,
            status: job.status,
          };
          if (repoToken !== undefined) body.tokenIgnored = true;
          res.status(202).json(body);
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

              await cloneOrPull(
                repoUrl,
                targetPath,
                (progress) => {
                  jobManager.updateJob(job.id, {
                    progress: { phase: progress.phase, percent: 5, message: progress.message },
                  });
                },
                repoToken ? { token: repoToken } : undefined,
              );
            }

            if (!targetPath) {
              throw new Error('No target path resolved');
            }

            launchAnalysisWorker(job, targetPath, { force, embeddings, dropEmbeddings });
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
    },
  );

  // POST /api/analyze/upload — analyze a browser folder upload.
  // Securely ingests the multipart upload into a sandbox, promotes it to a
  // persistent dir, and analyzes it via the shared job/worker machinery.
  // localhost-only (no cross-origin write reach) + conservative rate limit.
  app.post(
    '/api/analyze/upload',
    createRouteLimiter({ limit: 5 }),
    requireLocalhostOrigin,
    createAnalyzeUploadHandler({
      createJob: (params) => jobManager.createJob(params),
      launch: (job, targetPath, opts) => launchAnalysisWorker(job, targetPath, opts),
      failJob: (jobId, error) => jobManager.updateJob(jobId, { status: 'failed', error }),
    }),
  );

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
  app.delete('/api/analyze/:jobId', requireLocalhostOrigin, (req, res) => {
    const jobId = req.params.jobId as string;
    const job = jobManager.getJob(jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    if (job.status === 'complete' || job.status === 'failed') {
      res.status(400).json({ error: `Job already ${job.status}` });
      return;
    }
    jobManager.cancelJob(jobId, 'Cancelled by user');
    res.json({ id: job.id, status: 'failed', error: 'Cancelled by user' });
  });

  // ── Embedding endpoints ────────────────────────────────────────────

  const embedJobManager = new JobManager();

  // POST /api/embed — trigger server-side embedding generation
  app.post(
    '/api/embed',
    createRouteLimiter({ limit: 20 }),
    requireLocalhostOrigin,
    async (req, res) => {
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
              // Fetch existing content hashes for incremental embedding.
              // Delegated to lbug-adapter which owns the DB query logic and legacy-fallback handling.
              const { fetchExistingEmbeddingHashes } = await import('../core/lbug/lbug-adapter.js');
              const existingEmbeddings = await fetchExistingEmbeddingHashes(executeQuery);
              if (existingEmbeddings && existingEmbeddings.size > 0) {
                console.log(
                  `[embed] ${existingEmbeddings.size} nodes already embedded — incremental run with content-hash comparison`,
                );
              }
              await runEmbeddingPipeline(
                executeQuery,
                executeWithReusedStatement,
                (p) => {
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
                },
                {}, // config: use defaults
                undefined, // skipNodeIds
                undefined, // context
                existingEmbeddings,
              );

              // Flush WAL so subsequent /api/search requests see the new
              // embeddings immediately (#1149). In the CLI path closeLbug()
              // handles this during process exit, but the server keeps the
              // connection open for other routes — a CHECKPOINT is enough.
              await flushWAL();
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
    },
  );

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
  app.delete('/api/embed/:jobId', requireLocalhostOrigin, (req, res) => {
    const jobId = req.params.jobId as string;
    const job = embedJobManager.getJob(jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    if (job.status === 'complete' || job.status === 'failed') {
      res.status(400).json({ error: `Job already ${job.status}` });
      return;
    }
    embedJobManager.cancelJob(jobId, 'Cancelled by user');
    res.json({ id: job.id, status: 'failed', error: 'Cancelled by user' });
  });

  // ── Web UI (served at root) ───────────────────────────────────────

  // Resolve the gitnexus-web dist directory relative to this file's location.
  // In the published package: <pkg>/dist/server/api.js → <pkg>/web/
  // In dev (tsx):            gitnexus/src/server/api.ts → gitnexus-web/dist/
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const webDistDir = path.resolve(__dirname, '..', '..', 'web');
  const devWebDistDir = path.resolve(__dirname, '..', '..', '..', 'gitnexus-web', 'dist');
  const staticDir = await resolveWebDistDir(webDistDir, devWebDistDir);
  registerWebUI(app, staticDir);

  // Global error handler — catch anything the route handlers miss
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err }, 'Unhandled error:');
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

    // Graceful shutdown — close Express + LadybugDB cleanly. Pino's default
    // destination is `sync: false` (buffered); `flushLoggerSync()` before
    // `process.exit` so records emitted during cleanup reach stderr.
    const shutdown = async () => {
      console.log('\nShutting down...');
      server.close();
      jobManager.dispose();
      embedJobManager.dispose();
      await cleanupMcp();
      await closeLbug();
      await backend.disconnect();
      const { flushLoggerSync } = await import('../core/logger.js');
      flushLoggerSync();
      process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);

    // Catch-all crash guards (mirrors startMCPServer in mcp/server.ts).
    // Pino v10's default destination is buffered (`sync: false`) — call
    // `flushLoggerSync()` after logging and before triggering shutdown
    // so the crash record reaches stderr regardless of how cleanup goes.
    // Worker-thread transports (pino-pretty under TTY) handle their own
    // flush on process exit in v10. `pino.final` was removed in v10
    // because the new transport architecture made it unnecessary.
    let shuttingDown = false;
    process.on('uncaughtException', (err) => {
      logger.error({ err }, 'GitNexus uncaughtException');
      flushLoggerSync();
      if (!shuttingDown) {
        shuttingDown = true;
        shutdown().catch(() => {});
      }
    });
    process.on('unhandledRejection', (reason: unknown) => {
      // Availability-first: log the rejection without exiting.
      const err = reason instanceof Error ? reason : new Error(String(reason));
      logger.error({ err }, 'GitNexus unhandledRejection');
    });
  });
};
