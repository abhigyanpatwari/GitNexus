export type WatchRefresh = (paths: readonly string[]) => Promise<void>;
export type WatchRefreshError = (error: unknown, paths: readonly string[]) => void;

export const WATCH_FULL_REFRESH_PATH = '*';

export interface WatchRefreshQueueOptions {
  readonly maxWaitMs?: number;
  readonly maxPendingPaths?: number;
  readonly retryBaseDelayMs?: number;
  readonly retryMaxDelayMs?: number;
  readonly holdEventsUntilInitialRefresh?: boolean;
  readonly isPriorityPath?: (filePath: string) => boolean;
}

/** Debounces filesystem events and guarantees that refreshes never overlap. */
export class WatchRefreshQueue {
  private readonly pending = new Set<string>();
  private readonly idleWaiters = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<void> | undefined;
  private closed = false;
  private initialPending = false;
  private firstPendingAt: number | undefined;
  private overflowed = false;
  private consecutiveFailures = 0;
  private retryNotBefore: number | undefined;

  constructor(
    private readonly refresh: WatchRefresh,
    private readonly onError: WatchRefreshError,
    private readonly debounceMs: number,
    private readonly options: WatchRefreshQueueOptions = {},
  ) {
    this.initialPending = options.holdEventsUntilInitialRefresh === true;
  }

  enqueue(filePath: string): void {
    if (this.closed) return;
    this.addPendingPath(filePath);
    this.firstPendingAt ??= Date.now();
    if (!this.initialPending && this.active === undefined) this.schedule();
  }

  private addPendingPath(filePath: string): void {
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
  }

  /** Run the initial refresh while still queueing events that arrive during it. */
  async runInitial(): Promise<void> {
    if (this.closed) return;
    if (this.active !== undefined) throw new Error('Watch refresh is already running');
    try {
      await this.runBatch([], true);
    } finally {
      this.initialPending = false;
      if (!this.closed && this.hasPendingWork()) this.schedule();
      else this.resolveIdleWaiters();
    }
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
    this.consecutiveFailures = 0;
    this.retryNotBefore = undefined;
    // A refresh rejection is already surfaced through `onError` (or through
    // runInitial). Closing from that handler can race the runBatch `finally`,
    // so consume the same rejection here instead of reporting it twice.
    await this.active?.catch(() => {});
    this.resolveIdleWaiters();
  }

  private schedule(retryDelayMs?: number): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    const maxWaitMs = this.options.maxWaitMs ?? Math.max(this.debounceMs, 2_000);
    const now = Date.now();
    if (retryDelayMs !== undefined) this.retryNotBefore = now + retryDelayMs;
    const elapsed = this.firstPendingAt === undefined ? 0 : now - this.firstPendingAt;
    const debounced = Math.max(0, Math.min(this.debounceMs, maxWaitMs - elapsed));
    // An event arriving mid-backoff merges into the pending batch but must not
    // pull the retry earlier than the deadline the backoff already committed to.
    const delay =
      retryDelayMs ??
      (this.retryNotBefore === undefined
        ? debounced
        : Math.max(debounced, this.retryNotBefore - now));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, delay);
  }

  private async drain(): Promise<void> {
    if (this.closed || this.active !== undefined || !this.hasPendingWork()) return;
    const paths = [
      ...(this.overflowed ? [WATCH_FULL_REFRESH_PATH] : []),
      ...[...this.pending].sort(),
    ];
    this.pending.clear();
    this.firstPendingAt = undefined;
    this.overflowed = false;
    this.retryNotBefore = undefined;
    await this.runBatch(paths, false);
  }

  private async runBatch(paths: readonly string[], propagateError: boolean): Promise<void> {
    let work: Promise<void>;
    try {
      work = this.refresh(paths);
    } catch (error) {
      work = Promise.reject(error);
    }
    this.active = work;
    let retryDelayMs: number | undefined;
    try {
      await work;
      this.consecutiveFailures = 0;
    } catch (error) {
      if (propagateError) throw error;
      try {
        await this.onError(error, paths);
      } catch {
        // Refresh failures are already handled here; a reporter must not
        // reject the detached drain promise and become an unhandled rejection.
      }
      if (!this.closed) {
        if (paths.includes(WATCH_FULL_REFRESH_PATH)) this.overflowed = true;
        for (const filePath of paths) {
          if (filePath !== WATCH_FULL_REFRESH_PATH) this.addPendingPath(filePath);
        }
        this.firstPendingAt = Date.now();
        this.consecutiveFailures++;
        const base = this.options.retryBaseDelayMs ?? Math.max(250, this.debounceMs);
        const maximum = this.options.retryMaxDelayMs ?? 30_000;
        retryDelayMs = Math.min(maximum, base * 2 ** (this.consecutiveFailures - 1));
      }
    } finally {
      if (this.active === work) this.active = undefined;
      if (!this.closed && !this.initialPending && this.hasPendingWork())
        this.schedule(retryDelayMs);
      else this.resolveIdleWaiters();
    }
  }

  private hasPendingWork(): boolean {
    return this.overflowed || this.pending.size > 0;
  }

  private isIdle(): boolean {
    return this.active === undefined && this.timer === undefined && !this.hasPendingWork();
  }

  private resolveIdleWaiters(): void {
    if (!this.isIdle() && !this.closed) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}
