/**
 * Pins the host's effective RAM for `analyzeCommand` unit tests, so they do not
 * depend on how much memory the machine running them reports.
 *
 * `analyzeCommand` admits parser/model work against the host's real memory
 * (`resolveHostAnalysisResources`, #3829) before it reaches the pipeline these
 * tests mock. `vitest.config.ts` sets `GITNEXUS_MEMORY=off`, so the test fork's
 * own V8 heap limit is charged as the main heap. A CI runner reporting 15700 MiB
 * fell 12 MiB short, analyze exited 1, and every test that expects the mocked
 * pipeline to run failed.
 *
 * Only the RAM figure is pinned: the real admission policy still runs on it, with
 * the fork's real heap limit and RSS. Tests of admission itself
 * (`analysis-host-resources`, `analyze-worker-pool-size`, ...) do not use this.
 *
 * The factory has to be imported inside the hoisted `vi.mock` call:
 *
 *   vi.mock('../../src/core/ingestion/utils/effective-ram.js', async (importOriginal) =>
 *     (await import('../helpers/admitted-host-memory.js')).withAdmittedHostMemory(importOriginal),
 *   );
 */
type EffectiveRamModule = typeof import('../../src/core/ingestion/utils/effective-ram.js');

/** Admits any default V8 heap limit with a local embedding model reserved. */
export const ADMITTED_HOST_MEMORY_BYTES = 64 * 1024 ** 3;

export async function withAdmittedHostMemory(
  importOriginal: () => Promise<EffectiveRamModule>,
): Promise<EffectiveRamModule> {
  return { ...(await importOriginal()), effectiveRamBytes: () => ADMITTED_HOST_MEMORY_BYTES };
}
