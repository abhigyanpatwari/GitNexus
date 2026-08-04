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
        : execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
          }).trim();
    return startedAt || undefined;
  } catch {
    return undefined;
  }
}
