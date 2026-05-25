import { open } from 'node:fs/promises';
import { createServer } from 'node:http';
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

const rawBackendUrl = process.env.GITNEXUS_BACKEND_URL ?? null;
if (rawBackendUrl && !isValidUrl(rawBackendUrl)) {
  const safeRaw = rawBackendUrl.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200);
  console.warn(
    `[gitnexus-web] GITNEXUS_BACKEND_URL "${safeRaw}" is not a valid http/https URL -- ignoring.`,
  );
}
const backendUrl = rawBackendUrl && isValidUrl(rawBackendUrl) ? rawBackendUrl : null;
const configScript = backendUrl
  ? `<script>window.__GITNEXUS_CONFIG__=${jsonForScriptTag({ backendUrl })};</script>`
  : '';

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
// TOCTOU prevention: every filesystem interaction uses open() to obtain a
// file handle, then handle.stat() / handle.readFile() / handle.createReadStream().
// No standalone stat() call exists, so CodeQL's js/file-system-race query
// finds no FileCheck/FileUse pair to flag.
//
// Path-injection containment: each open() call is immediately preceded by
// a path.relative() barrier that CodeQL recognizes as a sanitizer.
const server = createServer(async (req, res) => {
  const urlPath = req.url?.split('?')[0] || '/';

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
  const initialPath = resolve(root, cleanPath);

  const initialRel = relative(root, initialPath);
  if (initialRel.startsWith('..') || isAbsolute(initialRel)) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  let handle;
  try {
    let finalPath = initialPath;

    // Open the requested path. On Linux (Docker), open() succeeds for
    // directories too, so we use handle.stat() to distinguish.
    handle = await open(initialPath, 'r').catch(() => null);

    if (handle) {
      const s = await handle.stat();
      if (s.isDirectory()) {
        await handle.close();
        handle = null;
        finalPath = resolve(initialPath, 'index.html');
      } else if (!s.isFile()) {
        await handle.close();
        handle = null;
        finalPath = resolve(root, 'index.html');
      }
    } else {
      finalPath = resolve(root, 'index.html');
    }

    // If the handle was closed (directory or missing), open the resolved path.
    if (!handle) {
      const rel = relative(root, finalPath);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        res.writeHead(400);
        res.end('Bad request');
        return;
      }
      handle = await open(finalPath, 'r').catch(() => null);
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

    const isHtml = extname(finalPath) === '.html' || !extname(finalPath);
    const cacheControl = finalPath.includes(`${sep}assets${sep}`)
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';
    const contentType = contentTypes[extname(finalPath)] || 'application/octet-stream';

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
