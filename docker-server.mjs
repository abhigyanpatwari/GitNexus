import { open, stat } from 'node:fs/promises';
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
// Path-injection containment: each filesystem sink is preceded by the
// canonical `path.relative` containment check that CodeQL recognizes as
// a sanitizer barrier.
//
// TOCTOU prevention: after the path barrier, the file is opened once via
// fs.promises.open() and all subsequent operations (stat, readFile,
// createReadStream) use the file handle, eliminating any race between
// the existence check and the read.
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

  // Sanitizer barrier #1 — guards the first stat() sink.
  const initialRel = relative(root, initialPath);
  if (initialRel.startsWith('..') || isAbsolute(initialRel)) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  let handle;
  try {
    const initialStat = await stat(initialPath).catch(() => null);

    // Pick the path we actually serve. Note: any branch reassigns to a
    // freshly-resolved path; the next sanitizer barrier re-validates.
    let finalPath;
    if (initialStat?.isDirectory()) {
      finalPath = resolve(initialPath, 'index.html');
    } else if (!initialStat?.isFile()) {
      finalPath = resolve(root, 'index.html');
    } else {
      finalPath = initialPath;
    }

    // Sanitizer barrier #2 — guards the open() sink below. No
    // reassignment of finalPath happens between this guard and the
    // open(), so the analyzer can prove containment.
    const finalRel = relative(root, finalPath);
    if (finalRel.startsWith('..') || isAbsolute(finalRel)) {
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
    const finalStat = await handle.stat();
    if (!finalStat.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
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
