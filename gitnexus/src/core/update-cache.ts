import fs from 'node:fs';
import path from 'node:path';
import { getGlobalDir } from '../storage/global-dir.js';

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

/** Strict x.y.z numeric comparison. Invalid or prerelease versions are silent. */
export function isNewerVersion(installedVersion: string, latestVersion: string): boolean {
  if (!STRICT_UPDATE_VERSION.test(installedVersion) || !STRICT_UPDATE_VERSION.test(latestVersion)) {
    return false;
  }
  const installed = installedVersion.split('.').map(Number);
  const latest = latestVersion.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (latest[index] !== installed[index]) return latest[index] > installed[index];
  }
  return false;
}

export function normalizedUpdateRegistry(env: NodeJS.ProcessEnv = process.env): {
  identity: string;
  packageUrl: string;
} {
  const parsed = new URL(env.npm_config_registry || DEFAULT_UPDATE_REGISTRY);
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
  const packagePath = `${pathname}/gitnexus`.replace(/\/{2,}/g, '/');
  return { identity, packageUrl: `${parsed.protocol}//${parsed.host}${packagePath}` };
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
    const globalDir = env.GITNEXUS_HOME || getGlobalDir();
    const raw = fs.readFileSync(path.join(globalDir, 'update-check.json'), 'utf8');
    const entry = parseUpdateCache(raw, registry.identity);
    if (!entry) return null;
    const lastCheckAt = Date.parse(entry.lastCheckAt);
    const now = options.now ?? Date.now();
    return {
      lastCheckAt,
      ...(entry.latestVersion === undefined ? {} : { latestVersion: entry.latestVersion }),
      stale: lastCheckAt > now || now - lastCheckAt >= UPDATE_CACHE_TTL_MS,
    };
  } catch {
    return null;
  }
}
