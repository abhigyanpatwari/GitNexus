import express from 'express';
import http from 'node:http';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { hasLadybugNative } from '../helpers/ladybug-native.js';

const WRITE_QUERY_TEST_CYPHER =
  "CREATE (n:Function {id: 'api-write-test', name: 'api-write-test', filePath: '', startLine: 0, endLine: 0, isExported: false, content: '', description: ''})";

const startServer = (app: express.Express): Promise<{ server: http.Server; baseUrl: string }> =>
  new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('Failed to start test server');
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });

const stopServer = (server: http.Server): Promise<void> =>
  new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));

withTestLbugDB(
  'api-query-http',
  (handle) => {
    describe.skipIf(!hasLadybugNative())('/api/query runtime contract', () => {
      let server: http.Server;
      let baseUrl = '';
      let handleQueryRequest: typeof import('../../src/server/api.js').handleQueryRequest;

      beforeAll(async () => {
        ({ handleQueryRequest } = await import('../../src/server/api.js'));
        const app = express();
        app.use(express.json());
        app.post('/api/query', async (req, res) => {
          await handleQueryRequest(req, res, async () => ({
            storagePath: handle.tmpHandle.dbPath,
          }));
        });
        ({ server, baseUrl } = await startServer(app));
      });

      afterAll(async () => {
        await stopServer(server);
      });

      it('returns 200 for a valid read query', async () => {
        const response = await fetch(`${baseUrl}/api/query`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cypher: 'RETURN 1 AS one' }),
        });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(Array.isArray(body.result)).toBe(true);
        expect(body.result[0].one).toBe(1);
      });

      it('returns 403 for a write query on read-only HTTP path', async () => {
        const response = await fetch(`${baseUrl}/api/query`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            cypher: WRITE_QUERY_TEST_CYPHER,
          }),
        });
        expect(response.status).toBe(403);
        const body = await response.json();
        expect(body.error).toContain('Write queries are not allowed');
      });

      it('returns 400 for invalid params payload', async () => {
        const response = await fetch(`${baseUrl}/api/query`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cypher: 'RETURN 1 AS one', params: [1, 2, 3] }),
        });
        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error).toContain('"params"');
      });

      it('returns 400 when cypher is missing', async () => {
        const response = await fetch(`${baseUrl}/api/query`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        });
        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error).toContain('Missing "cypher"');
      });
    });
  },
  {
    poolAdapter: false,
  },
);
