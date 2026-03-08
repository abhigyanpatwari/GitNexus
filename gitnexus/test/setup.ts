/**
 * Vitest per-file setup file (runs inside each forked worker).
 *
 * KuzuDB's native C++ addon has two problems on Linux:
 *  1. Persistent N-API handles keep the event loop alive after closeSync(),
 *     preventing the fork worker from exiting naturally (→ hang).
 *  2. N-API destructor hooks segfault (SIGSEGV) on process exit even after
 *     closeSync() has nulled the internal shared_ptrs.
 *
 * Strategy:
 *  - Each test file's own cleanup (withTestKuzuDB afterAll, etc.) calls
 *    detachKuzu() to close native objects and null JS refs.
 *  - This global afterAll unref's all remaining active handles so the
 *    event loop drains naturally — no process.exit(0) needed.
 *  - Safety net: force-exit after 5s if native handles can't be unref'd.
 *    The timer is cleared in beforeAll so it doesn't leak across files
 *    when vitest reuses the fork (maxWorkers: 1).
 *
 * IMPORTANT: We do NOT import kuzu-adapter here. Importing it would load
 * the native addon even in non-KuzuDB test files, registering persistent
 * handles that prevent the fork from exiting.
 */
import { afterAll, beforeAll } from 'vitest';

// Persists across files in the same fork (module is cached).
let safetyTimer: ReturnType<typeof setTimeout> | undefined;

beforeAll(() => {
  // Clear safety-net timer from the PREVIOUS file's afterAll.
  // Without this, the timer leaks into the next file and fires
  // process.exit(0) mid-test, killing the fork.
  if (safetyTimer) {
    clearTimeout(safetyTimer);
    safetyTimer = undefined;
  }
});

afterAll(() => {
  // Unref all active handles so the event loop can drain naturally.
  // For non-KuzuDB test files this is a no-op (no native handles).
  // For KuzuDB test files, detachKuzu() already ran in withTestKuzuDB
  // cleanup — this catches any lingering handles.
  try {
    const handles = (process as any)._getActiveHandles?.();
    if (handles) {
      for (const h of handles) {
        if (typeof h.unref === 'function') h.unref();
      }
    }
  } catch {}

  // Safety net: if native handles can't be unref'd (e.g. KuzuDB C++
  // refs that don't expose .unref()), force-exit after a delay long
  // enough for vitest to flush IPC results back to the parent.
  // The timer is .unref()'d so it doesn't keep non-KuzuDB forks alive,
  // and cleared in beforeAll so it doesn't leak across files.
  safetyTimer = setTimeout(() => process.exit(0), 5000);
  safetyTimer.unref();
});
