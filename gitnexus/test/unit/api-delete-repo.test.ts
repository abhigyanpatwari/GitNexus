/**
 * DELETE /api/repo on a shared-store checkout slot (#3374).
 *
 * The handler must remove the slot the way `gitnexus remove` does: the
 * checkout's `store.json` pointer and the registry entry go under the slot's
 * index lock. When an analyze holds that lock the handler answers 409 and
 * leaves the entry registered, instead of swallowing the failure and
 * reporting `{deleted}`.
 *
 * Boots createServer like analyze-delete-api.test.ts (mocked listen, no
 * LadybugDB/MCP); the registry and storage are real, under a temp
 * GITNEXUS_HOME.
 */
import express from 'express';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobManager } from '../../src/server/analyze-job.js';
import { acquireIndexLock } from '../../src/storage/index-lock.js';
import { readRegistry, type RegistryEntry } from '../../src/storage/repo-manager.js';
import { SHARED_STORE_POINTER } from '../../src/storage/shared-store.js';
import { writeSharedStorePointer } from '../../src/storage/shared-store-lifecycle.js';
import { createTempDir } from '../helpers/test-db.js';

const captured = vi.hoisted(() => ({
  managers: [] as JobManager[],
}));

// Deletability policy is covered by storage-resolver tests; here the slot is
// taken as deletable so the handler's own removal path is what runs.
vi.mock('../../src/storage/storage-resolver.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/storage/storage-resolver.js')>()),
  requireDeletableStoragePath: vi.fn(async (entry: { storagePath: string }) => entry.storagePath),
}));
vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  withLbugDb: vi.fn(),
  executeQuery: vi.fn(async () => []),
  executePrepared: vi.fn(async () => []),
  executeWithReusedStatement: vi.fn(async () => []),
  streamQuery: vi.fn(async () => 0),
  flushWAL: vi.fn(),
  closeLbug: vi.fn(),
  isReadOnlyDbError: vi.fn(() => false),
}));
vi.mock('../../src/core/search/bm25-index.js', () => ({ searchFTSFromLbug: vi.fn() }));
vi.mock('../../src/mcp/local/local-backend.js', () => ({
  LocalBackend: class {
    async init() {
      return true;
    }
  },
}));
vi.mock('../../src/server/mcp-http.js', () => ({
  installServeMcpAuth: vi.fn(),
  mountMCPEndpoints: vi.fn(async () => vi.fn()),
}));
vi.mock('../../src/server/upload-sweep.js', () => ({ sweepStaleUploads: vi.fn(async () => {}) }));
vi.mock('../../src/server/update-controller.js', () => ({
  createServeUpdateController: vi.fn(() => ({ stop: vi.fn() })),
  bindServeUpdateControllerLifecycle: vi.fn(),
  buildServerInfo: vi.fn(),
}));
vi.mock('../../src/server/grep-scan.js', () => ({
  runGrepScanInWorker: vi.fn(async () => ({ results: [], timedOut: false })),
}));
vi.mock('../../src/server/sse-progress.js', () => ({ mountSSEProgress: vi.fn() }));
vi.mock('../../src/server/analyze-job.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/server/analyze-job.js')>();
  return {
    ...actual,
    JobManager: class extends actual.JobManager {
      constructor() {
        super();
        captured.managers.push(this);
      }
    },
  };
});

import { createServer } from '../../src/server/api.js';

interface HandlerResponse {
  statusCode: number;
  body: unknown;
  status(code: number): HandlerResponse;
  json(body: unknown): HandlerResponse;
}

interface RouteLayer {
  route?: {
    path: string;
    methods?: Record<string, boolean>;
    stack: Array<{ handle: (req: unknown, res: HandlerResponse) => Promise<void> }>;
  };
}

let app: express.Express;
const events = ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'] as const;
const originalListeners = new Map(events.map((event) => [event, process.listeners(event)]));
const saved = {
  home: process.env.GITNEXUS_HOME,
  lockTimeout: process.env.GITNEXUS_INDEX_LOCK_TIMEOUT_MS,
};

const restoreEnv = (name: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

beforeAll(async () => {
  const listen = vi.spyOn(express.application, 'listen').mockImplementation(function (
    this: express.Express,
    ...args: unknown[]
  ) {
    app = this;
    queueMicrotask(args.at(-1) as () => void);
    return new EventEmitter() as ReturnType<express.Express['listen']>;
  });
  try {
    await createServer(0);
  } finally {
    listen.mockRestore();
  }
});

afterAll(() => {
  for (const manager of captured.managers) manager.dispose();
  for (const event of events) {
    for (const listener of process.listeners(event)) {
      if (!originalListeners.get(event)?.includes(listener)) {
        process.removeListener(event, listener);
      }
    }
  }
});

const invokeDeleteRepo = async (repo: string): Promise<HandlerResponse> => {
  const layer = (app.router.stack as unknown as RouteLayer[]).find(
    (item) => item.route?.path === '/api/repo' && item.route.methods?.delete,
  );
  const handler = layer?.route?.stack.at(-1)?.handle;
  expect(handler, 'DELETE /api/repo').toBeDefined();
  const res: HandlerResponse = {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  await handler?.({ query: { repo }, body: {} }, res);
  return res;
};

describe('DELETE /api/repo on a shared-store slot (#3374)', () => {
  let home: Awaited<ReturnType<typeof createTempDir>>;
  let checkout: string;
  let slot: string;

  beforeEach(async () => {
    home = await createTempDir('gitnexus-test-delete-repo-');
    const root = await fs.realpath(home.dbPath);
    process.env.GITNEXUS_HOME = path.join(root, 'home');
    // A held lock must fail fast, not wait out the 10-minute default.
    process.env.GITNEXUS_INDEX_LOCK_TIMEOUT_MS = '200';
    checkout = path.join(root, 'checkout');
    const key = 'store-key';
    slot = path.join(process.env.GITNEXUS_HOME, 'stores', key, 'checkouts', 'slot-a');
    await fs.mkdir(checkout, { recursive: true });
    await fs.mkdir(slot, { recursive: true });
    await fs.writeFile(path.join(slot, 'gitnexus.json'), '{}\n');
    await writeSharedStorePointer(checkout, { key, checkoutSlot: slot });
    const entry: RegistryEntry = {
      name: 'checkout',
      path: checkout,
      storagePath: slot,
      indexedAt: '2026-01-01T00:00:00.000Z',
      lastCommit: 'abc123',
    };
    await fs.writeFile(
      path.join(process.env.GITNEXUS_HOME, 'registry.json'),
      `${JSON.stringify([entry], null, 2)}\n`,
    );
  });

  afterEach(async () => {
    restoreEnv('GITNEXUS_HOME', saved.home);
    restoreEnv('GITNEXUS_INDEX_LOCK_TIMEOUT_MS', saved.lockTimeout);
    await home.cleanup();
  });

  it('removes the pointer, the slot and the registry entry', async () => {
    const res = await invokeDeleteRepo('checkout');

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ deleted: 'checkout' });
    expect(existsSync(path.join(checkout, '.gitnexus', SHARED_STORE_POINTER))).toBe(false);
    expect(existsSync(slot)).toBe(false);
    expect(await readRegistry()).toEqual([]);
  });

  it('answers 409 and keeps the entry while an analyze holds the slot lock', async () => {
    const lock = await acquireIndexLock(slot);
    try {
      const res = await invokeDeleteRepo('checkout');

      expect(res.statusCode).toBe(409);
      expect(res.body).not.toHaveProperty('deleted');
      expect((await readRegistry()).map((e) => e.path)).toEqual([checkout]);
      expect(existsSync(path.join(checkout, '.gitnexus', SHARED_STORE_POINTER))).toBe(true);
      expect(existsSync(slot)).toBe(true);
    } finally {
      lock.release();
    }
  });
});
