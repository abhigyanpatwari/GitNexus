import { timingSafeEqual } from 'node:crypto';
import { writeSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { extname, isAbsolute, normalize, relative, resolve, sep } from 'node:path';

const host = '0.0.0.0';
const port = Number(process.env.PORT || '4173');
const root = resolve(process.cwd(), 'dist');

function isValidUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function jsonForScriptTag(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

// Warnings echo operator input back, so strip control characters (log forging)
// and cap the length first.
function sanitizeForLog(value) {
  return (
    String(value)
      // The line-break strip is redundant with the range below, but CodeQL's
      // js/log-injection recognizes only this shape as a sanitizer: a global
      // replace of a literal \n with the empty string.
      .replace(/\n/g, '')
      .replace(/\r/g, '')
      .replace(/[\x00-\x1f\x7f]/g, ' ')
      .slice(0, 200)
  );
}

// console.error is asynchronous when stderr is a pipe, so pairing it with
// process.exit can drop the one message explaining the refusal. writeSync isn't.
function exitWithRefusal(message) {
  writeSync(2, `${message}\n`);
  process.exit(1);
}

// `value` if it's a usable http/https URL, else null + a warning naming `label`.
// `rawForLog` lets a caller that normalized first echo back the operator's input.
function validHttpUrl(label, value, rawForLog = value) {
  if (!value) return null;
  if (isValidUrl(value)) return value;
  const safeRaw = sanitizeForLog(rawForLog);
  console.warn(`[gitnexus-web] ${label} "${safeRaw}" is not a valid http/https URL -- ignoring.`);
  return null;
}

// Numeric env var. Every consumer below reads <= 0 as "disabled", so obeying a
// typo like -1 would switch a timeout off silently. Warn and use the default.
function numberFromEnv(label, fallback, min = 0) {
  const raw = process.env[label];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.warn(
      `[gitnexus-web] ${label} "${sanitizeForLog(raw)}" is not a number -- using ${fallback}.`,
    );
    return fallback;
  }
  if (n < min) {
    console.warn(
      `[gitnexus-web] ${label} "${sanitizeForLog(raw)}" is below the minimum ${min} -- using ${fallback}.`,
    );
    return fallback;
  }
  return n;
}

// Falls back to RENDER_EXTERNAL_URL so a Render web service hands the browser
// its own public origin — same-origin API calls via the proxy below, no config.
const backendUrlVar =
  process.env.GITNEXUS_BACKEND_URL !== undefined ? 'GITNEXUS_BACKEND_URL' : 'RENDER_EXTERNAL_URL';
const rawBackendUrl = process.env.GITNEXUS_BACKEND_URL ?? process.env.RENDER_EXTERNAL_URL ?? null;
const backendUrl = validHttpUrl(backendUrlVar, rawBackendUrl);
const configScript = backendUrl
  ? `<script>window.__GITNEXUS_CONFIG__=${jsonForScriptTag({ backendUrl })};</script>`
  : '';

// Optional same-origin reverse proxy for the API server. On a split deploy
// (public web service, private API) the browser must reach the API without a
// cross-origin request, since its CORS allowlist and write-route guard only
// admit same-host origins. So the browser targets THIS origin and we forward
// /api/* to GITNEXUS_UPSTREAM_URL. Unset → no proxy (docker-compose default).
// A scheme-less host:port — what Render's `fromService: hostport` yields —
// gets http:// prepended.
const rawUpstream = process.env.GITNEXUS_UPSTREAM_URL;
const rawUpstreamUrl = rawUpstream
  ? /^https?:\/\//.test(rawUpstream)
    ? rawUpstream
    : `http://${rawUpstream}`
  : null;
const upstreamBase = validHttpUrl('GITNEXUS_UPSTREAM_URL', rawUpstreamUrl, rawUpstream);
// The one origin this proxy will ever connect to (see proxyToUpstream).
const upstreamOrigin = upstreamBase ? new URL(upstreamBase).origin : null;

// The Bearer token every /api/* request must carry. The private upstream has no
// auth of its own and loses its Origin guard one hop below (see
// proxyToUpstream), so the gate belongs here. The browser holds it — never
// inject it next to `backendUrl`. Blank-is-absent follows resolveAuthToken
// (gitnexus/src/mcp/http-transport.ts).
const authToken = process.env.GITNEXUS_SERVE_AUTH_TOKEN?.trim() || null;

// The protocol-layer credential the upstream `serve` expects on /api/mcp when it
// runs with MCP Bearer auth enabled. Set it to the SAME value on both services:
// the edge token is spent here and replaced with this one for MCP requests only
// (see proxyToUpstream). Unset — the default — means no injection, so a backend
// without MCP auth is unaffected. Blank-is-absent follows resolveAuthToken
// (gitnexus/src/mcp/http-transport.ts). Never logged.
const mcpAuthToken = process.env.GITNEXUS_MCP_AUTH_TOKEN?.trim() || null;

// Mirrors the non-loopback refusal in http-transport.ts (startMcpHttpServer),
// relocated because the trust boundary is here: an unguarded `serve` behind a
// private service is legitimate, an unguarded public proxy is not.
if (upstreamBase && !authToken) {
  exitWithRefusal(
    '[gitnexus-web] Refusing to start: GITNEXUS_UPSTREAM_URL is set without ' +
      'GITNEXUS_SERVE_AUTH_TOKEN. The proxy would expose every indexed repo — ' +
      'index, read source, and delete — to anyone with this URL. Set a token, ' +
      'or unset GITNEXUS_UPSTREAM_URL to serve static assets only.',
  );
}

// Rejected requests never reach the upstream limiter, so guesses are free. A
// throttle would add per-address state to a stateless proxy and a lockout an
// attacker can aim at a real user; a length floor makes guessing hopeless and
// only ever rejects a hand-picked token.
const MIN_AUTH_TOKEN_LENGTH = 32;
if (authToken && authToken.length < MIN_AUTH_TOKEN_LENGTH) {
  exitWithRefusal(
    `[gitnexus-web] Refusing to start: GITNEXUS_SERVE_AUTH_TOKEN is shorter than ` +
      `${MIN_AUTH_TOKEN_LENGTH} characters. It is the only thing standing between the ` +
      'public internet and every indexed repo, and a failed guess is not rate-limited. ' +
      'Use a generated random value.',
  );
}

// Whether an inbound X-Forwarded-For may be believed (see clientAddressFor).
// Default off, so a wrong deployment fails toward over-restriction rather than
// toward an address the caller picks. `true` is rejected as it is server-side
// (resolveTrustProxy, which also takes hop counts and so rejects `yes`/`on`
// too): it reads as "trust the whole chain".
function resolveTrustXff(raw) {
  const value = raw?.trim();
  if (!value) return false;
  if (/^(1|yes|on)$/i.test(value)) return true;
  if (/^(0|no|off|false)$/i.test(value)) return false;
  console.warn(
    `[gitnexus-web] GITNEXUS_PROXY_TRUST_XFF "${sanitizeForLog(value)}" is not a recognized ` +
      'boolean -- ignoring the inbound X-Forwarded-For chain. Set 1 only when a load balancer ' +
      'that appends the real peer sits in front of this service.',
  );
  return false;
}
const trustInboundXff = resolveTrustXff(process.env.GITNEXUS_PROXY_TRUST_XFF);

// Idle timeout for a proxied request → 504. Socket activity (SSE heartbeats)
// resets it, so long-lived streams are unaffected. 0 disables.
const proxyTimeoutMs = numberFromEnv('GITNEXUS_PROXY_TIMEOUT_MS', 120000);

// nginx's client_body_timeout equivalent: how long to wait for a replayable
// client body before 400. Defaults to the idle timeout; 0 disables.
const proxyClientBodyTimeoutMs = numberFromEnv(
  'GITNEXUS_PROXY_CLIENT_BODY_TIMEOUT_MS',
  proxyTimeoutMs,
);

// Bounded connection-retry, to ride out the few-second window where a
// single-instance upstream (private server + disk ⇒ no zero-downtime deploy)
// is restarting. Attempts of 1 disables it, and body buffering with it.
const proxyRetryAttempts = numberFromEnv('GITNEXUS_PROXY_RETRY_ATTEMPTS', 3, 1);
const proxyRetryEnabled = proxyRetryAttempts > 1;
const proxyRetryMaxBodyBytes = numberFromEnv('GITNEXUS_PROXY_RETRY_MAX_BODY_BYTES', 256 * 1024);
// Never connected ⇒ the upstream got nothing ⇒ safe to replay any method.
const preConnectRetryCodes = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);
// Failed after connecting ⇒ the upstream may already be working on it, so
// replay only idempotent methods (RFC 7231 §4.2.2) to avoid double-execution.
const postConnectRetryCodes = new Set(['ECONNRESET', 'ETIMEDOUT']);
const idempotentMethods = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE', 'TRACE']);

// Buffer a request body, capped. Resolves null on overflow, client error, or
// timeout — one "unreadable body" contract, which the caller maps to 400.
// Listeners detach once settled so a later pipe of the same request is clean.
function readBodyCapped(req, cap, timeoutMs) {
  return new Promise((resolvePromise) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(value);
    };
    const onData = (chunk) => {
      total += chunk.length;
      if (total > cap) {
        finish(null);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish(Buffer.concat(chunks));
    const onError = () => finish(null);
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    // Hard cap regardless of idle activity; Node's requestTimeout is the outer
    // backstop.
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        console.warn(`[gitnexus-web] client body read timed out after ${timeoutMs}ms`);
        finish(null);
      }, timeoutMs);
    }
  });
}

// Constant-time Bearer check, mirroring createAuthMiddleware in
// gitnexus/src/mcp/http-transport.ts — dummy comparison included, so an absent
// or wrong-length header costs the same and the timing can't leak the length.
// Duplicated because this file is plain ESM and can't import from gitnexus/src.
function authorized(req) {
  if (!authToken) return true; // static-only: no proxy, nothing to gate
  const header = req.headers['authorization'];
  const expected = Buffer.from(`Bearer ${authToken}`);
  if (typeof header !== 'string') {
    timingSafeEqual(Buffer.alloc(expected.length), expected);
    return false;
  }
  const provided = Buffer.from(header);
  if (provided.length !== expected.length) {
    timingSafeEqual(Buffer.alloc(expected.length), expected);
    return false;
  }
  return timingSafeEqual(provided, expected);
}

// WWW-Authenticate names the scheme; the stable `code` is what the web client
// dispatches on, not message text. The body must not distinguish "no token
// configured" from "wrong token". `Connection: close` because we answer before
// reading the body, which Node would otherwise drain (as with the 400 below).
function sendUnauthorized(res) {
  const body = JSON.stringify({ error: 'unauthorized', code: 'unauthorized' });
  res.writeHead(401, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'WWW-Authenticate': 'Bearer',
    Connection: 'close',
  });
  res.end(body);
}

// Fail a proxied request. Once headers are sent the body is partially written
// and can't be replaced, so the socket is all we can destroy.
function failGateway(res, status, message) {
  if (res.headersSent) {
    res.destroy();
  } else {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(message);
  }
}

// Hop-by-hop headers (RFC 7230 §6.1) describe one connection, so a proxy must
// not forward them in either direction; Node sets its own per hop.
const hopByHopHeaders = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

function stripHopByHopHeaders(headers) {
  // §6.1 also lets `Connection` name additional single-hop headers, which the
  // fixed list below can't cover. Node lowercases header keys on both the
  // server and client side, so a lowercased name indexes `headers` directly.
  for (const listed of String(headers.connection ?? '').split(',')) {
    const name = listed.trim().toLowerCase();
    if (name) delete headers[name];
  }
  for (const name of hopByHopHeaders) delete headers[name];
  return headers;
}

// The client address this proxy vouches for upstream. The API keys its rate
// limiter off req.ip, so forwarding a client-supplied X-Forwarded-For would let
// anyone rotate a fake address per request. Which entry is real depends on a
// deployment fact this process can't observe (is anything in front appending the
// peer?), so the operator asserts it via GITNEXUS_PROXY_TRUST_XFF; until then we
// forward the socket peer.
function clientAddressFor(req) {
  if (!trustInboundXff) return req.socket.remoteAddress || null;
  const forwarded = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .pop();
  return forwarded || req.socket.remoteAddress || null;
}

// Forward an `/api/*` request upstream, streaming both bodies (SSE / chunked
// graph streams) untouched. Retries connect failures when the body is replayable.
async function proxyToUpstream(req, res) {
  let upstream;
  try {
    upstream = new URL(req.url, upstreamBase);
  } catch {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }
  // The `/api/` route guard keeps req.url host-relative, so resolution can't
  // leave upstreamBase. Asserting it here means the SSRF boundary doesn't rest
  // on that two-step argument: one legitimate destination, checked locally.
  if (upstream.origin !== upstreamOrigin) {
    console.error(`[gitnexus-web] refusing to proxy off-origin target ${upstream.origin}`);
    res.writeHead(400);
    res.end('Bad request');
    return;
  }
  const isHttps = upstream.protocol === 'https:';
  const requestFn = isHttps ? httpsRequest : httpRequest;
  const headers = stripHopByHopHeaders({ ...req.headers });
  // Terminate the browser origin: the API admits Origin-less requests as
  // trusted server-to-server calls. Nothing is lost — the browser only ever
  // talks to this same-origin web service.
  delete headers.origin;
  delete headers.referer;
  // The edge token is spent here and must never be forwarded: copying
  // Authorization would put a live credential into another service's logs. So
  // drop it unconditionally first, then — for the MCP route alone, and only
  // when a backend token is configured — replace it with that separate
  // protocol credential. Unset GITNEXUS_MCP_AUTH_TOKEN (the default) leaves
  // every request stripped, as before. The scope is the normalized pathname,
  // so a query string can't widen it and /api/mcpfoo doesn't qualify.
  delete headers.authorization;
  const upstreamPath = upstream.pathname;
  const isMcpRoute = upstreamPath === '/api/mcp' || upstreamPath.startsWith('/api/mcp/');
  if (isMcpRoute && mcpAuthToken) headers.authorization = `Bearer ${mcpAuthToken}`;
  headers.host = upstream.host;
  // Replace, never forward, the inbound chain (see clientAddressFor).
  const clientAddress = clientAddressFor(req);
  if (clientAddress) headers['x-forwarded-for'] = clientAddress;
  else delete headers['x-forwarded-for'];

  // A retry replays the body, so buffer it up front — but only when small and
  // of known length. Larger/unknown bodies (multipart uploads) stream once with
  // no retry; an upload is never buffered.
  const method = (req.method || 'GET').toUpperCase();
  const isIdempotentMethod = idempotentMethods.has(method);
  // A request has a body iff it frames one (RFC 7230 §3.3.3). Keying off the
  // method sends a bodyless DELETE down the stream-once path and gives up a
  // replay that costs nothing.
  const hasBody =
    req.headers['content-length'] !== undefined || req.headers['transfer-encoding'] !== undefined;
  const len = Number(req.headers['content-length']);
  const bufferable =
    proxyRetryEnabled && Number.isFinite(len) && len >= 0 && len <= proxyRetryMaxBodyBytes;
  let bodyBuf = hasBody ? null : Buffer.alloc(0);
  if (hasBody && bufferable) {
    bodyBuf = await readBodyCapped(req, proxyRetryMaxBodyBytes, proxyClientBodyTimeoutMs);
    if (bodyBuf === null) {
      // Overflow, client error, and timeout all collapse to 400 (not 413/408).
      // `Connection: close` lets Node drop the socket after the 400 flushes,
      // rather than half-open draining a stalled upload until requestTimeout.
      if (!res.headersSent) {
        res.writeHead(400, {
          'Content-Type': 'text/plain; charset=utf-8',
          Connection: 'close',
        });
        res.end('Bad request');
      }
      return;
    }
  }
  // bodyBuf === null means "stream the live request once, no retry".
  const retryEligible = bodyBuf !== null;

  const attempt = (n) => {
    let timedOut = false;
    const upstreamReq = requestFn(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || (isHttps ? 443 : 80),
        method: req.method,
        path: upstream.pathname + upstream.search,
        headers,
      },
      (upstreamRes) => {
        // Pipe rather than buffer, so SSE / chunked streams reach the browser
        // incrementally. Node re-derives Transfer-Encoding for this hop.
        const responseHeaders = stripHopByHopHeaders({ ...upstreamRes.headers });
        res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
        upstreamRes.on('error', () => res.destroy());
        upstreamRes.pipe(res);
      },
    );
    upstreamReq.on('error', (err) => {
      if (timedOut) return; // 504 already sent by the timeout handler below
      // Only before any response byte reaches the browser — once headers are
      // sent the body is partially written and can't be replayed.
      const retryableError =
        preConnectRetryCodes.has(err.code) ||
        (isIdempotentMethod && postConnectRetryCodes.has(err.code));
      if (retryEligible && !res.headersSent && n < proxyRetryAttempts && retryableError) {
        const delay = 250 * 2 ** (n - 1); // 250ms, 500ms, ...
        console.warn(
          `[gitnexus-web] upstream ${sanitizeForLog(err.code)}; retry ${n}/${proxyRetryAttempts - 1} in ${delay}ms`,
        );
        setTimeout(() => {
          // The client may have aborted during the backoff window; don't fire a
          // fresh upstream request nobody is waiting for anymore.
          if (res.writableEnded || res.destroyed) return;
          attempt(n + 1);
        }, delay);
        return;
      }
      console.error('[gitnexus-web] upstream proxy error:', sanitizeForLog(err.message));
      failGateway(res, 502, 'Bad gateway');
    });
    if (proxyTimeoutMs > 0) {
      upstreamReq.setTimeout(proxyTimeoutMs, () => {
        timedOut = true;
        console.error(`[gitnexus-web] upstream proxy timeout after ${proxyTimeoutMs}ms`);
        failGateway(res, 504, 'Gateway timeout');
        upstreamReq.destroy();
      });
    }
    if (bodyBuf !== null) {
      // Replayable body already buffered; write it fresh on each attempt.
      if (bodyBuf.length) upstreamReq.write(bodyBuf);
      upstreamReq.end();
    } else {
      // Non-retryable: stream the live request once.
      req.on('error', () => upstreamReq.destroy());
      req.pipe(upstreamReq);
    }
  };
  attempt(1);
}

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// Static asset server for the gitnexus-web Docker image.
//
// TOCTOU prevention: every filesystem interaction uses open() to get a
// file handle; subsequent reads use handle.readFile()/createReadStream().
//
// CodeQL js/file-system-race: the query pairs open() calls when their
// path arguments are data-flow aliased. This handler uses exactly two
// open() calls whose paths are provably independent:
//   1. open(requestedPath) — derived from the URL
//   2. open(spaFallback)   — the constant root/index.html
// Because spaFallback has no data-flow from the request, CodeQL cannot
// pair them as a check/use on the same path.
//
// Path-injection containment: each open() is preceded by a
// path.relative() barrier that CodeQL recognizes as a sanitizer.

const spaFallback = resolve(root, 'index.html');

const server = createServer(async (req, res) => {
  const urlPath = req.url?.split('?')[0] || '/';

  // Same-origin API proxy; everything else falls through to the SPA below.
  if (upstreamBase && (urlPath === '/api' || urlPath.startsWith('/api/'))) {
    // Before body buffering and the upstream socket, so an unauthenticated
    // request costs nothing upstream. Static assets are never gated: the UI has
    // to load in order to prompt for the token.
    if (!authorized(req)) {
      sendUnauthorized(res);
      return;
    }
    // Fire-and-forget, so guard the boundary against unhandledRejection.
    proxyToUpstream(req, res).catch((err) => {
      console.error('[gitnexus-web] proxy handler crashed:', sanitizeForLog(err?.message ?? err));
      failGateway(res, 502, 'Bad gateway');
    });
    return;
  }

  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }
  if (decoded.includes('\0')) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  const cleanPath = normalize(decoded.replace(/^\/+/, ''));
  const requestedPath = resolve(root, cleanPath);

  const rel = relative(root, requestedPath);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  let handle;
  try {
    let servePath = requestedPath;

    // Try to open the exact path the client asked for.
    handle = await open(requestedPath, 'r').catch(() => null);
    if (handle) {
      const s = await handle.stat();
      if (!s.isFile()) {
        // Directories and other non-files fall through to SPA fallback.
        await handle.close();
        handle = null;
      }
    }

    // If the requested path wasn't a regular file, serve the SPA entry
    // point. spaFallback is a module-level constant with no data-flow
    // from the request, so this open() is independent of the one above.
    if (!handle) {
      servePath = spaFallback;
      handle = await open(spaFallback, 'r').catch(() => null);
      if (!handle) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const s = await handle.stat();
      if (!s.isFile()) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
    }

    const isHtml = extname(servePath) === '.html' || !extname(servePath);
    const cacheControl = servePath.includes(`${sep}assets${sep}`)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';
    const contentType = contentTypes[extname(servePath)] || 'application/octet-stream';

    if (isHtml && configScript) {
      const raw = await handle.readFile('utf8');
      await handle.close();
      handle = null;
      if (!raw.includes('</head>')) {
        console.warn('[gitnexus-web] Could not inject config: no </head> tag found in HTML');
      }
      const html = raw.includes('</head>') ? raw.replace('</head>', `${configScript}</head>`) : raw;
      const buf = Buffer.from(html, 'utf8');
      res.writeHead(200, {
        'Cache-Control': cacheControl,
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': buf.length,
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      });
      res.end(buf);
    } else {
      res.writeHead(200, {
        'Cache-Control': cacheControl,
        'Content-Type': contentType,
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      });
      const stream = handle.createReadStream();
      handle = null;
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    }
  } catch (error) {
    console.error(error);
    res.writeHead(500);
    res.end('Internal server error');
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
});

server.listen(port, host, () => {
  console.log(`gitnexus-web listening on http://${host}:${port}`);
});
