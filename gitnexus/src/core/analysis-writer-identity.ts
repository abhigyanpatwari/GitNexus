import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { readProcStartTime } from '../storage/index-lock.js';

export interface AnalysisWriterBirth {
  kind: 'linux-proc' | 'darwin-lstart' | 'win32-ticks';
  value: string;
}

export function isAnalysisWriterBirth(value: unknown): value is AnalysisWriterBirth {
  if (!value || typeof value !== 'object') return false;
  const birth = value as AnalysisWriterBirth;
  if (typeof birth.value !== 'string') return false;
  if (birth.kind === 'linux-proc' || birth.kind === 'win32-ticks')
    return /^\d{1,32}$/.test(birth.value);
  return (
    birth.kind === 'darwin-lstart' &&
    /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(
      birth.value,
    )
  );
}

export function getAnalysisWriterProbeTimeoutMs(): number {
  return os.platform() === 'win32' ? 5000 : 1500;
}

/** Unknown identity never establishes that a writer has exited. External probes
 * use fixed executables, bounded output and the caller's remaining wait budget. */
export async function readAnalysisWriterBirth(
  pid: number,
  timeoutMs = getAnalysisWriterProbeTimeoutMs(),
): Promise<AnalysisWriterBirth | undefined> {
  if (!Number.isSafeInteger(pid) || pid < 1 || timeoutMs <= 0) return undefined;
  try {
    const platform = os.platform();
    if (platform === 'linux') {
      const value = readProcStartTime(pid);
      return value ? { kind: 'linux-proc', value } : undefined;
    }
    if (platform !== 'darwin' && platform !== 'win32') return undefined;
    const executable =
      platform === 'darwin'
        ? '/bin/ps'
        : path.win32.join(
            process.env.SystemRoot || 'C:\\Windows',
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'powershell.exe',
          );
    const args =
      platform === 'darwin'
        ? ['-p', String(pid), '-o', 'lstart=']
        : [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `$ErrorActionPreference='Stop';(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`,
          ];
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        executable,
        args,
        {
          encoding: 'utf8',
          maxBuffer: 1024,
          timeout: Math.max(1, Math.floor(timeoutMs)),
          windowsHide: true,
          env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
        },
        (error, output) => (error ? reject(error) : resolve(output)),
      );
    });
    const birth = {
      kind: platform === 'darwin' ? 'darwin-lstart' : 'win32-ticks',
      value: stdout.trim().replace(/\s+/g, ' '),
    };
    return isAnalysisWriterBirth(birth) ? birth : undefined;
  } catch {
    return undefined;
  }
}
