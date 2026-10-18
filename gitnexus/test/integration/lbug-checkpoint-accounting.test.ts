/**
 * #3529 regression guard. On LadybugDB 0.18.3 (shipped in 1.6.12 and
 * 1.6.13-rc.57) every CHECKPOINT orphaned the shadow file handle, and that
 * handle's frame groups stayed charged against max_db_size until the database
 * closed (LadybugDB #924, fixed by #925 before 0.21.1). Measured on 0.18.3:
 * about 8-9 MiB per checkpoint, even for an empty one, so this test fails there
 * at the ceiling with "Maximum database size of 268435456 bytes has been
 * reached"; 0.21.1 passes. Analyze checkpoints every 5 s and per embedding
 * window, and a fresh process starts the accounting at zero, which matches a
 * transient failure that a retry heals.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

// A power of two, so parseMaxDbSize keeps it exactly (it rounds others up).
const CEILING = 256 * 1024 * 1024;
// Any leak of 2 MiB or more per checkpoint overflows CEILING.
const CHECKPOINTS = 128;

afterEach(() => {
  vi.unstubAllEnvs();
});

it('repeated analyze checkpoints do not consume the max DB size ceiling (#3529)', async () => {
  // LBUG_MAX_DB_SIZE is resolved at module load, so stub before importing.
  vi.stubEnv('GITNEXUS_LBUG_MAX_DB_SIZE', String(CEILING));
  vi.stubEnv('GITNEXUS_LBUG_BUFFER_POOL_SIZE', String(128 * 1024 * 1024));
  vi.resetModules();
  const adapter = await import('../../src/core/lbug/lbug-adapter.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-checkpoint-accounting-'));
  try {
    await adapter.initLbug(path.join(dir, 'lbug'), { skipFts: true });
    await adapter.executeQuery('CREATE NODE TABLE Tick(id INT64, PRIMARY KEY(id))');
    // tryFlushWAL is the CHECKPOINT call each WAL-checkpoint driver tick makes.
    for (let tick = 0; tick < CHECKPOINTS; tick++) {
      await adapter.executeQuery(`CREATE (:Tick {id: ${tick}})`);
      await expect(adapter.tryFlushWAL()).resolves.toBe(true);
    }
    expect(await adapter.executeQuery('MATCH (t:Tick) RETURN count(t) AS n')).toEqual([
      { n: CHECKPOINTS },
    ]);
  } finally {
    await adapter.closeLbug();
    await fs.rm(dir, { recursive: true, force: true });
  }
}, 120_000);
