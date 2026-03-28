/**
 * Consolidated HTTP client for the GitNexus backend server.
 *
 * Replaces backend.ts, server-connection.ts, and worker HTTP helpers
 * with a single typed module. All graph queries, search, embeddings,
 * and file operations go through this client.
 */

import type { GraphNode, GraphRelationship } from 'gitnexus-shared';

// ── Types ──────────────────────────────────────────────────────────────────

export interface BackendRepo {
  name: string;
  path: string;
  repoPath?: string;          // git HEAD returns "repoPath"; older versions return "path"
  indexedAt: string;
  lastCommit?: string;
  stats?: {
    files?: number;
    nodes?: number;
    edges?: number;
    communities?: number;
    processes?: number;
  };
}

export interface EnrichedSearchResult {
  filePath: string;
  score: number;
  rank?: number;
  sources?: string[];
  nodeId?: string;
  name?: string;
  label?: string;
  startLine?: number;
  endLine?: number;
  // Enrichment (server-side)
  connections?: {
    outgoing: Array<{ name: string; type: string; confidence?: number }>;
    incoming: Array<{ name: string; type: string; confidence?: number }>;
  };
  cluster?: string;
  processes?: Array<{ id: string; label: string; step?: number; stepCount?: number }>;
}

export interface GrepResult {
  filePath: string;
  line: number;
  text: string;
}

export interface JobProgress {
  phase: string;
  percent: number;
  message: string;
}

export interface JobStatus {
  id: string;
  status: 'queued' | 'cloning' | 'analyzing' | 'loading' | 'complete' | 'failed';
  repoUrl?: string;
  repoPath?: string;
  repoName?: string;
  progress: JobProgress;
  error?: string;
  startedAt: number;
  completedAt?: number;
}

export class BackendError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: 'network' | 'server' | 'client' | 'not_found' | 'timeout',
  ) {
    super(message);
    this.name = 'BackendError';
  }
}

// ── SSE Utility ────────────────────────────────────────────────────────────

export interface SSEHandlers<T = unknown> {
  onMessage?: (data: T) => void;
  onComplete?: (data: T) => void;
  onError?: (error: string) => void;
}

/**
 * Generic SSE stream consumer using fetch + ReadableStream.
 * Returns an AbortController to cancel the stream.
 * Automatically reconnects on network drops (up to 3 retries with backoff).
 */
export function streamSSE<T = unknown>(url: string, handlers: SSEHandlers<T>): AbortController {
  const controller = new AbortController();
  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 1_000;

  let lastEventId = '';

  const connect = (retryCount: number) => {
    if (controller.signal.aborted) return;

    (async () => {
      try {
        const headers: Record<string, string> = {};
        if (lastEventId) {
          headers['Last-Event-ID'] = lastEventId;
        }

        const response = await fetch(url, { signal: controller.signal, headers });
        if (!response.ok) {
          handlers.onError?.(`Server returned ${response.status}`);
          return;
        }

        const reader = response.body?.getReader();
        if (!reader) {
          handlers.onError?.('No response body');
          return;
        }

        // Reset retry count on successful connection
        retryCount = 0;

        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          let eventType = 'message';
          for (const line of lines) {
            if (line.startsWith('id: ')) {
              lastEventId = line.slice(4).trim();
              continue;
            }
            if (line.startsWith(':')) {
              // SSE comment (heartbeat) — skip
              continue;
            }
            if (line.startsWith('event: ')) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
              try {
                const parsed = JSON.parse(line.slice(6)) as T;
                if (eventType === 'complete') {
                  handlers.onComplete?.(parsed);
                  return;
                } else if (eventType === 'failed') {
                  const errData = parsed as any;
                  handlers.onError?.(errData?.error || 'Job failed');
                  return;
                } else {
                  handlers.onMessage?.(parsed);
                }
              } catch {
                // Skip malformed JSON
              }
              eventType = 'message';
            }
          }
        }

        // Stream ended without terminal event — try to reconnect
        if (!controller.signal.aborted && retryCount < MAX_RETRIES) {
          setTimeout(() => connect(retryCount + 1), BASE_DELAY_MS * 2 ** retryCount);
        }
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        // Network error — attempt reconnect with backoff
        if (!controller.signal.aborted && retryCount < MAX_RETRIES) {
          setTimeout(() => connect(retryCount + 1), BASE_DELAY_MS * 2 ** retryCount);
        } else {
          handlers.onError?.(err instanceof Error ? err.message : 'Stream error');
        }
      }
    })();
  };

  connect(0);
  return controller;
}

// ── Configuration ──────────────────────────────────────────────────────────

let _backendUrl = 'http://localhost:4747';

export const setBackendUrl = (url: string): void => {
  _backendUrl = url.replace(/\/$/, '');
};

export const getBackendUrl = (): string => _backendUrl;

/**
 * Normalize a user-entered server URL into a base URL suitable for setBackendUrl().
 * Adds protocol if missing, strips trailing slashes, and strips a trailing /api suffix
 * (since all API methods append their own /api/... paths to _backendUrl).
 */
export function normalizeServerUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, '');

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    if (url.startsWith('localhost') || url.startsWith('127.0.0.1')) {
      url = `http://${url}`;
    } else {
      url = `https://${url}`;
    }
  }

  // Strip /api suffix if present — _backendUrl stores the base, not the /api path
  url = url.replace(/\/api$/, '');

  return url;
}

// ── Internal Helpers ───────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 2_000;

const fetchWithTimeout = async (
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> => {
  const controller = new AbortController();
  // Merge external signal if provided
  const externalSignal = init.signal;
  if (externalSignal) {
    externalSignal.addEventListener('abort', () => controller.abort());
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return response;
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      if (externalSignal?.aborted) {
        throw new BackendError('Request aborted', 0, 'network');
      }
      throw new BackendError(`Request to ${url} timed out after ${timeoutMs}ms`, 0, 'timeout');
    }
    if (error instanceof TypeError) {
      throw new BackendError(
        `Network error reaching GitNexus backend at ${_backendUrl}: ${error.message}`,
        0, 'network',
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

const assertOk = async (response: Response): Promise<void> => {
  if (response.ok) return;

  let message = `Backend returned ${response.status} ${response.statusText}`;
  try {
    const body = await response.json();
    if (body && typeof body.error === 'string') {
      message = body.error;
    }
  } catch {
    // Response body was not JSON
  }

  const code = response.status === 404 ? 'not_found'
    : response.status >= 400 && response.status < 500 ? 'client'
    : 'server';
  throw new BackendError(message, response.status, code);
};

const repoParam = (repo?: string): string =>
  repo ? `repo=${encodeURIComponent(repo)}` : '';

// ── API Methods ────────────────────────────────────────────────────────────

/** Server info from /api/info. */
export interface ServerInfo {
  version: string;
  launchContext: 'npx' | 'global' | 'local';
  nodeVersion: string;
}

/** Fetch server info (version, launch context). */
export const fetchServerInfo = async (): Promise<ServerInfo> => {
  const response = await fetchWithTimeout(`${_backendUrl}/api/info`);
  await assertOk(response);
  return response.json() as Promise<ServerInfo>;
};

/**
 * Connect an SSE heartbeat to the backend. Fires `onDisconnect` when the
 * server goes down (after one retry to avoid false positives from transient
 * network hiccups). Returns a cleanup function.
 */
export const connectHeartbeat = (
  onConnect: () => void,
  onDisconnect: () => void,
): (() => void) => {
  let closed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let es: EventSource | null = null;
  let attempt = 0;
  const MAX_RETRIES = 3;

  const connect = () => {
    if (closed) return;
    es = new EventSource(`${_backendUrl}/api/heartbeat`);
    es.onopen = () => { if (!closed) { attempt = 0; onConnect(); } };
    es.onerror = () => {
      es?.close();
      es = null;
      if (closed) return;
      if (attempt < MAX_RETRIES) {
        const delay = 1_000 * Math.pow(2, attempt);
        attempt++;
        retryTimer = setTimeout(connect, delay);
      } else {
        onDisconnect();
      }
    };
  };

  connect();

  return () => {
    closed = true;
    es?.close();
    if (retryTimer) clearTimeout(retryTimer);
  };
};

/** Delete a repo's index and unregister it. */
export const deleteRepo = async (repoName: string): Promise<void> => {
  const response = await fetchWithTimeout(`${_backendUrl}/api/repo?repo=${encodeURIComponent(repoName)}`, {
    method: 'DELETE',
  });
  await assertOk(response);
};

/** Probe the backend. Returns true if reachable. */
export const probeBackend = async (): Promise<boolean> => {
  try {
    const response = await fetchWithTimeout(`${_backendUrl}/api/repos`, {}, PROBE_TIMEOUT_MS);
    return response.status === 200;
  } catch {
    return false;
  }
};

/** Fetch list of indexed repositories. */
export const fetchRepos = async (): Promise<BackendRepo[]> => {
  const response = await fetchWithTimeout(`${_backendUrl}/api/repos`);
  await assertOk(response);
  return response.json() as Promise<BackendRepo[]>;
};

/** Fetch repo metadata. */
export const fetchRepoInfo = async (repo?: string): Promise<BackendRepo> => {
  const url = `${_backendUrl}/api/repo${repo ? `?${repoParam(repo)}` : ''}`;
  const response = await fetchWithTimeout(url);
  await assertOk(response);
  const data = await response.json();
  return { ...data, repoPath: data.repoPath ?? data.path };
};

/** Fetch the graph (nodes + relationships). Content stripped by default. */
export const fetchGraph = async (
  repo?: string,
  opts?: { includeContent?: boolean; signal?: AbortSignal; onProgress?: (downloaded: number, total: number | null) => void },
): Promise<{ nodes: GraphNode[]; relationships: GraphRelationship[] }> => {
  const params = [repoParam(repo), opts?.includeContent ? 'includeContent=true' : ''].filter(Boolean).join('&');
  const url = `${_backendUrl}/api/graph${params ? `?${params}` : ''}`;
  const response = await fetchWithTimeout(url, { signal: opts?.signal }, 60_000);
  await assertOk(response);

  if (!opts?.onProgress || !response.body) {
    return response.json() as Promise<{ nodes: GraphNode[]; relationships: GraphRelationship[] }>;
  }

  // Streaming download with progress
  const contentLength = response.headers.get('Content-Length');
  const total = contentLength ? parseInt(contentLength, 10) : null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let downloaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    downloaded += value.length;
    opts.onProgress(downloaded, total);
  }

  const combined = new Uint8Array(downloaded);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(combined));
};

/** Execute a Cypher query. Returns rows. */
export const runQuery = async (
  cypher: string,
  repo?: string,
): Promise<Record<string, unknown>[]> => {
  const response = await fetchWithTimeout(`${_backendUrl}/api/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cypher, repo }),
  });
  await assertOk(response);
  const body = await response.json();
  return (body.result ?? body) as Record<string, unknown>[];
};

/** Search with optional enrichment and mode selection. */
export const search = async (
  query: string,
  opts?: { limit?: number; mode?: 'hybrid' | 'semantic' | 'bm25'; enrich?: boolean; repo?: string },
): Promise<EnrichedSearchResult[]> => {
  const response = await fetchWithTimeout(`${_backendUrl}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      limit: opts?.limit,
      mode: opts?.mode,
      enrich: opts?.enrich,
      repo: opts?.repo,
    }),
  });
  await assertOk(response);
  const body = await response.json();
  return (body.results ?? []) as EnrichedSearchResult[];
};

/** Grep across file contents in the indexed repo. */
export const grep = async (
  pattern: string,
  repo?: string,
  limit?: number,
): Promise<GrepResult[]> => {
  const params = [
    `pattern=${encodeURIComponent(pattern)}`,
    repoParam(repo),
    limit ? `limit=${limit}` : '',
  ].filter(Boolean).join('&');
  const response = await fetchWithTimeout(`${_backendUrl}/api/grep?${params}`);
  await assertOk(response);
  const body = await response.json();
  return (body.results ?? []) as GrepResult[];
};

/** Result from reading a file, optionally with line range. */
export interface ReadFileResult {
  content: string;
  startLine?: number;
  endLine?: number;
  totalLines: number;
}

/** Read a file's content. Supports optional line range (0-indexed). */
export const readFile = async (
  filePath: string,
  options?: { startLine?: number; endLine?: number; repo?: string },
): Promise<ReadFileResult> => {
  const params = [
    `path=${encodeURIComponent(filePath)}`,
    repoParam(options?.repo),
    options?.startLine !== undefined ? `startLine=${options.startLine}` : '',
    options?.endLine !== undefined ? `endLine=${options.endLine}` : '',
  ].filter(Boolean).join('&');
  const response = await fetchWithTimeout(`${_backendUrl}/api/file?${params}`);
  await assertOk(response);
  return response.json() as Promise<ReadFileResult>;
};

/** Fetch all processes for a repo. */
export const fetchProcesses = async (repo?: string): Promise<unknown> => {
  const response = await fetchWithTimeout(`${_backendUrl}/api/processes${repo ? `?${repoParam(repo)}` : ''}`);
  await assertOk(response);
  return response.json();
};

/** Fetch detail for a single process. */
export const fetchProcessDetail = async (repo: string, name: string): Promise<unknown> => {
  const response = await fetchWithTimeout(
    `${_backendUrl}/api/process?${repoParam(repo)}&name=${encodeURIComponent(name)}`,
  );
  await assertOk(response);
  return response.json();
};

/** Fetch all clusters for a repo. */
export const fetchClusters = async (repo?: string): Promise<unknown> => {
  const response = await fetchWithTimeout(`${_backendUrl}/api/clusters${repo ? `?${repoParam(repo)}` : ''}`);
  await assertOk(response);
  return response.json();
};

/** Fetch detail for a single cluster. */
export const fetchClusterDetail = async (repo: string, name: string): Promise<unknown> => {
  const response = await fetchWithTimeout(
    `${_backendUrl}/api/cluster?${repoParam(repo)}&name=${encodeURIComponent(name)}`,
  );
  await assertOk(response);
  return response.json();
};

// ── Analyze API ────────────────────────────────────────────────────────────

/** Start a server-side analysis job. */
export const startAnalyze = async (
  request: { url?: string; path?: string; force?: boolean; embeddings?: boolean },
): Promise<{ jobId: string; status: string }> => {
  const response = await fetchWithTimeout(`${_backendUrl}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  }, 30_000);
  await assertOk(response);
  return response.json() as Promise<{ jobId: string; status: string }>;
};

/** Poll analysis job status. */
export const getAnalyzeStatus = async (jobId: string): Promise<JobStatus> => {
  const response = await fetchWithTimeout(`${_backendUrl}/api/analyze/${encodeURIComponent(jobId)}`);
  await assertOk(response);
  return response.json() as Promise<JobStatus>;
};

/** Cancel a running analysis job. */
export const cancelAnalyze = async (jobId: string): Promise<void> => {
  const response = await fetchWithTimeout(
    `${_backendUrl}/api/analyze/${encodeURIComponent(jobId)}`,
    { method: 'DELETE' },
  );
  await assertOk(response);
};

/** Stream analysis progress via SSE. */
export const streamAnalyzeProgress = (
  jobId: string,
  onProgress: (progress: JobProgress) => void,
  onComplete: (data: { repoName?: string }) => void,
  onError: (error: string) => void,
): AbortController => {
  return streamSSE<JobProgress>(
    `${_backendUrl}/api/analyze/${encodeURIComponent(jobId)}/progress`,
    {
      onMessage: onProgress,
      onComplete: onComplete as (data: unknown) => void,
      onError,
    },
  );
};

// ── Embed API ──────────────────────────────────────────────────────────────

/** Start server-side embedding generation. */
export const startEmbeddings = async (repo: string): Promise<{ jobId: string; status: string }> => {
  const response = await fetchWithTimeout(`${_backendUrl}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo }),
  }, 30_000);
  await assertOk(response);
  return response.json() as Promise<{ jobId: string; status: string }>;
};

/** Poll embedding job status. */
export const getEmbedStatus = async (jobId: string): Promise<JobStatus> => {
  const response = await fetchWithTimeout(`${_backendUrl}/api/embed/${encodeURIComponent(jobId)}`);
  await assertOk(response);
  return response.json() as Promise<JobStatus>;
};

/** Cancel a running embedding job. */
export const cancelEmbeddings = async (jobId: string): Promise<void> => {
  const response = await fetchWithTimeout(
    `${_backendUrl}/api/embed/${encodeURIComponent(jobId)}`,
    { method: 'DELETE' },
  );
  await assertOk(response);
};

/** Stream embedding progress via SSE. */
export const streamEmbeddingProgress = (
  jobId: string,
  onProgress: (progress: JobProgress) => void,
  onComplete: (data: { repoName?: string }) => void,
  onError: (error: string) => void,
): AbortController => {
  return streamSSE<JobProgress>(
    `${_backendUrl}/api/embed/${encodeURIComponent(jobId)}/progress`,
    {
      onMessage: onProgress,
      onComplete: onComplete as (data: unknown) => void,
      onError,
    },
  );
};

// ── Convenience: connect to server ─────────────────────────────────────────

export interface ConnectResult {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  repoInfo: BackendRepo;
}

/**
 * Connect to a server: validate, fetch repo info, download graph.
 * Content is NOT included (use readFile/grep for file access).
 */
export async function connectToServer(
  url: string,
  onProgress?: (phase: string, downloaded: number, total: number | null) => void,
  signal?: AbortSignal,
  repoName?: string,
): Promise<ConnectResult> {
  const baseUrl = normalizeServerUrl(url);
  setBackendUrl(baseUrl);

  onProgress?.('validating', 0, null);
  const repoInfo = await fetchRepoInfo(repoName);

  onProgress?.('downloading', 0, null);
  const { nodes, relationships } = await fetchGraph(repoName, {
    signal,
    onProgress: (downloaded, total) => onProgress?.('downloading', downloaded, total),
  });

  return { nodes, relationships, repoInfo };
}
