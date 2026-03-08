/**
 * Vitest per-file setup file (runs inside each forked worker).
 *
 * Unref's all active handles after each test file so the event loop can
 * drain naturally. For non-native test files this is sufficient to let
 * the fork exit. For KuzuDB test files, native C++ handles may not expose
 * .unref() — CI handles this via process isolation (one vitest invocation
 * per KuzuDB test file) so the OS reclaims everything on process exit.
 *
 * IMPORTANT: We do NOT import kuzu-adapter here. Importing it would load
 * the native addon even in non-KuzuDB test files, registering persistent
 * handles that prevent the fork from exiting.
 *
 * IMPORTANT: We do NOT call process.exit() here. On Linux, process.exit()
 * triggers N-API destructor hooks in the KuzuDB native addon that segfault
 * (SIGSEGV), crashing the fork before it can send results back via IPC.
 */
import { afterAll } from 'vitest';

afterAll(() => {
  try {
    const handles = (process as any)._getActiveHandles?.();
    if (handles) {
      for (const h of handles) {
        if (typeof h.unref === 'function') h.unref();
      }
    }
  } catch {}
});
