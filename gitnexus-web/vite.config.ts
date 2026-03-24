import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import path from 'path';
import {
  getConfiguredGitHostPatterns,
  isGitHostAllowed,
  MAX_PROXY_REQUEST_BODY_BYTES,
} from './api/proxy-utils';

const gitProxyCorsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Git-Protocol, Accept',
};

const isAllowedGitProxyTarget = (
  url: URL,
  env: Record<string, string | undefined> = process.env
): boolean => {
  if (url.protocol !== 'https:') return false;

  const configuredHosts = getConfiguredGitHostPatterns();
  if (isGitHostAllowed(url.hostname, configuredHosts)) return true;

  return env.GITNEXUS_DEV_ALLOW_ALL_HOSTS === '1';
};

const writeJson = (
  res: { statusCode: number; setHeader: (key: string, value: string) => void; end: (chunk?: string | Buffer) => void },
  statusCode: number,
  payload: Record<string, string>
) => {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
};

const readRequestBody = async (
  req: AsyncIterable<Buffer | string>
): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_PROXY_REQUEST_BODY_BYTES) {
      throw new Error('Request body too large');
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
};

const createGitProxyMiddleware = () => async (
  req: {
    url?: string;
    method?: string;
    headers: Record<string, string | string[] | undefined>;
    [Symbol.asyncIterator]?: () => AsyncIterableIterator<Buffer | string>;
  },
  res: {
    statusCode: number;
    setHeader: (key: string, value: string) => void;
    end: (chunk?: string | Buffer) => void;
  },
  next: () => void
) => {
  const isProxyRoute = req.url === '/api/proxy' || req.url?.startsWith('/api/proxy?');
  if (!isProxyRoute) {
    next();
    return;
  }

  if (req.method === 'OPTIONS') {
    Object.entries(gitProxyCorsHeaders).forEach(([key, value]) => res.setHeader(key, value));
    res.statusCode = 200;
    res.end();
    return;
  }

  const requestUrl = new URL(req.url, 'http://localhost');
  const targetUrl = requestUrl.searchParams.get('url');

  if (!targetUrl) {
    writeJson(res, 400, { error: 'Missing url query parameter' });
    return;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    writeJson(res, 400, { error: 'Invalid URL' });
    return;
  }

  if (!isAllowedGitProxyTarget(parsedUrl)) {
    writeJson(res, 403, {
      error: `Git host "${parsedUrl.hostname}" is not allowed. Set GITNEXUS_ALLOWED_GIT_HOSTS or GITNEXUS_DEV_ALLOW_ALL_HOSTS=1 for local dev.`,
    });
    return;
  }

  try {
    const headers: Record<string, string> = {
      'User-Agent': 'git/isomorphic-git',
    };

    if (typeof req.headers.authorization === 'string') {
      headers['Authorization'] = req.headers.authorization;
    }
    if (typeof req.headers['content-type'] === 'string') {
      headers['Content-Type'] = req.headers['content-type'];
    }
    if (typeof req.headers['git-protocol'] === 'string') {
      headers['Git-Protocol'] = req.headers['git-protocol'];
    }
    if (typeof req.headers.accept === 'string') {
      headers['Accept'] = req.headers.accept;
    }

    let body: Buffer | undefined;
    if (req.method === 'POST' && req[Symbol.asyncIterator]) {
      body = await readRequestBody(req as AsyncIterable<Buffer | string>);
    }

    const response = await fetch(targetUrl, {
      method: req.method || 'GET',
      headers,
      body: body as unknown as BodyInit | undefined,
    });

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', '*');

    const skipHeaders = ['content-encoding', 'transfer-encoding', 'connection', 'www-authenticate'];
    response.headers.forEach((value, key) => {
      if (!skipHeaders.includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });

    res.statusCode = response.status;
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    if (error instanceof Error && error.message === 'Request body too large') {
      writeJson(res, 413, { error: 'Proxy request body exceeds 256 MB limit' });
      return;
    }

    writeJson(res, 500, { error: 'Proxy request failed', details: String(error) });
  }
};

const attachGitProxy = (
  server: { middlewares: { use: (handler: ReturnType<typeof createGitProxyMiddleware>) => void } }
) => {
  server.middlewares.use(createGitProxyMiddleware());
};

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    wasm(),
    topLevelAwait(),
    // Copy lbug-wasm worker file to assets folder for production
    viteStaticCopy({
      targets: [
        {
          src: 'node_modules/@ladybugdb/wasm-core/lbug_wasm_worker.js',
          dest: 'assets'
        }
      ]
    }),
    {
      name: 'gitnexus-git-proxy',
      configureServer(server) {
        attachGitProxy(server);
      },
      configurePreviewServer(server) {
        attachGitProxy(server);
      },
    },
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Fix for Rollup failing to resolve this deep import from @langchain/anthropic
      '@anthropic-ai/sdk/lib/transform-json-schema': path.resolve(__dirname, 'node_modules/@anthropic-ai/sdk/lib/transform-json-schema.mjs'),
      // Fix for mermaid d3-color prototype crash on Vercel (known issue with mermaid 10.9.0+ and Vite)
      'mermaid': path.resolve(__dirname, 'node_modules/mermaid/dist/mermaid.esm.min.mjs'),
    },
  },
  // Polyfill Buffer for isomorphic-git (Node.js API needed in browser)
  define: {
    global: 'globalThis',
  },
  // Optimize deps - exclude lbug-wasm from pre-bundling (it has WASM files)
  optimizeDeps: {
    exclude: ['@ladybugdb/wasm-core'],
    include: ['buffer'],
  },
  // Required for LadybugDB WASM (SharedArrayBuffer needs Cross-Origin Isolation)
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    // Allow serving files from node_modules
    fs: {
      allow: ['..'],
    },
  },
  // Also set for preview/production builds
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  // Worker configuration
  worker: {
    format: 'es',
    plugins: () => [wasm(), topLevelAwait()],
  },
});
