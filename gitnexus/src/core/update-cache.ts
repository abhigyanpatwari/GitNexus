import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getGlobalDir } from '../storage/global-dir.js';
import { isProcessAlive, readProcessStartTime } from '../utils/process-identity.js';

export const UPDATE_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
export const STRICT_UPDATE_VERSION = /^\d+\.\d+\.\d+$/;
export const DEFAULT_UPDATE_REGISTRY = 'https://registry.npmjs.org';

export interface UpdateCacheEntry {
  lastCheckAt: string;
  registry: string;
  latestVersion?: string;
}

export interface ValidatedUpdateCache {
  lastCheckAt: number;
  latestVersion?: string;
  stale: boolean;
}

/** Broad truthy parsing shared by the update-notifier guards. */
export function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  return !['', '0', 'false', 'no', 'off'].includes(value.toLowerCase());
}

/** The update notifier is disabled by either opt-out env or a CI environment. */
export function updateNotifierOptedOut(env: NodeJS.ProcessEnv): boolean {
  return (
    isTruthyEnv(env.GITNEXUS_NO_UPDATE_NOTIFIER) ||
    isTruthyEnv(env.NO_UPDATE_NOTIFIER) ||
    isTruthyEnv(env.CI)
  );
}

/** Freshness gate for the 24h TTL; future-dated timestamps are stale. */
export function isUpdateCacheFresh(lastCheckAt: string, now: number): boolean {
  const checkedAt = Date.parse(lastCheckAt);
  return checkedAt <= now && now - checkedAt < UPDATE_CACHE_TTL_MS;
}

/** Strict x.y.z numeric comparison. Invalid or prerelease versions are silent. */
export function isNewerVersion(installedVersion: string, latestVersion: string): boolean {
  if (!STRICT_UPDATE_VERSION.test(installedVersion) || !STRICT_UPDATE_VERSION.test(latestVersion)) {
    return false;
  }
  const installed = installedVersion.split('.').map(BigInt);
  const latest = latestVersion.split('.').map(BigInt);
  for (let index = 0; index < 3; index += 1) {
    if (latest[index] !== installed[index]) return latest[index] > installed[index];
  }
  return false;
}

let registryMemo: { key: string; value: { identity: string; packageUrl: string } } | undefined;

export function normalizedUpdateRegistry(env: NodeJS.ProcessEnv = process.env): {
  identity: string;
  packageUrl: string;
} {
  const key = env.npm_config_registry ?? '';
  if (registryMemo?.key === key) return registryMemo.value;
  const value = buildUpdateRegistry(key);
  registryMemo = { key, value };
  return value;
}

function buildUpdateRegistry(rawRegistry: string): { identity: string; packageUrl: string } {
  const parsed = new URL(rawRegistry || DEFAULT_UPDATE_REGISTRY);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Unsupported npm registry protocol');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('Registry URL cannot contain query or fragment');
  }
  parsed.username = '';
  parsed.password = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';

  const pathname = parsed.pathname === '/' ? '' : parsed.pathname;
  const identity = `${parsed.protocol}//${parsed.host}${pathname}`;
  // `/<pkg>/latest` is the small dist-tag document. The full packument at
  // `/<pkg>` is multi-megabyte on this package and cannot fit the fetch cap.
  const packagePath = `${pathname}/gitnexus/latest`.replace(/\/{2,}/g, '/');
  return { identity, packageUrl: `${parsed.protocol}//${parsed.host}${packagePath}` };
}

export function updateCheckCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.GITNEXUS_HOME || getGlobalDir(), 'update-check.json');
}

export function updateCheckLockPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.GITNEXUS_HOME || getGlobalDir(), 'update-check.lock');
}

/**
 * Best-effort synchronous probe: is a refresh plausibly in flight? Used to
 * coalesce detached refresh spawns. A dead same-host owner returns false so
 * the spawned child can reclaim the stale lock; a foreign-host owner returns
 * false and lets the child's full lock logic decide.
 */
export function updateRefreshInProgress(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const owner = JSON.parse(fs.readFileSync(updateCheckLockPath(env), 'utf8')) as {
      pid?: unknown;
      hostname?: unknown;
      processStartTime?: unknown;
    };
    if (typeof owner.pid !== 'number' || owner.pid <= 0) return false;
    if (owner.hostname !== os.hostname()) return false;
    if (!isProcessAlive(owner.pid)) return false;
    // Same rule as acquireFileLock: a live PID with a different start time is
    // reuse, not the lock owner. Unreadable start time stays conservative
    // (treat as in progress) so we don't spawn a racing child.
    if (typeof owner.processStartTime === 'string' && owner.processStartTime) {
      const currentStartTime = readProcessStartTime(owner.pid);
      if (currentStartTime && currentStartTime !== owner.processStartTime) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function parseUpdateCache(raw: string, registry: string): UpdateCacheEntry | null {
  try {
    const parsed = JSON.parse(raw) as Partial<UpdateCacheEntry>;
    if (
      typeof parsed.lastCheckAt !== 'string' ||
      !Number.isFinite(Date.parse(parsed.lastCheckAt)) ||
      parsed.registry !== registry ||
      (parsed.latestVersion !== undefined &&
        (typeof parsed.latestVersion !== 'string' ||
          !STRICT_UPDATE_VERSION.test(parsed.latestVersion)))
    ) {
      return null;
    }
    return {
      lastCheckAt: parsed.lastCheckAt,
      registry: parsed.registry,
      ...(parsed.latestVersion === undefined ? {} : { latestVersion: parsed.latestVersion }),
    };
  } catch {
    return null;
  }
}

export function readValidatedUpdateCacheSync(
  options: {
    env?: NodeJS.ProcessEnv;
    now?: number;
  } = {},
): ValidatedUpdateCache | null {
  try {
    const env = options.env ?? process.env;
    const registry = normalizedUpdateRegistry(env);
    const raw = fs.readFileSync(updateCheckCachePath(env), 'utf8');
    const entry = parseUpdateCache(raw, registry.identity);
    if (!entry) return null;
    const lastCheckAt = Date.parse(entry.lastCheckAt);
    const now = options.now ?? Date.now();
    return {
      lastCheckAt,
      ...(entry.latestVersion === undefined ? {} : { latestVersion: entry.latestVersion }),
      stale: !isUpdateCacheFresh(entry.lastCheckAt, now),
    };
  } catch {
    return null;
  }
}
