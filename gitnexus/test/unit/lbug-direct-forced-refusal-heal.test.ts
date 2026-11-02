/**
 * Behavioral recovery test — DIRECT adapter, refusal FORCED on any engine pin.
 *
 * Complements `lbug-pool-forced-refusal-heal.test.ts`: the direct adapter is
 * LAZY (the native Database constructor defers the file open to the first
 * query — `ensureReadOnlyConnectionUsable`'s probe), so its refusal surfaces
 * at probe time and must route through the same writable-recovery: probe →
 * writable open → probe → CHECKPOINT → read-only reopen. Pinned here behind a
 * mocked native layer so CI enforces it on the 0.18.3 pin too (where no real
 * engine emits the refusal).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const REFUSAL =
  'Connection exception: Cannot open database in read-only mode while checkpoint is in progress. Please retry later.';

const { native } = vi.hoisted(() => {
  const native = {
    calls: {
      constructions: [] as Array<'ro' | 'rw'>,
      checkpoints: 0,
      refusalProbes: 0,
    },
    /** Script the FIRST read-only Database (index 0) as the checkpoint victim. */
    refuseFirst: true,
    /** Script constructor-time refusal (direct adapter has no init() on open). */
    refuseOnOpen: false,
    reset(options: { refuseFirst?: boolean; refuseOnOpen?: boolean } = {}) {
      native.seq = 0;
      native.calls.constructions = [];
      native.calls.checkpoints = 0;
      native.calls.refusalProbes = 0;
      native.refuseFirst = options.refuseFirst ?? true;
      native.refuseOnOpen = options.refuseOnOpen ?? false;
    },
    seq: 0,
  };
  return { native };
});

// The DIRECT adapter is lazy — its index-0 read-only Database never gets
// init(); the open happens at the FIRST probe query, which refuses. The
// writable recovery open and the read-only retry (index 1 and 2) never
// refuse, or the recovery would kill itself.
vi.mock('@ladybugdb/core', () => {
  class Database {
    role: 'ro' | 'rw';
    index: number;
    constructor(
      _path: unknown,
      _bufferManagerSize: unknown,
      _compression: unknown,
      readOnly = false,
    ) {
      this.role = readOnly ? 'ro' : 'rw';
      this.index = native.seq++;
      native.calls.constructions.push(this.role);
      // Open-time path: `createLbugDatabase` / `openLbugConnection` never
      // call init(); a 0.19 constructor refusal must surface here.
      if (this.index === 0 && this.role === 'ro' && native.refuseOnOpen) {
        throw new Error(REFUSAL);
      }
    }
    async init(): Promise<void> {}
    async close(): Promise<void> {}
  }
  const refuseIfVictim = (db: Database, text: string): void => {
    const t = text.trim().toUpperCase();
    if (db.index === 0 && db.role === 'ro' && native.refuseFirst && t.startsWith('MATCH')) {
      native.calls.refusalProbes++;
      throw new Error(REFUSAL);
    }
    if (t === 'CHECKPOINT') native.calls.checkpoints++;
  };
  const emptyResult = {
    getAll: async () => [],
    close: async () => {},
    isSuccess: () => true,
    getErrorMessage: async () => '',
  };
  class Connection {
    constructor(private db: Database) {}
    async query(text: string) {
      refuseIfVictim(this.db, text);
      return emptyResult;
    }
    async prepare(cypher: string) {
      refuseIfVictim(this.db, cypher);
      return { isSuccess: () => true, getErrorMessage: async () => '' };
    }
    async execute() {
      return emptyResult;
    }
    async close(): Promise<void> {}
  }
  const mod = { Database, Connection };
  return { ...mod, default: mod, lbug: mod };
});

import { closeLbug, withLbugDb } from '../../src/core/lbug/lbug-adapter.js';

describe('direct adapter self-heals a refused read-only probe (forced refusal)', () => {
  let dbPath: string;
  let tmpDir: string;

  beforeEach(async () => {
    native.reset();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-direct-forced-cp-'));
    dbPath = path.join(tmpDir, 'lbug');
    await fs.writeFile(dbPath, '');
  });

  afterEach(async () => {
    await closeLbug().catch(() => {});
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('recovers via writable CHECKPOINT and answers inside the same withLbugDb call', async () => {
    const result = await withLbugDb(
      dbPath,
      async () => {
        // Running on the recovered connection: any read-only query lands on
        // the healed reopen (constructions[2]) and must not refuse.
        return 'served';
      },
      { readOnly: true },
    );

    expect(result).toBe('served');
    expect(native.calls.constructions).toEqual(['ro', 'rw', 'ro']);
    expect(native.calls.checkpoints).toBe(1);
    expect(native.calls.refusalProbes).toBe(1);
  });

  it('does not open writable when the read-only probe succeeds outright', async () => {
    // No refusal scripted: the singleton serves the whole call read-only.
    native.reset({ refuseFirst: false });
    const result = await withLbugDb(dbPath, async () => 'served', { readOnly: true });

    expect(result).toBe('served');
    expect(native.calls.constructions).toEqual(['ro']);
    expect(native.calls.checkpoints).toBe(0);
  });

  it('recovers when the read-only constructor refuses before any probe', async () => {
    native.reset({ refuseFirst: false, refuseOnOpen: true });
    const result = await withLbugDb(dbPath, async () => 'served', { readOnly: true });

    expect(result).toBe('served');
    expect(native.calls.constructions).toEqual(['ro', 'rw', 'ro']);
    expect(native.calls.checkpoints).toBe(1);
    expect(native.calls.refusalProbes).toBe(0);
  });
});
