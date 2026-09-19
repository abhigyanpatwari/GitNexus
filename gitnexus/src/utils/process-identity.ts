import { execFileSync } from 'node:child_process';

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export function readProcessStartTime(pid: number): string | undefined {
  try {
    const startedAt =
      process.platform === 'win32'
        ? execFileSync(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($p) { $p.CreationDate.ToUniversalTime().ToString("O") }`,
            ],
            { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
          ).trim()
        : // `lstart` is rendered through localtime and the active locale, so the
          // same live process yields a different string under a different TZ or
          // LC_TIME. That string is a lock owner's identity, and a mismatch is
          // read as PID reuse — an unpinned render lets one daemon reclaim a
          // mutex another still holds. Pin both so the identity is absolute.
          execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
            env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
          }).trim();
    return startedAt || undefined;
  } catch {
    return undefined;
  }
}

let ownStartTime: string | undefined;

/**
 * `readProcessStartTime`, except this process's own start time is probed once.
 * It cannot change while we are running, and every `acquireFileLock` — plus
 * each retry attempt and each stale-lock reclaim guard — stamps the owner file
 * with it. On Windows that probe is a `powershell.exe` spawn and a WMI query,
 * so a process taking several locks pays it several times for one constant.
 *
 * A foreign pid is never cached: that process can exit and its pid can be
 * reused, which is the very thing the stamp exists to detect. A failed probe
 * is not cached either — one transient failure would otherwise leave the
 * process unable to take a lock for its whole lifetime.
 */
export function readProcessStartTimeCached(pid: number): string | undefined {
  if (pid !== process.pid) return readProcessStartTime(pid);
  return (ownStartTime ??= readProcessStartTime(pid));
}
