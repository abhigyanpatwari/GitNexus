/**
 * Windows reopen fix — cross-process evidence (#2274 / PR #2313).
 *
 * The RO bridge-handle cache exists to fix a Windows-specific failure: in a
 * long-lived MCP serve process, repeated `@group` calls used to reopen
 * `bridge.lbug` per call, and the in-process reopen fails on Windows. The cache
 * keeps ONE handle alive and reuses it, so there is no reopen.
 *
 * The unit-test cache cases all begin with an in-process `writeBridge` →
 * read-only open (the unfixed write→read reopen), so they are win32-skipped and
 * cannot prove the fix on the target platform. THIS test seeds `bridge.lbug` in
 * a SEPARATE process (so the writable handle is fully released before we open
 * read-only), making the first RO open a clean cross-process open. It therefore
 * runs on win32 CI and proves the load-bearing property: a second/third
 * `getCachedBridgeReadOnly` returns the SAME handle with no reopen.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  getCachedBridgeReadOnly,
  queryBridge,
  closeBridgeDb,
  closeAllCachedBridges,
} from '../../../src/core/group/bridge-db.js';
import { retryRename } from '../../../src/storage/fs-atomic.js';
import { cleanupTempDir } from '../../helpers/test-db.js';
import { tsxLoaderUrl } from '../../helpers/cli-entry.js';

// Absolute file:// URL to the tsx loader so the seed script runs under tsx in a
// child process (shared resolver — see test/helpers/cli-entry.ts).
const tsxImportUrl = tsxLoaderUrl();
const seedScript = fileURLToPath(new URL('./fixtures/seed-bridge.ts', import.meta.url));

describe('bridge RO-handle cache — cross-process seed (Windows reopen fix, #2274)', () => {
  let groupDir: string;

  beforeEach(async () => {
    groupDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bridge-xproc-'));
    // Seed bridge.lbug in a SEPARATE process. Its writable handle is released by
    // process death, so this process's first read-only open is NOT an in-process
    // write→read reopen — the property that lets the reuse assertions run on win32.
    const res = spawnSync(process.execPath, ['--import', tsxImportUrl, seedScript, groupDir], {
      stdio: 'pipe',
      timeout: 60_000,
    });
    expect(res.status, `seed process failed: ${res.stderr?.toString() ?? ''}`).toBe(0);
  });

  afterEach(async () => {
    await closeAllCachedBridges();
    await cleanupTempDir(groupDir);
  });

  it('reuses one cached handle across repeated calls without reopening', async () => {
    // First open: a clean cross-process open (seed already exited) — succeeds on
    // win32. This is the cold-cache open the cache does NOT need to fix.
    const first = await getCachedBridgeReadOnly(groupDir);
    expect(first).not.toBeNull();

    // Repeated calls reuse the SAME handle — no reopen. THIS is the Windows fix:
    // pre-cache, each of these reopened bridge.lbug and failed on Windows.
    const second = await getCachedBridgeReadOnly(groupDir);
    const third = await getCachedBridgeReadOnly(groupDir);
    expect(second).toBe(first);
    expect(third).toBe(first);

    // The reused handle still answers queries.
    const rows = await queryBridge<{ repo: string }>(
      first!,
      'MATCH (c:Contract) RETURN c.repo AS repo',
    );
    expect(rows).toMatchObject([{ repo: 'backend' }]);

    await closeBridgeDb(first!);
    await closeBridgeDb(second!);
    await closeBridgeDb(third!);
  });

  it('concurrent cold-cache opens dedupe to one handle (no double-open) on the target platform', async () => {
    // N concurrent first-callers must coalesce to a single open via inFlightOpens
    // and all receive the same handle — verified here on the cross-process seed so
    // it exercises a real win32 open, not the skipped in-process reopen.
    const N = 6;
    const handles = await Promise.all(
      Array.from({ length: N }, () => getCachedBridgeReadOnly(groupDir)),
    );
    expect(handles.every((h) => h !== null)).toBe(true);
    const first = handles[0]!;
    expect(handles).toMatchObject(Array.from({ length: N }, () => first));

    for (const h of handles) await closeBridgeDb(h!);
  });

  // B2 probe — moved here from the unit suite so it RUNS ON WIN32. bridge.lbug is
  // seeded cross-process (beforeEach), so opening RO is a clean cross-process
  // open, not the in-process write→read reopen that forced the old probe to be
  // win32-skipped. This settles, on Windows CI, the assumption under
  // writeBridge's invalidate-before-rename and the win32 drain: does an open
  // cached RO handle block an external atomic rename over bridge.lbug?
  // LadybugDB opens RO with FILE_SHARE_DELETE, which should permit the rename;
  // a failure on Windows CI means it does not, and invalidate-before-rename is
  // load-bearing rather than belt-and-suspenders.
  it('external rename over bridge.lbug succeeds while a cached RO handle is held', async () => {
    const dbPath = path.join(groupDir, 'bridge.lbug');
    const tmpPath = path.join(groupDir, 'bridge.lbug.tmp');

    // Stage the byte-identical replacement BEFORE opening the RO handle, so we
    // never hold a SECOND OS handle on bridge.lbug while LadybugDB has it open
    // (reading it concurrently would probe FILE_SHARE_READ — a different
    // question — and could red for the wrong reason).
    await fsp.copyFile(dbPath, tmpPath);

    // Hold the cached RO handle open (a long-lived MCP serve process's state).
    const handle = await getCachedBridgeReadOnly(groupDir);
    expect(handle).not.toBeNull();

    // Rename the staged copy over bridge.lbug WHILE the RO handle is held —
    // exactly what a concurrent `gitnexus group sync` does. Use production's
    // retryRename policy (writeBridge uses it), so transient EBUSY/EPERM from
    // the Windows AV/indexer scanning the fresh temp file is absorbed. A RED is
    // then the real steady-state answer: an open RO handle blocks the atomic
    // rename on Windows (FILE_SHARE_DELETE not set) → writeBridge's
    // invalidate-before-rename and the win32 drain are load-bearing. (The
    // handle-survives-rename property is covered by the reuse test above; this
    // probe's sole verdict is whether the rename itself is blocked.)
    let renameError: string | null = null;
    try {
      await retryRename(tmpPath, dbPath);
    } catch (err: unknown) {
      renameError = err instanceof Error ? err.message : String(err);
    }
    expect(
      renameError,
      `[B2] external rename blocked while cached RO handle held: ${renameError}`,
    ).toBeNull();

    await closeBridgeDb(handle!);
  });
});
