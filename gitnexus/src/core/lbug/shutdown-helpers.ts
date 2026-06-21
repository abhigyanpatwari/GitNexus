/**
 * Shared bounded "checkpoint, then exit" cleanup for interrupt/cancel signals
 * (#2264). The CLI SIGINT handler and the forked worker's SIGTERM handler both
 * need to: CHECKPOINT the WAL for durability (skipping the native close — see
 * closeLbugBeforeExit), but NOT hang behind an in-flight COPY that holds the
 * connection lock, and then exit. Bounding the CHECKPOINT with a short timeout
 * keeps a single Ctrl-C / cancel responsive; the WAL replays on the next analyze.
 */
import { closeLbugBeforeExit } from './lbug-adapter.js';

/** Default cap so a CHECKPOINT queued behind a long COPY can't wedge the signal. */
export const DEFAULT_EXIT_CLEANUP_TIMEOUT_MS = 2000;

export interface BoundedCheckpointExitOptions {
  /** Exit code to terminate with (130 for SIGINT, 0 for a worker SIGTERM). */
  exitCode: number;
  /** Cap on the CHECKPOINT; defaults to {@link DEFAULT_EXIT_CLEANUP_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Report a CHECKPOINT failure (e.g. over IPC) rather than swallowing it. */
  onFlushError?: (err: unknown) => void;
  /** Run just before exit (e.g. flush the logger synchronously). */
  beforeExit?: () => void | Promise<void>;
  /** @internal test seam — defaults to {@link closeLbugBeforeExit}. */
  checkpoint?: () => Promise<void>;
  /** @internal test seam — defaults to `process.exit`. */
  exit?: (code: number) => void;
}

/**
 * Best-effort CHECKPOINT bounded by a timeout, then exit. Never rejects — the
 * exit always fires (in `finally`) even if the CHECKPOINT throws. Fire-and-forget
 * from a signal handler (`void boundedCheckpointBeforeExit({...})`).
 */
export async function boundedCheckpointBeforeExit(
  opts: BoundedCheckpointExitOptions,
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_EXIT_CLEANUP_TIMEOUT_MS;
  const checkpoint = opts.checkpoint ?? closeLbugBeforeExit;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      checkpoint().catch((err: unknown) => opts.onFlushError?.(err)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await opts.beforeExit?.();
    exit(opts.exitCode);
  }
}
