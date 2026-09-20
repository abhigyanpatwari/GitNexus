/**
 * Interrupted-checkpoint self-heal — end-to-end against the REAL pool adapter.
 *
 * Homelab repro 2026-09-19 ("LadybugDB unavailable for __wiki__ ... Cannot
 * open database in read-only mode while checkpoint is in progress"): a wiki
 * pod killed mid-CHECKPOINT left the engine's checkpoint artifacts on disk,
 * and every later read-only open refused — permanently — until a writable
 * open (any `gitnexus analyze`) recovered it. The read path now self-heals:
 * the refusal is classified (`isReadOnlyCheckpointInProgressError`) and
 * cleared by one writable open + probe + CHECKPOINT, then the read-only open
 * is retried.
 *
 * The killed-checkpoint SIGNATURE is planted deterministically — no process
 * killing, no race: a checkpointed db plus a `lbug.wal.checkpoint` sidecar, an
 * empty `lbug.shadow`, and the zero-byte checkpoint intent/apply lock files
 * the engine leaves mid-checkpoint. Verified against @ladybugdb/core 0.19.1,
 * where this exact state refuses with the exact production message; on the
 * pinned 0.18.x the engine may tolerate the planted state, in which case this
 * suite still pins the contract that the pooled read path opens and answers.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeLbug, executeQuery, initLbug } from '../../src/core/lbug/pool-adapter.js';
import lbug from '@ladybugdb/core';

const REPO = 'test-interrupted-checkpoint';
const ROWS = 300;

/**
 * Deterministic interrupted-checkpoint signature: build rows on a writable
 * session with AUTO-CHECKPOINT DISABLED and close WITHOUT checkpointing, so —
 * exactly like a CHECKPOINT killed mid-flight — the main file is stale and
 * every row lives only in the WAL. Then rename that WAL to the
 * `lbug.wal.checkpoint` name the engine gives it during checkpoint, and plant
 * the shadow + intent/apply lock files it leaves behind.
 */
async function plantInterruptedCheckpoint(dbPath: string): Promise<void> {
  // Raw constructor (positional args mirror createLbugDatabase) because the
  // autoCheckpoint toggle is not exposed through the config helpers — and
  // auto-checkpoint-on-close is precisely what must NOT happen here.
  const db = new lbug.Database(
    dbPath,
    128 * 1024 * 1024, // bufferManagerSize
    false, // enableCompression
    false, // readOnly
    16 * 1024 * 1024 * 1024, // maxDBSize
    false, // autoCheckpoint — the whole point
    64 * 1024 * 1024, // checkpointThreshold
    false, // throwOnWalReplayFailure
    true, // enableChecksums
  );
  await db.init();
  const conn = new lbug.Connection(db);
  try {
    await conn.query('CREATE NODE TABLE Person (name STRING, PRIMARY KEY(name))');
    for (let i = 0; i < ROWS; i += 100) {
      const batch = Array.from({ length: 100 }, (_, j) => `{name: 'p${i + j}'}`).join(', ');
      await conn.query(`UNWIND [${batch}] AS r CREATE (:Person {name: r.name})`);
    }
    const walBuffer = await fs.readFile(`${dbPath}.wal`);
    // Close WITHOUT checkpoint: rows stay WAL-only, main file stays stale.
    await conn.close().catch(() => {});
    await db.close().catch(() => {});
    await fs.rename(`${dbPath}.wal`, `${dbPath}.wal.checkpoint`);
    await fs.writeFile(`${dbPath}.wal`, '');
    await fs.writeFile(`${dbPath}.shadow`, '');
    await fs.writeFile(`${dbPath}.checkpoint.intent.lock`, '');
    await fs.writeFile(`${dbPath}.checkpoint.apply.lock`, '');
  } catch (err) {
    await conn.close().catch(() => {});
    await db.close().catch(() => {});
    throw err;
  }
}

describe('interrupted-checkpoint recovery (pooled read path self-heal)', () => {
  let dbPath: string;
  let tmpDir: string;

  afterAll(async () => {
    await closeLbug(REPO).catch(() => {});
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('opens read-only through the pool refusal and answers queries', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-lbug-interrupted-cp-'));
    dbPath = path.join(tmpDir, 'lbug');
    await plantInterruptedCheckpoint(dbPath);

    // Engine-version honesty: only 0.19+ refuses on the planted signature
    // ("Cannot open database in read-only mode while checkpoint is in
    // progress"); the pinned 0.18.x tolerates it. When the engine DOES
    // refuse, prove the planted state is the real one before the pool heals
    // it — otherwise this suite would silently degenerate into a plain
    // read-only smoke test on engines where the bug cannot occur.
    const engineVersion = JSON.parse(
      await fs.readFile(
        path.join(
          path.dirname(fileURLToPath(import.meta.url)),
          '../../node_modules/@ladybugdb/core/package.json',
        ),
        'utf-8',
      ),
    ).version as string;
    const refusalExpected = Number(engineVersion.split('.')[1]) >= 19;
    if (refusalExpected) {
      await expect(
        (async () => {
          const probe = new lbug.Database(
            dbPath,
            128 * 1024 * 1024,
            false,
            true,
            16 * 1024 * 1024 * 1024,
            true,
            64 * 1024 * 1024,
            false,
            true,
          );
          try {
            await probe.init();
          } finally {
            await probe.close().catch(() => {});
          }
        })(),
      ).rejects.toThrow(/checkpoint is in progress/i);
    }

    // The wiki path: pooled READ-ONLY open. Before the fix this refused with
    // "Cannot open database in read-only mode while checkpoint is in
    // progress" on 0.19.x engines and never recovered on its own.
    await initLbug(REPO, dbPath);

    const rows = await executeQuery(REPO, 'MATCH (n:Person) RETURN count(n) AS c');
    expect(rows.length).toBe(1);
    expect(Number((rows[0] as Record<string, unknown>)['c'])).toBe(ROWS);

    // A second open must answer without needing recovery again.
    await closeLbug(REPO);
    await initLbug(REPO, dbPath);
    const again = await executeQuery(REPO, 'MATCH (n:Person) RETURN count(n) AS c');
    expect(again.length).toBe(1);
    expect(Number((again[0] as Record<string, unknown>)['c'])).toBe(ROWS);
  });
});
