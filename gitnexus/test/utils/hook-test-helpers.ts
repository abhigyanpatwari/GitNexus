/**
 * Shared helpers for hook test files (unit + integration).
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export function runHook(
  hookPath: string,
  input: Record<string, any>,
  cwd?: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    timeout: 10000,
    cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

export function parseHookOutput(
  stdout: string,
): { hookEventName?: string; additionalContext?: string } | null {
  if (!stdout.trim()) return null;
  try {
    const parsed = JSON.parse(stdout.trim());
    return parsed.hookSpecificOutput || null;
  } catch {
    return null;
  }
}

function gitNexusLauncherNames(): string[] {
  return process.platform === 'win32'
    ? ['gitnexus', 'gitnexus.cmd', 'gitnexus.bat', 'gitnexus.exe', 'gitnexus.ps1']
    : ['gitnexus'];
}

export function pathWithoutGitNexus(
  pathValue = process.env.PATH || process.env.Path || process.env.path || '',
): string {
  return pathValue
    .split(path.delimiter)
    .filter((dir) => {
      if (!dir) return false;
      return !gitNexusLauncherNames().some((name) => fs.existsSync(path.join(dir, name)));
    })
    .join(path.delimiter);
}

export function envWithPath(pathValue: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') delete env[key];
  }
  env.PATH = pathValue;
  return env;
}

export function createGitNexusPathEntry(): {
  pathValue: string;
  cleanup: () => void;
} {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-path-'));
  const launcher = path.join(binDir, process.platform === 'win32' ? 'gitnexus.cmd' : 'gitnexus');
  fs.writeFileSync(
    launcher,
    process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n',
  );
  if (process.platform !== 'win32') fs.chmodSync(launcher, 0o755);

  return {
    pathValue: [binDir, pathWithoutGitNexus()].filter(Boolean).join(path.delimiter),
    cleanup: () => fs.rmSync(binDir, { recursive: true, force: true }),
  };
}
