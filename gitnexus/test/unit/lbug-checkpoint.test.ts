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

  // Strip comments before the structural assertions so they reflect CODE only.
  // Otherwise a `conn.close()` / `db.close()` / `.query('CHECKPOINT')` token
  // mentioned in a doc comment would falsely trip (or vacuously satisfy) a guard,
  // coupling the test to comment wording — exactly the brittleness flagged in the
  // #2264 review (a prior commit had to reword a comment just to keep this green).
  const codeOnly = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  beforeAll(async () => {
    adapterSource = codeOnly(
      await fs.readFile(
        path.join(__dirname, '..', '..', 'src', 'core', 'lbug', 'lbug-adapter.ts'),
        'utf-8',
      ),
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
    // Match `closeLbug =` precisely so we don't prefix-match `closeLbugBeforeExit`.
    const closeLbugBody = adapterSource.slice(adapterSource.indexOf('export const closeLbug ='));
    expect(closeLbugBody).toMatch(/await safeClose\(\)/);
    // closeLbug must NOT contain its own conn.close() or db.close() — those
    // live exclusively inside safeClose now.
    const closeLbugBlock = closeLbugBody.slice(0, closeLbugBody.indexOf('export const', 1) >>> 0);
    expect(closeLbugBlock).not.toMatch(/conn\.close\(\)/);
    expect(closeLbugBlock).not.toMatch(/db\.close\(\)/);
  });

  it('exports closeLbugBeforeExit (CHECKPOINT-only, skips native close) (#2264)', () => {
    expect(adapterSource).toMatch(/export const closeLbugBeforeExit/);
    // closeLbugBeforeExit is declared immediately before closeLbug; its body must
    // CHECKPOINT via flushWAL and NEVER do a native conn/db close (that's the
    // whole point — it relies on a guaranteed process.exit).
    const body = adapterSource.slice(
      adapterSource.indexOf('export const closeLbugBeforeExit'),
      adapterSource.indexOf('export const closeLbug ='),
    );
    expect(body).toMatch(/await flushWAL\(\)/);
    expect(body).not.toMatch(/conn\.close\(\)/);
    expect(body).not.toMatch(/db\.close\(\)/);
  });

  it('CHECKPOINT is issued only by flushWAL (best-effort) and tryFlushWAL (rethrows for the retry driver)', () => {
    // Receiver-agnostic: since the connection-serialization refactor (#2264)
    // both sites capture `const c = conn` and call `c.query('CHECKPOINT')`
    // inside withConnLock, so match `.query('CHECKPOINT')` regardless of the
    // receiver name rather than the literal `conn.query(...)`.
    const matches = adapterSource.match(/\.query\('CHECKPOINT'\)/g) ?? [];
    // Two authorized sites: `flushWAL` (swallows errors — used by
    // `safeClose` and the server's best-effort flush) and `tryFlushWAL`
    // (rethrows so the manual checkpoint driver in `wal-checkpoint-driver.ts`
    // can apply its bounded retry). Any third occurrence is a regression —
    // a CHECKPOINT outside these two helpers will be invisible to the
    // retry/error policy.
    expect(matches.length).toBe(2);
  });

  it('exports tryFlushWAL (CHECKPOINT-with-rethrow for the manual retry driver)', () => {
    expect(adapterSource).toMatch(/export const tryFlushWAL/);
  });

  it('flushWAL drains and closes the CHECKPOINT result before returning', () => {
    const flushBody = adapterSource.slice(
      adapterSource.indexOf('export const flushWAL'),
      adapterSource.indexOf('export const safeClose'),
    );
    expect(flushBody).toMatch(/await drainQueryResult\(checkpointResult\)/);
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
