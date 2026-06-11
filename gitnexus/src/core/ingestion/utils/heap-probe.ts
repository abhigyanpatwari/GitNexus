/**
 * Synchronous heap probes for large-repo OOM investigation (#1983).
 *
 * Writes to stderr (not pino) so lines flush under CI=1 / gdb attach.
 * Enabled with `GITNEXUS_DEBUG_HEAP=1` or `GITNEXUS_PROFILE_DEFERRED=1`.
 */

import { appendFileSync } from 'node:fs';
import { parseTruthyEnv } from './env.js';
import { isDeferredResolutionProfileEnabled } from './deferred-resolution-profile.js';

export const isDebugHeapEnabled = (): boolean =>
  parseTruthyEnv(process.env.GITNEXUS_DEBUG_HEAP) || isDeferredResolutionProfileEnabled();

export const heapUsedMb = (): number => Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

const rssMb = (): number => Math.round(process.memoryUsage().rss / 1024 / 1024);

/**
 * Flush a one-line heap snapshot to stderr.
 *
 * stderr is async on a pipe (Linux), so a probe written just before an
 * OOM-kill is lost in the pipe buffer. For OOM investigation set
 * `GITNEXUS_HEAP_PROBE_FILE=/path` — each probe is then ALSO appended to
 * that file with a synchronous `appendFileSync`, whose `write(2)` syscall
 * completes (data handed to the kernel) before the call returns, so the
 * last line survives SIGKILL. Includes rss alongside heapUsed so the
 * native/off-heap gap is visible.
 */
export const logHeapProbe = (label: string, detail?: string): void => {
  if (!isDebugHeapEnabled()) return;
  const suffix = detail ? ` ${detail}` : '';
  const line = `[gitnexus-heap] ${label} used_mb=${heapUsedMb()} rss_mb=${rssMb()}${suffix}\n`;
  process.stderr.write(line);
  const file = process.env.GITNEXUS_HEAP_PROBE_FILE;
  if (file) {
    try {
      appendFileSync(file, line);
    } catch {
      // Best-effort diagnostics sink; never let a probe failure abort analyze.
    }
  }
};
