/**
 * Vitest global setup file.
 *
 * KuzuDB's C++ destructors hang when N-API cleanup hooks fire during
 * forked process exit (Ubuntu CI) or segfault (Windows).
 *
 * Fix: detachKuzu() calls .close() on all native objects during afterAll,
 * which nulls the internal shared_ptrs.  When process.exit(0) later runs
 * N-API cleanup, the destructors find null ptrs and return immediately.
 *
 * The beforeExit handler is a safety net — if any native objects survive
 * afterAll (e.g. from test code creating raw kuzu connections), it forces
 * exit before GC can trigger destructors on them.
 */
import { afterAll } from 'vitest';

// ── Safety net: force-exit before GC triggers native destructors ─────
process.on('beforeExit', () => process.exit(0));

afterAll(async () => {
  // Close + detach all native KuzuDB refs.  After .close(), native
  // shared_ptrs are null → N-API destructor hooks become no-ops.
  try { (await import('../src/core/kuzu/kuzu-adapter.js')).detachKuzu(); } catch {}
  try { (await import('../src/mcp/core/kuzu-adapter.js')).detachKuzu(); } catch {}
});
