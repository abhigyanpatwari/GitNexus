import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';

const host = '0.0.0.0';
const port = Number(process.env.PORT || '4173');
const root = join(process.cwd(), 'dist');

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

function resolvePath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const cleanPath = normalize(decoded.replace(/^\/+/, ''));
  const candidate = join(root, cleanPath);
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  return candidate;
}

const server = createServer(async (req, res) => {
  const requestPath = req.url?.split('?')[0] || '/';
  let filePath = resolvePath(requestPath);

  if (!filePath) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  try {
    const fileStat = await stat(filePath).catch(() => null);
    if (fileStat?.isDirectory()) {
      filePath = join(filePath, 'index.html');
    } else if (!fileStat?.isFile()) {
      filePath = join(root, 'index.html');
    }

    const finalStat = await stat(filePath).catch(() => null);
    if (!finalStat?.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    res.writeHead(200, {
      'Cache-Control': filePath.includes('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
      'Content-Type': contentTypes[extname(filePath)] || 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    const stream = createReadStream(filePath);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  } catch (error) {
    res.writeHead(500);
    res.end(error instanceof Error ? error.message : 'Internal server error');
  }
});

server.listen(port, host, () => {
  console.log(`gitnexus-web listening on http://${host}:${port}`);
});
