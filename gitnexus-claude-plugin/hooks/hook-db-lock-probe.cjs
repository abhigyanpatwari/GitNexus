/**
 * Cross-platform best-effort probe: does another process hold dbPath open
 * with a command line that looks like a GitNexus MCP/serve server?
 *
 * Backends (no user-installed Sysinternals):
 * - Linux: cmdline-first procfs scan under /proc, no lsof at all (#2180). Three
 *   phases, cheapest first: (0) read /proc/<pid>/comm — a tiny task->comm read
 *   that never touches the target's mm — and keep only PIDs whose comm is a
 *   plausible node/gitnexus server; (1) read up to GITNEXUS_HOOK_PROC_CMDLINE_MAX
 *   bytes of /proc/<pid>/cmdline via openSync+readSync (bounded, so a D-state
 *   holder stuck on mmap_lock or a giant argv can't wedge the hook) and prefilter
 *   with isGitNexusServerCommand; (2) only for the 0..N survivors, stat their
 *   /proc/<pid>/fd/* and compare dev+inode against the target lbug. The lbug
 *   handle is fd-visible (a @ladybugdb/core property), so this finds every real
 *   owner without scanning every fd of every process.
 * - macOS / *BSD / etc.: trusted lsof + ps (absolute paths first).
 * - Windows: Restart Manager (rstrtmgr) via bundled PowerShell script +
 *   Win32_Process for command lines; trusted powershell.exe under %SystemRoot%.
 *
 * Fail matrix:
 * - Linux proc scan: owner found -> fail-closed (skip augment); budget exhausted
 *   (GITNEXUS_HOOK_LINUX_PROC_BUDGET_MS) -> fail-CLOSED (#2180). This is a
 *   deliberate change from the old "timeout -> fail-open then try lsof" path.
 *   End-to-end the busy-host outcome is unchanged: the old code's lsof fallback
 *   ETIMEDOUT'd on the very hosts where the scan ran out of budget and ALSO
 *   failed closed there — the lsof leg only ever added 1-2s of dead work plus
 *   the orphan-storm risk it caused (#2163). What changes is that an overloaded
 *   host now self-throttles immediately (the throttle the incident needed)
 *   instead of paying for a doomed lsof. Mid-load hosts that used to fall
 *   through to a successful lsof now answer from the scan directly (faster) or,
 *   if even the scan can't finish in budget, fail closed (self-throttle) — a
 *   bounded, documented tradeoff, never an orphan.
 * - macOS / other Unix: fail-open on most errors; fail-closed only on lsof
 *   ETIMEDOUT, matching the hook contract.
 * - Windows: fail-closed only on PowerShell ETIMEDOUT.
 *
 * Unix subprocess containment contract (#2163):
 * - lsof/ps are wrapped in coreutils `timeout`/`gtimeout` when a working
 *   wrapper is found (`timeout -k 1 <budget> lsof ...`). If this hook process
 *   is itself SIGKILLed (e.g. by the runner's 10s hook timeout) the wrapper
 *   survives, SIGTERMs its child at the budget (2s lsof / 1s ps) and SIGKILLs
 *   it 1s later — orphan lifetime is bounded at ~3s instead of unbounded.
 * - GITNEXUS_HOOK_TIMEOUT_PATH: the sentinel value `disabled` switches the
 *   wrapper off deterministically; any other value is adopted only when it
 *   exists AND passes a one-shot `-k` exit-propagation self-test — otherwise
 *   resolution FALLS THROUGH to the built-in candidate list (first self-test
 *   pass wins), so no malformed value of any shape can silently disable
 *   orphan containment.
 * - The gitnexus server is lazy-open + sticky-hold: an idle MCP server holds
 *   ZERO lbug fds until the repo's first MCP query, then keeps the fd open.
 *   A probe before that first query is therefore always false — a known,
 *   pre-existing race, not a bug in this probe.
 * - resolveUnixGuardTimeout is exported so the hook adapters can wrap the
 *   `gitnexus augment` CLI child — the longest-lived hook subprocess (7s
 *   local / 12s npx inner budgets) — in the same guard; see runGitNexusCli
 *   in the adapters (#2163 follow-up).
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

// GITNEXUS_DEBUG-gated stderr diagnostics. Reuses the exact gating predicate the
// Windows ps1-load warning already uses (===' 1' / ==='true') so there is one
// debug convention in this file, and writes via process.stderr.write (NOT a
// spawn) so it never perturbs the windowsHide spawn-count invariant.
function debugLog(msg) {
  if (process.env.GITNEXUS_DEBUG === '1' || process.env.GITNEXUS_DEBUG === 'true') {
    process.stderr.write(`[GitNexus hook] ${msg}\n`);
  }
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

function hasMissingHookBinaryOverride(tool) {
  const envKey = tool === 'lsof' ? 'GITNEXUS_HOOK_LSOF_PATH' : 'GITNEXUS_HOOK_PS_PATH';
  const fromEnv = process.env[envKey];
  if (!fromEnv || !String(fromEnv).trim()) return false;
  try {
    return !fs.existsSync(String(fromEnv).trim());
  } catch {
    return true;
  }
}

// Sentinel:
//   undefined = not resolved yet (resolve lazily, on first lsof/ps fallback)
//   string    = self-tested coreutils timeout/gtimeout path (use as wrapper)
//   null      = no usable wrapper (disabled, none found, or self-test failed)
let unixGuardTimeoutCache;

/**
 * Resolve a coreutils `timeout`/`gtimeout` binary to wrap lsof/ps with
 * (#2163). Unix-only by contract: the probe's win32 dispatch returns before
 * reaching it, and the exported callers (the adapters' runGitNexusCli,
 * #2163 follow-up) must check the platform first — the self-test below
 * spawns /bin/sh. The memoized result is module-wide, so probe and adapter
 * share one lazy self-test per hook process.
 *
 * GITNEXUS_HOOK_TIMEOUT_PATH semantics: the sentinel `disabled` turns the
 * wrapper off; any other value is only a CANDIDATE — an existing file path
 * is tried first, but it must pass the `-k` exit-propagation self-test to
 * be adopted. On any failure (non-existent path, directory, non-executable
 * file, wrapper without `-k` support, always-exit-0 stub, …) resolution
 * falls through to the built-in candidates below, tried in order, first
 * self-test pass wins. This is strictly stronger than the sibling
 * GITNEXUS_HOOK_LSOF_PATH / GITNEXUS_HOOK_PS_PATH overrides (which only
 * check existence): no bad env value of ANY shape can silently disable
 * orphan containment.
 *
 * Lazy self-test: candidates are probed only when the lsof/ps fallback is
 * first reached, and the result is memoized. A candidate is adopted only
 * when `timeout -k 1 1 /bin/sh -c 'exit 42'` exits 42 — i.e. it must RUN
 * the wrapped command AND PROPAGATE its exit status. This rejects two
 * failure shapes: wrappers without the coreutils `-k` flag — busybox <1.34,
 * toybox, broken symlinks — which would exit with a usage error without
 * ever running lsof, silently converting the lsof-ETIMEDOUT fail-closed
 * contract into fail-open (#1492 regression); and always-exit-0 stubs
 * (/bin/true shapes), which would otherwise be adopted and "succeed" every
 * wrapped spawn instantly without running it — a constant no-owner probe
 * answer and, worse, a silently dead augment (status 0, empty stderr passes
 * the adapters' success check with no context; #2163 follow-up review).
 * Only when EVERY candidate fails does the probe fall back to the unwrapped
 * status quo (memoized null). busybox ≥1.34 passes the test and is fully
 * usable for everything THIS file spawns (lsof/ps are the guard's direct
 * children) and for the adapters' direct-exec arm. The adapters' npx arm
 * additionally relies on coreutils' process-GROUP signalling for its
 * `-s KILL` grandchild reaping; busybox signals only its direct child, and
 * this self-test deliberately does not probe that capability — see the
 * adapter docblocks for the residual-gap statement.
 */
function passesGuardSelfTest(guard) {
  try {
    const selfTest = spawnSync(guard, ['-k', '1', '1', '/bin/sh', '-c', 'exit 42'], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    });
    return !selfTest.error && selfTest.status === 42;
  } catch {
    return false;
  }
}

function resolveUnixGuardTimeout() {
  if (unixGuardTimeoutCache !== undefined) return unixGuardTimeoutCache;
  unixGuardTimeoutCache = null;
  const fromEnv = process.env.GITNEXUS_HOOK_TIMEOUT_PATH;
  const trimmed = fromEnv ? String(fromEnv).trim() : '';
  if (trimmed === 'disabled') return unixGuardTimeoutCache;
  const candidates = [];
  if (trimmed && fs.existsSync(trimmed)) candidates.push(trimmed);
  for (const builtin of [
    '/usr/bin/timeout',
    '/bin/timeout',
    '/opt/homebrew/bin/gtimeout',
    '/usr/local/bin/gtimeout',
  ]) {
    try {
      if (fs.existsSync(builtin)) candidates.push(builtin);
    } catch {
      /* ignore */
    }
  }
  for (const candidate of candidates) {
    if (passesGuardSelfTest(candidate)) {
      unixGuardTimeoutCache = candidate;
      break;
    }
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

// The procfs root every Linux scan path reads from. Production is always /proc;
// GITNEXUS_HOOK_PROC_ROOT only exists so unit tests can inject a fixture tree
// (comm + cmdline + fd symlinks) and assert the three-phase logic without
// scanning the real, ~hundreds-of-process /proc of the test host.
//
// Test-only gate (F4): the override is honored ONLY under a test runner —
// vitest injects VITEST="true" and NODE_ENV="test" into every worker (verified;
// a production hook is `node <file>.cjs` with neither set). Without the gate, a
// production env that accidentally leaked GITNEXUS_HOOK_PROC_ROOT (pointing at an
// empty/bad tree) would make readdirSync find no pids -> 'not-owned' -> Linux
// owner detection silently OFF (fail-OPEN: augment races the real server for the
// lbug, the #1492 class). Gating to the test signal makes that leak inert in
// production (always /proc) while the fake-procfs unit tests, which run under
// vitest, still inject freely. Unset env (or non-test context) => /proc, so the
// production path is byte-for-byte the historical behavior.
function isTestContext() {
  return (
    process.env.VITEST === 'true' || process.env.VITEST === '1' || process.env.NODE_ENV === 'test'
  );
}
function getProcRoot() {
  if (!isTestContext()) return '/proc';
  const raw = process.env.GITNEXUS_HOOK_PROC_ROOT;
  return raw && String(raw).trim() ? String(raw) : '/proc';
}

// Max bytes read from /proc/<pid>/cmdline in Phase 1. Bounded by default so a
// D-state holder wedged on mmap_lock, or a process with a pathological multi-MB
// argv, can't stall the hook. 16 KiB comfortably clears a realistic
// `node <abs path to .../node_modules/gitnexus/dist/cli/index.js> mcp` line
// (the `mcp`/`serve` mode token lives at the very tail, so the cap must be large
// enough to reach it — see PROC_CMDLINE_FLOOR escalation below). Overridable for
// tests; never goes below PROC_CMDLINE_FLOOR.
const PROC_CMDLINE_FLOOR = 4096;
function getCmdlineMaxBytes() {
  const raw = process.env.GITNEXUS_HOOK_PROC_CMDLINE_MAX;
  // Number() (not parseInt) so "8e3" reads as 8000, not 8 (parseInt stops at
  // 'e'). The `raw && String(raw).trim()` guard keeps empty/whitespace on the
  // default; trailing garbage ("8abc") now -> NaN -> default (stricter).
  const n = raw && String(raw).trim() ? Number(String(raw).trim()) : NaN;
  if (Number.isFinite(n) && n >= PROC_CMDLINE_FLOOR) return n;
  return 16384;
}

// Phase 0 comm prefilter. /proc/<pid>/comm is the kernel task->comm string,
// capped at 16 bytes INCLUDING the trailing NUL — i.e. at most 15 visible
// chars, truncated by the kernel with no marker. So a process whose real name
// is longer than 15 chars shows a 15-char prefix here. The match below is
// therefore truncation-safe in BOTH directions (a whitelist name that is a
// prefix of comm, or comm that is a prefix of a whitelist name, both count) to
// guarantee we never drop a real owner at this cheap stage — Phase 2's dev+ino
// fd check is the real authority; Phase 0/1 only exist to skip the overwhelming
// majority (kernel threads, shells, editors) cheaply.
//
// The whitelist is calibrated against what a real `gitnexus mcp`/`serve` server
// actually reports for comm. Observed on production hosts: the server renames
// its main thread, so comm reads `MainThread` (via @ladybugdb/core's
// worker_threads setup), NOT `node` — omitting it would blind the probe to
// every real server (#1492-class owner miss). We also keep the plausible
// launcher/runtime basenames in case a future build does not rename the thread.
// Conservative by design: over-collecting a few extra candidates only costs a
// bounded number of Phase 1 cmdline reads.
const COMM_CANDIDATES = ['node', 'gitnexus', 'bun', 'deno', 'npm', 'npx', 'MainThread'];
function commLooksLikeServer(comm) {
  const c = comm.trim();
  if (!c) return false;
  for (const name of COMM_CANDIDATES) {
    if (name === c || name.startsWith(c) || c.startsWith(name)) return true;
  }
  return false;
}

function readProcComm(procRoot, pidStr) {
  try {
    return fs
      .readFileSync(path.join(procRoot, pidStr, 'comm'), 'utf8')
      .replace(/\0+/g, '')
      .trim();
  } catch {
    return '';
  }
}

// Timeout sentinel for readLinuxCmdline (F3). MUST be distinct from the
// "unreadable/empty" return value (''): '' flows through isGitNexusServerCommand
// as a NON-candidate (both regexes are false on ''), so the Phase 1 caller
// `continue`s past it — correct for a raced/openSync-failed pid, but a FAIL-OPEN
// bug if it ever meant "I ran out of budget mid-read" (a real owner whose
// escalation timed out would be silently dropped, racing the lbug -> #1492). A
// unique Symbol can never collide with any cmdline string, so the caller can
// branch on it explicitly and map a mid-read timeout to the tri-state 'timeout'
// (fail-CLOSED) instead of swallowing it as a non-candidate.
const CMDLINE_TIMEOUT = Symbol('gitnexus.cmdline.timeout');

// Bounded /proc/<pid>/cmdline read for Phase 1. openSync+readSync (not
// readFileSync) so a D-state holder cannot stall the hook on a huge or
// never-EOF argv: we read at most `cap` bytes and stop. cmdline separates argv
// with NULs; convert to spaces for isGitNexusServerCommand.
//
// Owner-miss guard for the 4 KB cap: the `gitnexus` token usually sits in the
// first path component while the `mcp`/`serve` mode token is the LAST argv, so
// a naive 4 KB read could clip the mode token off a server launched with a very
// long interpreter path and silently miss a real owner. We mitigate two ways:
// (a) the default cap (16 KiB) already clears realistic lines; (b) if the first
// read fills the cap AND already contains the `gitnexus` token but no mode
// token yet, we keep reading in bounded chunks (up to a hard ceiling) until the
// mode token appears or the file ends — so a genuine server is never missed for
// want of a few more bytes, while non-candidates still pay only the initial
// bounded read.
//
// Budget (F3): the escalation loop above is the one place a SINGLE pathological
// candidate could read up to HARD_CEIL (256 KiB) before the next scan-level
// budget check, weakening the timeout contract. `outOfBudget` (the scan's shared
// deadline callback) is checked once per escalation iteration; on expiry we
// return CMDLINE_TIMEOUT (NOT '') so the caller can fail-closed honestly rather
// than mistake the partial read for a non-candidate. Reads that simply can't
// open / error out still return '' (genuinely "not a readable candidate").
function readLinuxCmdline(procRoot, pidStr, cap, outOfBudget) {
  const file = path.join(procRoot, pidStr, 'cmdline');
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return '';
  }
  try {
    const HARD_CEIL = 262144; // 256 KiB absolute ceiling for the escalation path
    let collected = Buffer.alloc(0);
    let offset = 0;
    let chunkCap = cap;
    for (;;) {
      // allocUnsafe is safe here: readSync fills exactly [0, bytes), only
      // buf.subarray(0, bytes) is consumed, and Buffer.concat deep-copies that
      // slice into `collected`, so the uninitialized tail never reaches decode.
      const buf = Buffer.allocUnsafe(chunkCap);
      const bytes = fs.readSync(fd, buf, 0, chunkCap, offset);
      if (bytes <= 0) break;
      collected = Buffer.concat([collected, buf.subarray(0, bytes)]);
      offset += bytes;
      const text = collected.toString('utf8').replace(/\0+/g, ' ');
      // Stop early when we can already decide "owner": has both the gitnexus
      // token and a mode token. Keep going only when gitnexus is present but
      // the mode token might be just past the boundary.
      const hasGitNexus =
        /(?:^|[/\\\s])gitnexus(?:\.cmd)?(?:\s|$)/.test(text) ||
        /node_modules[/\\]gitnexus[/\\]/.test(text);
      const hasMode = /(?:^|\s)(mcp|serve)(?:\s|$)/.test(text);
      if (hasMode) break; // decided (positive); isGitNexusServerCommand re-checks below
      if (bytes < chunkCap) break; // EOF: full cmdline read, definitive
      if (!hasGitNexus) break; // not a candidate; do not escalate the read
      if (offset >= HARD_CEIL) break; // bounded escalation only
      // Budget gate the escalation: a single huge-argv candidate must not burn
      // the whole scan deadline before we re-check. Return the timeout sentinel
      // (never '') so the caller fails closed instead of treating us as a
      // non-candidate. The sole caller (linuxProcScanFindGitNexusServer) always
      // passes outOfBudget, so no presence guard is needed.
      if (outOfBudget()) return CMDLINE_TIMEOUT;
      chunkCap = cap; // keep reading more in cap-sized chunks
    }
    return collected.toString('utf8').replace(/\0+/g, ' ').trim();
  } catch {
    return '';
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

function resolveLinuxProcBudgetMs() {
  const raw = process.env.GITNEXUS_HOOK_LINUX_PROC_BUDGET_MS;
  // Gate on the STRING's emptiness, NOT the parsed number's truthiness — the
  // old `Number(raw && trim()) ? ... : 1200` form treated "0" as falsy and
  // silently fell back to 1200 (#2180). Use Number() (not parseInt) so "16e3"
  // reads as 16000, not 16 (parseInt stops at 'e'). The `&& String(raw).trim()`
  // guard is load-bearing: without it a set-but-empty/whitespace value would be
  // `Number("")===0` => budget 0 => immediate fail-CLOSED timeout (augment
  // permanently skipped). With it, ''/whitespace => NaN => 1200 default, while a
  // finite "0" still parses to an explicit, deterministic "no budget" =>
  // immediate timeout. Non-numeric / unset => default 1200.
  const n = raw != null && String(raw).trim() ? Number(String(raw).trim()) : NaN;
  if (!Number.isFinite(n)) return 1200;
  return n; // may be <= 0, meaning "out of budget on the first check"
}

// Returns one of: 'owned' (a non-self process with a GitNexus-server cmdline
// holds the target lbug fd), 'not-owned' (scan completed, no such owner), or
// 'timeout' (the per-scan budget was exhausted before a verdict). The name is
// pinned by a source-contract test; only the return TYPE changed (#2180:
// boolean -> tri-state, so the dispatcher can fail-closed on 'timeout').
function linuxProcScanFindGitNexusServer(dbPathAbs, myPid) {
  const budget = resolveLinuxProcBudgetMs();
  // A non-positive budget is an explicit, deterministic "no time to scan" =>
  // immediate timeout (the #2180 test vector, and the only correct reading of
  // the fixed parse: "0" must NOT mean 1200). Returning before any procfs read
  // keeps it instantaneous regardless of host load.
  if (budget <= 0) return 'timeout';
  const procRoot = getProcRoot();
  const cmdlineCap = getCmdlineMaxBytes();
  const start = Date.now();
  const outOfBudget = () => Date.now() - start > budget;

  let targetStat;
  try {
    targetStat = fs.statSync(dbPathAbs);
  } catch {
    // Caller already existsSync'd the path; a stat failure here is a transient
    // race, treat as no owner (historical semantics).
    return 'not-owned';
  }

  let procEntries;
  try {
    procEntries = fs.readdirSync(procRoot, { withFileTypes: true });
  } catch {
    return 'not-owned';
  }

  // Phase 0 + Phase 1: collect the few PIDs whose comm AND cmdline look like a
  // GitNexus server, without touching any fd yet.
  const candidates = [];
  for (const ent of procEntries) {
    if (outOfBudget()) return 'timeout';
    if (!ent.isDirectory() || !/^\d+$/.test(ent.name)) continue;
    const pid = Number.parseInt(ent.name, 10);
    if (!Number.isFinite(pid) || pid === myPid) continue;

    // Phase 0: cheap comm prefilter.
    const comm = readProcComm(procRoot, ent.name);
    if (!comm) continue; // unreadable comm (kernel thread, raced exit) -> skip
    if (!commLooksLikeServer(comm)) continue;

    // Phase 1: bounded cmdline read + isGitNexusServerCommand prefilter.
    if (outOfBudget()) return 'timeout';
    const cmdline = readLinuxCmdline(procRoot, ent.name, cmdlineCap, outOfBudget);
    // F3: a mid-read budget timeout returns the CMDLINE_TIMEOUT sentinel (a
    // Symbol, never a string). Fail CLOSED on it rather than letting it fall
    // through isGitNexusServerCommand as a non-candidate — a real owner whose
    // escalation timed out must not be silently dropped (would fail-OPEN).
    if (cmdline === CMDLINE_TIMEOUT) return 'timeout';
    if (!isGitNexusServerCommand(cmdline)) continue;
    candidates.push(ent.name);
  }

  // Phase 2: only now stat the fds of the (typically 0-2) survivors.
  for (const pidStr of candidates) {
    if (outOfBudget()) return 'timeout';
    const fdDir = path.join(procRoot, pidStr, 'fd');
    let fds;
    try {
      fds = fs.readdirSync(fdDir);
    } catch (err) {
      // F1: the old code returned 'owned' for EVERY non-ENOENT error. That was
      // a correctness bug: /proc/<pid>/fd is owner-only (mode 0500), so a
      // cross-user/root `gitnexus mcp` serving a DIFFERENT repo passes Phase 0+1
      // (its cmdline matches) and then EACCES'es here — yet its dev+ino was
      // NEVER compared against THIS lbug. Claiming 'owned' lets it permanently,
      // silently suppress augment for a repo it does not actually lock. We now
      // distinguish the failure shapes (all still fail-closed where we can't
      // prove non-ownership, but 'timeout' is the HONEST verdict for
      // "inconclusive", not the false-positive 'owned'):
      const code = err && err.code;
      if (code === 'ENOENT') {
        // Process raced away between the candidate scan and now -> genuinely no
        // longer an owner. Move on.
        continue;
      }
      if (code === 'EACCES' || code === 'EPERM') {
        // Permission-denied fd dir: cannot read fds, so ownership is
        // UNVERIFIABLE. Fail closed honestly via 'timeout' (the dispatcher maps
        // timeout -> true, same protective skip as before) WITHOUT lying that we
        // confirmed ownership. Do NOT degrade to not-owned/fail-open: if this
        // really is the owner, fail-open re-opens the #1492 lbug race; augment
        // is optional context, so a conservative skip costs little.
        debugLog(
          `fd dir unreadable for candidate pid ${pidStr} (${code}); ownership ` +
            `unverifiable, probe inconclusive -> fail-closed (timeout)`,
        );
        return 'timeout';
      }
      if (code === 'EIO' || code === 'ESTALE') {
        // Genuine transient I/O against this candidate's fd dir — not evidence
        // it does NOT hold the lbug. Treat as inconclusive and fail closed
        // (timeout) rather than continue, so a real owner mid-I/O-blip is not
        // dropped (would fail-open).
        debugLog(
          `fd dir transient I/O error for candidate pid ${pidStr} (${code}); ` +
            `probe inconclusive -> fail-closed (timeout)`,
        );
        return 'timeout';
      }
      // Any other shape (ENOTDIR — fd path is not a directory at all, so this
      // is not a plausible live-procfs owner — and the long tail) is treated as
      // "this candidate is not an owner": move to the next candidate instead of
      // the old blanket 'owned'. If no other candidate owns the lbug the scan
      // ends not-owned (dispatcher fail-open) — acceptable because ENOTDIR means
      // the fd entry is structurally not a real /proc/<pid>/fd.
      debugLog(
        `fd dir not a readable directory for candidate pid ${pidStr} ` +
          `(${code || 'unknown'}); treating candidate as non-owner -> continue`,
      );
      continue;
    }
    for (const fd of fds) {
      if (outOfBudget()) return 'timeout';
      try {
        const st = fs.statSync(path.join(fdDir, fd));
        if (st.dev === targetStat.dev && st.ino === targetStat.ino) {
          return 'owned';
        }
      } catch {
        /* fd raced closed; ignore */
      }
    }
  }

  return 'not-owned';
}

function unixLsofPsFindGitNexusServer(dbPathAbs, myPid) {
  const guard = resolveUnixGuardTimeout();
  // An explicit missing override models ENOENT and must fail open instead of
  // falling through to a host binary with different process-table visibility.
  if (hasMissingHookBinaryOverride('lsof')) return false;
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
  // Guard-mediated deaths map to "unresponsive holder" (fail-closed). Three
  // result shapes, verified against coreutils 9.1:
  //   - signal-death: when `-k` escalates to SIGKILL, coreutils timeout
  //     SELF-RAISES the signal, so spawnSync reports {status: null, signal}
  //     with no .error (spawnSync's own ETIMEDOUT was handled above). The
  //     same shape appears when this hook is frozen >2s (SIGSTOP, laptop
  //     suspend) and the guard expires while it sleeps. By construction, a
  //     guard-wrapped probe that died by signal without spawnSync ETIMEDOUT
  //     is a budget/kill outcome.
  //   - 124: budget expired and the child exited after the plain SIGTERM.
  //   - 137: NOT the coreutils -k path — only exit-code-propagating wrappers,
  //     or a child SIGKILLed externally (e.g. the OOM killer).
  if (guard && lsof.status === null && lsof.signal) return true;
  if (guard && (lsof.status === 124 || lsof.status === 137)) return true;

  const pids = (lsof.stdout || '').split(/\s+/).filter(Boolean);
  const psMissing = hasMissingHookBinaryOverride('ps');
  const psPath = resolveHookBinary('ps');
  for (const pid of pids) {
    if (Number(pid) === myPid) continue;
    // Missing ps means we cannot verify that this pid is a GitNexus server.
    if (psMissing) continue;
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
    // Same guard-mediated-death mapping as the lsof call above (signal-death
    // from the -k escalation or a frozen hook; 124 budget expiry; 137 only
    // for exit-code-propagating wrappers / external SIGKILL).
    if (guard && ps.status === null && ps.signal) return true;
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
    // #2180: cmdline-first procfs scan, no lsof. 'timeout' fails CLOSED
    // (overloaded host self-throttles — the throttle the orphan-storm incident
    // needed; the old lsof fallback ETIMEDOUT'd and failed closed on these same
    // hosts anyway, only slower and with the orphan risk). 'not-owned' is the
    // only false. See the fail matrix in the file header.
    const verdict = linuxProcScanFindGitNexusServer(dbPathAbs, myPid);
    return verdict !== 'not-owned';
  }

  return unixLsofPsFindGitNexusServer(dbPathAbs, myPid);
}

module.exports = {
  hasGitNexusDbLockedByGitNexusServer,
  // Exported for white-box unit tests that must assert the tri-state verdict
  // ('owned' | 'not-owned' | 'timeout') directly — the dispatcher collapses
  // timeout and owned to the same boolean true, so the boolean API alone cannot
  // distinguish the F1 EACCES->timeout fix from the old EACCES->owned bug. The
  // Probe interface already declares this optional. Linux-only by contract; the
  // name is pinned by a source-contract test.
  linuxProcScanFindGitNexusServer,
  // #2163 follow-up: the hook adapters wrap the augment CLI in the same
  // guard. Returns a self-tested wrapper path — the built-in candidates are
  // always absolute; a GITNEXUS_HOOK_TIMEOUT_PATH override is adopted as the
  // exact string that passed the self-test. Same string is also the same
  // RESOLUTION for absolute paths and for slashless names (PATH lookup is
  // cwd-independent); a slash-containing RELATIVE override, however, is
  // existsSync-checked and self-tested against this process's cwd while the
  // adapters spawn the CLI with a `cwd` option (chdir-before-exec), so such
  // a value can pass here yet ENOENT at the augment call site — set the
  // override to an absolute path. Returns null when the wrapper is
  // disabled/unavailable. Never call on win32 (see its JSDoc).
  resolveUnixGuardTimeout,
  // Exported for white-box unit tests of the numeric-env parsing (#2183 review):
  // Number()-not-parseInt so "16e3" reads as 16000, plus the empty/whitespace
  // guard that keeps a set-but-empty budget on the 1200 default instead of an
  // immediate fail-closed timeout. Tested directly because the values are
  // otherwise only observable indirectly through scan timing/escalation.
  getCmdlineMaxBytes,
  resolveLinuxProcBudgetMs,
};
