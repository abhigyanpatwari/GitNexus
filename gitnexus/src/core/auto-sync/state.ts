import fs from 'node:fs/promises';
import path from 'node:path';
import { acquireFileLock, FileLockBusyError } from '../../storage/file-lock.js';
import { getGlobalDir } from '../../storage/repo-manager.js';

export type AutoSyncAnalyzeStatus = 'success' | 'failed' | 'skipped' | 'threshold_skipped';

export interface AutoSyncCommitStateEntry {
  codeCommitId: string;
  analyzedCommitId?: string;
  lastAnalyzeStatus?: AutoSyncAnalyzeStatus;
  analyzeConsecutiveFailures?: number;
  lastAnalyzeError?: string;
  groupSyncPending?: boolean;
  lastSyncTime: string;
}

export type AutoSyncCommitState = Record<string, AutoSyncCommitStateEntry>;

export function getAutoSyncWatchDir(gitnexusDir = getGlobalDir()): string {
  return path.join(gitnexusDir, 'watch');
}

export function getAutoSyncMutexPath(gitnexusDir = getGlobalDir()): string {
  return path.join(getAutoSyncWatchDir(gitnexusDir), 'watch.mutex');
}

export function getAutoSyncStatePath(gitnexusDir = getGlobalDir()): string {
  return path.join(getAutoSyncWatchDir(gitnexusDir), 'auto-sync-state.json');
}

export function getProjectCommitInfoPath(gitnexusDir = getGlobalDir()): string {
  return path.join(getAutoSyncWatchDir(gitnexusDir), 'project_commit_info.txt');
}

export async function resetAutoSyncState(gitnexusDir = getGlobalDir()): Promise<boolean> {
  let releaseLock: () => Promise<void>;
  try {
    releaseLock = await acquireFileLock(getAutoSyncMutexPath(gitnexusDir));
  } catch (error) {
    if (error instanceof FileLockBusyError) return false;
    throw error;
  }

  try {
    await Promise.all([
      fs.rm(getAutoSyncStatePath(gitnexusDir), { force: true }),
      fs.rm(getProjectCommitInfoPath(gitnexusDir), { force: true }),
    ]);
    return true;
  } finally {
    await releaseLock();
  }
}

export function buildStateKey(repoPath: string, branch: string): string {
  return `${path.resolve(repoPath)}|${branch}`;
}

export function shouldAnalyzeCommit(input: {
  currentCommit: string;
  previousAnalyzedCommit?: string;
  previousStatus?: AutoSyncAnalyzeStatus;
}): boolean {
  if (!input.currentCommit) return false;
  if (input.previousStatus === 'failed') return true;
  return input.currentCommit !== input.previousAnalyzedCommit;
}

export async function loadAutoSyncState(
  statePath = getAutoSyncStatePath(),
): Promise<AutoSyncCommitState> {
  try {
    const raw = await fs.readFile(statePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, AutoSyncCommitStateEntry] =>
        isAutoSyncCommitStateEntry(entry[1]),
      ),
    );
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(
        `[auto-sync] Ignoring unreadable or corrupt state file: ${statePath}. State will be rebuilt.\n`,
      );
    }
    return {};
  }
}

function isAutoSyncCommitStateEntry(value: unknown): value is AutoSyncCommitStateEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.codeCommitId === 'string' &&
    typeof entry.lastSyncTime === 'string' &&
    (entry.analyzedCommitId === undefined || typeof entry.analyzedCommitId === 'string') &&
    (entry.lastAnalyzeStatus === undefined ||
      entry.lastAnalyzeStatus === 'success' ||
      entry.lastAnalyzeStatus === 'failed' ||
      entry.lastAnalyzeStatus === 'skipped' ||
      entry.lastAnalyzeStatus === 'threshold_skipped') &&
    (entry.analyzeConsecutiveFailures === undefined ||
      (typeof entry.analyzeConsecutiveFailures === 'number' &&
        Number.isInteger(entry.analyzeConsecutiveFailures) &&
        entry.analyzeConsecutiveFailures >= 0)) &&
    (entry.lastAnalyzeError === undefined || typeof entry.lastAnalyzeError === 'string') &&
    (entry.groupSyncPending === undefined || typeof entry.groupSyncPending === 'boolean')
  );
}

export async function saveAutoSyncState(
  state: AutoSyncCommitState,
  statePath = getAutoSyncStatePath(),
): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const tmpPath = `${statePath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  await fs.rename(tmpPath, statePath);
}

export async function writeProjectCommitInfo(
  entries: ProjectCommitInfoEntry[],
  infoPath = getProjectCommitInfoPath(),
): Promise<void> {
  await fs.mkdir(path.dirname(infoPath), { recursive: true });
  const lines = [
    '# GitNexus auto-sync project commit info',
    `updated_at: ${new Date().toISOString()}`,
    '',
    ...entries.flatMap((entry) => [
      `remote: ${entry.remoteUrl}`,
      `local_path: ${entry.localPath}`,
      `branch: ${entry.branch ?? ''}`,
      `code_commit: ${entry.codeCommitId ?? ''}`,
      `analyzed_commit: ${entry.analyzedCommitId ?? ''}`,
      `status: ${entry.status}`,
      `analyze_consecutive_failures: ${entry.analyzeConsecutiveFailures ?? 0}`,
      ...(entry.analyzeFailureThreshold === undefined
        ? []
        : [`analyze_failure_threshold: ${entry.analyzeFailureThreshold}`]),
      ...(entry.lastAnalyzeError ? [`last_analyze_error: ${entry.lastAnalyzeError}`] : []),
      `last_sync_time: ${entry.lastSyncTime}`,
      '',
    ]),
  ];
  const tmpPath = `${infoPath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmpPath, `${lines.join('\n')}\n`, 'utf-8');
  await fs.rename(tmpPath, infoPath);
}

export interface ProjectCommitInfoEntry {
  remoteUrl: string;
  localPath: string;
  branch?: string;
  codeCommitId?: string;
  analyzedCommitId?: string;
  status:
    | AutoSyncAnalyzeStatus
    | 'sync_failed'
    | 'branch_skipped'
    | 'branch_unavailable'
    | 'sync_timeout';
  analyzeConsecutiveFailures?: number;
  analyzeFailureThreshold?: number;
  lastAnalyzeError?: string;
  lastSyncTime: string;
}
