/**
 * Structural + behavioural tests for the WAL-flush / close helpers (#1376).
 *
 * After the review-driven refactor, the module exposes two layers:
 *   - flushWAL  — CHECKPOINT only (connection stays open)
 *   - safeClose — flushWAL + conn.close + db.close
 *
 * closeLbug delegates to safeClose for the CHECKPOINT + close step and
 * then resets module-level state (currentDbPath, ftsLoaded, etc.).
 *
 * The structural tests read the adapter source and verify delegation
 * contracts so a future refactor that inlines close logic is caught.
 *
 * The behavioural tests import flushWAL directly and exercise the
 * runtime null-guard path (conn is null at module load) so a future
 * refactor that accidentally throws is caught immediately.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { flushWAL } from '../../src/core/lbug/lbug-adapter.js';

describe('flushWAL / safeClose — consolidation guard (#1376)', () => {
  let adapterSource: string;

  beforeAll(async () => {
    adapterSource = await fs.readFile(
      path.join(__dirname, '..', '..', 'src', 'core', 'lbug', 'lbug-adapter.ts'),
      'utf-8',
    );
  });

  it('exports flushWAL (CHECKPOINT-only helper)', () => {
    expect(adapterSource).toMatch(/export const flushWAL/);
  });

  it('exports safeClose (CHECKPOINT + close helper)', () => {
    expect(adapterSource).toMatch(/export const safeClose/);
  });

  it('safeClose delegates to flushWAL for the CHECKPOINT step', () => {
    const safeCloseBody = adapterSource.slice(adapterSource.indexOf('export const safeClose'));
    expect(safeCloseBody).toMatch(/await flushWAL\(\)/);
  });

  it('closeLbug delegates to safeClose instead of inlining conn.close/db.close', () => {
    const closeLbugBody = adapterSource.slice(adapterSource.indexOf('export const closeLbug'));
    expect(closeLbugBody).toMatch(/await safeClose\(\)/);
    // closeLbug must NOT contain its own conn.close() or db.close() — those
    // live exclusively inside safeClose now.
    const closeLbugBlock = closeLbugBody.slice(0, closeLbugBody.indexOf('export const', 1) >>> 0);
    expect(closeLbugBlock).not.toMatch(/conn\.close\(\)/);
    expect(closeLbugBlock).not.toMatch(/db\.close\(\)/);
  });

  it('flushWAL is the only place that issues conn.query(CHECKPOINT)', () => {
    const matches = adapterSource.match(/conn\.query\('CHECKPOINT'\)/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('conn.close() only appears inside safeClose (with eslint-disable)', () => {
    // Every conn.close() in the adapter must live inside safeClose, guarded
    // by the eslint-disable comment. Count occurrences to catch leaks.
    const matches = adapterSource.match(/await conn\.close\(\)/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('db.close() only appears inside safeClose (with eslint-disable)', () => {
    const matches = adapterSource.match(/await db\.close\(\)/g) ?? [];
    expect(matches.length).toBe(1);
  });
});

// Behavioural tests — exercise flushWAL at runtime rather than just
// grepping source text.  At module load `conn` is null, so these hit
// the early-return guard without needing a real LadybugDB instance.
describe('flushWAL — runtime behaviour', () => {
  it('resolves without error when no connection is open', async () => {
    // conn is null at module load — flushWAL must not throw.
    await expect(flushWAL()).resolves.toBeUndefined();
  });

  it('can be called repeatedly without throwing (idempotent)', async () => {
    await flushWAL();
    await flushWAL();
    // No assertion needed beyond "did not throw".
  });
});
