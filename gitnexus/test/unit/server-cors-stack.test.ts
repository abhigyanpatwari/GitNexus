/**
 * Regression tests for createServer() CORS + PNA middleware (Express 5).
 *
 * Express 5 / path-to-regexp v8 rejects bare `app.options('*')`, which broke
 * `gitnexus serve` in CI after #872. These tests mirror the registration order
 * in createServer() without booting LadybugDB or MCP.
 */
import express from 'express';
import cors from 'cors';
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { isAllowedOrigin } from '../../src/server/api.js';

/** Mirrors createServer() trust proxy + PNA + cors + json stack. */
const buildCreateServerCorsStack = (): express.Express => {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    next();
  });
  app.use(
    cors({
      origin: (origin, callback) => {
        callback(null, isAllowedOrigin(origin));
      },
    }),
  );
  app.use(express.json({ limit: '10mb' }));
  return app;
};

describe('createServer CORS/PNA stack — Express 5 registration', () => {
  it('registers without path-to-regexp wildcard errors', () => {
    expect(() => buildCreateServerCorsStack()).not.toThrow();
  });
});

describe('createServer CORS/PNA stack — OPTIONS preflight', () => {
  let server: http.Server | undefined;
  let baseUrl = '';

  afterEach(
    () =>
      new Promise<void>((resolve, reject) => {
        if (!server) {
          resolve();
          return;
        }
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  );

  const start = (app: express.Express): Promise<void> =>
    new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server!.address();
        if (typeof addr === 'object' && addr) {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });

  it('OPTIONS /api/repos includes PNA and ACAO for allowed origin', async () => {
    const app = buildCreateServerCorsStack();
    await start(app);

    const res = await fetch(`${baseUrl}/api/repos`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://gitnexus.vercel.app',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Private-Network': 'true',
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://gitnexus.vercel.app');
    expect(res.headers.get('access-control-allow-private-network')).toBe('true');
  });

  it('OPTIONS / includes PNA header for localhost bridge', async () => {
    const app = buildCreateServerCorsStack();
    await start(app);

    const res = await fetch(`${baseUrl}/`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Private-Network': 'true',
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(res.headers.get('access-control-allow-private-network')).toBe('true');
  });
});
