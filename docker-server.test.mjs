import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
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
