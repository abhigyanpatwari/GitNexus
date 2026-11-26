import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getNodesByLabel,
  getRelationships,
  runPipelineFromRepo,
} from '../integration/resolvers/helpers.js';

describe('framework receiver provenance through ingestion', () => {
  it('does not attribute a shadowing handler parameter to a global function', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-route-handler-shadow-'));
    try {
      fs.writeFileSync(
        path.join(root, 'server.ts'),
        `
        import express from 'express';
        function handler() {}
        function install(handler) { const app = express(); app.get('/shadow', handler); }
      `,
      );
      const result = await runPipelineFromRepo(root, () => {});
      expect(getNodesByLabel(result, 'Route')).toContain('/shadow');
      const edges = getRelationships(result, 'HANDLES_ROUTE').filter(
        (edge) => edge.target === '/shadow',
      );
      expect(edges).toHaveLength(1);
      expect(result.graph.getNode(edges[0].rel.sourceId)?.label).toBe('File');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60000);

  it('preserves framework registration priority over a same-file data route table', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-route-source-priority-'));
    try {
      fs.writeFileSync(
        path.join(root, 'server.ts'),
        `
        import express from 'express';
        const app = express();
        function frameworkHandler() {} function tableHandler() {}
        const routes = [{ path: '/same', method: 'GET', handler: tableHandler }];
        app.get('/same', frameworkHandler);
      `,
      );
      const result = await runPipelineFromRepo(root, () => {});
      const handlers = getRelationships(result, 'HANDLES_ROUTE').filter(
        (edge) => edge.target === '/same' && edge.sourceLabel === 'Function',
      );
      expect(handlers.map((edge) => edge.source)).toEqual(['frameworkHandler']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60000);

  it('preserves cross-file declaration priority when a later registration is a data table', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-route-file-priority-'));
    try {
      for (const file of ['a.ts', 'b.ts'])
        fs.writeFileSync(
          path.join(root, file),
          `
        import express from 'express'; const app = express();
        function handler() {} app.get('/same', handler);
      `,
        );
      const first = await runPipelineFromRepo(root, () => {});
      const winner = getRelationships(first, 'HANDLES_ROUTE').find(
        (edge) => edge.target === '/same' && edge.sourceLabel === 'File',
      )!.sourceFilePath;
      const loser = winner === 'a.ts' ? 'b.ts' : 'a.ts';
      fs.writeFileSync(
        path.join(root, loser),
        `
        function handler() {}
        const routes = [{ path: '/same', method: 'GET', handler }];
      `,
      );
      const changed = await runPipelineFromRepo(root, () => {});
      expect(
        getRelationships(changed, 'HANDLES_ROUTE')
          .filter((edge) => edge.target === '/same' && edge.sourceLabel === 'File')
          .map((edge) => edge.sourceFilePath),
      ).toEqual([winner]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60000);

  it('keeps proven Hono routes and static mounts alongside unresolved Express mounts', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-route-dynamic-mount-'));
    try {
      fs.writeFileSync(
        path.join(root, 'server.ts'),
        `
        import express from 'express'; import { Hono } from 'hono';
        const app = express(); const hidden = express.Router(); const mixed = express.Router();
        function handler() {}
        hidden.get('/hidden', handler); mixed.get('/visible', handler);
        app.use(runtimePrefix, hidden); app.use(runtimePrefix, mixed); app.use('/static', mixed);
        const edge = new Hono(); edge.get('/hono', handler);
      `,
      );
      const result = await runPipelineFromRepo(root, () => {});
      expect(getNodesByLabel(result, 'Route').sort()).toEqual(['/hono', '/static/visible']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60000);

  it('honors configured local modules that shadow a framework package specifier', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-route-package-shadow-'));
    try {
      fs.writeFileSync(
        path.join(root, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { baseUrl: '.', paths: { express: ['./local.ts'] } },
        }),
      );
      fs.writeFileSync(
        path.join(root, 'local.ts'),
        `export default function storage() { return new Map(); }`,
      );
      fs.writeFileSync(
        path.join(root, 'server.ts'),
        `
        import express from 'express'; import { Hono } from 'hono';
        const storage = express(); storage.get('/not-http', 'fallback');
        const edge = new Hono(); edge.get('/hono', () => {});
      `,
      );
      const result = await runPipelineFromRepo(root, () => {});
      expect(getNodesByLabel(result, 'Route')).toEqual(['/hono']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60000);

  it('uses the mount prefix for an Express Router endpoint', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-route-mount-'));
    try {
      fs.writeFileSync(
        path.join(root, 'server.ts'),
        `
        import express from 'express';
        const app = express();
        const router = express.Router();
        router.get('/users', handler);
        app.use('/api', router);
        function handler() {}
      `,
      );
      const result = await runPipelineFromRepo(root, () => {});
      expect(getNodesByLabel(result, 'Route').sort()).toEqual(['/api/users']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60000);

  it('keeps the proven Express endpoint and rejects an unrelated storage method', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-route-provenance-'));
    try {
      fs.writeFileSync(
        path.join(root, 'server.ts'),
        `
        import express from 'express';
        const app = express();
        app.get('/real', handler);
        const storage = new Map();
        storage.get('/not-http', 'fallback');
        function handler() {}
      `,
      );
      const result = await runPipelineFromRepo(root, () => {});
      expect(getNodesByLabel(result, 'Route').sort()).toEqual(['/real']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
});
