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
    // Used as-is when provided: every caller passes a full env (a spread of
    // process.env plus overrides), so re-merging process.env here is redundant
    // and, worse, on Windows it re-adds the original `Path` key alongside a
    // replaced `PATH` — defeating envWithPath(), which deletes path variants so a
    // scrubbed PATH is honored deterministically.
    env: options.env ?? process.env,
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

// ─── Stale-index hint PATH-detection helpers (#1938) ────────────────
//
// The hooks emit `gitnexus analyze` (no npx) when a launcher is on PATH. These
// helpers let an e2e test fabricate that condition deterministically: scrub any
// ambient `gitnexus` off PATH, then prepend a synthetic launcher — so the test
// asserts the hook's real PATH auto-detection rather than env-var forcing.

/** Names a global `gitnexus` may take on each platform (for scrub + fabricate). */
function gitNexusLauncherNames(): string[] {
  return process.platform === 'win32'
    ? ['gitnexus', 'gitnexus.cmd', 'gitnexus.bat', 'gitnexus.exe', 'gitnexus.ps1']
    : ['gitnexus'];
}

/** True if `dir` holds a runnable `gitnexus` launcher (isFile + X_OK on POSIX). */
function hasGitNexusLauncher(dir: string): boolean {
  return gitNexusLauncherNames().some((name) => {
    const candidate = path.join(dir, name);
    try {
      if (!fs.statSync(candidate).isFile()) return false;
      if (process.platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * The current PATH with every dir that contains a `gitnexus` launcher removed, so
 * a test box that already has gitnexus installed cannot make the assertion pass
 * (or fail) for the wrong reason. Mirrors the hook's own detection — isFile() +
 * X_OK — rather than a bare existsSync.
 */
export function pathWithoutGitNexus(
  pathValue: string = process.env.PATH || process.env.Path || process.env.path || '',
): string {
  return pathValue
    .split(path.delimiter)
    .filter((dir) => dir && !hasGitNexusLauncher(dir))
    .join(path.delimiter);
}

/** A full env copy with PATH replaced by `pathValue` and all case variants of the key removed. */
export function envWithPath(pathValue: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') delete env[key];
  }
  env.PATH = pathValue;
  return env;
}

/**
 * Create a temp dir holding a runnable `gitnexus` launcher and return a PATH that
 * puts it first (with all other gitnexus launchers scrubbed). Caller must invoke
 * cleanup() to remove the temp dir.
 */
export function createGitNexusPathEntry(): { pathValue: string; cleanup: () => void } {
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
