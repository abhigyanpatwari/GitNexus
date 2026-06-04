export interface ReindexWatcherTarget {
  repoKey: string;
  repoName: string;
  repoPath: string;
}

export interface ReindexWatcherConfig {
  enabled: boolean;
  dryRun: boolean;
  debounceMs: number;
  sweepMs: number;
  embeddings: boolean;
}

export interface ReindexWatcherRequest {
  repoKey: string;
  repoName: string;
  repoPath: string;
  changedPaths: string[];
  dryRun: boolean;
  reason: 'watch' | 'sweep' | 'manual';
  force: true;
  embeddings: boolean;
}

export interface ReindexWatcherSchedulerOptions {
  targets: ReindexWatcherTarget[];
  dryRun?: boolean;
  debounceMs?: number;
  embeddings?: boolean;
  now?: () => number;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  requestReindex: (request: ReindexWatcherRequest) => void | Promise<void>;
  onDryRun?: (request: ReindexWatcherRequest) => void;
}

interface DirtyRepo {
  changedPaths: Set<string>;
  lastChangedAt: number;
  timer?: unknown;
  reason: 'watch' | 'sweep' | 'manual';
}

const DEFAULT_DEBOUNCE_MS = 2_000;
const DEFAULT_SWEEP_MS = 60_000;

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

const parseBooleanEnv = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return fallback;
};

const parsePositiveIntEnv = (value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const readReindexWatcherConfigFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): ReindexWatcherConfig => ({
  enabled: parseBooleanEnv(env.GITNEXUS_REINDEX_WATCHER, false),
  dryRun: parseBooleanEnv(env.GITNEXUS_REINDEX_WATCHER_DRY_RUN, true),
  debounceMs: parsePositiveIntEnv(env.GITNEXUS_REINDEX_WATCHER_DEBOUNCE_MS, DEFAULT_DEBOUNCE_MS),
  sweepMs: parsePositiveIntEnv(env.GITNEXUS_REINDEX_WATCHER_SWEEP_MS, DEFAULT_SWEEP_MS),
  embeddings: parseBooleanEnv(env.GITNEXUS_REINDEX_WATCHER_EMBEDDINGS, true),
});

export const isIgnoredReindexWatcherPath = (changedPath: string): boolean => {
  const normalized = changedPath.replace(/\\/g, '/').toLowerCase();
  const segments = normalized.split('/').filter(Boolean);
  if (
    segments.some((segment) =>
      [
        '.git',
        '.gitnexus',
        'node_modules',
        'dist',
        'build',
        'coverage',
        '.next',
        '.turbo',
        '.cache',
        'tmp',
        'temp',
      ].includes(segment),
    )
  ) {
    return true;
  }

  return /(^|\/)(~|\.)[^/]*\.swp$/.test(normalized) || /(~|\.tmp|\.temp)$/.test(normalized);
};

export class ReindexWatcherScheduler {
  private readonly targets = new Map<string, ReindexWatcherTarget>();
  private readonly dirtyRepos = new Map<string, DirtyRepo>();
  private readonly dryRun: boolean;
  private readonly debounceMs: number;
  private readonly embeddings: boolean;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly requestReindex: ReindexWatcherSchedulerOptions['requestReindex'];
  private readonly onDryRun?: ReindexWatcherSchedulerOptions['onDryRun'];

  constructor(options: ReindexWatcherSchedulerOptions) {
    for (const target of options.targets) {
      this.targets.set(target.repoKey, target);
    }
    this.dryRun = options.dryRun ?? true;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.embeddings = options.embeddings ?? true;
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.requestReindex = options.requestReindex;
    this.onDryRun = options.onDryRun;
  }

  recordChange(
    repoKey: string,
    changedPath: string,
    reason: 'watch' | 'sweep' | 'manual' = 'watch',
  ): boolean {
    if (isIgnoredReindexWatcherPath(changedPath)) return false;
    const target = this.targets.get(repoKey);
    if (!target) return false;

    const existing = this.dirtyRepos.get(repoKey);
    if (existing?.timer) this.clearTimer(existing.timer);

    const dirty = existing ?? {
      changedPaths: new Set<string>(),
      lastChangedAt: this.now(),
      reason,
    };
    dirty.changedPaths.add(changedPath);
    dirty.lastChangedAt = this.now();
    dirty.reason = reason;
    dirty.timer = this.setTimer(() => {
      void this.flushRepo(repoKey);
    }, this.debounceMs);
    this.dirtyRepos.set(repoKey, dirty);
    return true;
  }

  markAllDirty(reason: 'sweep' | 'manual' = 'sweep'): number {
    let marked = 0;
    for (const target of this.targets.values()) {
      if (this.recordChange(target.repoKey, target.repoPath, reason)) marked += 1;
    }
    return marked;
  }

  async sweepDue(): Promise<number> {
    const now = this.now();
    const due = Array.from(this.dirtyRepos.entries()).filter(
      ([, dirty]) => now - dirty.lastChangedAt >= this.debounceMs,
    );
    for (const [repoKey] of due) {
      await this.flushRepo(repoKey);
    }
    return due.length;
  }

  async flushRepo(repoKey: string): Promise<ReindexWatcherRequest | undefined> {
    const target = this.targets.get(repoKey);
    const dirty = this.dirtyRepos.get(repoKey);
    if (!target || !dirty) return undefined;

    if (dirty.timer) this.clearTimer(dirty.timer);
    this.dirtyRepos.delete(repoKey);

    const request: ReindexWatcherRequest = {
      repoKey,
      repoName: target.repoName,
      repoPath: target.repoPath,
      changedPaths: Array.from(dirty.changedPaths).sort(),
      dryRun: this.dryRun,
      reason: dirty.reason,
      force: true,
      embeddings: this.embeddings,
    };

    if (this.dryRun) {
      this.onDryRun?.(request);
      return request;
    }

    await this.requestReindex(request);
    return request;
  }

  pendingRepoKeys(): string[] {
    return Array.from(this.dirtyRepos.keys()).sort();
  }

  dispose(): void {
    for (const dirty of this.dirtyRepos.values()) {
      if (dirty.timer) this.clearTimer(dirty.timer);
    }
    this.dirtyRepos.clear();
  }
}
