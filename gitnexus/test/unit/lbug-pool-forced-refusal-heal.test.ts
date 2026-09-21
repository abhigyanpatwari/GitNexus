/**
 * Behavioral recovery test — POOL adapter, refusal FORCED on any engine pin.
 *
 * The integration plant (`lbug-interrupted-checkpoint-recovery.test.ts`) only
 * exercises the refusal on engines that emit it (0.19+); on the committed
 * 0.18.3 pin CI can stay green with the new classifier and recovery CHECKPOINT
 * deleted (review finding: "0.18.3 CI never forces the refusal"). This suite
 * pins the BEHAVIOR behind a mocked native layer instead: the read-only open
 * throws the canonical 0.19 refusal, and the pool must run the full
 * self-heal — writable open, probe, CHECKPOINT, read-only retry — regardless
 * of which engine binary is installed.
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
      /** Every Database construction in order — the self-heal shape. */
      constructions: [] as Array<'ro' | 'rw'>,
      checkpoints: 0,
      /** Every MATCH — victim, writable replay probe, and post-heal retry. */
      probes: 0,
    },
    /** Script the FIRST read-only Database (index 0) as the checkpoint victim. */
    refuseFirst: true,
    reset(options: { refuseFirst?: boolean } = {}) {
      native.seq = 0;
      native.calls.constructions = [];
      native.calls.checkpoints = 0;
      native.calls.probes = 0;
      native.refuseFirst = options.refuseFirst ?? true;
    },
    seq: 0,
  };
  return { native };
});

// The Database at index 0 is the interrupted-checkpoint victim: its init()
// throws the canonical refusal (the pool calls init explicitly) and any query
// on it refuses. Every LATER Database is healthy — in particular the WRITABLE
// recovery open and the read-only retry must never refuse, or the recovery
// would kill itself.
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
    }
    async init(): Promise<void> {
      if (this.index === 0 && this.role === 'ro' && native.refuseFirst) {
        throw new Error(REFUSAL);
      }
    }
    async close(): Promise<void> {}
  }
  const refuseIfVictim = (db: Database, text: string): void => {
    const t = text.trim().toUpperCase();
    if (t.startsWith('MATCH')) native.calls.probes++;
    if (db.index === 0 && db.role === 'ro' && native.refuseFirst && t.startsWith('MATCH')) {
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

import { closeLbug, executeQuery, initLbug } from '../../src/core/lbug/pool-adapter.js';

describe('pool adapter self-heals a refused read-only open (forced refusal)', () => {
  let dbPath: string;
  let tmpDir: string;
  const REPO = 'test-pool-forced-refusal';

  beforeEach(async () => {
    native.reset();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-pool-forced-cp-'));
    dbPath = path.join(tmpDir, 'lbug');
    // The native layer is mocked; the file only has to EXIST (doInitLbug
    // stats it before opening).
    await fs.writeFile(dbPath, '');
  });

  afterEach(async () => {
    await closeLbug(REPO).catch(() => {});
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('runs writable open + CHECKPOINT + read-only retry, then serves queries', async () => {
    await initLbug(REPO, dbPath);

    // Self-heal shape: refused read-only open → writable recovery open →
    // read-only retry. Exactly one CHECKPOINT, issued by the recovery.
    expect(native.calls.constructions).toEqual(['ro', 'rw', 'ro']);
    expect(native.calls.checkpoints).toBe(1);
    // Writable replay MATCH + post-heal read-only MATCH. A CHECKPOINT without
    // its required replay probe would leave this at 1.
    expect(native.calls.probes).toBe(2);

    const rows = await executeQuery(REPO, 'MATCH (n:Person) RETURN count(n) AS c');
    expect(rows).toEqual([]);
  });

  it('does not issue a CHECKPOINT when the read-only open succeeds outright', async () => {
    // A healthy db: the first read-only construction is the only one, and the
    // recovery machinery must stay out of the way (no writable open, no
    // CHECKPOINT on the read path).
    native.reset({ refuseFirst: false });
    await initLbug(REPO, dbPath);
    await executeQuery(REPO, 'MATCH (n:Person) RETURN count(n) AS c');

    expect(native.calls.constructions).toEqual(['ro']);
    expect(native.calls.checkpoints).toBe(0);
    expect(native.calls.probes).toBe(2);
  });
});
