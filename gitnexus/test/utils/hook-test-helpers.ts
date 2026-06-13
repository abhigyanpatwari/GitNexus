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

// ─── Fake tool dir for the DB-owner probe (shared by unit + e2e) ────
//
// Builds a temp bin dir holding fake `gitnexus`, `lsof`, and `ps` executables so
// a hook spawned with hookEnv(binDir) sees a deterministic DB-owner probe result
// (and a marker-writing fake CLI) without touching the real process table.

// Module-private: only createHookToolDir writes these fakes; callers use the
// higher-level createHookToolDir, never writeExecutable directly.
function writeExecutable(filePath: string, content: string) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

export function createHookToolDir(options: {
  gitnexusStderr?: string;
  gitnexusMarkerPath?: string;
  /** Fake gitnexus CLI writes its own PID here as its FIRST statement, minimizing detection latency for augment orphan-reaping tests (#2163 follow-up). */
  gitnexusPidFile?: string;
  /** Fake gitnexus CLI sleeps this long instead of exiting — models a hung augment child. */
  gitnexusSleepMs?: number;
  /** Fake gitnexus CLI traps SIGTERM as a no-op before sleeping — models an unkillable CLI that only SIGKILL can end (#2163 follow-up). */
  gitnexusIgnoreSigterm?: boolean;
  lsofOutput?: string;
  lsofOutputLines?: string[];
  psOutput?: string;
  psOutputByPid?: Record<string, string>;
  lsofSleepMs?: number;
  /** Fake lsof writes this marker file as soon as it starts — proves whether the probe reached the lsof fallback at all (#2163). */
  lsofMarkerPath?: string;
  /** Fake lsof writes its own PID here as its FIRST statement, minimizing detection latency for orphan-reaping tests (#2163). */
  lsofPidFile?: string;
  /** Fake lsof traps SIGTERM as a no-op before sleeping — models an unkillable/D-state lsof that only SIGKILL can end (#2163). */
  lsofIgnoreSigterm?: boolean;
}) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-hook-bin-'));
  const gitnexusStderr = JSON.stringify(options.gitnexusStderr ?? '');
  const markerPath = JSON.stringify(options.gitnexusMarkerPath ?? '');

  // Composable prologue (mirrors the fake-lsof one below): pidFile write MUST
  // stay the first statement (see the option docs above); the SIGTERM trap
  // MUST be installed before any sleep.
  const fakeGitNexus =
    `#!/usr/bin/env node\nconst fs = require('fs');\n` +
    (options.gitnexusPidFile != null
      ? `fs.writeFileSync(${JSON.stringify(options.gitnexusPidFile)}, String(process.pid));\n`
      : '') +
    (options.gitnexusIgnoreSigterm ? `process.on('SIGTERM', () => {});\n` : '') +
    `const marker = ${markerPath};\nif (marker) fs.writeFileSync(marker, 'called');\n` +
    (options.gitnexusSleepMs != null
      ? `setTimeout(() => {}, ${Number(options.gitnexusSleepMs)});\n`
      : `process.stderr.write(${gitnexusStderr});\n`);
  writeExecutable(path.join(binDir, 'gitnexus'), fakeGitNexus);
  writeExecutable(path.join(binDir, 'gitnexus-cli.js'), fakeGitNexus);

  const lsofOutput =
    options.lsofOutputLines != null
      ? options.lsofOutputLines.join('\n') + (options.lsofOutputLines.length ? '\n' : '')
      : (options.lsofOutput ?? '');
  // Composable prologue: pidFile write MUST stay the first statement (see the
  // option docs above); SIGTERM trap MUST be installed before any sleep.
  const lsofPrologue =
    `#!/usr/bin/env node\nconst fs = require('fs');\n` +
    (options.lsofPidFile != null
      ? `fs.writeFileSync(${JSON.stringify(options.lsofPidFile)}, String(process.pid));\n`
      : '') +
    (options.lsofMarkerPath != null
      ? `fs.writeFileSync(${JSON.stringify(options.lsofMarkerPath)}, 'called');\n`
      : '') +
    (options.lsofIgnoreSigterm ? `process.on('SIGTERM', () => {});\n` : '');
  const lsofBody =
    options.lsofSleepMs != null
      ? `${lsofPrologue}setTimeout(() => {}, ${Number(options.lsofSleepMs)});\n`
      : `${lsofPrologue}process.stdout.write(${JSON.stringify(lsofOutput)});\nprocess.exit(0);\n`;
  writeExecutable(path.join(binDir, 'lsof'), lsofBody);

  const psBody =
    options.psOutputByPid != null
      ? `#!/usr/bin/env node
const byPid = ${JSON.stringify(options.psOutputByPid)};
const args = process.argv;
const p = args[args.indexOf('-p') + 1];
process.stdout.write(byPid[p] ?? '');
process.exit(0);
`
      : `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(options.psOutput ?? '')});\nprocess.exit(0);\n`;
  writeExecutable(path.join(binDir, 'ps'), psBody);

  return binDir;
}

/** A full env that points a spawned hook at the fake tool dir from createHookToolDir. */
export function hookEnv(binDir: string) {
  return {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
    GITNEXUS_HOOK_CLI_PATH: path.join(binDir, 'gitnexus-cli.js'),
    GITNEXUS_HOOK_LSOF_PATH: path.join(binDir, 'lsof'),
    GITNEXUS_HOOK_PS_PATH: path.join(binDir, 'ps'),
  };
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
