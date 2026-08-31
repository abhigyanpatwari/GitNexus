/** Remote auto-sync CLI (`gitnexus watch`). Local incremental watch lives in `analyze-watch.ts`. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  getAutoSyncConfigPath,
  getAutoSyncMutexPath,
  readAutoSyncWatchStatus,
  resetAutoSyncState,
  startAutoSyncWatch,
  stopAutoSyncWatch,
  type WatchStatusRecord,
} from '../core/auto-sync/index.js';

export async function watchCommand(action = 'start'): Promise<void> {
  if (action === 'init') {
    await initWatchConfig();
    return;
  }
  if (action === 'reset') {
    if (!(await resetAutoSyncState())) {
      process.stderr.write(
        `[auto-sync] Cannot reset analysis state while the watch mutex is held. Confirm no watch process is running, then remove ${getAutoSyncMutexPath()}.\n`,
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write('[auto-sync] Reset analysis state.\n');
    return;
  }
  if (action === 'status') {
    printStatus(await readAutoSyncWatchStatus());
    return;
  }
  if (action === 'stop') {
    if ((await stopAutoSyncWatch()) !== 'stopped') process.exitCode = 1;
    return;
  }
  if (action === 'restart') {
    const result = await stopAutoSyncWatch();
    if (result === 'refused' || result === 'timeout') {
      process.exitCode = 1;
      return;
    }
    await startWatchProcess();
    return;
  }
  if (action !== 'start') {
    process.stderr.write(`[auto-sync] Unknown watch action: ${action}\n`);
    process.exitCode = 1;
    return;
  }
  await startWatchProcess();
}

async function startWatchProcess(): Promise<void> {
  const handle = await startAutoSyncWatch();
  if (!handle) {
    process.exitCode = 1;
    return;
  }

  const stop = () => {
    void handle.stop().then(
      () => {
        process.stderr.write('[auto-sync] Watch stopped.\n');
        process.exit(0);
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[auto-sync] Failed to stop watch: ${message}\n`);
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

function printStatus(status: WatchStatusRecord): void {
  const parts = [`state=${status.state}`];
  if (status.pid) parts.push(`pid=${status.pid}`);
  if (status.configPath) parts.push(`config=${status.configPath}`);
  if (status.message) parts.push(`message=${status.message}`);
  parts.push(`updated_at=${status.updatedAt}`);
  process.stdout.write(`${parts.join(' ')}\n`);
}

async function initWatchConfig(): Promise<void> {
  const configPath = getAutoSyncConfigPath();
  try {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      defaultSyncConfig(path.resolve(path.dirname(configPath), 'repos')),
      {
        flag: 'wx',
      },
    );
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      process.stderr.write(`[auto-sync] Config already exists: ${configPath}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  process.stdout.write(`[auto-sync] Created ${configPath}\n`);
}

function defaultSyncConfig(localPath: string): string {
  return [
    'sync_interval_minutes: 10',
    'max_concurrency: 1',
    'repo_git_timeout: 10s',
    'analyze_timeout: 5m',
    'analyze_failure_threshold: 3',
    'projects:',
    `  - local_path: ${localPath}`,
    '    branches: [master, main]',
    '    overwrite_local_changes: false',
    '    remote_urls:',
    '      - git@github.com:owner/repo.git',
    '',
  ].join('\n');
}
