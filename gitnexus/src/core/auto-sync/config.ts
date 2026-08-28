import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { getGlobalDir } from '../../storage/repo-manager.js';
import { normalizeConfiguredCloneRoot } from './path-security.js';

const _require = createRequire(import.meta.url);
const yaml = _require('js-yaml') as typeof import('js-yaml');

export const AUTO_SYNC_CONFIG_FILE = 'watch_config.yml';
const GROUP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MIN_SYNC_INTERVAL_MINUTES = 5;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_SYNC_INTERVAL_MINUTES = Math.floor(MAX_TIMER_DELAY_MS / 60_000);
const DEFAULT_REPO_GIT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CONCURRENCY = 1;
export const DEFAULT_ANALYZE_FAILURE_THRESHOLD = 3;
const MIN_ANALYZE_FAILURE_THRESHOLD = 2;
const ALLOWED_REMOTE_HOSTS = new Set(['github.com', 'gitlab.com', 'gitee.com']);

export interface AutoSyncProjectConfig {
  localPath: string;
  groupName?: string;
  overwriteLocalChanges: boolean;
  branches: string[];
  remoteUrls: string[];
}

export interface AutoSyncConfig {
  configPath: string;
  syncIntervalMinutes: number;
  repoGitTimeoutMs: number;
  analyzeTimeoutMs: number;
  maxConcurrency: number;
  analyzeFailureThreshold: number;
  projects: AutoSyncProjectConfig[];
}

export type AutoSyncConfigLoadResult =
  | { ok: true; config: AutoSyncConfig }
  | { ok: false; reason: 'missing' | 'unreadable' | 'invalid'; message: string };

export function getAutoSyncConfigPath(gitnexusDir = getGlobalDir()): string {
  return path.join(gitnexusDir, AUTO_SYNC_CONFIG_FILE);
}

export function parseBranchCandidates(branchValue: unknown): string[] {
  const rawItems = Array.isArray(branchValue)
    ? branchValue.flatMap((item) => String(item).split(','))
    : String(branchValue ?? '').split(',');
  const branches: string[] = [];
  const seen = new Set<string>();
  for (const item of rawItems) {
    const branch = item.trim();
    if (!branch || seen.has(branch)) continue;
    seen.add(branch);
    branches.push(branch);
  }
  return branches;
}

export async function loadAutoSyncConfig(
  configPath = getAutoSyncConfigPath(),
): Promise<AutoSyncConfigLoadResult> {
  let content: string;
  try {
    content = await fs.readFile(configPath, 'utf-8');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        ok: false,
        reason: 'missing',
        message: `[auto-sync] Missing config file: ${configPath}. Auto sync is skipped.`,
      };
    }
    return {
      ok: false,
      reason: 'unreadable',
      message: `[auto-sync] Unable to read config file: ${configPath}. Auto sync is skipped.`,
    };
  }

  try {
    return { ok: true, config: parseAutoSyncConfig(content, configPath) };
  } catch (err: unknown) {
    return {
      ok: false,
      reason: 'invalid',
      message: `[auto-sync] Invalid watch_config.yml: ${(err as Error).message}. Auto sync is skipped.`,
    };
  }
}

export function parseAutoSyncConfig(content: string, configPath: string): AutoSyncConfig {
  const raw = yaml.load(content, { schema: yaml.JSON_SCHEMA }) as Record<string, unknown>;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('expected a YAML object');
  }

  const errors: string[] = [];
  const interval = Number(raw.sync_interval_minutes);
  if (!Number.isInteger(interval) || interval <= 0) {
    errors.push('sync_interval_minutes must be a positive integer');
  } else if (interval < MIN_SYNC_INTERVAL_MINUTES) {
    errors.push(`sync_interval_minutes must be at least ${MIN_SYNC_INTERVAL_MINUTES}`);
  } else if (interval > MAX_SYNC_INTERVAL_MINUTES) {
    errors.push(`sync_interval_minutes must not exceed ${MAX_SYNC_INTERVAL_MINUTES}`);
  }

  const maxConcurrency =
    raw.max_concurrency === undefined ? DEFAULT_MAX_CONCURRENCY : Number(raw.max_concurrency);
  if (!Number.isInteger(maxConcurrency) || maxConcurrency <= 0) {
    errors.push('max_concurrency must be a positive integer');
  }

  const repoGitTimeoutMs =
    raw.repo_git_timeout === undefined
      ? DEFAULT_REPO_GIT_TIMEOUT_MS
      : parseDurationMs(raw.repo_git_timeout);
  if (!Number.isInteger(repoGitTimeoutMs) || repoGitTimeoutMs <= 0) {
    errors.push('repo_git_timeout must be a positive duration such as 10s');
  } else if (repoGitTimeoutMs > MAX_TIMER_DELAY_MS) {
    errors.push(`repo_git_timeout must not exceed ${MAX_TIMER_DELAY_MS}ms`);
  }

  const maxAnalyzeTimeoutMs =
    Number.isInteger(interval) &&
    interval >= MIN_SYNC_INTERVAL_MINUTES &&
    interval <= MAX_SYNC_INTERVAL_MINUTES
      ? interval * 30_000
      : undefined;
  const analyzeTimeoutMs =
    raw.analyze_timeout === undefined
      ? (maxAnalyzeTimeoutMs ?? 0)
      : parseDurationMs(raw.analyze_timeout);
  if (!Number.isInteger(analyzeTimeoutMs) || analyzeTimeoutMs <= 0) {
    errors.push('analyze_timeout must be a positive duration such as 30m');
  } else if (maxAnalyzeTimeoutMs !== undefined && analyzeTimeoutMs > maxAnalyzeTimeoutMs) {
    errors.push(
      `analyze_timeout must not exceed half of sync_interval_minutes (${maxAnalyzeTimeoutMs / 60_000}m)`,
    );
  }

  const analyzeFailureThreshold =
    raw.analyze_failure_threshold === undefined
      ? DEFAULT_ANALYZE_FAILURE_THRESHOLD
      : Number(raw.analyze_failure_threshold);
  if (
    !Number.isInteger(analyzeFailureThreshold) ||
    analyzeFailureThreshold < MIN_ANALYZE_FAILURE_THRESHOLD
  ) {
    errors.push(`analyze_failure_threshold must be an integer >= ${MIN_ANALYZE_FAILURE_THRESHOLD}`);
  }

  const rawProjects = raw.projects;
  if (!Array.isArray(rawProjects) || rawProjects.length === 0) {
    errors.push('projects must contain at least one project');
  }

  const projects: AutoSyncProjectConfig[] = [];
  if (Array.isArray(rawProjects)) {
    rawProjects.forEach((projectValue, index) => {
      const project = projectValue as Record<string, unknown>;
      if (!project || typeof project !== 'object' || Array.isArray(project)) {
        errors.push(`projects[${index}] must be an object`);
        return;
      }

      const localPath = typeof project.local_path === 'string' ? project.local_path.trim() : '';
      if (!localPath) {
        errors.push(`projects[${index}].local_path is required`);
      } else {
        try {
          normalizeConfiguredCloneRoot(localPath);
        } catch (err: unknown) {
          errors.push(`projects[${index}].local_path ${(err as Error).message}`);
        }
      }

      const remoteUrls = Array.isArray(project.remote_urls)
        ? project.remote_urls.map((url) => String(url).trim()).filter(Boolean)
        : [];
      if (remoteUrls.length === 0) {
        errors.push(`projects[${index}].remote_urls must contain at least one URL`);
      }
      for (let urlIndex = 0; urlIndex < remoteUrls.length; urlIndex += 1) {
        try {
          validateAutoSyncRemoteUrl(remoteUrls[urlIndex]);
        } catch (err: unknown) {
          errors.push(`projects[${index}].remote_urls[${urlIndex}] ${(err as Error).message}`);
        }
      }

      if (project.branch !== undefined && project.branches !== undefined) {
        errors.push(`projects[${index}] must not set both branch and branches`);
      }
      const branches = parseBranchCandidates(
        project.branches !== undefined ? project.branches : project.branch,
      );
      if (branches.length === 0) errors.push(`projects[${index}].branches is required`);
      for (let branchIndex = 0; branchIndex < branches.length; branchIndex += 1) {
        try {
          validateAutoSyncBranchName(branches[branchIndex]);
        } catch (err: unknown) {
          errors.push(`projects[${index}].branches[${branchIndex}] ${(err as Error).message}`);
        }
      }

      const groupName =
        typeof project.group_name === 'string' && project.group_name.trim()
          ? project.group_name.trim()
          : undefined;
      if (groupName && !GROUP_NAME_PATTERN.test(groupName)) {
        errors.push(`projects[${index}].group_name is invalid`);
      }

      const overwriteLocalChanges =
        project.overwrite_local_changes === undefined ? false : project.overwrite_local_changes;
      if (typeof overwriteLocalChanges !== 'boolean') {
        errors.push(`projects[${index}].overwrite_local_changes must be a boolean`);
      }

      if (localPath && remoteUrls.length > 0 && branches.length > 0) {
        projects.push({
          localPath,
          groupName,
          overwriteLocalChanges: overwriteLocalChanges === true,
          branches,
          remoteUrls,
        });
      }
    });
  }

  if (errors.length > 0) throw new Error(errors.join('; '));
  return {
    configPath,
    syncIntervalMinutes: interval,
    repoGitTimeoutMs,
    analyzeTimeoutMs,
    maxConcurrency,
    analyzeFailureThreshold,
    projects,
  };
}

export function validateAutoSyncRemoteUrl(remoteUrl: string): void {
  const trimmed = remoteUrl.trim();
  if (trimmed.includes('?') || trimmed.includes('#')) {
    throw new Error('must not include query strings or fragments');
  }
  const match = /^git@([^:\s/]+):([^\s]+)$/.exec(trimmed);
  if (!match) {
    throw new Error('must use an SSH URL on github.com, gitlab.com, or gitee.com');
  }
  const host = match[1].toLowerCase();
  const repoPath = match[2];
  if (!ALLOWED_REMOTE_HOSTS.has(host)) {
    throw new Error('host must be one of github.com, gitlab.com, or gitee.com');
  }
  const pathParts = repoPath.split('/');
  if (
    repoPath.startsWith('/') ||
    repoPath.includes('..') ||
    pathParts.length < 2 ||
    pathParts.some((part) => !part)
  ) {
    throw new Error('path must include owner/repo without traversal');
  }
}

export function validateAutoSyncBranchName(branch: string): void {
  if (!branch.trim()) throw new Error('must not be empty');
  if (/[\s\0-\x1f\x7f]/.test(branch))
    throw new Error('must not contain whitespace or control characters');
  if (/[~^:?*[\\]/.test(branch)) throw new Error('contains characters not allowed in a git ref');
  if (branch.startsWith('-')) throw new Error('must not start with "-"');
  if (branch.includes('..')) throw new Error('must not contain ".."');
  if (branch.includes('`')) throw new Error('must not contain backticks');
  if (branch.endsWith('/') || branch.endsWith('.')) throw new Error('must not end with "/" or "."');
  if (branch.includes('//')) throw new Error('must not contain consecutive slashes');
  if (branch.includes('@{')) throw new Error('must not contain "@{"');
  if (
    branch.split('/').some((component) => component.startsWith('.') || component.endsWith('.lock'))
  )
    throw new Error('must not contain hidden or .lock path components');
}

export function parseDurationMs(value: unknown): number {
  if (typeof value === 'number') return value * 1_000;
  const raw = String(value ?? '').trim();
  const match = /^(\d+)(ms|s|m)?$/.exec(raw);
  if (!match) return Number.NaN;
  const amount = Number(match[1]);
  const unit = match[2] ?? 's';
  if (unit === 'ms') return amount;
  if (unit === 's') return amount * 1_000;
  return amount * 60_000;
}
