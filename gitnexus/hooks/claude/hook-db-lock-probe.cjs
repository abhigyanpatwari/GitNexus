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
 *
 * Unix subprocess containment contract (#2163):
 * - lsof/ps are wrapped in coreutils `timeout`/`gtimeout` when a working
 *   wrapper is found (`timeout -k 1 <budget> lsof ...`). If this hook process
 *   is itself SIGKILLed (e.g. by the runner's 10s hook timeout) the wrapper
 *   survives, SIGTERMs its child at the budget (2s lsof / 1s ps) and SIGKILLs
 *   it 1s later — orphan lifetime is bounded at ~3s instead of unbounded.
 * - GITNEXUS_HOOK_TIMEOUT_PATH: the sentinel value `disabled` switches the
 *   wrapper off deterministically; any other non-existent value FALLS THROUGH
 *   to the built-in candidate list (same semantics as the sibling
 *   GITNEXUS_HOOK_LSOF_PATH / GITNEXUS_HOOK_PS_PATH overrides). A candidate
 *   must pass a one-shot `-k` self-test before being adopted.
 * - The gitnexus server is lazy-open + sticky-hold: an idle MCP server holds
 *   ZERO lbug fds until the repo's first MCP query, then keeps the fd open.
 *   A probe before that first query is therefore always false — a known,
 *   pre-existing race, not a bug in this probe.
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

// Sentinel:
//   undefined = not resolved yet (resolve lazily, on first lsof/ps fallback)
//   string    = self-tested coreutils timeout/gtimeout path (use as wrapper)
//   null      = no usable wrapper (disabled, none found, or self-test failed)
let unixGuardTimeoutCache;

/**
 * Resolve a coreutils `timeout`/`gtimeout` binary to wrap lsof/ps with
 * (#2163). Dead code on Windows (the win32 dispatch returns earlier).
 *
 * GITNEXUS_HOOK_TIMEOUT_PATH semantics: the sentinel `disabled` turns the
 * wrapper off; an existing file path is used as the candidate; any other
 * value falls through to the built-in candidates — matching the sibling
 * GITNEXUS_HOOK_LSOF_PATH / GITNEXUS_HOOK_PS_PATH overrides above, so a
 * typo'd path can never silently disable orphan containment.
 *
 * Lazy self-test: the chosen candidate is adopted only when
 * `timeout -k 1 1 /bin/sh -c :` exits 0. This rejects wrappers that do not
 * support the coreutils `-k` flag — busybox <1.34, toybox, broken symlinks —
 * which would otherwise exit with a usage error without ever running lsof,
 * silently converting the lsof-ETIMEDOUT fail-closed contract into fail-open
 * (#1492 regression). Rejection falls back to the unwrapped status quo.
 * busybox ≥1.34 passes the test and is fully usable (capability, not
 * identity, decides).
 */
function resolveUnixGuardTimeout() {
  if (unixGuardTimeoutCache !== undefined) return unixGuardTimeoutCache;
  unixGuardTimeoutCache = null;
  const fromEnv = process.env.GITNEXUS_HOOK_TIMEOUT_PATH;
  const trimmed = fromEnv ? String(fromEnv).trim() : '';
  if (trimmed === 'disabled') return unixGuardTimeoutCache;
  let guard = null;
  if (trimmed && fs.existsSync(trimmed)) {
    guard = trimmed;
  } else {
    const candidates = [
      '/usr/bin/timeout',
      '/bin/timeout',
      '/opt/homebrew/bin/gtimeout',
      '/usr/local/bin/gtimeout',
    ];
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          guard = candidate;
          break;
        }
      } catch {
        /* ignore */
      }
    }
  }
  if (!guard) return unixGuardTimeoutCache;
  try {
    const selfTest = spawnSync(guard, ['-k', '1', '1', '/bin/sh', '-c', ':'], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    });
    if (!selfTest.error && selfTest.status === 0) {
      unixGuardTimeoutCache = guard;
    }
  } catch {
    /* keep null — fall back to unwrapped lsof/ps */
  }
  return unixGuardTimeoutCache;
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
      windowsHide: true,
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
  const guard = resolveUnixGuardTimeout();
  const lsofPath = resolveHookBinary('lsof');
  // The spawnSync timeouts below (lsof 1000ms / ps 500ms) are deliberately
  // SHORTER than the wrapper budgets (2s / 1s): on the supervised path Node's
  // SIGTERM always fires first, so `error.code === 'ETIMEDOUT'` and the
  // fail-closed contract are untouched. The wrapper only matters once this
  // hook process has been SIGKILLed and can no longer deliver that SIGTERM.
  const [lsofCmd, lsofArgs] = guard
    ? [guard, ['-k', '1', '2', lsofPath, '-nP', '-t', '--', dbPathAbs]]
    : [lsofPath, ['-nP', '-t', '--', dbPathAbs]];
  const lsof = spawnSync(lsofCmd, lsofArgs, {
    encoding: 'utf-8',
    timeout: 1000,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  if (lsof.error) return lsof.error.code === 'ETIMEDOUT';
  // Belt-and-suspenders, coreutils-only: GNU/BSD timeout exits 124 on budget
  // expiry and 137 after the -k SIGKILL — map both to "unresponsive holder"
  // (fail-closed). busybox-style wrappers surface expiry as a signal with
  // status null instead, so this mapping never fires there — harmless,
  // because the 1s spawnSync timer above always ETIMEDOUTs first.
  if (guard && (lsof.status === 124 || lsof.status === 137)) return true;

  const pids = (lsof.stdout || '').split(/\s+/).filter(Boolean);
  const psPath = resolveHookBinary('ps');
  for (const pid of pids) {
    if (Number(pid) === myPid) continue;
    const [psCmd, psArgs] = guard
      ? [guard, ['-k', '1', '1', psPath, '-p', pid, '-o', 'command=']]
      : [psPath, ['-p', pid, '-o', 'command=']];
    const ps = spawnSync(psCmd, psArgs, {
      encoding: 'utf-8',
      timeout: 500,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    if (ps.error) {
      if (ps.error.code === 'ETIMEDOUT') return true;
      continue;
    }
    // Same coreutils-only defensive mapping as the lsof call above.
    if (guard && (ps.status === 124 || ps.status === 137)) return true;
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
