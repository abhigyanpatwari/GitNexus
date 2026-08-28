export type WatchRefresh = (paths: readonly string[]) => Promise<void>;
export type WatchRefreshError = (error: unknown, paths: readonly string[]) => void;

export const WATCH_FULL_REFRESH_PATH = '*';

export interface WatchRefreshQueueOptions {
  readonly maxWaitMs?: number;
  readonly maxPendingPaths?: number;
  readonly isPriorityPath?: (filePath: string) => boolean;
}

/** Debounces filesystem events and guarantees that refreshes never overlap. */
export class WatchRefreshQueue {
  private readonly pending = new Set<string>();
  private readonly idleWaiters = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<void> | undefined;
  private closed = false;
  private firstPendingAt: number | undefined;
  private overflowed = false;

  constructor(
    private readonly refresh: WatchRefresh,
    private readonly onError: WatchRefreshError,
    private readonly debounceMs: number,
    private readonly options: WatchRefreshQueueOptions = {},
  ) {}

  enqueue(filePath: string): void {
    if (this.closed) return;
    const maxPendingPaths = this.options.maxPendingPaths ?? 1_000;
    const priority = this.options.isPriorityPath?.(filePath) === true;
    if (this.pending.has(filePath)) {
      // A duplicate does not increase memory use or imply that paths were dropped.
    } else if (this.pending.size < maxPendingPaths) {
      this.pending.add(filePath);
    } else {
      this.overflowed = true;
      if (priority) {
        const evictable = [...this.pending].find(
          (pendingPath) => this.options.isPriorityPath?.(pendingPath) !== true,
        );
        if (evictable !== undefined) {
          this.pending.delete(evictable);
          this.pending.add(filePath);
        }
      }
    }
    this.firstPendingAt ??= Date.now();
    if (this.active === undefined) this.schedule();
  }

  /** Run the initial refresh while still queueing events that arrive during it. */
  async runInitial(): Promise<void> {
    if (this.closed) return;
    if (this.active !== undefined) throw new Error('Watch refresh is already running');
    await this.runBatch([], true);
  }

  async waitForIdle(): Promise<void> {
    if (this.isIdle()) return;
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
    this.firstPendingAt = undefined;
    this.overflowed = false;
    // A refresh rejection is already surfaced through `onError` (or through
    // runInitial). Closing from that handler can race the runBatch `finally`,
    // so consume the same rejection here instead of reporting it twice.
    await this.active?.catch(() => {});
    this.resolveIdleWaiters();
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    const maxWaitMs = this.options.maxWaitMs ?? Math.max(this.debounceMs, 2_000);
    const elapsed = this.firstPendingAt === undefined ? 0 : Date.now() - this.firstPendingAt;
    const delay = Math.max(0, Math.min(this.debounceMs, maxWaitMs - elapsed));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, delay);
  }

  private async drain(): Promise<void> {
    if (this.closed || this.active !== undefined || this.pending.size === 0) return;
    const paths = [
      ...(this.overflowed ? [WATCH_FULL_REFRESH_PATH] : []),
      ...[...this.pending].sort(),
    ];
    this.pending.clear();
    this.firstPendingAt = undefined;
    this.overflowed = false;
    await this.runBatch(paths, false);
  }

  private async runBatch(paths: readonly string[], propagateError: boolean): Promise<void> {
    const work = this.refresh(paths);
    this.active = work;
    try {
      await work;
    } catch (error) {
      if (propagateError) throw error;
      try {
        await this.onError(error, paths);
      } catch {
        // Refresh failures are already handled here; a reporter must not
        // reject the detached drain promise and become an unhandled rejection.
      }
    } finally {
      if (this.active === work) this.active = undefined;
      if (!this.closed && this.pending.size > 0) this.schedule();
      else this.resolveIdleWaiters();
    }
  }

  private isIdle(): boolean {
    return this.active === undefined && this.timer === undefined && this.pending.size === 0;
  }

  private resolveIdleWaiters(): void {
    if (!this.isIdle() && !this.closed) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}
