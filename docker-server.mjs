import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, isAbsolute, normalize, relative, resolve } from 'node:path';

const host = '0.0.0.0';
const port = Number(process.env.PORT || '4173');
const root = resolve(process.cwd(), 'dist');

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
// Path-injection containment: the request handler is intentionally a single
// inline pipeline with no helper functions on the path-data flow. Each
// filesystem sink (stat, createReadStream) is immediately preceded by the
// canonical `path.relative` containment check that CodeQL's
// `js/path-injection` query recognizes as a sanitizer barrier:
//
//     const rel = relative(root, candidate);
//     if (rel.startsWith('..') || isAbsolute(rel)) reject;
//     // candidate is now proven inside `root`
//
// Earlier iterations of this file used a helper (`resolveWithinRoot`) and a
// `startsWith(root + sep)` check. Both were semantically correct but neither
// was recognized by CodeQL: `startsWith(root + sep)` is not in the analyzer's
// barrier-pattern set, and helper-based sanitization is not followed across
// the request handler's reassignment paths in vanilla JS. The inline-at-sink
// shape below is the documented analyzer-friendly idiom.
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

    // Sanitizer barrier #2 — guards both the second stat() and the
    // createReadStream() sinks. No reassignment of finalPath happens
    // between this guard and either sink, so the analyzer can prove
    // containment for both.
    const finalRel = relative(root, finalPath);
    if (finalRel.startsWith('..') || isAbsolute(finalRel)) {
      res.writeHead(400);
      res.end('Bad request');
      return;
    }

    const finalStat = await stat(finalPath).catch(() => null);
    if (!finalStat?.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    res.writeHead(200, {
      'Cache-Control': finalPath.includes('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
      'Content-Type': contentTypes[extname(finalPath)] || 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    const stream = createReadStream(finalPath);
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
