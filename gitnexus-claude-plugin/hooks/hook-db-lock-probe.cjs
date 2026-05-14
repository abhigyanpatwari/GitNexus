/**
 * Cross-platform best-effort probe: does another process hold dbPath open
 * with a command line that looks like a GitNexus MCP/serve server?
 *
 * Backends (no user-installed Sysinternals):
 * - Linux: scan procfs under /proc (per-PID fd entries) via stat(2) (dev+inode); works without lsof;
 *   optional lsof fallback when proc scan finds nothing.
 * - macOS / *BSD / etc.: trusted lsof + ps (absolute paths first).
 * - Windows: Restart Manager (rstrtmgr) via bundled PowerShell script +
 *   Win32_Process for command lines; trusted powershell.exe under %SystemRoot%.
 *
 * Fail-open on most errors; fail-closed only on lsof ETIMEDOUT (Unix) or
 * PowerShell ETIMEDOUT (Windows), matching the hook contract.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function isGitNexusServerCommand(command) {
  const hasServerMode = /(?:^|\s)(mcp|serve)(?:\s|$)/.test(command);
  const hasGitNexus =
    /(?:^|[/\\\s])gitnexus(?:\.cmd)?(?:\s|$)/.test(command) ||
    /node_modules[/\\]gitnexus[/\\]/.test(command);
  return hasServerMode && hasGitNexus;
}

function resolveHookBinary(tool) {
  const envKey = tool === 'lsof' ? 'GITNEXUS_HOOK_LSOF_PATH' : 'GITNEXUS_HOOK_PS_PATH';
  const fromEnv = process.env[envKey];
  if (fromEnv && String(fromEnv).trim() && fs.existsSync(String(fromEnv))) {
    return String(fromEnv);
  }
  const candidates =
    tool === 'lsof'
      ? ['/usr/bin/lsof', '/usr/sbin/lsof', '/sbin/lsof', tool]
      : ['/bin/ps', '/usr/bin/ps', tool];
  for (const candidate of candidates) {
    if (candidate === tool) return tool;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return tool;
}

function resolveWindowsPowerShellPath() {
  const fromEnv = process.env.GITNEXUS_HOOK_POWERSHELL_PATH;
  if (fromEnv && String(fromEnv).trim() && fs.existsSync(String(fromEnv).trim())) {
    return String(fromEnv).trim();
  }
  const root = process.env.SystemRoot || 'C:\\Windows';
  const ps = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (fs.existsSync(ps)) return ps;
  const psWow = path.join(root, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (fs.existsSync(psWow)) return psWow;
  return 'powershell.exe';
}

// Sentinel:
//   undefined = not loaded yet (try the read)
//   string    = encoded PowerShell command (successful load)
//   null      = load attempted and failed (do not retry; warning already emitted)
let windowsRmListPsEncodedCommandCache;
let windowsRmListPsLoadFailureWarned = false;
function getWindowsRmListEncodedCommand() {
  if (windowsRmListPsEncodedCommandCache !== undefined) {
    return windowsRmListPsEncodedCommandCache;
  }
  try {
    const ps1Path = path.join(__dirname, 'win-rm-list-json.ps1');
    const src = fs
      .readFileSync(ps1Path, 'utf8')
      .replace(/^\uFEFF/, '')
      .replace(/\r\n/g, '\n');
    windowsRmListPsEncodedCommandCache = Buffer.from(src, 'utf16le').toString('base64');
  } catch (err) {
    windowsRmListPsEncodedCommandCache = null;
    if (
      !windowsRmListPsLoadFailureWarned &&
      (process.env.GITNEXUS_DEBUG === '1' || process.env.GITNEXUS_DEBUG === 'true')
    ) {
      windowsRmListPsLoadFailureWarned = true;
      const msg = err && err.message ? String(err.message).slice(0, 200) : 'unknown';
      process.stderr.write(`[GitNexus hook] win-rm-list-json.ps1 load failed: ${msg}\n`);
    }
  }
  return windowsRmListPsEncodedCommandCache;
}

function hasGitNexusServerOwnerWindows(dbPathAbs, myPid) {
  const encoded = getWindowsRmListEncodedCommand();
  if (!encoded) return false;
  const psExe = resolveWindowsPowerShellPath();
  const r = spawnSync(
    psExe,
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-STA',
      '-EncodedCommand',
      encoded,
    ],
    {
      encoding: 'utf-8',
      timeout: 6000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GITNEXUS_HOOK_RM_TARGET: dbPathAbs },
    },
  );
  // ETIMEDOUT means the PowerShell probe didn't return in time; treat as 'unresponsive process holds DB' → fail-closed (skip augment).
  if (r.error) return r.error.code === 'ETIMEDOUT';
  if (r.status !== 0) return false;
  let rows;
  try {
    rows = JSON.parse(String(r.stdout || '').trim() || '[]');
  } catch {
    return false;
  }
  if (!Array.isArray(rows)) return false;
  for (const row of rows) {
    const procId = Number(row.pid);
    const cmd = String(row.cmd || '');
    if (!Number.isFinite(procId) || procId === myPid) continue;
    if (isGitNexusServerCommand(cmd)) return true;
  }
  return false;
}

function readLinuxCmdline(pidStr) {
  try {
    return fs.readFileSync(`/proc/${pidStr}/cmdline`, 'utf8').replace(/\0+/g, ' ').trim();
  } catch {
    return '';
  }
}

function linuxProcScanFindGitNexusServer(dbPathAbs, myPid) {
  const raw = process.env.GITNEXUS_HOOK_LINUX_PROC_BUDGET_MS;
  const budget = Number(raw && String(raw).trim()) ? Number.parseInt(String(raw), 10) : 1200;
  const start = Date.now();
  let targetStat;
  try {
    targetStat = fs.statSync(dbPathAbs);
  } catch {
    return false;
  }
  let procEntries;
  try {
    procEntries = fs.readdirSync('/proc', { withFileTypes: true });
  } catch {
    return false;
  }
  for (const ent of procEntries) {
    if (Date.now() - start > budget) return false;
    if (!ent.isDirectory() || !/^\d+$/.test(ent.name)) continue;
    const pid = Number.parseInt(ent.name, 10);
    if (!Number.isFinite(pid) || pid === myPid) continue;
    const fdDir = path.join('/proc', ent.name, 'fd');
    let fds;
    try {
      fds = fs.readdirSync(fdDir);
    } catch {
      continue;
    }
    let holds = false;
    for (const fd of fds) {
      if (Date.now() - start > budget) return false;
      try {
        const st = fs.statSync(path.join(fdDir, fd));
        if (st.dev === targetStat.dev && st.ino === targetStat.ino) {
          holds = true;
          break;
        }
      } catch {
        /* ignore */
      }
    }
    if (!holds) continue;
    if (isGitNexusServerCommand(readLinuxCmdline(ent.name))) return true;
  }
  return false;
}

function unixLsofPsFindGitNexusServer(dbPathAbs, myPid) {
  const lsofPath = resolveHookBinary('lsof');
  const lsof = spawnSync(lsofPath, ['-nP', '-t', '--', dbPathAbs], {
    encoding: 'utf-8',
    timeout: 1000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (lsof.error) return lsof.error.code === 'ETIMEDOUT';

  const pids = (lsof.stdout || '').split(/\s+/).filter(Boolean);
  const psPath = resolveHookBinary('ps');
  for (const pid of pids) {
    if (Number(pid) === myPid) continue;
    const ps = spawnSync(psPath, ['-p', pid, '-o', 'command='], {
      encoding: 'utf-8',
      timeout: 500,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (ps.error) {
      if (ps.error.code === 'ETIMEDOUT') return true;
      continue;
    }
    if (isGitNexusServerCommand(ps.stdout || '')) return true;
  }
  return false;
}

/**
 * @param {string} dbPath Absolute or relative path to the DB file (e.g. .../lbug).
 * @param {number} myPid Current process PID (hook runner), excluded from matches.
 */
function hasGitNexusDbLockedByGitNexusServer(dbPath, myPid) {
  if (!fs.existsSync(dbPath)) return false;
  const dbPathAbs = path.resolve(dbPath);

  if (process.platform === 'win32') {
    return hasGitNexusServerOwnerWindows(dbPathAbs, myPid);
  }

  if (process.platform === 'linux') {
    if (linuxProcScanFindGitNexusServer(dbPathAbs, myPid)) return true;
    return unixLsofPsFindGitNexusServer(dbPathAbs, myPid);
  }

  return unixLsofPsFindGitNexusServer(dbPathAbs, myPid);
}

module.exports = {
  hasGitNexusDbLockedByGitNexusServer,
};
