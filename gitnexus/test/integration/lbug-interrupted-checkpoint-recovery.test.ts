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
 * where this exact state refuses with the exact production message. The suite
 * version-gates itself: on engines that tolerate the planted state (< 0.19,
 * e.g. the committed 0.18.3 pin) it skips — a refusal cannot be forced there,
 * and the behavioral contract is held on every pin by the mocked
 * forced-refusal suites instead.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeLbug, executeQuery, initLbug } from '../../src/core/lbug/pool-adapter.js';
import lbug from '@ladybugdb/core';
import { closeQueryResults } from '../../src/core/lbug/query-result-utils.js';

const REPO = 'test-interrupted-checkpoint';
const ROWS = 300;

/**
 * Preserve the main file and WAL before native close forces a checkpoint.
 * Restoring both snapshots models a killed checkpoint with every row still
 * WAL-only. All query results must be closed before releasing the database:
 * native results retain the database and its writer lock until closed or GC'd.
 */
async function plantInterruptedCheckpoint(dbPath: string): Promise<void> {
  // Disable automatic checkpoints while building the WAL. Native close still
  // forces a checkpoint, so the pre-close main file must also be preserved.
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
  let conn: lbug.Connection | undefined;
  let mainBuffer: Buffer;
  let walBuffer: Buffer;
  try {
    await db.init();
    conn = new lbug.Connection(db);
    const statements = ['CREATE NODE TABLE Person (name STRING, PRIMARY KEY(name))'];
    for (let i = 0; i < ROWS; i += 100) {
      const batch = Array.from({ length: 100 }, (_, j) => `{name: 'p${i + j}'}`).join(', ');
      statements.push(`UNWIND [${batch}] AS r CREATE (:Person {name: r.name})`);
    }
    for (const statement of statements) {
      const result = await conn.query(statement);
      try {
        for (const cursor of Array.isArray(result) ? result : [result]) await cursor.getAll();
      } finally {
        await closeQueryResults(result);
      }
    }
    [mainBuffer, walBuffer] = await Promise.all([
      fs.readFile(dbPath),
      fs.readFile(`${dbPath}.wal`),
    ]);
    expect(walBuffer.byteLength).toBeGreaterThan(0);
  } finally {
    try {
      await conn?.close();
    } finally {
      await db.close();
    }
  }
  // A separate process must acquire the native writer lock before the
  // fixture files are restored. A byte-zero file read cannot test that lock.
  const probe = spawnSync(
    process.execPath,
    [
      '-e',
      `const lbug = require(process.argv[1]);
       const db = new lbug.Database(process.argv[2], 128 * 1024 * 1024, false,
         false, 16 * 1024 * 1024 * 1024);
       db.init().then(() => db.close()).catch((error) => {
         console.error(error);
         process.exitCode = 1;
       });`,
      fileURLToPath(new URL('../../node_modules/@ladybugdb/core', import.meta.url)),
      dbPath,
    ],
    { encoding: 'utf8', timeout: 15_000 },
  );
  expect(probe.error).toBeUndefined();
  expect(probe.status, probe.stderr).toBe(0);

  await fs.writeFile(dbPath, mainBuffer);
  await fs.writeFile(`${dbPath}.wal.checkpoint`, walBuffer);
  await fs.writeFile(`${dbPath}.wal`, '');
  await fs.writeFile(`${dbPath}.shadow`, '');
  await fs.writeFile(`${dbPath}.checkpoint.intent.lock`, '');
  await fs.writeFile(`${dbPath}.checkpoint.apply.lock`, '');
}

describe('interrupted-checkpoint recovery (pooled read path self-heal)', () => {
  let dbPath: string;
  let tmpDir: string;

  afterAll(async () => {
    await closeLbug(REPO).catch(() => {});
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('opens read-only through the pool refusal and answers queries', async (ctx) => {
    // Engine-version honesty: only 0.19+ treats the planted signature as an
    // interrupted checkpoint ("Cannot open database in read-only mode while
    // checkpoint is in progress"). On the 0.18.x pin the engine TOLERATES the
    // plant — and worse, its staging-replay of the synthetic sidecars is
    // nondeterministic (double-apply → "Person already exists in catalog";
    // observed as a hosted-CI flake), so running the plant there buys a
    // vacuous smoke test at flake prices. The behavioral coverage on ANY pin
    // lives in the forced-refusal units (lbug-pool-forced-refusal-heal,
    // lbug-direct-forced-refusal-heal); this native plant runs where the bug
    // actually exists — 0.19+ — and is registered in lbug-db / LBUG_NATIVE so
    // Windows and macOS exercise it the moment the pin moves off 0.18.3.
    const engineVersion = JSON.parse(
      await fs.readFile(
        path.join(
          path.dirname(fileURLToPath(import.meta.url)),
          '../../node_modules/@ladybugdb/core/package.json',
        ),
        'utf-8',
      ),
    ).version as string;
    const [major, minor] = engineVersion.split('.').map((part) => Number(part));
    // Skip only 0.x below 0.19. A 1.0.0 pin is newer than 0.19 and must run.
    if (Number.isFinite(major) && Number.isFinite(minor) && major === 0 && minor < 19) {
      ctx.skip();
    }

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-lbug-interrupted-cp-'));
    dbPath = path.join(tmpDir, 'lbug');
    await plantInterruptedCheckpoint(dbPath);

    // Prove the planted state is the real one before the pool heals it.
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

    // The wiki path: pooled READ-ONLY open. Before the fix this refused with
    // "Cannot open database in read-only mode while checkpoint is in
    // progress" on 0.19.x engines and never recovered on its own.
    await initLbug(REPO, dbPath);

    const rows = await executeQuery(REPO, 'MATCH (n:Person) RETURN count(n) AS c');
    expect(rows.length).toBe(1);
    expect(Number((rows[0] as Record<string, unknown>)['c'])).toBe(ROWS);

    // Normalize to the state a healthy engine leaves after recovery: on
    // 0.19.x the recovery CHECKPOINT consumes the staged wal.checkpoint and
    // the checkpoint locks, but on 0.18.3 (which never staged them) they
    // survive the recovery — and a second open would replay the stale
    // staging WAL onto a main file that already has the rows ("Person
    // already exists in catalog", the fixture's other CI flake). The
    // post-recovery contract is "sidecars consumed"; pin that before
    // reopening.
    for (const artifact of [
      'lbug.wal.checkpoint',
      'lbug.shadow',
      'lbug.checkpoint.intent.lock',
      'lbug.checkpoint.apply.lock',
    ]) {
      await fs.rm(path.join(tmpDir, artifact), { force: true });
    }

    // A second open must answer without needing recovery again.
    await closeLbug(REPO);
    await initLbug(REPO, dbPath);
    const again = await executeQuery(REPO, 'MATCH (n:Person) RETURN count(n) AS c');
    expect(again.length).toBe(1);
    expect(Number((again[0] as Record<string, unknown>)['c'])).toBe(ROWS);
  });
});
