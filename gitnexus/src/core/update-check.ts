import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { getGlobalDir } from '../storage/global-dir.js';
import { writeFileAtomic } from '../storage/fs-atomic.js';
import { acquireFileLock, FileLockBusyError } from '../storage/file-lock.js';
import { validateGitUrl } from '../server/git-clone.js';
import { updateEligibleInstall } from './install-context.js';
import { createLogger } from './logger.js';
import {
  isNewerVersion,
  isUpdateCacheFresh,
  normalizedUpdateRegistry,
  parseUpdateCache,
  STRICT_UPDATE_VERSION,
  UPDATE_CACHE_TTL_MS,
  updateCheckCachePath,
  updateCheckLockPath,
  updateNotifierOptedOut,
  type UpdateCacheEntry,
} from './update-cache.js';

const _require = createRequire(import.meta.url);
const pkg = _require('../../package.json') as { version?: unknown };

const FETCH_TIMEOUT_MS = 3_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_REDIRECTS = 5;
const updateLogger = createLogger('update-check');

function defaultInstalledVersion(): string {
  return typeof pkg.version === 'string' ? pkg.version : '';
}

export interface UpdateState {
  updateAvailable: boolean;
  latestVersion?: string;
}

export interface UpdateCheckOptions {
  /** Test/adapter override; omitted means classify process.argv[1]. */
  eligible?: boolean;
  /** Test override; omitted means this package's installed version. */
  installedVersion?: string;
  /** Test override in epoch milliseconds. */
  now?: number;
  /** Cache-only consumers can suppress stale-while-revalidate. */
  refreshIfStale?: boolean;
}

export interface UpdateRefreshSchedulerOptions extends Omit<
  UpdateCheckOptions,
  'now' | 'refreshIfStale'
> {
  now?: () => number;
}

function isOptedOut(): boolean {
  return updateNotifierOptedOut(process.env);
}

async function isEligible(override: boolean | undefined): Promise<boolean> {
  return override ?? (await updateEligibleInstall());
}

function cacheFile(): string {
  return updateCheckCachePath();
}

function lockFile(): string {
  return updateCheckLockPath();
}

function normalizedRegistry(): { identity: string; packageUrl: string } {
  const registry = normalizedUpdateRegistry();
  validateGitUrl(registry.packageUrl);
  return registry;
}

async function readCache(registry: string): Promise<UpdateCacheEntry | null> {
  try {
    return parseUpdateCache(await fs.readFile(cacheFile(), 'utf8'), registry);
  } catch {
    return null;
  }
}

function stateFrom(entry: UpdateCacheEntry, installedVersion: string): UpdateState {
  return {
    updateAvailable:
      entry.latestVersion !== undefined && isNewerVersion(installedVersion, entry.latestVersion),
    ...(entry.latestVersion === undefined ? {} : { latestVersion: entry.latestVersion }),
  };
}

/**
 * Read update state cache-first. Every invalid/missing/stale cache starts one
 * catch-isolated refresh unless the caller explicitly requests cache-only.
 */
export async function evaluate(options: UpdateCheckOptions = {}): Promise<UpdateState | null> {
  try {
    if (isOptedOut() || !(await isEligible(options.eligible))) return null;
    const registry = normalizedRegistry();
    const now = options.now ?? Date.now();
    const entry = await readCache(registry.identity);
    if (
      (!entry || !isUpdateCacheFresh(entry.lastCheckAt, now)) &&
      options.refreshIfStale !== false
    ) {
      void refresh(options).catch(() => {});
    }
    if (!entry) return null;
    return stateFrom(entry, options.installedVersion ?? defaultInstalledVersion());
  } catch {
    return null;
  }
}

async function readResponseBody(response: Response): Promise<string> {
  const advertised = Number(response.headers.get('content-length'));
  if (Number.isFinite(advertised) && advertised > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Registry response too large');
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('Registry response too large');
      chunks.push(value);
    }
  } finally {
    if (bytes > MAX_RESPONSE_BYTES) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sanitizedHttpUrl(input: string | URL, base?: string): URL {
  const parsed = new URL(input, base);
  parsed.username = '';
  parsed.password = '';
  validateGitUrl(parsed.toString());
  return parsed;
}

async function fetchLatest(packageUrl: string): Promise<string> {
  let url = sanitizedHttpUrl(packageUrl);
  for (let redirects = 0; ; redirects += 1) {
    const response = await fetch(url.toString(), {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      if (redirects >= MAX_REDIRECTS) throw new Error('Too many registry redirects');
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location) throw new Error('Registry redirect missing location');
      url = sanitizedHttpUrl(location, url.toString());
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Registry returned ${response.status}`);
    }
    const parsed = JSON.parse(await readResponseBody(response)) as {
      'dist-tags'?: { latest?: unknown };
    };
    const latest = parsed['dist-tags']?.latest;
    if (typeof latest !== 'string' || !STRICT_UPDATE_VERSION.test(latest)) {
      throw new Error('Registry latest version is invalid');
    }
    return latest;
  }
}

async function publishMonotonically(
  entry: UpdateCacheEntry,
  attemptStartedAt: number,
): Promise<void> {
  const current = await readCache(entry.registry);
  if (current && Date.parse(current.lastCheckAt) > attemptStartedAt) return;
  await fs.mkdir(getGlobalDir(), { recursive: true });
  await writeFileAtomic(cacheFile(), `${JSON.stringify(entry)}\n`, 1);
}

let refreshInFlight: Promise<UpdateState | null> | null = null;

/** Run one locked, fail-open registry refresh. */
export function refresh(options: UpdateCheckOptions = {}): Promise<UpdateState | null> {
  if (refreshInFlight) return refreshInFlight;
  const run = async (): Promise<UpdateState | null> => {
    let release: (() => Promise<void>) | undefined;
    try {
      if (isOptedOut() || !(await isEligible(options.eligible))) return null;
      const registry = normalizedRegistry();
      const attemptStartedAt = options.now ?? Date.now();
      try {
        release = await acquireFileLock(lockFile(), { retries: 0 });
      } catch (error) {
        if (error instanceof FileLockBusyError) return null;
        throw error;
      }

      let latestVersion: string | undefined;
      try {
        latestVersion = await fetchLatest(registry.packageUrl);
      } catch {
        // Negative entries enforce the same TTL on offline/authenticated-only
        // registries as successful checks.
      }
      const entry: UpdateCacheEntry = {
        lastCheckAt: new Date(attemptStartedAt).toISOString(),
        registry: registry.identity,
        ...(latestVersion === undefined ? {} : { latestVersion }),
      };
      await publishMonotonically(entry, attemptStartedAt);
      return stateFrom(entry, options.installedVersion ?? defaultInstalledVersion());
    } catch (error) {
      updateLogger.debug(
        { code: (error as NodeJS.ErrnoException).code },
        'Update check failed open',
      );
      return null;
    } finally {
      if (release) await release().catch(() => {});
    }
  };
  refreshInFlight = run().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/**
 * Start an immediate evaluation and repeat on the cache TTL cadence. Timers
 * never keep the process alive; refresh() supplies process-wide single-flight.
 */
export function armUpdateRefreshScheduler(
  onState: (state: UpdateState | null) => void,
  options: UpdateRefreshSchedulerOptions = {},
): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const cycle = async (): Promise<void> => {
    if (stopped) return;
    const now = options.now?.() ?? Date.now();
    let entry: UpdateCacheEntry | null = null;
    try {
      const registry = normalizedRegistry();
      entry = await readCache(registry.identity);
      if (!entry || !isUpdateCacheFresh(entry.lastCheckAt, now)) {
        await refresh({ ...options, now });
        entry = await readCache(registry.identity);
      }
    } catch {
      // The public scheduler shares the service's fail-open contract.
    }
    // Derive state from the entry already read above; a full evaluate() here
    // would re-run guards and re-read the cache on every tick.
    let state: UpdateState | null = null;
    try {
      state =
        isOptedOut() || !(await isEligible(options.eligible)) || !entry
          ? null
          : stateFrom(entry, options.installedVersion ?? defaultInstalledVersion());
    } catch {
      state = null;
    }
    if (!stopped) onState(state);
    if (!stopped) {
      const checkedAt = entry ? Date.parse(entry.lastCheckAt) : Number.NaN;
      const delay =
        Number.isFinite(checkedAt) && checkedAt <= now
          ? Math.max(1, checkedAt + UPDATE_CACHE_TTL_MS - now)
          : UPDATE_CACHE_TTL_MS;
      timer = setTimeout(() => void cycle(), delay);
      timer.unref();
    }
  };
  timer = setTimeout(() => void cycle(), 0);
  timer.unref();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
