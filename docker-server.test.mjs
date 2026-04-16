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

after(async () => {
  child?.kill();
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

it('returns 404 when dist/index.html is missing', async () => {
  await unlink(join(tmpDir, 'dist', 'index.html'));
  const res = await rawGet(serverPort, '/nonexistent-page');
  assert.equal(res.status, 404);
});
