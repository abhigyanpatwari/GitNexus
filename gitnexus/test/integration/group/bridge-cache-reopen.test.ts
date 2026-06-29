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
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  getCachedBridgeReadOnly,
  queryBridge,
  closeBridgeDb,
  closeAllCachedBridges,
} from '../../../src/core/group/bridge-db.js';
import { cleanupTempDir } from '../../helpers/test-db.js';

// Absolute file:// URL to the tsx loader so the seed script runs under tsx in a
// child process (mirrors test/integration/cli-e2e.test.ts).
const _require = createRequire(import.meta.url);
const tsxPkgDir = path.dirname(_require.resolve('tsx/package.json'));
const tsxImportUrl = pathToFileURL(path.join(tsxPkgDir, 'dist', 'loader.mjs')).href;
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
});
