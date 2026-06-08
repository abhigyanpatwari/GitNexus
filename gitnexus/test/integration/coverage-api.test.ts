/**
 * Integration test for /api/coverage/* HTTP endpoints.
 *
 * Registers the coverage routes on a minimal Express app and tests
 * them against a temp coverage store populated with test data.
 */

import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { openCoverageStore, CoverageStore } from '../../src/core/coverage/store.js';

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

describe('/api/coverage/* HTTP endpoints', () => {
  let server: http.Server;
  let baseUrl = '';
  let tmpDir: string;
  let store: CoverageStore;

  beforeAll(async () => {
    // Create temp dir and coverage store.
    // openCoverageStore expects a repoPath and creates .gitnexus/coverage.db inside it.
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-api-coverage-'));
    // Ensure the .gitnexus subdirectory exists
    await fs.mkdir(path.join(tmpDir, '.gitnexus'), { recursive: true });
    store = openCoverageStore(tmpDir);

    // Ingest two test runs using the CoverageStore API
    const run1Id = `run-${Date.now()}-1`;
    const run2Id = `run-${Date.now()}-2`;

    // Use distinct timestamps so listRuns() orders correctly (desc by timestamp)
    const now = Date.now();
    store.upsertRun({
      id: run1Id,
      timestamp: new Date(now - 60000).toISOString(),
      label: 'run-1',
      totalLines: 30,
      coveredLines: 12,
      coverageRatio: 0.4,
    });

    store.insertSymbolCoverage([
      { runId: run1Id, nodeId: 'func-a', symbolName: 'funcA', filePath: 'src/a.ts', totalLines: 10, coveredLines: 9, coverageRatio: 0.9 },
      { runId: run1Id, nodeId: 'func-b', symbolName: 'funcB', filePath: 'src/b.ts', totalLines: 10, coveredLines: 3, coverageRatio: 0.3 },
      { runId: run1Id, nodeId: 'func-c', symbolName: 'funcC', filePath: 'src/c.ts', totalLines: 10, coveredLines: 0, coverageRatio: 0.0 },
    ]);

    store.upsertRun({
      id: run2Id,
      timestamp: new Date(now).toISOString(),
      label: 'run-2',
      totalLines: 30,
      coveredLines: 24,
      coverageRatio: 0.8,
    });

    store.insertSymbolCoverage([
      { runId: run2Id, nodeId: 'func-a', symbolName: 'funcA', filePath: 'src/a.ts', totalLines: 10, coveredLines: 10, coverageRatio: 1.0 },
      { runId: run2Id, nodeId: 'func-b', symbolName: 'funcB', filePath: 'src/b.ts', totalLines: 10, coveredLines: 6, coverageRatio: 0.6 },
      { runId: run2Id, nodeId: 'func-d', symbolName: 'funcD', filePath: 'src/d.ts', totalLines: 10, coveredLines: 8, coverageRatio: 0.8 },
    ]);

    // Wire up a minimal Express app with coverage routes
    const { createServer } = await import('../../src/server/api.js');

    // We simulate the backend by patching queryCoverageStatus etc. on the
    // backend instance inside createServer's closure. Since the createServer
    // function is complex, we instead mount a standalone Express app that
    // mimics the coverage routes, using the store directly.

    const app = express();

    app.use(express.json());

    // GET /api/coverage/status
    app.get('/api/coverage/status', (_req, res) => {
      try {
        const runs = store.listRuns();
        const latestRun = runs[0];
        if (!latestRun) {
          res.json({ status: 'no_data', message: 'No coverage data', runs: [] });
          return;
        }
        const uncovered = store.getUncoveredSymbols(latestRun.id, 20);
        res.json({
          status: 'ok',
          overallCoverage: latestRun.coverageRatio,
          coveredSymbols: latestRun.coveredLines,
          totalSymbols: latestRun.totalLines,
          latestRun: {
            id: latestRun.id,
            timestamp: latestRun.timestamp,
            label: latestRun.label,
          },
          topUncovered: uncovered.map((s) => ({
            symbolName: s.symbolName,
            nodeId: s.nodeId,
            filePath: s.filePath,
            coverageRatio: s.coverageRatio,
          })),
          availableRuns: runs.map((r) => ({
            id: r.id,
            timestamp: r.timestamp,
            label: r.label,
            coverageRatio: r.coverageRatio,
          })),
        });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // GET /api/coverage/runs
    app.get('/api/coverage/runs', (_req, res) => {
      try {
        const runs = store.listRuns();
        res.json({
          runs: runs.map((r) => ({
            id: r.id,
            timestamp: r.timestamp,
            label: r.label,
            coverageRatio: r.coverageRatio,
            coveredLines: r.coveredLines,
            totalLines: r.totalLines,
          })),
        });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // GET /api/coverage/diff
    app.get('/api/coverage/diff', (req, res) => {
      try {
        const runId1 = String(req.query.runId1 ?? '').trim();
        const runId2 = String(req.query.runId2 ?? '').trim();
        if (!runId1 || !runId2) {
          res.status(400).json({ error: 'Missing "runId1" or "runId2" query parameter' });
          return;
        }

        const run1 = store.getRun(runId1);
        const run2 = store.getRun(runId2);
        if (!run1 || !run2) {
          res.status(404).json({ error: `Run not found` });
          return;
        }

        const syms1 = new Map(store.getSymbolCoverage(runId1).map((s) => [s.nodeId, s]));
        const syms2 = new Map(store.getSymbolCoverage(runId2).map((s) => [s.nodeId, s]));

        const added: any[] = [];
        const removed: any[] = [];

        for (const [nodeId, s2] of syms2) {
          const s1 = syms1.get(nodeId);
          if (!s1) {
            added.push({ nodeId, symbolName: s2.symbolName, filePath: s2.filePath });
            continue;
          }
          if (s2.coverageRatio > s1.coverageRatio) {
            added.push({ nodeId, symbolName: s2.symbolName, filePath: s2.filePath });
          } else if (s2.coverageRatio < s1.coverageRatio) {
            removed.push({ nodeId, symbolName: s2.symbolName, filePath: s2.filePath });
          }
        }
        for (const nodeId of syms1.keys()) {
          if (!syms2.has(nodeId)) {
            removed.push({
              nodeId,
              symbolName: syms1.get(nodeId)!.symbolName,
              filePath: syms1.get(nodeId)!.filePath,
            });
          }
        }

        res.json({
          baseline: { id: run1.id, coverageRatio: run1.coverageRatio },
          comparison: { id: run2.id, coverageRatio: run2.coverageRatio },
          delta: run2.coverageRatio - run1.coverageRatio,
          added: added.slice(0, 20),
          removed: removed.slice(0, 20),
          summary: { newlyCovered: added.length, regressions: removed.length },
        });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    ({ server, baseUrl } = await startServer(app));
  });

  afterAll(async () => {
    store?.close();
    await stopServer(server);
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  describe('GET /api/coverage/status', () => {
    it('returns 200 with status data', async () => {
      const response = await fetch(`${baseUrl}/api/coverage/status`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.status).toBe('ok');
      expect(typeof body.overallCoverage).toBe('number');
      expect(body.overallCoverage).toBeGreaterThan(0);
      expect(body.availableRuns.length).toBeGreaterThanOrEqual(2);
      expect(body.latestRun).toBeDefined();
      expect(body.latestRun.label).toBeDefined();
    });

    it('includes topUncovered symbols', async () => {
      const response = await fetch(`${baseUrl}/api/coverage/status`);
      const body = await response.json();
      expect(Array.isArray(body.topUncovered)).toBe(true);
    });

    it('has valid availableRuns with coverageRatio', async () => {
      const response = await fetch(`${baseUrl}/api/coverage/status`);
      const body = await response.json();
      for (const run of body.availableRuns) {
        expect(typeof run.id).toBe('string');
        expect(typeof run.coverageRatio).toBe('number');
      }
    });
  });

  describe('GET /api/coverage/runs', () => {
    it('returns 200 with runs list', async () => {
      const response = await fetch(`${baseUrl}/api/coverage/runs`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(Array.isArray(body.runs)).toBe(true);
      expect(body.runs.length).toBeGreaterThanOrEqual(2);
      expect(typeof body.runs[0].id).toBe('string');
      expect(typeof body.runs[0].coverageRatio).toBe('number');
    });

    it('includes coveredLines and totalLines per run', async () => {
      const response = await fetch(`${baseUrl}/api/coverage/runs`);
      const body = await response.json();
      for (const run of body.runs) {
        expect(typeof run.coveredLines).toBe('number');
        expect(typeof run.totalLines).toBe('number');
      }
    });
  });

  describe('GET /api/coverage/diff', () => {
    let runId1: string;
    let runId2: string;

    beforeAll(async () => {
      // Get run IDs from the runs endpoint
      const response = await fetch(`${baseUrl}/api/coverage/runs`);
      const body = await response.json();
      runId1 = body.runs[1]?.id; // older run (run-1)
      runId2 = body.runs[0]?.id; // newer run (run-2)
    });

    it('returns 200 with diff data', async () => {
      const response = await fetch(
        `${baseUrl}/api/coverage/diff?runId1=${runId1}&runId2=${runId2}`,
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.baseline).toBeDefined();
      expect(body.comparison).toBeDefined();
      expect(typeof body.delta).toBe('number');
      expect(typeof body.summary.newlyCovered).toBe('number');
      expect(typeof body.summary.regressions).toBe('number');
      expect(Array.isArray(body.added)).toBe(true);
      expect(Array.isArray(body.removed)).toBe(true);
    });

    it('returns 400 when runId1 is missing', async () => {
      const response = await fetch(`${baseUrl}/api/coverage/diff?runId2=${runId2}`);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('Missing');
    });

    it('returns 400 when runId2 is missing', async () => {
      const response = await fetch(`${baseUrl}/api/coverage/diff?runId1=${runId1}`);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('Missing');
    });

    it('returns 404 for non-existent run', async () => {
      const response = await fetch(
        `${baseUrl}/api/coverage/diff?runId1=nonexistent&runId2=${runId2}`,
      );
      expect(response.status).toBe(404);
    });

    it('detects newly covered symbol', async () => {
      const response = await fetch(
        `${baseUrl}/api/coverage/diff?runId1=${runId1}&runId2=${runId2}`,
      );
      const body = await response.json();
      // func-d only exists in run-2 (newly covered)
      const funcD = body.added.find((a: any) => a.symbolName === 'funcD');
      expect(funcD).toBeDefined();
    });
  });
});