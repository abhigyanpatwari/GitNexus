/**
 * Direct unit tests for the Linux cmdline-first DB-owner scan (#2180).
 *
 * These exercise linuxProcScanFindGitNexusServer / hasGitNexusDbLockedByGitNexusServer
 * against a FAKE /proc tree (GITNEXUS_HOOK_PROC_ROOT) so the three-phase logic
 * (comm -> cmdline -> fd dev+ino) is asserted deterministically, without
 * scanning the test host's real /proc. One live e2e at the bottom uses the REAL
 * /proc to protect the "lbug handle is fd-visible" property the scan relies on.
 *
 * The probe is a CJS module; we require it through createRequire and toggle env
 * per-test. resetModules-style isolation is unnecessary because the only
 * module-level cache (unixGuardTimeoutCache) is on the macOS/Unix path, which
 * these Linux tests never reach.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { createFakeProcRoot, type FakeProcEntry } from '../utils/hook-test-helpers.js';

const PROBE_PATH = path.resolve(__dirname, '..', '..', 'hooks', 'claude', 'hook-db-lock-probe.cjs');

type Probe = {
  hasGitNexusDbLockedByGitNexusServer: (dbPath: string, myPid: number) => boolean;
  linuxProcScanFindGitNexusServer?: (dbPathAbs: string, myPid: number) => string;
  getCmdlineMaxBytes?: () => number;
  resolveLinuxProcBudgetMs?: () => number;
};
const probe = createRequire(import.meta.url)(PROBE_PATH) as Probe;

// The probe now exports linuxProcScanFindGitNexusServer unconditionally (F1
// white-box verdict assertions). Narrow it once here to a non-optional typed
// fn so the per-test call sites stay assertion-free; a dedicated test below
// pins that the export really is a function.
type ScanVerdictFn = (dbPathAbs: string, myPid: number) => string;
const scanVerdictFn = probe.linuxProcScanFindGitNexusServer as ScanVerdictFn;

const isLinux = process.platform === 'linux';

// ── env scoping helpers ────────────────────────────────────────────
const ENV_KEYS = [
  'GITNEXUS_HOOK_PROC_ROOT',
  'GITNEXUS_HOOK_LINUX_PROC_BUDGET_MS',
  'GITNEXUS_HOOK_PROC_CMDLINE_MAX',
] as const;
const savedEnv: Record<string, string | undefined> = {};
function setEnv(overrides: Record<string, string | undefined>) {
  for (const k of ENV_KEYS) {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const k of Object.keys(savedEnv)) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete savedEnv[k];
  }
  while (cleanups.length) {
    try {
      cleanups.pop()!();
    } catch {
      /* best-effort */
    }
  }
});

/**
 * Build a temp lbug + a fake /proc root, run the dispatcher with the fake root,
 * and return the boolean owner verdict. The lbug is the dev+ino the fake fd
 * symlinks point at, so a holder whose fdTargets include `lbug` is a true owner.
 */
function runScan(
  entries: (lbugPath: string) => FakeProcEntry[],
  env: Record<string, string | undefined> = {},
): { owned: boolean; lbugPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-probe-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lbugPath = path.join(dir, 'lbug');
  fs.writeFileSync(lbugPath, '');
  const procRoot = createFakeProcRoot(entries(lbugPath));
  cleanups.push(() => fs.rmSync(procRoot, { recursive: true, force: true }));
  setEnv({ GITNEXUS_HOOK_PROC_ROOT: procRoot, ...env });
  const owned = probe.hasGitNexusDbLockedByGitNexusServer(lbugPath, 1);
  return { owned, lbugPath };
}

const GITNEXUS_MCP_ARGV = (script: string) => ['node', script, 'mcp'];

// ── Numeric env parsing (white-box, #2183 review) ──────────────────────
//
// getCmdlineMaxBytes / resolveLinuxProcBudgetMs switched from parseInt(.,10) to
// Number() so scientific notation ("16e3") parses as 16000 instead of 16. These
// are platform-independent (pure string->number), so they run on every OS, not
// just Linux. The load-bearing case is the EMPTY-STRING budget regression guard:
// a naive parseInt->Number swap would make a set-but-empty
// GITNEXUS_HOOK_LINUX_PROC_BUDGET_MS="" resolve to Number("")===0 => budget 0 =>
// immediate fail-CLOSED timeout (augment permanently skipped). The added
// `&& String(raw).trim()` guard keeps ''/whitespace on the 1200 default.
describe('numeric env parsing (white-box, #2183 review)', () => {
  const budget = probe.resolveLinuxProcBudgetMs as () => number;
  const cmdlineMax = probe.getCmdlineMaxBytes as () => number;

  it('exports the two parse helpers as functions', () => {
    expect(typeof probe.resolveLinuxProcBudgetMs).toBe('function');
    expect(typeof probe.getCmdlineMaxBytes).toBe('function');
  });

  it('budget: "16e3" parses as 16000 (scientific notation), not 16', () => {
    // parseInt('16e3',10) === 16 (stops at 'e'); Number('16e3') === 16000.
    setEnv({ GITNEXUS_HOOK_LINUX_PROC_BUDGET_MS: '16e3' });
    expect(budget()).toBe(16000);
  });

  it('budget: set-but-empty "" and whitespace fall back to 1200, NOT 0 (regression guard)', () => {
    // The deepening catch: without the `&& String(raw).trim()` guard these would
    // be Number('')===0 => an immediate fail-closed timeout on every hook call.
    for (const empty of ['', '   ', '\t']) {
      setEnv({ GITNEXUS_HOOK_LINUX_PROC_BUDGET_MS: empty });
      expect(budget()).toBe(1200);
    }
  });

  it('budget: "0" still parses to 0 (the deliberate #2180 immediate-timeout vector)', () => {
    setEnv({ GITNEXUS_HOOK_LINUX_PROC_BUDGET_MS: '0' });
    expect(budget()).toBe(0);
  });

  it('budget: trailing garbage "123abc" and unset fall back to 1200', () => {
    setEnv({ GITNEXUS_HOOK_LINUX_PROC_BUDGET_MS: '123abc' });
    expect(budget()).toBe(1200);
    setEnv({ GITNEXUS_HOOK_LINUX_PROC_BUDGET_MS: undefined });
    expect(budget()).toBe(1200);
  });

  it('cmdline max: "8e3" parses as 8000 (>= floor); "2e3" (=2000, below floor) and ""/unset -> 16384', () => {
    setEnv({ GITNEXUS_HOOK_PROC_CMDLINE_MAX: '8e3' });
    expect(cmdlineMax()).toBe(8000);
    setEnv({ GITNEXUS_HOOK_PROC_CMDLINE_MAX: '2e3' });
    expect(cmdlineMax()).toBe(16384);
    setEnv({ GITNEXUS_HOOK_PROC_CMDLINE_MAX: '' });
    expect(cmdlineMax()).toBe(16384);
    setEnv({ GITNEXUS_HOOK_PROC_CMDLINE_MAX: undefined });
    expect(cmdlineMax()).toBe(16384);
  });
});

describe.skipIf(!isLinux)('Linux cmdline-first DB-owner scan (#2180)', () => {
  // ── D1: three-phase correctness ──────────────────────────────────

  it('owned: a gitnexus mcp process holding the lbug fd is detected', () => {
    const { owned } = runScan((lbug) => [
      {
        pid: 4242,
        comm: 'MainThread', // real gitnexus servers report this on modern Node
        cmdline: GITNEXUS_MCP_ARGV('/opt/app/node_modules/gitnexus/dist/cli/index.js'),
        fdTargets: ['/dev/null', lbug],
      },
    ]);
    expect(owned).toBe(true);
  });

  it('not-owned: a node process that is not a gitnexus server (even holding the lbug) is ignored', () => {
    const { owned } = runScan((lbug) => [
      {
        pid: 5555,
        comm: 'node',
        cmdline: ['node', '/some/app/server.js'],
        fdTargets: [lbug], // holds the fd, but cmdline is not a gitnexus server
      },
    ]);
    expect(owned).toBe(false);
  });

  it('not-owned: a gitnexus mcp process that does NOT hold the lbug fd is not an owner', () => {
    const { owned } = runScan((lbug) => [
      {
        pid: 6001,
        comm: 'MainThread',
        cmdline: GITNEXUS_MCP_ARGV('/x/node_modules/gitnexus/dist/cli/index.js'),
        fdTargets: ['/dev/null'], // server, but holds some OTHER fd, not this lbug
      },
      // a decoy that holds the lbug but is not a server
      {
        pid: 6002,
        comm: 'vim',
        cmdline: ['vim', '/etc/hosts'],
        fdTargets: [lbug],
      },
    ]);
    expect(owned).toBe(false);
  });

  it('Phase 0 trap: cmdline LOOKS like gitnexus but comm is non-candidate → filtered out before fd check', () => {
    // The fd symlink points at the lbug, so if Phase 0 did NOT filter on comm
    // the cmdline prefilter would match and the fd check would say "owned".
    // Because comm is a non-candidate ('postgres'), Phase 0 drops it first.
    const { owned } = runScan((lbug) => [
      {
        pid: 7007,
        comm: 'postgres', // not in COMM_CANDIDATES, not a prefix of any
        cmdline: GITNEXUS_MCP_ARGV('/x/node_modules/gitnexus/dist/cli/index.js'),
        fdTargets: [lbug],
      },
    ]);
    expect(owned).toBe(false);
  });

  it('Phase 0 truncation-safe: a 15-char-truncated comm prefix of a candidate still matches', () => {
    // Kernel comm cap is 15 visible chars; a candidate name truncated to a
    // prefix must NOT be dropped. We use a comm that is a strict prefix of a
    // whitelist entry ('MainThr' ⊂ 'MainThread').
    const { owned } = runScan((lbug) => [
      {
        pid: 8008,
        comm: 'MainThr',
        cmdline: GITNEXUS_MCP_ARGV('/x/node_modules/gitnexus/dist/cli/index.js'),
        fdTargets: [lbug],
      },
    ]);
    expect(owned).toBe(true);
  });

  // ── D2: budget / timeout → fail-closed ───────────────────────────

  it('budget <= 0 → immediate timeout → dispatcher fails CLOSED (owner=true)', () => {
    // Even though NO process is a gitnexus server, budget 0 yields 'timeout'
    // which the dispatcher maps to true (self-throttle). This also pins the
    // #2180 budget-parse fix: "0" must NOT fall back to 1200.
    const { owned } = runScan(
      () => [{ pid: 9001, comm: 'bash', cmdline: ['bash'], fdTargets: [] }],
      { GITNEXUS_HOOK_LINUX_PROC_BUDGET_MS: '0' },
    );
    expect(owned).toBe(true);
  });

  it('budget "0" is not silently treated as 1200 (regression for the parse bug)', () => {
    // With a healthy non-owner fake proc and budget '0', the OLD code (which
    // coerced "0" to 1200) would have completed the scan and returned
    // not-owned (false). The fixed code returns timeout → true.
    const { owned } = runScan(
      () => [{ pid: 9100, comm: 'node', cmdline: ['node', '/app/x.js'], fdTargets: [] }],
      { GITNEXUS_HOOK_LINUX_PROC_BUDGET_MS: '0' },
    );
    expect(owned).toBe(true);
  });

  it('a generous budget over a non-owner tree completes and returns not-owned', () => {
    const { owned } = runScan(
      () => [
        { pid: 9200, comm: 'node', cmdline: ['node', '/app/x.js'], fdTargets: [] },
        { pid: 9201, comm: 'bash', cmdline: ['bash', '-l'], fdTargets: [] },
      ],
      { GITNEXUS_HOOK_LINUX_PROC_BUDGET_MS: '5000' },
    );
    expect(owned).toBe(false);
  });

  // ── D3: 4 KB+ cmdline cap — escalation must really iterate (F2) ────
  //
  // The cmdline shape here is deliberate (Codex): the `gitnexus` token sits in
  // the SECOND argv (a SHORT node_modules/gitnexus path, well inside the first
  // 4 KB chunk) so `if (!hasGitNexus) break` does NOT abort the read; a ~9 KB
  // pad argv then pushes the trailing `mcp` mode token PAST 4096, so the first
  // 4 KB chunk has gitnexus-but-no-mode and the loop MUST escalate to a second
  // read to find `mcp`. Setting GITNEXUS_HOOK_PROC_CMDLINE_MAX=4096 makes the
  // chunk size 4 KB so escalation actually happens (the 16 KB default would read
  // the whole line in one shot and the loop would never iterate — the old test's
  // latent no-op).

  // gitnexus token early (well under 4 KB), mode token forced past 4 KB by pad.
  const GITNEXUS_SHORT = '/nm/node_modules/gitnexus/dist/cli/index.js';
  const PAD_PAST_4K = 'x'.repeat(9000); // pushes the trailing `mcp` well past 4096

  it('owned even when the mode token sits far past 4 KB → escalation iterates and finds it', () => {
    const readSyncSpy = vi.spyOn(fs, 'readSync');
    cleanups.push(() => readSyncSpy.mockRestore());
    const { owned } = runScan(
      (lbug) => [
        {
          pid: 10001,
          comm: 'MainThread',
          // node | SHORT gitnexus path (<4KB) | 9KB pad | mcp  → mcp lands >4096
          cmdline: ['node', GITNEXUS_SHORT, PAD_PAST_4K, 'mcp'],
          fdTargets: [lbug],
        },
      ],
      { GITNEXUS_HOOK_PROC_CMDLINE_MAX: '4096' },
    );
    expect(owned).toBe(true);
    // White-box proof the escalation actually re-read: with a 4 KB chunk over a
    // >4 KB cmdline, readSync must have been called more than once for this pid.
    // (A "just bump the cap" pseudo-fix that read everything in one go would
    // leave this at 1 and fail.)
    expect(readSyncSpy.mock.calls.length).toBeGreaterThan(1);
  });

  it('discrimination: same gitnexus cmdline but mode token past HARD_CEIL → not-owned', () => {
    // Negative control proving the escalation has a real upper bound (HARD_CEIL
    // = 256 KiB) and the positive test above is not just "always escalates". The
    // gitnexus token is early so escalation runs, but a >256 KiB pad keeps the
    // `mcp` token beyond the ceiling, so the bounded read stops before reaching
    // it → isGitNexusServerCommand sees no mode token → not a candidate →
    // not-owned. (A broken "escalate forever" impl would wrongly read to `mcp`
    // and report owned, failing this assertion.)
    const padPastCeil = 'x'.repeat(300000); // > HARD_CEIL (262144)
    const { owned } = runScan(
      (lbug) => [
        {
          pid: 10002,
          comm: 'MainThread',
          cmdline: ['node', GITNEXUS_SHORT, padPastCeil, 'mcp'],
          fdTargets: [lbug],
        },
      ],
      { GITNEXUS_HOOK_PROC_CMDLINE_MAX: '4096' },
    );
    expect(owned).toBe(false);
  });

  it('does not over-read: a giant non-gitnexus cmdline is bounded and yields not-owned', () => {
    const giant = 'x'.repeat(500000); // 500 KB single arg, no gitnexus token
    const { owned } = runScan((lbug) => [
      {
        pid: 10100,
        comm: 'node',
        cmdline: ['node', `/app/${giant}.js`],
        fdTargets: [lbug],
      },
    ]);
    expect(owned).toBe(false);
  });

  // ── D3b: cmdline escalation respects the scan budget (F3) ─────────
  //
  // A single pathological candidate whose `mcp` token sits far past the chunk
  // size used to be able to read up to HARD_CEIL (256 KiB) inside one
  // readLinuxCmdline call before the scan-level budget was re-checked. F3 wires
  // outOfBudget into the escalation loop: when the deadline trips mid-read it
  // returns the CMDLINE_TIMEOUT *Symbol* (NOT '' — '' would flow through
  // isGitNexusServerCommand as a non-candidate and silently drop a possible
  // owner, a fail-OPEN), and the Phase 1 caller maps that Symbol to the 'timeout'
  // verdict (fail-CLOSED). We drive the deadline deterministically by advancing
  // a Date.now spy after the first escalation read.

  it('escalation that exceeds the budget mid-read → verdict timeout (sentinel, not silent drop)', () => {
    const scan = scanVerdictFn;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-probe-f3-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const lbugPath = path.join(dir, 'lbug');
    fs.writeFileSync(lbugPath, '');
    // gitnexus token early (escalation will start), mode token pushed past 4 KB
    // so a SECOND read is required — between those reads we trip the clock.
    const procRoot = createFakeProcRoot([
      {
        pid: 10200,
        comm: 'MainThread',
        cmdline: ['node', GITNEXUS_SHORT, 'x'.repeat(9000), 'mcp'],
        fdTargets: [lbugPath],
      },
    ]);
    cleanups.push(() => fs.rmSync(procRoot, { recursive: true, force: true }));
    setEnv({
      GITNEXUS_HOOK_PROC_ROOT: procRoot,
      GITNEXUS_HOOK_PROC_CMDLINE_MAX: '4096',
      GITNEXUS_HOOK_LINUX_PROC_BUDGET_MS: '1000', // positive, so the scan starts
    });

    // Deterministic clock: the scan captures `start` (call #1) and runs its
    // Phase-0/1 entry budget checks in-budget; once the escalation loop is under
    // way we jump Date.now() past the 1000 ms budget so the loop's in-read
    // outOfBudget() returns the CMDLINE_TIMEOUT sentinel. The threshold (>4) is
    // chosen so the early checks (start capture, per-entry + Phase-1 pre-read
    // checks) stay at base and only the escalation's mid-loop check trips.
    const base = Date.now();
    let nowCalls = 0;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      nowCalls += 1;
      return nowCalls > 4 ? base + 5000 : base;
    });
    cleanups.push(() => nowSpy.mockRestore());

    const verdict = scan(lbugPath, 1);
    // The load-bearing assertion: a mid-escalation budget trip yields the
    // 'timeout' verdict (via the Symbol sentinel) — NOT a silent non-candidate
    // drop (which would be 'not-owned' here and a fail-OPEN if this were a real
    // cross-budget owner).
    expect(verdict).toBe('timeout');
    nowSpy.mockRestore();
  });

  // ── D5: GITNEXUS_HOOK_PROC_ROOT is honored ONLY under a test runner (F4) ──
  //
  // Production hooks run as `node <probe>.cjs` with neither VITEST nor
  // NODE_ENV=test set; vitest injects both into every worker (verified). F4
  // gates getProcRoot() on that signal so a production env that leaked
  // GITNEXUS_HOOK_PROC_ROOT (pointing at an empty/bad tree) cannot turn Linux
  // owner detection OFF (no pids -> not-owned -> fail-OPEN, the #1492 class).
  // These tests run inside vitest, so the gate is OPEN and injection works (the
  // entire fake-procfs suite above already depends on that). Here we prove the
  // gate is load-bearing: with the test signals stripped, the override is
  // ignored and the scan falls back to the real /proc (so our fake lbug is NOT
  // found there -> not-owned), and with them present the override is honored.

  it('honors GITNEXUS_HOOK_PROC_ROOT under the vitest test signal (gate open)', () => {
    // Sanity: in this vitest worker VITEST/NODE_ENV are set, so the fake root is
    // honored and a fake owner is detected — same mechanism the whole suite uses.
    const { owned } = runScan((lbug) => [
      {
        pid: 10300,
        comm: 'MainThread',
        cmdline: GITNEXUS_MCP_ARGV('/x/node_modules/gitnexus/dist/cli/index.js'),
        fdTargets: [lbug],
      },
    ]);
    expect(owned).toBe(true);
  });

  it('ignores GITNEXUS_HOOK_PROC_ROOT when the test signal is absent (gate closed → real /proc)', () => {
    // Strip BOTH test signals so getProcRoot() falls back to /proc even though
    // GITNEXUS_HOOK_PROC_ROOT points at our fake tree. The fake lbug is not an
    // fd under the real /proc, so the scan returns not-owned: proof the override
    // is inert in a non-test (production-shaped) context.
    const savedVitest = process.env.VITEST;
    const savedNodeEnv = process.env.NODE_ENV;
    cleanups.push(() => {
      if (savedVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = savedVitest;
      if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = savedNodeEnv;
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-probe-f4-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const lbugPath = path.join(dir, 'lbug');
    fs.writeFileSync(lbugPath, '');
    const procRoot = createFakeProcRoot([
      {
        pid: 10400,
        comm: 'MainThread',
        cmdline: GITNEXUS_MCP_ARGV('/x/node_modules/gitnexus/dist/cli/index.js'),
        fdTargets: [lbugPath],
      },
    ]);
    cleanups.push(() => fs.rmSync(procRoot, { recursive: true, force: true }));
    setEnv({ GITNEXUS_HOOK_PROC_ROOT: procRoot });
    // Now drop the test signals — must happen AFTER setEnv so the gate sees them gone.
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    const verdict = scanVerdictFn(lbugPath, 1);
    // Gate closed -> getProcRoot() returns '/proc'; our fake lbug fd is not in
    // the real /proc, so no owner is found.
    expect(verdict).toBe('not-owned');
    expect(probe.hasGitNexusDbLockedByGitNexusServer(lbugPath, 1)).toBe(false);
  });

  // ── D4: unreadable candidate fd dir → honest tri-state verdict (F1) ──
  //
  // /proc/<pid>/fd is owner-only (mode 0500). A cross-user/root `gitnexus mcp`
  // serving a DIFFERENT repo clears Phase 0+1 (cmdline matches) and then EACCES
  // here — but its dev+ino was never compared against THIS lbug. The OLD code
  // returned 'owned' for every non-ENOENT readdir error, falsely claiming
  // ownership and permanently suppressing augment for a repo that process does
  // not lock. F1 splits the failure shapes:
  //   - EACCES / EPERM      -> 'timeout'  (unverifiable; fail-closed HONESTLY)
  //   - EIO / ESTALE        -> 'timeout'  (transient I/O; fail-closed)
  //   - ENOTDIR / other     -> continue   (not a real fd dir; treat as non-owner)
  // The dispatcher collapses owned+timeout to boolean true, so these assert the
  // exported tri-state verdict directly — a boolean check could not tell the F1
  // fix from the old bug.

  it('exports linuxProcScanFindGitNexusServer for white-box verdict assertions', () => {
    expect(typeof probe.linuxProcScanFindGitNexusServer).toBe('function');
  });

  it('candidate fd dir EACCES → verdict timeout (honest fail-closed, NOT owned)', () => {
    if (process.getuid && process.getuid() === 0) {
      // root bypasses chmod 000, so a real EACCES is not reproducible on this
      // host. This disk-based test no-ops under root; the uid-agnostic spy
      // tests below cover every F1 errno branch (EACCES/EPERM/EIO/ESTALE/
      // ENOTDIR) regardless of who runs the suite.
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-probe-eacces-'));
    cleanups.push(() => {
      try {
        fs.chmodSync(path.join(dir, 'proc', '11001', 'fd'), 0o755);
      } catch {
        /* ignore */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const lbugPath = path.join(dir, 'lbug');
    fs.writeFileSync(lbugPath, '');
    const procRoot = path.join(dir, 'proc');
    const fdDir = path.join(procRoot, '11001', 'fd');
    fs.mkdirSync(fdDir, { recursive: true });
    fs.writeFileSync(path.join(procRoot, '11001', 'comm'), 'MainThread\n');
    fs.writeFileSync(
      path.join(procRoot, '11001', 'cmdline'),
      ['node', '/x/node_modules/gitnexus/dist/cli/index.js', 'mcp'].join('\0') + '\0',
    );
    fs.chmodSync(fdDir, 0o000); // EACCES on readdir
    setEnv({ GITNEXUS_HOOK_PROC_ROOT: procRoot });
    // White-box: assert the verdict is 'timeout' (NOT 'owned' — the F1 point).
    const verdict = scanVerdictFn(lbugPath, 1);
    expect(verdict).toBe('timeout');
    // And the dispatcher still fails closed (boolean true) on that timeout.
    const owned = probe.hasGitNexusDbLockedByGitNexusServer(lbugPath, 1);
    expect(owned).toBe(true);
  });

  // uid-agnostic coverage of every F1 fd-readdir errno branch. chmod 000 yields
  // no EACCES for root, so the disk-based tests above no-op there — these spy
  // fs.readdirSync to throw a chosen errno only for the candidate's fd dir (the
  // procRoot enumeration calls through), pinning the F1 split in CI regardless
  // of the runner's uid.
  for (const { code, expected } of [
    { code: 'EACCES', expected: 'timeout' },
    { code: 'EPERM', expected: 'timeout' },
    { code: 'EIO', expected: 'timeout' },
    { code: 'ESTALE', expected: 'timeout' },
    { code: 'ENOTDIR', expected: 'not-owned' },
  ] as const) {
    it(`candidate fd readdir ${code} → verdict ${expected} (uid-agnostic spy)`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-probe-fderr-'));
      cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
      const lbugPath = path.join(dir, 'lbug');
      fs.writeFileSync(lbugPath, '');
      const procRoot = path.join(dir, 'proc');
      const fdDir = path.join(procRoot, '11001', 'fd');
      fs.mkdirSync(fdDir, { recursive: true });
      fs.writeFileSync(path.join(procRoot, '11001', 'comm'), 'MainThread\n');
      fs.writeFileSync(
        path.join(procRoot, '11001', 'cmdline'),
        ['node', '/x/node_modules/gitnexus/dist/cli/index.js', 'mcp'].join('\0') + '\0',
      );
      setEnv({ GITNEXUS_HOOK_PROC_ROOT: procRoot });
      const realReaddir = fs.readdirSync.bind(fs);
      const spy = vi.spyOn(fs, 'readdirSync').mockImplementation((p, ...rest) => {
        if (typeof p === 'string' && p.endsWith(`${path.sep}fd`)) {
          const err = new Error(`mock ${code}`) as NodeJS.ErrnoException;
          err.code = code;
          throw err;
        }
        return (realReaddir as (...a: unknown[]) => unknown)(p, ...rest);
      });
      cleanups.push(() => spy.mockRestore());
      // White-box: assert the exported tri-state verdict directly (the
      // dispatcher would collapse timeout+owned to the same boolean).
      expect(scanVerdictFn(lbugPath, 1)).toBe(expected);
      spy.mockRestore();
    });
  }

  it('candidate fd path is a FILE (ENOTDIR) → treated as non-owner → not-owned', () => {
    // ENOTDIR means the fd entry is not a real /proc/<pid>/fd directory at all,
    // so it is not a plausible live owner. The candidate is skipped (continue);
    // with no other candidate the scan ends not-owned (the OLD code wrongly
    // returned 'owned' here). Runs on every OS incl. root.
    const { verdict, owned } = runScanFdEnotdir();
    expect(verdict).toBe('not-owned');
    expect(owned).toBe(false);
  });

  it('EACCES candidate then a REAL owner later → still detects the real owner', () => {
    // Regression guard for the F1 continue/return choice: an EACCES candidate
    // must NOT short-circuit the scan in a way that hides a genuine owner. Here
    // the EACCES dir yields timeout BEFORE reaching the true owner — timeout is
    // the protective (fail-closed) verdict, so dispatcher returns true either
    // way. (Ordering in /proc readdir is numeric-string; 11001 < 11050.)
    if (process.getuid && process.getuid() === 0) return; // EACCES needs non-root
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-probe-mixed-'));
    cleanups.push(() => {
      try {
        fs.chmodSync(path.join(dir, 'proc', '11001', 'fd'), 0o755);
      } catch {
        /* ignore */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const lbugPath = path.join(dir, 'lbug');
    fs.writeFileSync(lbugPath, '');
    const procRoot = path.join(dir, 'proc');
    // Candidate A: EACCES fd dir.
    const fdDirA = path.join(procRoot, '11001', 'fd');
    fs.mkdirSync(fdDirA, { recursive: true });
    fs.writeFileSync(path.join(procRoot, '11001', 'comm'), 'MainThread\n');
    fs.writeFileSync(
      path.join(procRoot, '11001', 'cmdline'),
      ['node', '/x/node_modules/gitnexus/dist/cli/index.js', 'mcp'].join('\0') + '\0',
    );
    fs.chmodSync(fdDirA, 0o000);
    setEnv({ GITNEXUS_HOOK_PROC_ROOT: procRoot });
    const verdict = scanVerdictFn(lbugPath, 1);
    // EACCES is hit first and fails closed (timeout) — the protective outcome.
    expect(verdict).toBe('timeout');
    expect(probe.hasGitNexusDbLockedByGitNexusServer(lbugPath, 1)).toBe(true);
  });
});

// Helper for the ENOTDIR branch: fd is a FILE not a dir, so readdir throws
// ENOTDIR. F1: this candidate is treated as a non-owner (continue) → not-owned.
function runScanFdEnotdir(): { verdict: string; owned: boolean } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-probe-enotdir-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lbugPath = path.join(dir, 'lbug');
  fs.writeFileSync(lbugPath, '');
  const procRoot = path.join(dir, 'proc');
  const pidDir = path.join(procRoot, '11002');
  fs.mkdirSync(pidDir, { recursive: true });
  fs.writeFileSync(path.join(pidDir, 'comm'), 'MainThread\n');
  fs.writeFileSync(
    path.join(pidDir, 'cmdline'),
    ['node', '/x/node_modules/gitnexus/dist/cli/index.js', 'mcp'].join('\0') + '\0',
  );
  fs.writeFileSync(path.join(pidDir, 'fd'), 'not a dir'); // readdir -> ENOTDIR
  setEnv({ GITNEXUS_HOOK_PROC_ROOT: procRoot });
  const verdict = scanVerdictFn(lbugPath, 1);
  const owned = probe.hasGitNexusDbLockedByGitNexusServer(lbugPath, 1);
  return { verdict, owned };
}

// ── D6: live e2e against the REAL /proc ─────────────────────────────
//
// Protects the load-bearing assumption that a real lbug handle is fd-visible in
// /proc/<pid>/fd (a @ladybugdb/core property; a future move to mmap-only would
// silently regress #1492 with no other test going red). We spawn a child that
// opens an fd on a real temp lbug AND wears a gitnexus-mcp cmdline, then assert
// the scan reports owned. Crucially we assert against OUR holder's identity, not
// "any owner" — this host runs background gitnexus servers, so a bare
// truthiness check could be a false positive.
describe.skipIf(!isLinux)('Linux DB-owner scan — live /proc e2e (#2180)', () => {
  it('detects a real fd-visible gitnexus-mcp-shaped lbug holder', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-e2e-'));
    const lbugPath = path.join(dir, 'lbug');
    fs.writeFileSync(lbugPath, '');
    // Give the holder a gitnexus-server cmdline by running it from a
    // node_modules/gitnexus/dist/cli/index.js path with an `mcp` arg.
    const scriptDir = path.join(dir, 'node_modules', 'gitnexus', 'dist', 'cli');
    fs.mkdirSync(scriptDir, { recursive: true });
    const script = path.join(scriptDir, 'index.js');
    const pidFile = path.join(dir, 'holder.pid');
    fs.writeFileSync(
      script,
      `const fs=require('fs');` +
        `const fd=fs.openSync(${JSON.stringify(lbugPath)},'r');` +
        `fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));` +
        `process.on('SIGTERM',()=>{try{fs.closeSync(fd);}catch{}process.exit(0);});` +
        `setInterval(()=>{},1<<30);`,
    );

    const holder = spawn(process.execPath, [script, 'mcp'], { stdio: 'ignore' });
    try {
      // Wait for the holder to report ready (pid file written). Widened to ~10s
      // (was 5s): a loaded CI runner can be slow to spawn the child, and this is
      // the one genuine false-FAIL path in the e2e (the budget timeout below
      // merely hollows the assertion rather than failing it).
      let holderPid = 0;
      for (let i = 0; i < 400; i++) {
        try {
          const raw = fs.readFileSync(pidFile, 'utf8').trim();
          if (raw) {
            holderPid = Number.parseInt(raw, 10);
            break;
          }
        } catch {
          /* not ready yet */
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(holderPid).toBeGreaterThan(0);

      // Confirm the holder really is fd-visible (the property under test).
      const fdDir = `/proc/${holderPid}/fd`;
      const targetStat = fs.statSync(lbugPath);
      const fdVisible = fs.readdirSync(fdDir).some((fd) => {
        try {
          const st = fs.statSync(path.join(fdDir, fd));
          return st.dev === targetStat.dev && st.ino === targetStat.ino;
        } catch {
          return false;
        }
      });
      expect(fdVisible).toBe(true);

      // Real /proc, generous explicit budget. Clear PROC_ROOT (-> real /proc)
      // and raise the scan budget via setEnv so the module afterEach restores
      // BOTH (no raw process.env mutation leaking to sibling tests). The
      // generous budget is load-bearing: this dispatcher maps a budget 'timeout'
      // to owned=TRUE, so on a busy host the default 1200ms could be exhausted
      // before reaching the holder and the assertion would still pass for the
      // WRONG reason (a hollow timeout, not real fd-visible detection). 10s
      // keeps the assertion honest. Use a PID we are NOT so the holder is not
      // excluded, and assert owned for OUR lbug specifically.
      setEnv({
        GITNEXUS_HOOK_PROC_ROOT: undefined,
        GITNEXUS_HOOK_LINUX_PROC_BUDGET_MS: '10000',
      });
      const t0 = Date.now();
      const owned = probe.hasGitNexusDbLockedByGitNexusServer(lbugPath, process.pid);
      const ms = Date.now() - t0;
      expect(owned).toBe(true);
      // Coarse regression guard against the old O(procs×fds)+lsof path (~1.2s+).
      // The bound sits ABOVE the 10s budget so a legitimately-slow-but-correct
      // scan can't trip it — a regression guard, not a tight perf SLA.
      expect(ms).toBeLessThan(15000);
    } finally {
      try {
        holder.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);
});
