import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import http, { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverScript = join(__dirname, 'docker-server.mjs');

function getFreePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function rawGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitForServer(port, retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      await rawGet(port, '/');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('Server did not start in time');
}

let tmpDir, serverPort, child;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'gitnexus-docker-test-'));
  const distDir = join(tmpDir, 'dist');
  const assetsDir = join(distDir, 'assets');
  await mkdir(assetsDir, { recursive: true });
  await writeFile(join(distDir, 'index.html'), '<html><body>spa</body></html>');
  await writeFile(join(assetsDir, 'app.abc123.js'), 'console.log("app")');

  serverPort = await getFreePort();
  child = spawn(process.execPath, [serverScript], {
    cwd: tmpDir,
    env: { ...process.env, PORT: String(serverPort) },
    stdio: 'pipe',
  });
  child.on('error', (err) => {
    throw err;
  });

  await waitForServer(serverPort);
});

function killAndWait(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null) {
      resolve();
      return;
    }
    proc.once('exit', resolve);
    proc.kill();
    if (proc.exitCode !== null) resolve();
  });
}

after(async () => {
  await killAndWait(child);
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

it('serves a valid asset with immutable cache header', async () => {
  const res = await rawGet(serverPort, '/assets/app.abc123.js');
  assert.equal(res.status, 200);
  assert.match(res.headers['cache-control'], /immutable/);
  assert.equal(res.headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(res.headers['cross-origin-embedder-policy'], 'require-corp');
});

it('serves SPA fallback for unknown routes', async () => {
  const res = await rawGet(serverPort, '/some/unknown/route');
  assert.equal(res.status, 200);
  assert.match(res.body, /spa/);
  assert.match(res.headers['cache-control'], /no-cache/);
});

it('rejects path traversal with 400', async () => {
  const res = await rawGet(serverPort, '/../../../etc/passwd');
  assert.equal(res.status, 400);
});

it('rejects percent-encoded null bytes with 400', async () => {
  const res = await rawGet(serverPort, '/foo%00bar');
  assert.equal(res.status, 400);
});

it('rejects percent-encoded path traversal with 400', async () => {
  // %2e%2e%2f decodes to '../'. Without the path.relative inline barrier,
  // a naive string check on the raw URL would let this through and only
  // the lexical-decoded path.resolve would catch it. Confirm the barrier
  // does its job after decodeURIComponent.
  const res = await rawGet(serverPort, '/%2e%2e%2f%2e%2e%2fetc%2fpasswd');
  assert.equal(res.status, 400);
});

it('rejects malformed percent-encoding with 400', async () => {
  // %GG is not a valid percent-encoded sequence — decodeURIComponent throws.
  // The handler's try/catch around decode must convert this to a 400 rather
  // than an unhandled rejection.
  const res = await rawGet(serverPort, '/foo%GGbar');
  assert.equal(res.status, 400);
});

it('returns 404 when dist/index.html is missing', async () => {
  await unlink(join(tmpDir, 'dist', 'index.html'));
  const res = await rawGet(serverPort, '/nonexistent-page');
  assert.equal(res.status, 404);
});

// -- Config injection: server-level integration tests ---

function spawnServerWithEnv(cwd, port, env) {
  const proc = spawn(process.execPath, [serverScript], {
    cwd,
    env: { ...process.env, PORT: String(port), ...env },
    stdio: 'pipe',
  });
  proc.on('error', (err) => {
    throw err;
  });
  return proc;
}

async function withInjectionServer(envOverrides, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'gitnexus-inject-'));
  const distDir = join(dir, 'dist');
  const assetsDir = join(distDir, 'assets');
  await mkdir(assetsDir, { recursive: true });
  await writeFile(
    join(distDir, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"></head><body>app</body></html>',
  );
  await writeFile(join(assetsDir, 'style.abc.css'), 'body{}');

  const port = await getFreePort();
  const proc = spawnServerWithEnv(dir, port, envOverrides);
  try {
    await waitForServer(port);
    await fn(port);
  } finally {
    await killAndWait(proc);
    await rm(dir, { recursive: true, force: true });
  }
}

it('injects __GITNEXUS_CONFIG__ into / when GITNEXUS_BACKEND_URL is valid', async () => {
  await withInjectionServer({ GITNEXUS_BACKEND_URL: 'http://10.0.0.1:4747' }, async (port) => {
    const res = await rawGet(port, '/');
    assert.equal(res.status, 200);
    assert.ok(
      res.body.includes('window.__GITNEXUS_CONFIG__'),
      'Expected __GITNEXUS_CONFIG__ in response body',
    );
    assert.ok(res.body.includes('http://10.0.0.1:4747'), 'Expected backend URL in response body');
  });
});

it('injects __GITNEXUS_CONFIG__ into SPA fallback routes', async () => {
  await withInjectionServer({ GITNEXUS_BACKEND_URL: 'http://10.0.0.1:4747' }, async (port) => {
    const res = await rawGet(port, '/some/deep/link');
    assert.equal(res.status, 200);
    assert.ok(
      res.body.includes('window.__GITNEXUS_CONFIG__'),
      'Expected __GITNEXUS_CONFIG__ in SPA fallback response',
    );
    assert.ok(
      res.body.includes('http://10.0.0.1:4747'),
      'Expected backend URL in SPA fallback response',
    );
  });
});

it('does not inject when GITNEXUS_BACKEND_URL is not set', async () => {
  await withInjectionServer({}, async (port) => {
    const res = await rawGet(port, '/');
    assert.equal(res.status, 200);
    assert.ok(
      !res.body.includes('__GITNEXUS_CONFIG__'),
      'Expected no __GITNEXUS_CONFIG__ when env var is unset',
    );
  });
});

it('does not inject when GITNEXUS_BACKEND_URL is invalid', async () => {
  await withInjectionServer({ GITNEXUS_BACKEND_URL: 'not-a-url' }, async (port) => {
    const res = await rawGet(port, '/');
    assert.equal(res.status, 200);
    assert.ok(
      !res.body.includes('__GITNEXUS_CONFIG__'),
      'Expected no __GITNEXUS_CONFIG__ for invalid URL',
    );
  });
});

it('does not inject when GITNEXUS_BACKEND_URL uses a non-http protocol', async () => {
  await withInjectionServer({ GITNEXUS_BACKEND_URL: 'ftp://somehost:21' }, async (port) => {
    const res = await rawGet(port, '/');
    assert.equal(res.status, 200);
    assert.ok(
      !res.body.includes('__GITNEXUS_CONFIG__'),
      'Expected no __GITNEXUS_CONFIG__ for non-http protocol',
    );
  });
});

it('escapes </script> in GITNEXUS_BACKEND_URL to prevent XSS', async () => {
  const xssUrl = 'http://example.com/?x=</script><script>alert(1)</script>';
  await withInjectionServer({ GITNEXUS_BACKEND_URL: xssUrl }, async (port) => {
    const res = await rawGet(port, '/');
    assert.equal(res.status, 200);

    const scriptMatches = res.body.match(/<script>/gi) || [];
    assert.equal(
      scriptMatches.length,
      1,
      `Expected exactly 1 <script> tag but found ${scriptMatches.length}: XSS breakout detected`,
    );

    assert.ok(
      !res.body.includes('</script><script>'),
      '</script> must not appear unescaped -- would allow script breakout',
    );
    assert.ok(res.body.includes('\\u003c'), 'Angle brackets must be escaped as \\u003c');
  });
});

it('does not inject config into static assets', async () => {
  await withInjectionServer({ GITNEXUS_BACKEND_URL: 'http://10.0.0.1:4747' }, async (port) => {
    const res = await rawGet(port, '/assets/style.abc.css');
    assert.equal(res.status, 200);
    assert.ok(
      !res.body.includes('__GITNEXUS_CONFIG__'),
      'Static assets must not contain injected config',
    );
    assert.equal(res.body, 'body{}');
  });
});
// -- API reverse proxy (GITNEXUS_UPSTREAM_URL) -----------------------------

// Every proxy fixture below runs the server with this token: the proxy refuses
// to start without one, and refuses one under 32 characters.
const TEST_AUTH_TOKEN = 'proxy-test-token-0123456789abcdefghij';
const TEST_BEARER = `Bearer ${TEST_AUTH_TOKEN}`;

// rawRequest never sends credentials; apiRequest does. In a file whose subject
// is who gets let through, no test should pass because a helper quietly
// authenticated for it.
function rawRequest(port, path, { method = 'GET', headers = {}, body } = {}) {
  // Send an explicit Content-Length like a browser fetch() does — the proxy
  // only buffers (and so only retries) bodies of known length.
  const outHeaders = { ...headers };
  if (
    body !== undefined &&
    !Object.keys(outHeaders).some((h) => h.toLowerCase() === 'content-length')
  ) {
    outHeaders['content-length'] = String(Buffer.byteLength(body));
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method, headers: outHeaders },
      (res) => {
        let respBody = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          respBody += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: respBody }),
        );
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// An authenticated /api/* call. An explicit `authorization` header wins, so the
// auth tests can send a wrong one.
function apiRequest(port, path, { headers = {}, ...rest } = {}) {
  const hasAuth = Object.keys(headers).some((h) => h.toLowerCase() === 'authorization');
  return rawRequest(port, path, {
    ...rest,
    headers: hasAuth ? headers : { ...headers, authorization: TEST_BEARER },
  });
}

const respondOk = (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end('{"ok":true}');
};

// Every proxy test needs the same four parts: a dist/ to serve, a fake upstream,
// a docker-server pointed at it, and teardown that leaks neither a process nor a
// temp dir. They differ only in how the upstream misbehaves.
//
//   upstream       request handler, replaceable mid-test via `ctx.handler`;
//                  null points the proxy at a port nothing ever listens on
//   listenAfterMs  bind the upstream this late, so the first attempt(s) hit
//                  ECONNREFUSED (a single-instance restart window)
//   schemeless     drop http:// from GITNEXUS_UPSTREAM_URL, the way Render's
//                  `fromService: { property: hostport }` yields it
//   env            extra environment for docker-server.mjs
//
// `ctx` collects what the upstream saw (calls, last request, last body) plus the
// proxy's stderr, so assertions read off one object.
async function withProxy(
  { upstream = respondOk, listenAfterMs = 0, schemeless = false, env = {} } = {},
  fn,
) {
  const dir = await mkdtemp(join(tmpdir(), 'gitnexus-proxy-'));
  await mkdir(join(dir, 'dist'), { recursive: true });
  await writeFile(join(dir, 'dist', 'index.html'), '<html><body>spa</body></html>');

  const ctx = { calls: 0, received: null, body: null, stderr: '', handler: upstream };
  // Read the forwarded request to completion before handing it to the handler,
  // so no test has to repeat that plumbing to assert on headers or body.
  const server = upstream
    ? createServer((req, res) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          ctx.calls += 1;
          ctx.body = body;
          ctx.received = { method: req.method, url: req.url, headers: req.headers, body };
          ctx.handler(req, res);
        });
      })
    : null;

  // A late (or never) bind needs its port reserved up front; otherwise let the
  // OS assign one at listen time.
  const upstreamPort =
    server && listenAfterMs === 0
      ? await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)))
      : await getFreePort();
  const bindTimer =
    server && listenAfterMs > 0
      ? setTimeout(() => server.listen(upstreamPort, '127.0.0.1'), listenAfterMs)
      : null;

  const port = await getFreePort();
  const target = `127.0.0.1:${upstreamPort}`;
  const proc = spawnServerWithEnv(dir, port, {
    GITNEXUS_UPSTREAM_URL: schemeless ? target : `http://${target}`,
    GITNEXUS_SERVE_AUTH_TOKEN: TEST_AUTH_TOKEN,
    ...env,
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk) => {
    ctx.stderr += chunk;
  });
  try {
    await waitForServer(port);
    await fn(port, ctx);
  } finally {
    if (bindTimer) clearTimeout(bindTimer);
    await killAndWait(proc);
    if (server?.listening) {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
    await rm(dir, { recursive: true, force: true });
  }
}

it('proxies /api/* requests to the upstream server', async () => {
  await withProxy({}, async (port, ctx) => {
    const res = await apiRequest(port, '/api/info?x=1');
    assert.equal(res.status, 200);
    assert.match(res.body, /"ok":true/);
    assert.equal(ctx.received.url, '/api/info?x=1', 'path + query forwarded verbatim');
  });
});

it('forwards the request method and body to the upstream', async () => {
  await withProxy({}, async (port, ctx) => {
    await apiRequest(port, '/api/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"q":"hello"}',
    });
    assert.equal(ctx.received.method, 'POST');
    assert.equal(ctx.received.body, '{"q":"hello"}');
  });
});

it('strips the browser Origin and Referer before forwarding to the API', async () => {
  await withProxy({}, async (port, ctx) => {
    await apiRequest(port, '/api/info', {
      headers: { origin: 'https://gitnexus-web.onrender.com', referer: 'https://x/y' },
    });
    assert.equal(
      ctx.received.headers.origin,
      undefined,
      'Origin must be stripped so the API treats it as a trusted server-to-server call',
    );
    assert.equal(ctx.received.headers.referer, undefined, 'Referer must be stripped');
  });
});

it('strips hop-by-hop headers before forwarding to the API', async () => {
  await withProxy({}, async (port, ctx) => {
    await apiRequest(port, '/api/info', {
      headers: {
        'keep-alive': 'timeout=5',
        upgrade: 'h2c',
        'proxy-authorization': 'Basic abc',
        te: 'trailers',
      },
    });
    assert.equal(ctx.received.headers['keep-alive'], undefined);
    assert.equal(ctx.received.headers.upgrade, undefined);
    assert.equal(ctx.received.headers['proxy-authorization'], undefined);
    assert.equal(ctx.received.headers.te, undefined);
  });
});

it('strips request headers that Connection names as single-hop', async () => {
  await withProxy({}, async (port, ctx) => {
    // RFC 7230 §6.1 lets Connection name hop-by-hop headers beyond the
    // well-known eight, and those must not be forwarded either. Against a fixed
    // list alone, x-custom-hop reaches the upstream.
    await apiRequest(port, '/api/info', {
      headers: { connection: 'x-custom-hop', 'x-custom-hop': 'private' },
    });
    assert.equal(ctx.received.headers['x-custom-hop'], undefined);
    // Connection itself is always re-derived by Node for the upstream hop, so
    // assert the client's value didn't survive rather than that it's absent.
    assert.notEqual(ctx.received.headers.connection, 'x-custom-hop');
  });
});

it('collapses a spoofed X-Forwarded-For chain to the load balancer entry when XFF is trusted', async () => {
  const env = { GITNEXUS_PROXY_TRUST_XFF: '1' };
  await withProxy({ env }, async (port, ctx) => {
    // With a load balancer in front, only the last entry is the LB's; the rest
    // is client-supplied and would otherwise let a caller fake req.ip and evade
    // the API's rate limits.
    await apiRequest(port, '/api/info', {
      headers: { 'x-forwarded-for': '10.0.0.1, 1.2.3.4, 203.0.113.9' },
    });
    assert.equal(ctx.received.headers['x-forwarded-for'], '203.0.113.9');
  });
});

it('ignores an inbound X-Forwarded-For chain when GITNEXUS_PROXY_TRUST_XFF is unset', async () => {
  await withProxy({}, async (port, ctx) => {
    // With nothing in front of the proxy, the whole chain is the caller's to
    // write, so popping it would forward an address they chose.
    await apiRequest(port, '/api/info', {
      headers: { 'x-forwarded-for': '10.0.0.1, 1.2.3.4, 203.0.113.9' },
    });
    assert.match(ctx.received.headers['x-forwarded-for'], /127\.0\.0\.1$/);
  });
});

it('ignores an inbound X-Forwarded-For chain when GITNEXUS_PROXY_TRUST_XFF is off', async () => {
  const env = { GITNEXUS_PROXY_TRUST_XFF: 'off' };
  await withProxy({ env }, async (port, ctx) => {
    await apiRequest(port, '/api/info', {
      headers: { 'x-forwarded-for': '203.0.113.9' },
    });
    assert.match(ctx.received.headers['x-forwarded-for'], /127\.0\.0\.1$/);
  });
});

it('warns and falls back to ignoring XFF when GITNEXUS_PROXY_TRUST_XFF is "true"', async () => {
  // Rejected for the same reason resolveTrustProxy rejects it server-side: it
  // reads as "trust everything", the configuration this knob exists to make
  // deliberate.
  const env = { GITNEXUS_PROXY_TRUST_XFF: 'true' };
  await withProxy({ env }, async (port, ctx) => {
    await apiRequest(port, '/api/info', {
      headers: { 'x-forwarded-for': '203.0.113.9' },
    });
    assert.match(ctx.received.headers['x-forwarded-for'], /127\.0\.0\.1$/);
    assert.match(
      ctx.stderr,
      /GITNEXUS_PROXY_TRUST_XFF "true" is not a recognized boolean/,
      'an unrecognized value must warn rather than fail silently',
    );
  });
});

it('forwards the socket peer, not the rotating header, on every authenticated request', async () => {
  // A caller rotating X-Forwarded-For per request earns a fresh limiter key
  // upstream unless this proxy overwrites it. Hitting the API server directly
  // would test its own trust-proxy handling instead of this hop.
  await withProxy({}, async (port, ctx) => {
    const forwarded = [];
    for (const spoofed of ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4']) {
      await apiRequest(port, '/api/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': spoofed },
        body: '{"q":"hi"}',
      });
      forwarded.push(ctx.received.headers['x-forwarded-for']);
    }
    assert.equal(ctx.calls, 4);
    for (const address of forwarded) {
      assert.match(
        address,
        /127\.0\.0\.1$/,
        'every request must key off the socket peer, not the value the client rotated',
      );
    }
  });
});

it('sets X-Forwarded-For from the socket peer when the client sends none', async () => {
  await withProxy({}, async (port, ctx) => {
    await apiRequest(port, '/api/info');
    assert.match(
      ctx.received.headers['x-forwarded-for'],
      /127\.0\.0\.1$/,
      'the API must always see a proxy-derived client address',
    );
  });
});

it('strips hop-by-hop headers from the upstream response', async () => {
  const upstream = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain', Trailer: 'X-Late' });
    res.end('ok');
  };
  await withProxy({ upstream }, async (port) => {
    const res = await apiRequest(port, '/api/info');
    assert.equal(res.status, 200);
    assert.equal(res.headers.trailer, undefined, 'Trailer describes the upstream hop only');
    assert.equal(res.body, 'ok');
  });
});

it('strips response headers that Connection names as single-hop', async () => {
  const upstream = (_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      Connection: 'x-upstream-hop',
      'x-upstream-hop': 'internal',
    });
    res.end('ok');
  };
  await withProxy({ upstream }, async (port) => {
    const res = await apiRequest(port, '/api/info');
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-upstream-hop'], undefined, 'named on the upstream hop only');
  });
});

it('does NOT proxy non-/api routes (still serves the SPA)', async () => {
  await withProxy({}, async (port, ctx) => {
    const res = await rawRequest(port, '/some/app/route');
    assert.equal(res.status, 200);
    assert.match(res.body, /spa/);
    assert.equal(ctx.calls, 0, 'non-/api requests must not reach the upstream');
  });
});

it('streams a chunked upstream response through to the client', async () => {
  const upstream = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: one\n\n');
    setTimeout(() => {
      res.write('data: two\n\n');
      res.end();
    }, 20);
  };
  await withProxy({ upstream }, async (port) => {
    const res = await apiRequest(port, '/api/stream');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/event-stream');
    assert.match(res.body, /data: one/);
    assert.match(res.body, /data: two/);
  });
});

it('accepts a scheme-less host:port upstream (Render fromService hostport)', async () => {
  await withProxy({ schemeless: true }, async (port, ctx) => {
    const res = await apiRequest(port, '/api/info');
    assert.equal(res.status, 200);
    assert.equal(ctx.received.url, '/api/info', 'scheme-less upstream should still be proxied');
  });
});

it('serves RENDER_EXTERNAL_URL as the backend origin when GITNEXUS_BACKEND_URL is unset', async () => {
  await withInjectionServer(
    { RENDER_EXTERNAL_URL: 'https://gitnexus-web.onrender.com' },
    async (port) => {
      const res = await rawGet(port, '/');
      assert.equal(res.status, 200);
      // Assert on the parsed value, not a substring of the page: a bare
      // includes() would also pass if the URL appeared in a comment.
      const injected = /window\.__GITNEXUS_CONFIG__=(\{.*?\});/.exec(res.body)?.[1];
      assert.ok(injected, 'Expected __GITNEXUS_CONFIG__ in response body');
      assert.equal(JSON.parse(injected).backendUrl, 'https://gitnexus-web.onrender.com');
    },
  );
});

it('returns 504 when the upstream does not respond within the timeout', async () => {
  // Upstream accepts the connection but never responds — an idle hang.
  const env = { GITNEXUS_PROXY_TIMEOUT_MS: '300' };
  await withProxy({ upstream: () => {}, env }, async (port) => {
    const res = await apiRequest(port, '/api/info');
    assert.equal(res.status, 504);
  });
});

it('returns 502 when the upstream is unreachable', async () => {
  // Retry disabled so this fails fast (the unreachable-upstream contract).
  const env = { GITNEXUS_PROXY_RETRY_ATTEMPTS: '1' };
  await withProxy({ upstream: null, env }, async (port) => {
    const res = await apiRequest(port, '/api/info');
    assert.equal(res.status, 502);
  });
});

// -- Connection-retry across an upstream restart window ---------------------
//
// `listenAfterMs: 400` binds the upstream late, so the first attempt hits
// ECONNREFUSED and must be retried — a single-instance restart. The default 3
// attempts (backoff 250ms, 500ms) span ~750ms, so a retry lands after the bind.

it('retries a connection-refused POST and succeeds once the upstream is up', async () => {
  await withProxy({ listenAfterMs: 400 }, async (port, ctx) => {
    const res = await apiRequest(port, '/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"repo":"x"}',
    });
    assert.equal(res.status, 200, 'first attempt should ride out the restart gap');
    assert.match(res.body, /"ok":true/);
    assert.equal(ctx.calls, 1, 'upstream must run the job exactly once (no double-execute)');
    assert.equal(ctx.body, '{"repo":"x"}', 'buffered body replayed intact');
  });
});

it('retries a bodyless DELETE, which frames no body to replay', async () => {
  // Retry eligibility follows RFC 7230 §3.3.3 framing. A DELETE with neither
  // Content-Length nor Transfer-Encoding has nothing to buffer, so it replays
  // safely even though it isn't a GET.
  await withProxy({ listenAfterMs: 400 }, async (port, ctx) => {
    const res = await apiRequest(port, '/api/repo', { method: 'DELETE' });
    assert.equal(res.status, 200, 'a bodyless DELETE must ride out the restart gap');
    assert.equal(ctx.calls, 1);
  });
});

it('falls back to the default retry budget when the knob is out of range', async () => {
  // A negative attempt count is a typo. Obeying it would turn every restart
  // window into a 502, silently.
  const env = { GITNEXUS_PROXY_RETRY_ATTEMPTS: '-1' };
  await withProxy({ listenAfterMs: 400, env }, async (port, ctx) => {
    const res = await apiRequest(port, '/api/info');
    assert.equal(res.status, 200);
    assert.equal(ctx.calls, 1);
  });
});

it('warns and keeps the default when a timeout knob is negative', async () => {
  const env = { GITNEXUS_PROXY_TIMEOUT_MS: '-1' };
  await withProxy({ upstream: null, env }, async (_port, ctx) => {
    // Every consumer reads <= 0 as "disabled", so an unvalidated -1 removes the
    // idle timeout and lets a proxied request hang forever.
    assert.match(
      ctx.stderr,
      /GITNEXUS_PROXY_TIMEOUT_MS "-1" is below the minimum 0 -- using 120000/,
    );
  });
});

it('does NOT retry after the client aborts during the backoff window', async () => {
  // The client aborts (~100ms) while a retry is pending, before the upstream
  // binds (~400ms). The backoff guard must cancel it — otherwise the retry
  // lands after the bind and runs a job nobody is waiting on.
  await withProxy({ listenAfterMs: 400 }, async (port, ctx) => {
    await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: '/api/analyze',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': '12',
          authorization: TEST_BEARER,
        },
      });
      req.on('error', () => {}); // aborting surfaces a local socket error; ignore
      req.write('{"repo":"x"}');
      req.end();
      // Abort after the first attempt has failed-and-scheduled (ECONNREFUSED is
      // near-instant) but well before the upstream binds at ~400ms.
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 100);
    });
    // Wait past the upstream bind + full retry budget (~750ms) so a leaked retry
    // would already have landed.
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(ctx.calls, 0, 'aborted request must not be retried against the upstream');
  });
});

it('returns 502 after exhausting the retry budget when the upstream stays down', async () => {
  const env = { GITNEXUS_PROXY_RETRY_ATTEMPTS: '3' };
  await withProxy({ upstream: null, env }, async (port) => {
    const res = await apiRequest(port, '/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"repo":"x"}',
    });
    assert.equal(res.status, 502, 'genuinely-down upstream still returns 502 after the budget');
  });
});

it('does NOT retry a POST that connects then resets before responding', async () => {
  // The upstream accepts the connection, reads the whole request, then dies
  // before sending any response byte — an instance that received the job and
  // crashed/restarted mid-flight. Because the reset arrives AFTER connecting and
  // POST is non-idempotent, replaying could run the job twice, so the proxy must
  // NOT retry: the upstream sees exactly one call and the browser gets 502.
  const upstream = (_req, res) => res.socket.destroy();
  const env = { GITNEXUS_PROXY_RETRY_ATTEMPTS: '3' };
  await withProxy({ upstream, env }, async (port, ctx) => {
    const res = await apiRequest(port, '/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"repo":"x"}',
    });
    assert.equal(res.status, 502, 'post-connection reset on a POST fails fast, no retry');
    // Give any (erroneous) retry a chance to fire before asserting.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(
      ctx.calls,
      1,
      'non-idempotent POST must not be replayed after the upstream got it',
    );
  });
});

it('does NOT retry after the upstream starts streaming, then drops mid-body', async () => {
  // Send headers + a partial body, then abruptly destroy the socket.
  const upstream = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"partial":');
    setTimeout(() => res.socket.destroy(), 20);
  };
  const env = { GITNEXUS_PROXY_RETRY_ATTEMPTS: '3' };
  await withProxy({ upstream, env }, async (port, ctx) => {
    // Settle on end OR on the mid-body abort/error, so the dropped connection
    // can't hang the test. What matters is that the proxy did NOT replay the
    // request (no duplicate job): the upstream must see exactly 1 call.
    await new Promise((resolve) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/analyze',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': '12',
            authorization: TEST_BEARER,
          },
        },
        (res) => {
          res.on('data', () => {});
          res.on('end', resolve);
          res.on('aborted', resolve);
          res.on('error', resolve);
        },
      );
      req.on('error', resolve);
      req.write('{"repo":"x"}');
      req.end();
    });
    // Give any (erroneous) retry a chance to fire before asserting.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(ctx.calls, 1, 'must not replay once the response body has started');
  });
});

it('does NOT buffer or retry a body larger than the retry cap', async () => {
  // Tiny cap so a modest body exceeds it and is streamed, not buffered.
  const env = { GITNEXUS_PROXY_RETRY_MAX_BODY_BYTES: '16' };
  const bigBody = 'x'.repeat(1024);
  await withProxy({ env }, async (port, ctx) => {
    const res = await apiRequest(port, '/api/analyze/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: bigBody,
    });
    assert.equal(res.status, 200, 'over-cap body is streamed straight through');
    assert.equal(ctx.body.length, bigBody.length, 'full body reaches upstream (not capped)');
  });
});

it('returns 400 when the client declares a body but never finishes sending it', async () => {
  // A live upstream, so a failure to reach it can't be mistaken for the body
  // timeout. It must see zero requests: the proxy never connects because the
  // buffering read times out first. The dedicated knob is set (leaving the
  // upstream idle timeout at its default) to prove the two tune independently.
  const env = { GITNEXUS_PROXY_CLIENT_BODY_TIMEOUT_MS: '300' };
  await withProxy({ env }, async (port, ctx) => {
    // Raw socket (not http.request, which would auto-finish the body): send a
    // Content-Length: 100 request but only 10 bytes, then hold the socket open.
    // We never close our side — the proxy must close it for us once the body
    // read times out (via `Connection: close`), rather than holding the
    // half-open connection until the server requestTimeout reaps it.
    const { status, serverClosed, raw } = await new Promise((resolve) => {
      const sock = connect(port, '127.0.0.1', () => {
        sock.write(
          'POST /api/analyze HTTP/1.1\r\n' +
            'Host: 127.0.0.1\r\n' +
            'Content-Type: application/json\r\n' +
            `Authorization: ${TEST_BEARER}\r\n` +
            'Content-Length: 100\r\n' +
            '\r\n' +
            'x'.repeat(10), // fewer than 100 bytes, then stall
        );
      });
      let buf = '';
      let status = null;
      // Fail-safe: if the proxy never closes on its own, report serverClosed
      // false (so the assertion fails cleanly) instead of hanging the test.
      const guard = setTimeout(() => {
        sock.destroy();
        resolve({ status, serverClosed: false, raw: buf });
      }, 2000);
      sock.setEncoding('utf8');
      sock.on('data', (chunk) => {
        buf += chunk;
        if (status === null) {
          const m = buf.split('\r\n', 1)[0].match(/^HTTP\/\d\.\d (\d{3})/);
          if (m) status = Number(m[1]);
        }
      });
      // The server closing its side (Connection: close) ends our socket; treat
      // any teardown initiated by the server as "closed promptly".
      sock.on('error', () => {}); // a reset may precede 'close'; swallow it
      sock.on('close', () => {
        clearTimeout(guard);
        resolve({ status, serverClosed: true, raw: buf });
      });
    });
    assert.equal(status, 400, 'stalled body read must be bounded and return 400, not hang');
    assert.ok(
      serverClosed,
      'proxy must close the half-open connection promptly, not hold it until requestTimeout',
    );
    assert.match(
      raw.toLowerCase(),
      /connection: close/,
      'the 400 for a stalled body must advertise Connection: close',
    );
    assert.equal(ctx.calls, 0, 'proxy must not connect upstream when the body never arrives');
  });
});

// -- Token gate at the public edge (GITNEXUS_SERVE_AUTH_TOKEN) --------------
//
// The proxy terminates the browser Origin, so the API's own write guard can't
// see a cross-site request coming. The token replaces it, checked on the way in.

it('answers an /api/* request with no Authorization header with a well-formed 401', async () => {
  await withProxy({}, async (port, ctx) => {
    const res = await rawRequest(port, '/api/health');
    assert.equal(res.status, 401);
    assert.equal(res.headers['www-authenticate'], 'Bearer');
    assert.match(res.headers['content-type'], /application\/json/);
    // The UI dispatches on the stable code, not on message text.
    assert.deepEqual(JSON.parse(res.body), { error: 'unauthorized', code: 'unauthorized' });
    assert.equal(ctx.calls, 0, 'an unauthenticated request must cost nothing upstream');
  });
});

it('closes the connection on a rejected request rather than draining its body', async () => {
  // The 401 is answered before the body is read, so without Connection: close
  // Node drains up to 64KB of an unauthenticated upload to keep the socket
  // reusable. Same reasoning as the stalled-body 400 above.
  await withProxy({}, async (port, ctx) => {
    const res = await rawRequest(port, '/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/etc' }),
    });
    assert.equal(res.status, 401);
    assert.equal(res.headers.connection, 'close');
    assert.equal(ctx.calls, 0);
  });
});

it('rejects a wrong token of the same length', async () => {
  await withProxy({}, async (port, ctx) => {
    const wrong = 'x'.repeat(TEST_AUTH_TOKEN.length);
    const res = await apiRequest(port, '/api/health', {
      headers: { authorization: `Bearer ${wrong}` },
    });
    assert.equal(res.status, 401);
    assert.equal(ctx.calls, 0);
  });
});

it('rejects a wrong token of a different length', async () => {
  // The unequal-length branch takes a different path through the comparison
  // (dummy compare, no timingSafeEqual on the real buffers) and still must 401.
  await withProxy({}, async (port, ctx) => {
    const res = await apiRequest(port, '/api/health', {
      headers: { authorization: 'Bearer short' },
    });
    assert.equal(res.status, 401);
    assert.equal(ctx.calls, 0);
  });
});

it('rejects the raw token without the Bearer prefix', async () => {
  await withProxy({}, async (port, ctx) => {
    const res = await apiRequest(port, '/api/health', {
      headers: { authorization: TEST_AUTH_TOKEN },
    });
    assert.equal(res.status, 401);
    assert.equal(ctx.calls, 0);
  });
});

it('forwards an /api/* request that carries the correct token', async () => {
  await withProxy({}, async (port, ctx) => {
    const res = await apiRequest(port, '/api/health', {
      headers: { authorization: TEST_BEARER },
    });
    assert.equal(res.status, 200);
    assert.equal(ctx.calls, 1);
  });
});

it('strips the Authorization header instead of forwarding the edge token', async () => {
  // The token is spent at this hop. `serve` reads no Authorization header, so
  // forwarding would only copy a live credential into another service's logs.
  await withProxy({}, async (port, ctx) => {
    const res = await apiRequest(port, '/api/mcp', { method: 'POST', body: '{}' });
    assert.equal(res.status, 200, 'the request itself must still be proxied');
    assert.equal(ctx.received.headers.authorization, undefined);
  });
});

it('never gates static assets behind the token', async () => {
  // The UI has to load before it can prompt for a token.
  await withProxy({}, async (port, ctx) => {
    for (const path of ['/', '/index.html', '/some/app/route']) {
      const res = await rawRequest(port, path);
      assert.equal(res.status, 200, `${path} must be served without a token`);
      assert.match(res.body, /spa/);
    }
    assert.equal(ctx.calls, 0);
  });
});

// Run docker-server.mjs to completion and report how it exited. Used for the
// boot-time refusal, which never reaches a listening state.
function runUntilExit(cwd, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [serverScript], {
      cwd,
      env: { ...process.env, ...env },
      stdio: 'pipe',
    });
    let stderr = '';
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    proc.on('error', reject);
    proc.on('exit', (code) => resolve({ code, stderr }));
    // A server that starts instead of refusing never exits, so name that failure
    // here rather than letting it surface as a timeout or a null exit code.
    setTimeout(() => {
      proc.kill();
      reject(new Error('docker-server.mjs kept running; it was expected to refuse and exit'));
    }, 5000).unref();
  });
}

async function withDistDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'gitnexus-boot-'));
  await mkdir(join(dir, 'dist'), { recursive: true });
  await writeFile(join(dir, 'dist', 'index.html'), '<html><body>spa</body></html>');
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

it('refuses to start when the proxy is enabled without a token', async () => {
  await withDistDir(async (dir) => {
    const port = await getFreePort();
    const { code, stderr } = await runUntilExit(dir, {
      PORT: String(port),
      GITNEXUS_UPSTREAM_URL: '127.0.0.1:4747',
      GITNEXUS_SERVE_AUTH_TOKEN: undefined,
    });
    assert.equal(code, 1, 'an unauthenticated public proxy must fail closed at boot');
    assert.match(stderr, /Refusing to start/);
    assert.match(stderr, /GITNEXUS_SERVE_AUTH_TOKEN/);
  });
});

it('refuses to start when the token is short enough to guess', async () => {
  // Nothing rate-limits a failed token, so a weak one is guessable at network
  // speed. The floor is what makes the missing limiter safe.
  await withDistDir(async (dir) => {
    const port = await getFreePort();
    const { code, stderr } = await runUntilExit(dir, {
      PORT: String(port),
      GITNEXUS_UPSTREAM_URL: '127.0.0.1:4747',
      GITNEXUS_SERVE_AUTH_TOKEN: 'hunter2',
    });
    assert.equal(code, 1);
    assert.match(stderr, /shorter than 32 characters/);
    assert.ok(!stderr.includes('hunter2'), 'the refusal must never echo the token');
  });
});

it('treats a whitespace-only token as absent rather than as a short one', async () => {
  // '   ' trims to empty, so this must hit the missing-token refusal, not the
  // length one.
  await withDistDir(async (dir) => {
    const port = await getFreePort();
    const { code, stderr } = await runUntilExit(dir, {
      PORT: String(port),
      GITNEXUS_UPSTREAM_URL: '127.0.0.1:4747',
      GITNEXUS_SERVE_AUTH_TOKEN: '   ',
    });
    assert.equal(code, 1);
    assert.match(stderr, /is set without GITNEXUS_SERVE_AUTH_TOKEN/);
  });
});

it('starts normally with neither the proxy nor a token configured', async () => {
  // docker-compose's default: static assets only, nothing to gate, no refusal.
  await withDistDir(async (dir) => {
    const port = await getFreePort();
    const proc = spawnServerWithEnv(dir, port, { GITNEXUS_SERVE_AUTH_TOKEN: undefined });
    try {
      await waitForServer(port);
      const res = await rawRequest(port, '/');
      assert.equal(res.status, 200);
      assert.match(res.body, /spa/);
    } finally {
      await killAndWait(proc);
    }
  });
});
