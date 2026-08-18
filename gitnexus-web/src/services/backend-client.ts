/**
 * Consolidated HTTP client for the GitNexus backend server.
 *
 * Replaces backend.ts, server-connection.ts, and worker HTTP helpers
 * with a single typed module. All graph queries, search, embeddings,
 * and file operations go through this client.
 */

import type { GraphNode, GraphRelationship } from 'gitnexus-shared';
import { CircuitOpenError, ResilientFetchExhaustedError, resilientFetch } from 'gitnexus-shared';
import {
  AUTH_TOKEN_STORAGE_KEY,
  LARGE_GRAPH_NODE_THRESHOLD,
  LARGE_GRAPH_EDGE_THRESHOLD,
} from '../config/ui-constants';
import { decideSkipGraph } from '../lib/graph-load-decision';

// ── Types ──────────────────────────────────────────────────────────────────

export interface BackendRepo {
  name: string;
  path: string;
  repoPath?: string; // git HEAD returns "repoPath"; older versions return "path"
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

/**
 * Canonical repo identity: the registry path. The display `name` is ambiguous
 * across duplicate repo names (#2419); `repoPath` is the normalized field and
 * `path` the legacy list-endpoint field.
 */
export const repoIdentity = (repo: BackendRepo): string => repo.repoPath ?? repo.path ?? repo.name;

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
    public readonly code:
      | 'network'
      | 'server'
      | 'client'
      | 'not_found'
      | 'source_unavailable'
      | 'timeout'
      | 'rate_limited'
      // The write-route same-host Origin guard rejected this request (HTTP 403
      // with `{ code: 'origin_not_allowed' }`). Distinct from a generic `client`
      // 403 so the UI can show actionable "open the local UI" guidance.
      | 'origin_blocked'
      // The public edge rejected this request for a missing or wrong deploy
      // access token (HTTP 401 with `{ code: 'unauthorized' }`). Distinct from a
      // generic `client` 4xx so the UI can prompt for the token instead of
      // showing a raw error.
      | 'unauthorized',
    /**
     * Milliseconds until the caller should retry. Populated for rate-limited
     * responses (HTTP 429) from the server's `Retry-After` header. `undefined`
     * for every other code, including `client` errors that aren't 429.
     */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'BackendError';
  }
}

/**
 * Thrown by the graph stream parser when the streamed node/relationship count
 * crosses the size limit mid-download (#2178). It is the backstop for the case
 * pre-fetch stats can't cover (absent/stale `stats.nodes`/`stats.edges` on a
 * genuinely large repo). `connectToServer` catches it and falls into chat-only
 * mode instead of letting the full graph hang the browser.
 */
export class GraphTooLargeError extends Error {
  constructor(
    message: string,
    public readonly nodeCount: number,
    public readonly relationshipCount: number,
  ) {
    super(message);
    this.name = 'GraphTooLargeError';
  }
}

// ── SSE Utility ────────────────────────────────────────────────────────────

export interface SSEHandlers<T = unknown> {
  onMessage?: (data: T) => void;
  onComplete?: (data: T) => void;
  onError?: (error: string) => void;
  /** Fires on every successful (re)connection, once the stream is readable. */
  onOpen?: () => void;
  /**
   * Fires each time a reconnect is scheduled after a drop. Callers that want
   * "notify once per outage" dedupe on their side, resetting in `onOpen`.
   */
  onReconnecting?: () => void;
}

export interface SSEOptions {
  /** Reconnect attempts after a drop. `Infinity` for an indefinite stream. Default 3. */
  maxRetries?: number;
  /** First backoff delay; doubles per attempt. Default 1000ms. */
  baseDelayMs?: number;
  /** Upper bound on the doubling backoff. Default unbounded. */
  capDelayMs?: number;
  /**
   * Reconnect on a non-OK HTTP response as well as on a network drop. Off by
   * default: a job-progress stream that 4xx's is a real, terminal error the
   * caller has to see. A long-lived liveness stream turns it on, so a 401 from
   * the edge's token gate resolves itself once a token is entered.
   */
  retryOnHttpError?: boolean;
}

/**
 * Generic SSE stream consumer using fetch + ReadableStream.
 * Returns an AbortController to cancel the stream.
 * Automatically reconnects on network drops (up to `maxRetries` with backoff).
 *
 * fetch-based rather than `EventSource` because `EventSource` cannot send
 * custom headers, and every `/api/*` request needs the `Authorization` header
 * to clear the public edge's token gate.
 */
export function streamSSE<T = unknown>(
  url: string,
  handlers: SSEHandlers<T>,
  options: SSEOptions = {},
): AbortController {
  const controller = new AbortController();
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1_000;
  const capDelayMs = options.capDelayMs ?? Infinity;

  let lastEventId = '';

  /** Schedule the next attempt. Returns false when the budget is spent. */
  const scheduleRetry = (retryCount: number): boolean => {
    if (controller.signal.aborted || retryCount >= maxRetries) return false;
    handlers.onReconnecting?.();
    setTimeout(() => connect(retryCount + 1), Math.min(baseDelayMs * 2 ** retryCount, capDelayMs));
    return true;
  };

  const connect = (retryCount: number) => {
    if (controller.signal.aborted) return;

    (async () => {
      try {
        const headers = withAuthHeader(new Headers());
        if (lastEventId) {
          headers.set('Last-Event-ID', lastEventId);
        }

        const response = await fetch(url, { signal: controller.signal, headers });
        if (!response.ok) {
          if (options.retryOnHttpError && scheduleRetry(retryCount)) return;
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
        handlers.onOpen?.();

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
        scheduleRetry(retryCount);
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        // Network error — attempt reconnect with backoff
        if (!scheduleRetry(retryCount)) {
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

/**
 * Validate that a backend URL is a safe http:// or https:// origin before
 * storing it as the fetch target base (CodeQL js/client-side-request-forgery).
 *
 * Throws if the URL uses a non-HTTP scheme (e.g. javascript:, data:, file://).
 * All other well-formed http/https URLs are accepted — the client intentionally
 * supports connecting to remote GitNexus servers, not just localhost.
 */
export function validateBackendUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Do not echo raw input — it may contain credentials.
    throw new Error('Invalid backend URL: must be a well-formed http:// or https:// URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    // Use parsed.protocol only (scheme), not the full URL, to avoid leaking credentials.
    throw new Error(`Backend URL must use http:// or https:// (got ${parsed.protocol})`);
  }
}

export const setBackendUrl = (url: string): void => {
  const trimmed = url.replace(/\/$/, '');
  validateBackendUrl(trimmed);
  _backendUrl = trimmed;
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

// ── Access token ───────────────────────────────────────────────────────────

/**
 * Deploy access token, sent as `Authorization: Bearer <token>` on every
 * `/api/*` request. `''` when the deploy has no gate, which is a valid state;
 * `null` means "not yet read from storage". See AUTH_TOKEN_STORAGE_KEY for why
 * sessionStorage and why a header rather than a cookie.
 */
let _authToken: string | null = null;

const readStoredAuthToken = (): string => {
  try {
    if (typeof sessionStorage === 'undefined') return '';
    return sessionStorage.getItem(AUTH_TOKEN_STORAGE_KEY) ?? '';
  } catch {
    // Storage can throw in private browsing modes — treat as no token.
    return '';
  }
};

/** The current access token, or `''` when the deploy is ungated. */
export const getAuthToken = (): string => {
  if (_authToken === null) {
    _authToken = readStoredAuthToken();
  }
  return _authToken;
};

/**
 * Store the access token for this browser session. A whitespace-only token
 * clears it, which is how the header is disabled for an ungated local backend.
 */
export const setAuthToken = (token: string): void => {
  const trimmed = token.trim();
  _authToken = trimmed;
  try {
    if (typeof sessionStorage === 'undefined') return;
    if (trimmed) {
      sessionStorage.setItem(AUTH_TOKEN_STORAGE_KEY, trimmed);
    } else {
      sessionStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
    }
  } catch (error) {
    // Persist failure is non-fatal: the in-memory token still authorizes this
    // tab's requests. Log the failure, never the token.
    console.warn('Failed to persist the GitNexus access token to sessionStorage:', error);
  }
};

/**
 * Add `Authorization` to a header set, in place. With no token the header is
 * omitted rather than sent empty: an empty credential is malformed, not absent.
 */
const withAuthHeader = (headers: Headers): Headers => {
  const token = getAuthToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return headers;
};

// ── Internal Helpers ───────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 2_000;

/** Idempotent HTTP methods. Other verbs (POST, PATCH, PUT, DELETE) get
 *  a single-attempt retry budget by default to avoid duplicate side
 *  effects on retry — a POST that 5xx'd may have already executed
 *  server-side. Callers that have idempotency keys or otherwise know
 *  their mutation is safe to retry can opt in via `forceRetry`. */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const fetchWithTimeout = async (
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  /**
   * Force a retry budget on non-idempotent methods. Default false.
   * Pass true only when the endpoint is known-idempotent (e.g. DELETE
   * of a known-deleted resource — second call is a 404 / no-op) AND
   * the duplicate-side-effect window is acceptable.
   */
  forceRetry = false,
): Promise<Response> => {
  // Merge the external caller signal (if any) with an
  // `AbortSignal.timeout()` so a timer-fired abort produces a
  // `DOMException` with `name === 'TimeoutError'`. Both shapes are
  // breaker-safe: `resilientFetch` classifies TimeoutError AND a manual
  // `AbortController.abort()`'s AbortError as terminal-network (no
  // retry, breaker-neutral via recordNeutral), so caller-driven
  // cancellation never penalizes the breaker.
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const externalSignal = init.signal;
  const signal = externalSignal ? AbortSignal.any([timeoutSignal, externalSignal]) : timeoutSignal;

  // Single chokepoint for the deploy access token — every REST call routes
  // through here. `Headers` rather than an object spread because callers pass
  // their own `headers` (e.g. `Content-Type: application/json`) and a spread
  // would drop one side or the other depending on ordering.
  const headers = withAuthHeader(new Headers(init.headers));

  const method = (init.method ?? 'GET').toUpperCase();
  const isIdempotent = IDEMPOTENT_METHODS.has(method);
  const maxAttempts = isIdempotent || forceRetry ? 2 : 1;

  // Key the breaker by the current backend origin so switching backend
  // URLs (e.g. recovering from a flapping local server by pointing at
  // a different host) gives the new origin a fresh breaker state. A
  // single shared `'web-backend'` key would otherwise leave a user
  // locked out for the full cooldown after one bad host trips the
  // circuit. The malformed-URL fallback is defensive — `setBackendUrl`
  // normalizes input, so this branch shouldn't fire in practice.
  let breakerKey: string;
  try {
    breakerKey = `web-backend:${new URL(_backendUrl).origin}`;
  } catch {
    breakerKey = 'web-backend:invalid';
  }

  try {
    // Bounded retries + 5xx/429 handling are delegated to resilientFetch.
    // Method-aware budget: idempotent verbs retry once on transient
    // backend failures; mutations (POST/PATCH/PUT/DELETE) default to
    // single-attempt to avoid duplicate side effects.
    const response = await resilientFetch(
      url,
      { ...init, headers, signal },
      {
        breakerKey,
        retry: { maxAttempts, baseDelayMs: 250, capDelayMs: 1500 },
      },
    );
    return response;
  } catch (error: unknown) {
    if (error instanceof CircuitOpenError) {
      throw new BackendError(
        `GitNexus backend at ${_backendUrl} is unhealthy; retry in ${Math.ceil(error.retryAfterMs / 1000)}s`,
        0,
        'network',
      );
    }
    if (error instanceof ResilientFetchExhaustedError) {
      // Fall through to caller — surface the raw response so assertOk
      // can craft the BackendError with the right code.
      return error.response;
    }
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new BackendError(`Request to ${url} timed out after ${timeoutMs}ms`, 0, 'timeout');
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
      // External caller-driven cancellation — `timeoutSignal` would
      // have surfaced as TimeoutError above, so this branch covers
      // only the externally-aborted case.
      throw new BackendError('Request aborted', 0, 'network');
    }
    if (error instanceof TypeError) {
      throw new BackendError(
        `Network error reaching GitNexus backend at ${_backendUrl}: ${error.message}`,
        0,
        'network',
      );
    }
    throw error;
  }
};

const assertOk = async (response: Response): Promise<void> => {
  if (response.ok) return;

  let message = response.statusText;
  let bodyCode: string | undefined;
  try {
    const body = await response.json();
    if (body && typeof body.error === 'string') {
      message = body.error;
    } else if (body && typeof body.message === 'string') {
      message = body.message;
    }
    if (body && typeof body.code === 'string') {
      bodyCode = body.code;
    }
  } catch {
    // Response body was not JSON
  }

  const code =
    bodyCode === 'source-unavailable'
      ? 'source_unavailable'
      : response.status === 404
        ? 'not_found'
        : response.status === 429
          ? 'rate_limited'
          : // The public edge's token gate returns 401 with this discriminator;
            // surface it as a distinct code so the UI can prompt for the token.
            bodyCode === 'unauthorized'
            ? 'unauthorized'
            : // The write-route Origin guard returns 403 with this discriminator;
              // surface it as a distinct code so the UI can give actionable guidance.
              bodyCode === 'origin_not_allowed'
              ? 'origin_blocked'
              : response.status >= 400 && response.status < 500
                ? 'client'
                : 'server';

  // Retry-After is the standard HTTP signal for when the client may try again.
  // express-rate-limit emits it on 429 with seconds (integer) or HTTP-date.
  // We accept both shapes; an unparseable header yields undefined retryAfterMs.
  let retryAfterMs: number | undefined;
  if (response.status === 429) {
    const header = response.headers.get('retry-after');
    if (header) {
      const seconds = Number(header);
      if (Number.isFinite(seconds) && seconds >= 0) {
        retryAfterMs = seconds * 1000;
      } else {
        const dateMs = Date.parse(header);
        if (Number.isFinite(dateMs)) {
          retryAfterMs = Math.max(0, dateMs - Date.now());
        }
      }
    }
  }

  throw new BackendError(message, response.status, code, retryAfterMs);
};

const repoParam = (repo?: string): string => (repo ? `repo=${encodeURIComponent(repo)}` : '');

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

const HEARTBEAT_MAX_BACKOFF_MS = 15_000;

/**
 * Connect an SSE heartbeat to the backend. Retries indefinitely with capped
 * exponential backoff so transient hiccups don't reset the UI.
 *
 * - `onConnect` fires on every successful (re)connection.
 * - `onReconnecting` fires on the first retry after a drop — use it to show
 *   a "reconnecting" banner while keeping the current view intact.
 *
 * Runs on `streamSSE` rather than `EventSource`: `EventSource` cannot send
 * custom headers, so it can't clear the edge's token gate, and the heartbeat
 * would 401 forever on a gated deploy. `streamSSE` reconnects on a non-OK
 * response here (`retryOnHttpError`), so a 401 recovers on its own once the
 * user enters a token instead of needing a page reload.
 *
 * Returns a cleanup function that aborts the stream and its pending retry.
 */
export const connectHeartbeat = (
  onConnect: () => void,
  onReconnecting: () => void,
): (() => void) => {
  /** Whether we've already fired onReconnecting for the current drop. */
  let notifiedReconnecting = false;

  const controller = streamSSE(
    `${_backendUrl}/api/heartbeat`,
    {
      onOpen: () => {
        notifiedReconnecting = false;
        onConnect();
      },
      onReconnecting: () => {
        if (notifiedReconnecting) return;
        notifiedReconnecting = true;
        onReconnecting();
      },
    },
    {
      maxRetries: Infinity,
      capDelayMs: HEARTBEAT_MAX_BACKOFF_MS,
      retryOnHttpError: true,
    },
  );

  return () => controller.abort();
};

/** Delete a repo's index and unregister it. */
export const deleteRepo = async (repoName: string): Promise<void> => {
  const response = await fetchWithTimeout(
    `${_backendUrl}/api/repo?repo=${encodeURIComponent(repoName)}`,
    {
      method: 'DELETE',
    },
  );
  await assertOk(response);
};

/**
 * Outcome of a backend probe. A single value rather than a pair of booleans,
 * so "reachable and gated at the same time" cannot be represented:
 * - `ok` — answered 200, reachable and authorized.
 * - `unauthorized` — the public edge rejected the probe for a missing or wrong
 *   access token (401). The deploy is up; the fix is to enter a token, not to
 *   start a server.
 * - `unreachable` — no usable answer: a transport failure, a timeout, or any
 *   other status.
 */
export type BackendProbeStatus = 'ok' | 'unauthorized' | 'unreachable';

/**
 * Probe the backend, distinguishing "not there" from "there but gated".
 * Never throws — a probe failure is a state, not an error.
 */
export const probeBackendStatus = async (): Promise<BackendProbeStatus> => {
  try {
    const response = await fetchWithTimeout(`${_backendUrl}/api/repos`, {}, PROBE_TIMEOUT_MS);
    if (response.status === 200) return 'ok';
    return response.status === 401 ? 'unauthorized' : 'unreachable';
  } catch {
    return 'unreachable';
  }
};

/** Fetch list of indexed repositories. */
export const fetchRepos = async (): Promise<BackendRepo[]> => {
  const response = await fetchWithTimeout(`${_backendUrl}/api/repos`);
  await assertOk(response);
  const repos = (await response.json()) as BackendRepo[];
  return repos.map((r) => ({ ...r, repoPath: r.repoPath ?? r.path }));
};

/** Fetch repo metadata.
 * Pass `awaitAnalysis: true` when connecting to a repo that may still be cloning/analyzing —
 * this enables the backend's hold-queue and uses a 5-minute timeout to match.
 * Normal calls (e.g. repo switching between already-indexed repos) use the default 10s timeout.
 *
 * Must stay in sync with HOLD_QUEUE_TIMEOUT_SECS in gitnexus/src/server/api.ts.
 */
const HOLD_QUEUE_TIMEOUT_MS = 300_000; // 5 minutes — matches backend HOLD_QUEUE_TIMEOUT_SECS

export const fetchRepoInfo = async (
  repo?: string,
  opts?: { awaitAnalysis?: boolean },
): Promise<BackendRepo> => {
  const url = `${_backendUrl}/api/repo${repo ? `?${repoParam(repo)}` : ''}`;
  const timeout = opts?.awaitAnalysis ? HOLD_QUEUE_TIMEOUT_MS : undefined;
  const response = await fetchWithTimeout(url, {}, timeout);
  await assertOk(response);
  const data = await response.json();
  return { ...data, repoPath: data.repoPath ?? data.path };
};

/** Fetch the graph (nodes + relationships). Content stripped by default.
 * `maxNodes`/`maxEdges` arm a streaming circuit breaker (#2178): if the streamed
 * count crosses either limit, the download aborts with a GraphTooLargeError
 * instead of materializing a graph that would hang the browser. Off by default. */
export const fetchGraph = async (
  repo?: string,
  opts?: {
    includeContent?: boolean;
    signal?: AbortSignal;
    onProgress?: (downloaded: number, total: number | null) => void;
    maxNodes?: number;
    maxEdges?: number;
  },
): Promise<{ nodes: GraphNode[]; relationships: GraphRelationship[] }> => {
  const params = [repoParam(repo), opts?.includeContent ? 'includeContent=true' : '', 'stream=true']
    .filter(Boolean)
    .join('&');
  const url = `${_backendUrl}/api/graph${params ? `?${params}` : ''}`;
  // Large repos can take a while to serialize the graph — use an elevated timeout
  const response = await fetchWithTimeout(url, { signal: opts?.signal }, 120_000);
  await assertOk(response);

  const contentType = response.headers.get('Content-Type') || '';
  if (contentType.includes('application/x-ndjson')) {
    return parseNdjsonGraphResponse(response, opts?.onProgress, opts?.maxNodes, opts?.maxEdges);
  }

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

const parseNdjsonGraphResponse = async (
  response: Response,
  onProgress?: (downloaded: number, total: number | null) => void,
  maxNodes?: number,
  maxEdges?: number,
): Promise<{ nodes: GraphNode[]; relationships: GraphRelationship[] }> => {
  if (!response.body) {
    throw new BackendError('No response body', response.status, 'server');
  }

  const contentLength = response.headers.get('Content-Length');
  const total = contentLength ? parseInt(contentLength, 10) : null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const nodes: GraphNode[] = [];
  const relationships: GraphRelationship[] = [];
  let buffer = '';
  let downloaded = 0;

  // Streaming circuit breaker (#2178): enforce the size limits mid-download as a
  // backstop when pre-fetch stats were missing. Same `> threshold` comparison as
  // decideSkipGraph. Throwing immediately after the offending push means a later
  // error record in the same chunk is never reached — the breaker wins.
  const overLimit = (): boolean =>
    (typeof maxNodes === 'number' && nodes.length > maxNodes) ||
    (typeof maxEdges === 'number' && relationships.length > maxEdges);

  const parseLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    const record = JSON.parse(trimmed) as
      | { type: 'node'; data: GraphNode }
      | { type: 'relationship'; data: GraphRelationship }
      | { type: 'error'; error: string };

    if (record.type === 'node') {
      nodes.push(record.data);
      return;
    }
    if (record.type === 'relationship') {
      relationships.push(record.data);
      return;
    }
    if (record.type === 'error') {
      throw new BackendError(record.error, response.status || 500, 'server');
    }
  };

  const tripBreaker = async () => {
    // Free the socket promptly; never let a cancel rejection mask the breaker.
    try {
      await reader.cancel();
    } catch {
      // ignore — we're aborting anyway
    }
    throw new GraphTooLargeError(
      `Graph exceeds the size limit (nodes=${nodes.length}, relationships=${relationships.length})`,
      nodes.length,
      relationships.length,
    );
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    downloaded += value.length;
    onProgress?.(downloaded, total);
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      parseLine(line);
      if (overLimit()) await tripBreaker();
    }
  }

  buffer += decoder.decode();
  parseLine(buffer);
  if (overLimit()) await tripBreaker();

  return { nodes, relationships };
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
  ]
    .filter(Boolean)
    .join('&');
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
  ]
    .filter(Boolean)
    .join('&');
  const response = await fetchWithTimeout(`${_backendUrl}/api/file?${params}`);
  await assertOk(response);
  return response.json() as Promise<ReadFileResult>;
};

/** Fetch all processes for a repo. */
export const fetchProcesses = async (repo?: string): Promise<unknown> => {
  const response = await fetchWithTimeout(
    `${_backendUrl}/api/processes${repo ? `?${repoParam(repo)}` : ''}`,
  );
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
  const response = await fetchWithTimeout(
    `${_backendUrl}/api/clusters${repo ? `?${repoParam(repo)}` : ''}`,
  );
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

// ── Upload API ─────────────────────────────────────────────────────────────

/**
 * Upload a folder (selected via `<input webkitdirectory>`) and start analysis.
 * Sends the file blobs plus a JSON `manifest` of their relative paths — the
 * multipart filename can't carry the path (browsers strip separators), so the
 * manifest is the source of truth. Routed through fetchWithTimeout (the shared,
 * origin-validated request path) rather than a raw XHR; returns the analysis
 * jobId, which the caller drives through the normal SSE flow.
 */
export const uploadFolder = async (
  files: File[],
  manifest: string[],
  signal?: AbortSignal,
): Promise<{ jobId: string; status: string }> => {
  const form = new FormData();
  // Manifest MUST precede the file parts (the server enforces this).
  form.append('manifest', JSON.stringify(manifest));
  for (const f of files) form.append('files', f);

  const response = await fetchWithTimeout(
    `${_backendUrl}/api/analyze/upload`,
    { method: 'POST', body: form, signal },
    5 * 60_000, // up to 5 min for large repos
  );
  await assertOk(response);
  return response.json() as Promise<{ jobId: string; status: string }>;
};

// ── Analyze API ────────────────────────────────────────────────────────────

/** Start a server-side analysis job. */
export const startAnalyze = async (request: {
  url?: string;
  path?: string;
  force?: boolean;
  embeddings?: boolean;
  token?: string;
}): Promise<{ jobId: string; status: string }> => {
  const response = await fetchWithTimeout(
    `${_backendUrl}/api/analyze`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    },
    30_000,
  );
  await assertOk(response);
  return response.json() as Promise<{ jobId: string; status: string }>;
};

/** Poll analysis job status. */
export const getAnalyzeStatus = async (jobId: string): Promise<JobStatus> => {
  const response = await fetchWithTimeout(
    `${_backendUrl}/api/analyze/${encodeURIComponent(jobId)}`,
  );
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
  onComplete: (data: { repoName?: string; repoPath?: string }) => void,
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
  const response = await fetchWithTimeout(
    `${_backendUrl}/api/embed`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo }),
    },
    30_000,
  );
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
  const response = await fetchWithTimeout(`${_backendUrl}/api/embed/${encodeURIComponent(jobId)}`, {
    method: 'DELETE',
  });
  await assertOk(response);
};

/** Stream embedding progress via SSE. */
export const streamEmbeddingProgress = (
  jobId: string,
  onProgress: (progress: JobProgress) => void,
  onComplete: (data: { repoName?: string; repoPath?: string }) => void,
  onError: (error: string) => void,
): AbortController => {
  return streamSSE<JobProgress>(`${_backendUrl}/api/embed/${encodeURIComponent(jobId)}/progress`, {
    onMessage: onProgress,
    onComplete: onComplete as (data: unknown) => void,
    onError,
  });
};

// ── Convenience: connect to server ─────────────────────────────────────────

export interface ConnectResult {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  repoInfo: BackendRepo;
  /**
   * True when the graph download was skipped (chat-only mode) — either because
   * the caller asked for it or because the project exceeded the auto-detect
   * node threshold. When true, `nodes`/`relationships` are empty and graph
   * visualization is unavailable, but AI chat and all backend-API features
   * work normally. See issue #2178.
   */
  graphSkipped: boolean;
}

/**
 * Connect to a server: validate, fetch repo info, download graph.
 * Content is NOT included (use readFile/grep for file access).
 * Pass `awaitAnalysis: true` when the repo may still be cloning/analyzing —
 * this enables the backend hold-queue and a 5-minute fetch timeout.
 * Pass `skipGraph: true`/`false` to force chat-only / full-graph mode; omit it
 * to auto-detect from the project's node count (LARGE_GRAPH_NODE_THRESHOLD).
 */
export async function connectToServer(
  url: string,
  onProgress?: (phase: string, downloaded: number, total: number | null) => void,
  signal?: AbortSignal,
  repoName?: string,
  opts?: { awaitAnalysis?: boolean; skipGraph?: boolean },
): Promise<ConnectResult> {
  const baseUrl = normalizeServerUrl(url);
  setBackendUrl(baseUrl);

  onProgress?.('validating', 0, null);
  const repoInfo = await fetchRepoInfo(repoName, { awaitAnalysis: opts?.awaitAnalysis });

  // Decide whether to skip the (potentially huge) graph download. The AI chat
  // talks to the backend HTTP API directly and does not need the in-memory
  // graph, so for large projects — or when the caller explicitly asked for
  // chat-only mode — we connect instantly without materializing the graph.
  // repoInfo is already fetched above, so the node-count check costs no extra
  // round-trip. See issue #2178.
  const skipGraph = decideSkipGraph({
    explicit: opts?.skipGraph,
    nodeCount: repoInfo.stats?.nodes,
    threshold: LARGE_GRAPH_NODE_THRESHOLD,
    edgeCount: repoInfo.stats?.edges,
    edgeThreshold: LARGE_GRAPH_EDGE_THRESHOLD,
  });

  if (skipGraph) {
    return { nodes: [], relationships: [], repoInfo, graphSkipped: true };
  }

  // Arm the streaming circuit breaker for auto-detect downloads as a backstop
  // for the no-stats fail-open case (#2178). An explicit "load anyway"
  // (skipGraph === false) opts out — the user has accepted the cost.
  const enforceLimits = opts?.skipGraph !== false;

  onProgress?.('downloading', 0, null);
  try {
    const { nodes, relationships } = await fetchGraph(repoName, {
      signal,
      onProgress: (downloaded, total) => onProgress?.('downloading', downloaded, total),
      maxNodes: enforceLimits ? LARGE_GRAPH_NODE_THRESHOLD : undefined,
      maxEdges: enforceLimits ? LARGE_GRAPH_EDGE_THRESHOLD : undefined,
    });
    return { nodes, relationships, repoInfo, graphSkipped: false };
  } catch (err) {
    // The breaker tripped mid-stream → fall into chat-only, the same result the
    // pre-fetch skip path produces. Re-throw every other error (genuine
    // BackendErrors must still surface to the caller's catch).
    if (err instanceof GraphTooLargeError) {
      return { nodes: [], relationships: [], repoInfo, graphSkipped: true };
    }
    throw err;
  }
}
