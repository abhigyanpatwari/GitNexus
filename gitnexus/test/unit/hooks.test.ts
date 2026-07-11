/**
 * Regression Tests: Claude Code Hooks
 *
 * Tests the hook scripts (gitnexus-hook.cjs and gitnexus-hook.js) that run
 * as PreToolUse and PostToolUse hooks in Claude Code.
 *
 * Covers:
 * - extractPattern: pattern extraction from Grep/Glob/Bash tool inputs
 * - findGitNexusDir: .gitnexus directory discovery
 * - handlePostToolUse: staleness detection after git mutations
 * - cwd validation: rejects relative paths (defense-in-depth)
 * - shell injection: verifies no shell: true in spawnSync calls
 * - dispatch map: correct handler routing
 * - cross-platform: Windows .cmd extension handling
 * - cross-platform: DB lock probe (Linux /proc, Unix lsof, Windows RM)
 *
 * Since the hooks are CJS scripts that call main() on load, we test them
 * by spawning them as child processes with controlled stdin JSON.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { createRequire } from 'node:module';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  runHook,
  parseHookOutput,
  createHookToolDir,
  createFakeProcRoot,
  hookEnv,
} from '../utils/hook-test-helpers.js';

// ─── Paths to both hook variants ────────────────────────────────────

const CJS_HOOK = path.resolve(__dirname, '..', '..', 'hooks', 'claude', 'gitnexus-hook.cjs');
const CJS_HOOK_LOCK = path.resolve(__dirname, '..', '..', 'hooks', 'claude', 'hook-lock.cjs');
const RESOLVE_CJS = path.resolve(
  __dirname,
  '..',
  '..',
  'hooks',
  'claude',
  'resolve-analyze-cmd.cjs',
);
const RESOLVE_PLUGIN_CJS = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'gitnexus-claude-plugin',
  'hooks',
  'resolve-analyze-cmd.cjs',
);
const PLUGIN_HOOK = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'gitnexus-claude-plugin',
  'hooks',
  'gitnexus-hook.js',
);
const PLUGIN_HOOK_LOCK = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'gitnexus-claude-plugin',
  'hooks',
  'hook-lock.js',
);
const CJS_HOOK_DB_PROBE = path.resolve(
  __dirname,
  '..',
  '..',
  'hooks',
  'claude',
  'hook-db-lock-probe.cjs',
);
const PLUGIN_HOOK_DB_PROBE = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'gitnexus-claude-plugin',
  'hooks',
  'hook-db-lock-probe.cjs',
);

// ─── lsof/ps-path lane gate (#2180) ─────────────────────────────────
//
// The owner-detection tests below drive the probe through its lsof + ps backend
// (via the fake lsof/ps in createHookToolDir). That backend is the macOS/other-
// Unix path; #2180 removed the Linux lsof fallback, so on Linux these tests
// would no longer exercise the real dispatch (the cmdline-first procfs scan
// answers instead, and a temp lbug held by nobody is simply not-owned). They
// remain valid coverage for the macOS lane; Linux gets equivalent three-phase
// coverage in test/unit/hook-db-lock-probe.test.ts (fake /proc + a live e2e).
const SKIP_LSOF_PATH = process.platform === 'win32' || process.platform === 'linux';

// ─── Host guard precheck for orphan-reaping tests (#2163) ───────────
//
// The reaping lanes depend on a host coreutils `timeout`/`gtimeout` that
// passes the probe's `-k` self-test. Without one, the SIGTERM-immune fake
// child simply survives and the aliveness poll times out — a red that says
// nothing about WHY. Resolve the guard once through the probe's own exported
// resolver (the exact candidate list + self-test the hook child will use,
// with any dev-shell GITNEXUS_HOOK_TIMEOUT_PATH override cleared to mirror
// the `''` these tests pass to the hook) and assert on it with an explicit
// message. Chosen form: precheck ASSERTION, not skipIf — a skip would
// silently drop the incident-mechanism coverage on a misconfigured host
// (green-but-vacuous lane), while a red with a one-line actionable cause
// keeps the contract honest. GitHub ubuntu runners always ship coreutils,
// so CI behavior is unchanged.
const GUARD_PRECHECK_MSG =
  'precheck: no self-test-passing coreutils timeout/gtimeout on this host — ' +
  'orphan reaping cannot work here (the wrapper IS the reaping mechanism). ' +
  'Install coreutils or expose one via GITNEXUS_HOOK_TIMEOUT_PATH.';

let hostGuardMemo: string | null | undefined;
function resolveHostGuardForReapingTests(): string | null {
  if (hostGuardMemo !== undefined) return hostGuardMemo;
  const saved = process.env.GITNEXUS_HOOK_TIMEOUT_PATH;
  process.env.GITNEXUS_HOOK_TIMEOUT_PATH = '';
  try {
    // createRequire: the probe is a CJS module; this also exercises the real
    // export surface the adapters consume (#2163 follow-up). Unix-only — the
    // resolver's self-test spawns /bin/sh — and all callers below live in
    // linux-gated describes.
    const probe = createRequire(import.meta.url)(CJS_HOOK_DB_PROBE) as {
      resolveUnixGuardTimeout: () => string | null;
    };
    hostGuardMemo = probe.resolveUnixGuardTimeout();
  } finally {
    if (saved === undefined) delete process.env.GITNEXUS_HOOK_TIMEOUT_PATH;
    else process.env.GITNEXUS_HOOK_TIMEOUT_PATH = saved;
  }
  return hostGuardMemo;
}

// ─── Test fixtures: temporary .gitnexus directory ───────────────────

function writeSelfTestingGuardWithMarkers(
  guardPath: string,
  markers: { lsof?: string; ps?: string },
) {
  fs.writeFileSync(
    guardPath,
    `#!/usr/bin/env node
const fs = require('fs');
const { spawnSync } = require('child_process');
const args = process.argv.slice(2);
const lsofMarker = ${JSON.stringify(markers.lsof ?? '')};
const psMarker = ${JSON.stringify(markers.ps ?? '')};
if (args.includes('exit 42')) process.exit(42);
if (lsofMarker && args.includes('-nP')) fs.writeFileSync(lsofMarker, 'called');
if (psMarker && args.includes('-p')) fs.writeFileSync(psMarker, 'called');
const child = spawnSync(args[3], args.slice(4), {
  encoding: 'utf-8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
if (child.stdout) process.stdout.write(child.stdout);
if (child.stderr) process.stderr.write(child.stderr);
if (child.error) process.exit(127);
process.exit(child.status ?? 0);
`,
    { mode: 0o755 },
  );
}

let tmpDir: string;
let gitNexusDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-hook-test-'));
  gitNexusDir = path.join(tmpDir, '.gitnexus');
  fs.mkdirSync(gitNexusDir, { recursive: true });

  // Initialize a bare git repo so git rev-parse HEAD works
  runGit(tmpDir, ['init']);
  runGit(tmpDir, ['config', 'user.email', 'test@test.com']);
  runGit(tmpDir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(tmpDir, 'dummy.txt'), 'hello');
  runGit(tmpDir, ['add', '.']);
  runGit(tmpDir, ['commit', '-m', 'init']);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Helper to get HEAD commit hash ─────────────────────────────────

function runGit(dir: string, args: string[]) {
  const result = spawnSync('git', args, {
    cwd: dir,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (result.status !== 0) {
    const message = result.stderr || result.stdout || result.error?.message || 'unknown error';
    throw new Error(`git ${args.join(' ')} failed in ${dir}: ${message}`);
  }
  return result;
}

function getHeadCommit(): string {
  const result = runGit(tmpDir, ['rev-parse', 'HEAD']);
  return (result.stdout || '').trim();
}

function initGitRepo(dir: string) {
  runGit(dir, ['init']);
  runGit(dir, ['config', 'user.email', 'test@test.com']);
  runGit(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'hello');
  runGit(dir, ['add', '.']);
  runGit(dir, ['commit', '-m', 'init']);
}

function createGlobalRegistry(homeDir: string, marker: 'both' | 'registry' | 'repos' = 'both') {
  const registryDir = path.join(homeDir, '.gitnexus');
  fs.mkdirSync(registryDir, { recursive: true });
  if (marker === 'both' || marker === 'repos') {
    fs.mkdirSync(path.join(registryDir, 'repos'), { recursive: true });
  }
  if (marker === 'both' || marker === 'registry') {
    fs.writeFileSync(path.join(registryDir, 'registry.json'), JSON.stringify({ repos: [] }));
  }
}

// createHookToolDir / hookEnv live in ../utils/hook-test-helpers so the antigravity
// e2e suite can reuse the same DB-owner-probe fakes.

// ─── Both hook files should exist ───────────────────────────────────

describe('Hook files exist', () => {
  it('CJS hook exists', () => {
    expect(fs.existsSync(CJS_HOOK)).toBe(true);
  });

  it('Plugin hook exists', () => {
    expect(fs.existsSync(PLUGIN_HOOK)).toBe(true);
  });
});

// ─── Source code regression: no shell: true ──────────────────────────

describe('Shell injection regression', () => {
  for (const [label, hookPath] of [
    ['CJS', CJS_HOOK],
    ['Plugin', PLUGIN_HOOK],
    ['Resolve CJS', RESOLVE_CJS],
    ['Resolve Plugin', RESOLVE_PLUGIN_CJS],
  ] as const) {
    it(`${label} hook has no shell: true in spawnSync calls`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      // Match spawnSync calls with shell option set to true or a variable
      // Allowed: comments mentioning shell: true, string literals
      const lines = source.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip comments and string literals
        if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
        // Check for shell: true or shell: isWin in actual code
        if (/shell:\s*(true|isWin)/.test(line)) {
          throw new Error(`${label} hook line ${i + 1} has shell injection risk: ${line.trim()}`);
        }
      }
    });
  }
});

// ─── Source code regression: windowsHide:true on every spawn-family call ───

/**
 * Every ``spawn`` / ``spawnSync`` / ``execFile`` / ``execFileSync`` /
 * ``execFileAsync`` / ``execSync`` call in the hook layer **and the
 * core/CLI/MCP/server source tree** must pass ``windowsHide: true``
 * in its options object. Without it, Node's ``child_process`` module
 * asks ``CreateProcess`` to use ``STARTF_USESHOWWINDOW`` with
 * ``SW_SHOWDEFAULT`` and a black console window flashes onto the
 * user's desktop for each call. Under active Claude Code / MCP /
 * gitnexus-serve use that's a near-continuous stream of pop-ups —
 * unusable in practice on Windows.
 *
 * ``windowsHide`` is a no-op on POSIX (silently dropped), so the
 * flag is safe to require unconditionally. ``stdio: 'inherit'``
 * callers (interactive editors etc.) are unaffected — windowsHide
 * only suppresses NEW console allocation; an inherited parent
 * console isn't touched.
 *
 * The check is source-level rather than behavioural because:
 *   - the flag's effect is observable only on Windows;
 *   - GitHub Actions runs vitest on Linux for these tests;
 *   - regressing this is easy (every new spawn site has to remember
 *     the flag), and a runtime check on a Windows-only CI leg would
 *     still let a PR land on the main branch first.
 *
 * The pre-existing fix at ``src/core/lbug/extension-loader.ts:96``
 * established the convention. This test enforces it everywhere.
 */
describe('windowsHide regression', () => {
  // Hook-layer files. Adding a new hook file MUST be reflected here.
  const HOOK_FILES: Array<readonly [string, string]> = [
    ['gitnexus/hooks/claude/gitnexus-hook.cjs', CJS_HOOK],
    ['gitnexus/hooks/claude/resolve-analyze-cmd.cjs', RESOLVE_CJS],
    ['gitnexus-claude-plugin/hooks/resolve-analyze-cmd.cjs', RESOLVE_PLUGIN_CJS],
    [
      'gitnexus/hooks/antigravity/gitnexus-antigravity-hook.cjs',
      path.resolve(__dirname, '..', '..', 'hooks', 'antigravity', 'gitnexus-antigravity-hook.cjs'),
    ],
    [
      'gitnexus/hooks/claude/hook-db-lock-probe.cjs',
      path.resolve(__dirname, '..', '..', 'hooks', 'claude', 'hook-db-lock-probe.cjs'),
    ],
    ['gitnexus-claude-plugin/hooks/gitnexus-hook.js', PLUGIN_HOOK],
    [
      'gitnexus-claude-plugin/hooks/hook-db-lock-probe.cjs',
      path.resolve(
        __dirname,
        '..',
        '..',
        '..',
        'gitnexus-claude-plugin',
        'hooks',
        'hook-db-lock-probe.cjs',
      ),
    ],
    [
      'gitnexus-cursor-integration/hooks/gitnexus-hook.cjs',
      path.resolve(
        __dirname,
        '..',
        '..',
        '..',
        'gitnexus-cursor-integration',
        'hooks',
        'gitnexus-hook.cjs',
      ),
    ],
  ];

  // Source-tree files. Every file that imports a spawn-family
  // function from ``child_process`` belongs here. Discovered via
  //   grep -rn "from 'child_process'" -- gitnexus/src/
  // plus the explicit ``await import('child_process')`` callers in
  // local-backend.ts.
  const SRC_FILES: Array<readonly [string, string]> = [
    [
      'gitnexus/src/cli/analyze.ts',
      path.resolve(__dirname, '..', '..', 'src', 'cli', 'analyze.ts'),
    ],
    ['gitnexus/src/cli/setup.ts', path.resolve(__dirname, '..', '..', 'src', 'cli', 'setup.ts')],
    ['gitnexus/src/cli/wiki.ts', path.resolve(__dirname, '..', '..', 'src', 'cli', 'wiki.ts')],
    [
      'gitnexus/src/core/embeddings/onnxruntime-node-resolver.ts',
      path.resolve(
        __dirname,
        '..',
        '..',
        'src',
        'core',
        'embeddings',
        'onnxruntime-node-resolver.ts',
      ),
    ],
    [
      'gitnexus/src/core/git-staleness.ts',
      path.resolve(__dirname, '..', '..', 'src', 'core', 'git-staleness.ts'),
    ],
    [
      'gitnexus/src/core/lbug/extension-loader.ts',
      path.resolve(__dirname, '..', '..', 'src', 'core', 'lbug', 'extension-loader.ts'),
    ],
    [
      'gitnexus/src/core/run-analyze.ts',
      path.resolve(__dirname, '..', '..', 'src', 'core', 'run-analyze.ts'),
    ],
    [
      'gitnexus/src/core/wiki/cursor-client.ts',
      path.resolve(__dirname, '..', '..', 'src', 'core', 'wiki', 'cursor-client.ts'),
    ],
    [
      'gitnexus/src/core/wiki/generator.ts',
      path.resolve(__dirname, '..', '..', 'src', 'core', 'wiki', 'generator.ts'),
    ],
    [
      'gitnexus/src/mcp/local/local-backend.ts',
      path.resolve(__dirname, '..', '..', 'src', 'mcp', 'local', 'local-backend.ts'),
    ],
    [
      'gitnexus/src/server/git-clone.ts',
      path.resolve(__dirname, '..', '..', 'src', 'server', 'git-clone.ts'),
    ],
    // New post-upstream-merge (May 2026 sync):
    [
      'gitnexus/src/storage/git.ts',
      path.resolve(__dirname, '..', '..', 'src', 'storage', 'git.ts'),
    ],
  ];

  /**
   * Strip pure-comment lines so prose mentions of ``spawn`` /
   * ``exec`` don't inflate the call count.
   */
  function stripComments(source: string): string {
    return source
      .split('\n')
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');
  }

  /**
   * Count spawn-family invocations. The regex matches ``spawn(``,
   * ``spawnSync(``, ``execFile(``, ``execFileSync(``,
   * ``execFileAsync(``, ``execSync(`` as function calls — not
   * destructures (``const { spawn } = ...``), not method calls
   * (``.exec(``), not bare ``exec()`` (which collides with regex
   * ``.exec()``; we explicitly drop it).
   */
  function countSpawnCalls(codeSource: string): number {
    const re =
      /(^|[^a-zA-Z0-9_$.])(spawn|spawnSync|execFile|execFileSync|execFileAsync|execSync)\s*\(/gm;
    let count = 0;
    while (re.exec(codeSource) !== null) {
      count++;
    }
    return count;
  }

  for (const [label, file] of [...HOOK_FILES, ...SRC_FILES]) {
    it(`${label}: every spawn-family options object contains windowsHide: true`, () => {
      // The file must exist — silent-skip would mask a deletion.
      expect(fs.existsSync(file)).toBe(true);
      const source = fs.readFileSync(file, 'utf-8');
      const codeSource = stripComments(source);

      const spawnCount = countSpawnCalls(codeSource);
      const hideCount = (codeSource.match(/windowsHide\s*:\s*true/g) ?? []).length;

      // Sanity: catch a refactor that accidentally deletes every
      // spawn call (which would otherwise make the equality below
      // trivially true at 0 == 0).
      expect(spawnCount).toBeGreaterThan(0);
      // One windowsHide per spawn-family call. We don't try to
      // match brace structure — a same-count proxy is sufficient
      // because every spawn site in these files passes an options
      // object literal (no helper indirection).
      expect(hideCount).toBe(spawnCount);
    });
  }
});

// ─── Source code regression: .cmd extensions for Windows ─────────────

describe('Windows .cmd extension handling', () => {
  for (const [label, hookPath] of [
    ['CJS', CJS_HOOK],
    ['Plugin', PLUGIN_HOOK],
  ] as const) {
    it(`${label} hook uses .cmd extensions for Windows npx`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      expect(source).toContain('npx.cmd');
    });
  }

  it('Plugin hook uses .cmd extension for Windows gitnexus binary', () => {
    const source = fs.readFileSync(PLUGIN_HOOK, 'utf-8');
    expect(source).toContain('gitnexus.cmd');
  });
});

// ─── Source code regression: cwd validation ─────────────────────────

describe('cwd validation guards', () => {
  for (const [label, hookPath] of [
    ['CJS', CJS_HOOK],
    ['Plugin', PLUGIN_HOOK],
  ] as const) {
    it(`${label} hook validates cwd is absolute path`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      const cwdChecks = (source.match(/path\.isAbsolute\(cwd\)/g) || []).length;
      // Should have at least 2 checks (one in PreToolUse, one in PostToolUse)
      expect(cwdChecks).toBeGreaterThanOrEqual(2);
    });
  }
});

// ─── Source code regression: sendHookResponse used consistently ──────

describe('sendHookResponse consistency', () => {
  for (const [label, hookPath] of [
    ['CJS', CJS_HOOK],
    ['Plugin', PLUGIN_HOOK],
  ] as const) {
    it(`${label} hook uses sendHookResponse in both handlers`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      const calls = (source.match(/sendHookResponse\(/g) || []).length;
      // At least 3: definition + PreToolUse call + PostToolUse call
      expect(calls).toBeGreaterThanOrEqual(3);
    });

    it(`${label} hook does not inline hookSpecificOutput JSON in handlers`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      // Count inline hookSpecificOutput usage (should only be in sendHookResponse definition)
      const inlineCount = (source.match(/hookSpecificOutput/g) || []).length;
      // Exactly 1 occurrence: inside the sendHookResponse function body
      expect(inlineCount).toBe(1);
    });
  }
});

// ─── Source code regression: dispatch map pattern ────────────────────

describe('Dispatch map pattern', () => {
  for (const [label, hookPath] of [
    ['CJS', CJS_HOOK],
    ['Plugin', PLUGIN_HOOK],
  ] as const) {
    it(`${label} hook uses dispatch map instead of if/else`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      expect(source).toContain('const handlers = {');
      expect(source).toContain('PreToolUse: handlePreToolUse');
      expect(source).toContain('PostToolUse: handlePostToolUse');
      // Should NOT have if/else dispatch in main()
      expect(source).not.toMatch(/if\s*\(hookEvent\s*===\s*'PreToolUse'\)/);
    });
  }
});

// ─── Source code regression: debug error truncation ──────────────────

describe('Debug error message truncation', () => {
  for (const [label, hookPath] of [
    ['CJS', CJS_HOOK],
    ['Plugin', PLUGIN_HOOK],
  ] as const) {
    it(`${label} hook truncates error messages to 200 chars`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      expect(source).toContain('.slice(0, 200)');
    });
  }
});

// ─── extractPattern regression (via source analysis) ────────────────

describe('extractPattern coverage', () => {
  for (const [label, hookPath] of [
    ['CJS', CJS_HOOK],
    ['Plugin', PLUGIN_HOOK],
  ] as const) {
    it(`${label} hook extracts pattern from Grep tool input`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      expect(source).toContain("toolName === 'Grep'");
      expect(source).toContain('toolInput.pattern');
    });

    it(`${label} hook extracts pattern from Glob tool input`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      expect(source).toContain("toolName === 'Glob'");
    });

    it(`${label} hook extracts pattern from Bash grep/rg commands`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      expect(source).toMatch(/\\brg\\b.*\\bgrep\\b/);
    });

    it(`${label} hook rejects patterns shorter than 3 chars`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      expect(source).toContain('cleaned.length >= 3');
    });
  }
});

// ─── PostToolUse: git mutation regex coverage ───────────────────────

describe('Git mutation regex', () => {
  const GIT_REGEX = /\\bgit\\s\+\(commit\|merge\|rebase\|cherry-pick\|pull\)/;

  for (const [label, hookPath] of [
    ['CJS', CJS_HOOK],
    ['Plugin', PLUGIN_HOOK],
  ] as const) {
    it(`${label} hook detects git commit`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      expect(source).toContain('commit');
    });

    it(`${label} hook detects git merge`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      expect(source).toContain('merge');
    });

    it(`${label} hook detects git rebase`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      expect(source).toContain('rebase');
    });

    it(`${label} hook detects git cherry-pick`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      expect(source).toContain('cherry-pick');
    });

    it(`${label} hook detects git pull`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      // 'pull' in the regex alternation
      expect(source).toMatch(/commit\|merge\|rebase\|cherry-pick\|pull/);
    });
  }
});

// ─── Source code regression: PreToolUse concurrency guard (#1486) ──

describe('PreToolUse concurrency guard', () => {
  for (const [label, hookPath, lockPath] of [
    ['CJS', CJS_HOOK, CJS_HOOK_LOCK],
    ['Plugin', PLUGIN_HOOK, PLUGIN_HOOK_LOCK],
  ] as const) {
    it(`${label} hook loads acquireHookSlot helper`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      expect(source).toContain('acquireHookSlot');
      expect(source).toContain('hook-lock');
    });

    it(`${label} helper defines acquireHookSlot`, () => {
      const source = fs.readFileSync(lockPath, 'utf-8');
      expect(source).toContain('function acquireHookSlot');
      expect(source).toContain('HOOK_LOCK_MAX_INFLIGHT');
    });

    it(`${label} hook calls acquireHookSlot in handlePreToolUse`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      const preBody = source.slice(
        source.indexOf('function handlePreToolUse'),
        source.indexOf('function handlePostToolUse'),
      );
      expect(preBody).toContain('acquireHookSlot(');
      expect(preBody).toMatch(/release\(\)/);
    });

    it(`${label} hook uses atomic fixed-name slot files (hard cap)`, () => {
      // Regression for the TOCTOU soft-cap: an earlier revision counted
      // entries then wrote a per-pid lock, which let simultaneous bursts
      // exceed MAX_INFLIGHT. The hard-cap version writes to fixed-name
      // slot-N.lock paths so O_CREAT|O_EXCL is atomic across processes.
      const source = fs.readFileSync(lockPath, 'utf-8');
      expect(source).toMatch(/slot-\$\{slot\}\.lock|`slot-/);
      // And no longer reads the lock dir to count active hooks.
      const slotFn = source.slice(
        source.indexOf('function acquireHookSlot'),
        source.indexOf('function', source.indexOf('function acquireHookSlot') + 1),
      );
      expect(slotFn).not.toContain('readdirSync');
    });

    it(`${label} hook fails closed when lock dir cannot be created`, () => {
      // Regression: an earlier revision returned `() => {}` (truthy no-op) on
      // mkdirSync failure, which left callers — `if (!release) return;` — to
      // proceed unguarded and reintroduce the #1486 fan-out on read-only or
      // cross-user `.gitnexus/` setups. The guard must fail closed (null).
      const source = fs.readFileSync(lockPath, 'utf-8');
      const slotFn = source.slice(
        source.indexOf('function acquireHookSlot'),
        source.indexOf('function', source.indexOf('function acquireHookSlot') + 1),
      );
      const mkdirCatch = slotFn.slice(
        slotFn.indexOf('fs.mkdirSync(lockDir'),
        slotFn.indexOf('const myPidStr'),
      );
      expect(mkdirCatch).toContain('return null');
      expect(mkdirCatch).not.toMatch(/return\s*\(\s*\)\s*=>\s*\{\s*\}/);
    });
  }
});

// ─── Integration: concurrency guard skips when slots are full ──────

// The burst tests spawn real child processes; under CI load a child can exit
// before printing its decision even though the slot hard cap still holds.
describe('PreToolUse concurrency guard (integration)', { retry: 1 }, () => {
  for (const [label, hookPath] of [
    ['CJS', CJS_HOOK],
    ['Plugin', PLUGIN_HOOK],
  ] as const) {
    it(`${label}: hook exits silently when all MAX_INFLIGHT slots hold live pids`, async () => {
      const { spawn } = await import('child_process');
      const lockDir = path.join(gitNexusDir, '.hook-locks');
      fs.mkdirSync(lockDir, { recursive: true });

      // Spawn 3 long-sleeping node child processes to use as live PIDs.
      const sleepers = [0, 1, 2].map(() =>
        spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], {
          stdio: 'ignore',
          detached: false,
        }),
      );
      const writtenLocks: string[] = [];
      try {
        for (let i = 0; i < sleepers.length; i++) {
          // Slot files are named slot-N.lock; content is the owning PID.
          const p = path.join(lockDir, `slot-${i}.lock`);
          fs.writeFileSync(p, String(sleepers[i].pid));
          writtenLocks.push(p);
        }

        const result = runHook(hookPath, {
          hook_event_name: 'PreToolUse',
          tool_name: 'Grep',
          tool_input: { pattern: 'validateUser' },
          cwd: tmpDir,
        });

        expect(result.stdout.trim()).toBe('');
        // Sentinel slot files survive; the hook bailed before claiming any of them.
        for (let i = 0; i < sleepers.length; i++) {
          const p = path.join(lockDir, `slot-${i}.lock`);
          expect(fs.existsSync(p)).toBe(true);
          // Owner unchanged.
          expect(fs.readFileSync(p, 'utf-8').trim()).toBe(String(sleepers[i].pid));
        }
      } finally {
        for (const child of sleepers) {
          try {
            child.kill();
          } catch {
            /* ignore */
          }
        }
        for (const p of writtenLocks) {
          try {
            fs.unlinkSync(p);
          } catch {
            /* ignore */
          }
        }
        try {
          fs.rmdirSync(lockDir);
        } catch {
          /* ignore */
        }
      }
    });

    it(`${label}: hook reclaims a slot held by a dead pid`, () => {
      const lockDir = path.join(gitNexusDir, '.hook-locks');
      fs.mkdirSync(lockDir, { recursive: true });
      // PID 1 exists on every POSIX system (init); on Windows process.kill(1,0)
      // throws. Use a definitely-dead PID instead: a very large number unlikely
      // to be assigned.
      const deadPid = 2_147_483_640;
      const stalePath = path.join(lockDir, 'slot-0.lock');
      try {
        fs.writeFileSync(stalePath, String(deadPid));
        expect(fs.readFileSync(stalePath, 'utf-8').trim()).toBe(String(deadPid));

        runHook(hookPath, {
          hook_event_name: 'PreToolUse',
          tool_name: 'Grep',
          tool_input: { pattern: 'validateUser' },
          cwd: tmpDir,
        });

        // The hook reclaimed and then released slot-0 — either the file is
        // gone (released) or its content is something other than the dead PID.
        if (fs.existsSync(stalePath)) {
          expect(fs.readFileSync(stalePath, 'utf-8').trim()).not.toBe(String(deadPid));
        }
      } finally {
        try {
          fs.unlinkSync(stalePath);
        } catch {
          /* already pruned */
        }
        try {
          fs.rmdirSync(lockDir);
        } catch {
          /* ignore */
        }
      }
    });

    it(`${label}: hook does not exceed MAX_INFLIGHT under simultaneous bursts (hard cap)`, async () => {
      // Spawn many hook processes concurrently and assert that at most
      // MAX_INFLIGHT (3) slot files end up populated by live pids. The
      // O_CREAT|O_EXCL slot scheme makes this a hard cap, not the soft cap
      // that the count-then-claim approach gives.
      const { spawn } = await import('child_process');
      const lockDir = path.join(gitNexusDir, '.hook-locks');
      // Clean any leftover slot files.
      try {
        for (const f of fs.readdirSync(lockDir)) fs.unlinkSync(path.join(lockDir, f));
      } catch {
        /* dir may not exist yet */
      }
      fs.mkdirSync(lockDir, { recursive: true });

      // We use child workers that just claim a slot via the same algorithm
      // and then sleep, so we can observe the on-disk state under contention
      // without spawning the real gitnexus augment CLI.
      const claimerScript = `
        const fs = require('fs'); const path = require('path');
        const lockDir = ${JSON.stringify(lockDir)};
        const MAX = 3;
        const STALE = 30000;
        const myPid = String(process.pid);
        function tryAcquire() {
          for (let slot = 0; slot < MAX; slot++) {
            const p = path.join(lockDir, 'slot-' + slot + '.lock');
            for (let a = 0; a < 2; a++) {
              try { fs.writeFileSync(p, myPid, { flag: 'wx' }); return p; }
              catch {
                let stat; try { stat = fs.statSync(p); } catch { continue; }
                let live = false;
                try {
                  const s = fs.readFileSync(p, 'utf-8').trim();
                  if (s === '') live = true;
                  else { const o = Number.parseInt(s, 10);
                    if (Number.isFinite(o) && o > 0) { try { process.kill(o, 0); live = true; } catch {} }
                  }
                } catch {}
                if (live && Date.now() - stat.mtimeMs > STALE) live = false;
                if (live) break;
                try { fs.unlinkSync(p); } catch {}
              }
            }
          }
          return null;
        }
        const claimed = tryAcquire();
        if (claimed) {
          process.stdout.write('CLAIMED:' + claimed + '\\n');
          setTimeout(() => {}, 5000);
        } else {
          process.stdout.write('SKIPPED\\n');
        }
      `;

      const N = 10;
      const claimers = Array.from({ length: N }, () =>
        spawn(process.execPath, ['-e', claimerScript], {
          stdio: ['ignore', 'pipe', 'ignore'],
          detached: false,
        }),
      );
      try {
        // Wait until every claimer has printed its decision.
        const decisions = await Promise.all(
          claimers.map(
            (c) =>
              new Promise<string>((resolve) => {
                let buf = '';
                c.stdout!.on('data', (d) => {
                  buf += d.toString();
                  if (buf.includes('\n')) resolve(buf.split('\n')[0]);
                });
                c.on('exit', () => resolve(buf.split('\n')[0] || 'EXIT'));
              }),
          ),
        );
        const claimedCount = decisions.filter((d) => d.startsWith('CLAIMED:')).length;
        const skippedCount = decisions.filter((d) => d === 'SKIPPED').length;

        // HARD CAP: never more than 3 winners, regardless of how many bursts.
        expect(claimedCount).toBeLessThanOrEqual(3);
        // And the remainder must have all explicitly skipped.
        expect(claimedCount + skippedCount).toBe(N);

        // On-disk state matches.
        const liveSlots = fs
          .readdirSync(lockDir)
          .filter((f) => /^slot-\d+\.lock$/.test(f))
          .filter((f) => {
            try {
              const o = Number.parseInt(fs.readFileSync(path.join(lockDir, f), 'utf-8').trim(), 10);
              return Number.isFinite(o) && o > 0;
            } catch {
              return false;
            }
          });
        expect(liveSlots.length).toBeLessThanOrEqual(3);
      } finally {
        for (const c of claimers) {
          try {
            c.kill();
          } catch {
            /* ignore */
          }
        }
        try {
          for (const f of fs.readdirSync(lockDir)) fs.unlinkSync(path.join(lockDir, f));
        } catch {
          /* ignore */
        }
        try {
          fs.rmdirSync(lockDir);
        } catch {
          /* ignore */
        }
      }
    });
  }
});

// ─── Source: cross-platform DB lock probe module (#1493) ─────────────

describe('Cross-platform DB lock probe (source)', () => {
  for (const [label, hookPath, probePath] of [
    ['CJS', CJS_HOOK, CJS_HOOK_DB_PROBE],
    ['Plugin', PLUGIN_HOOK, PLUGIN_HOOK_DB_PROBE],
  ] as const) {
    it(`${label} probe file exists`, () => {
      expect(fs.existsSync(probePath)).toBe(true);
    });

    it(`${label} hook requires hook-db-lock-probe.cjs`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      expect(source).toContain("require('./hook-db-lock-probe.cjs')");
    });

    it(`${label} probe covers Linux /proc, Unix lsof, and Windows Restart Manager`, () => {
      const p = fs.readFileSync(probePath, 'utf-8');
      expect(p).toContain('win-rm-list-json.ps1');
      expect(p).toContain('/proc/');
      expect(p).toContain('linuxProcScanFindGitNexusServer');
      expect(p).toContain('unixLsofPsFindGitNexusServer');
      expect(p).toContain('hasGitNexusServerOwnerWindows');
      expect(p).toContain('GITNEXUS_HOOK_LSOF_PATH');
      expect(p).toContain('GITNEXUS_HOOK_POWERSHELL_PATH');
      expect(p).toContain('GITNEXUS_HOOK_LINUX_PROC_BUDGET_MS');
      // #2163: lsof/ps orphan containment via a self-tested coreutils
      // timeout/gtimeout wrapper.
      expect(p).toContain('GITNEXUS_HOOK_TIMEOUT_PATH');
      expect(p).toContain('resolveUnixGuardTimeout');
    });
  }

  // T5 (#2163): the two probe copies were only kept in sync by convention
  // (setup.ts copies the canonical gitnexus/hooks/claude/ file; the plugin
  // ships its own). Enforce byte-parity in CI, mirroring the
  // resolve-analyze-cmd.cjs parity test. `.gitattributes` pins `eol=lf`
  // repo-wide, so the byte comparison is safe on the Windows lane too.
  it('keeps the two hook-db-lock-probe.cjs copies byte-identical', () => {
    expect(fs.readFileSync(CJS_HOOK_DB_PROBE, 'utf-8')).toBe(
      fs.readFileSync(PLUGIN_HOOK_DB_PROBE, 'utf-8'),
    );
  });
});

// ─── Source: hook slot must gate the DB-owner probe (#2163) ──────────

describe('Hook slot gates the DB-owner probe (source order, #2163)', () => {
  const ANTIGRAVITY_HOOK = path.resolve(
    __dirname,
    '..',
    '..',
    'hooks',
    'antigravity',
    'gitnexus-antigravity-hook.cjs',
  );

  // T1: pin cheap guards → acquireHookSlot → probe. The probe spawns lsof/ps,
  // so it must sit BEHIND the per-repo slot cap; and the acquire must stay
  // AFTER the cheap gating (extractPattern), or every tool call churns slot
  // files. The antigravity adapter splits the cheap gating (extractPattern in
  // buildAfterToolContext) from probe+augment (runAugment), so its slice
  // spans both functions to express the same call-order contract.
  for (const [label, hookPath, sliceStart, sliceEnd] of [
    ['CJS', CJS_HOOK, 'function handlePreToolUse', 'function handlePostToolUse'],
    ['Plugin', PLUGIN_HOOK, 'function handlePreToolUse', 'function handlePostToolUse'],
    [
      'Antigravity',
      ANTIGRAVITY_HOOK,
      'function buildAfterToolContext',
      'function buildStaleIndexHint',
    ],
  ] as const) {
    it(`${label}: extractPattern → acquireHookSlot → hasGitNexusServerOwner`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      const start = source.indexOf(sliceStart);
      const end = source.indexOf(sliceEnd);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      const slice = source.slice(start, end);
      const patternIdx = slice.indexOf('extractPattern(');
      const acquireIdx = slice.indexOf('acquireHookSlot(');
      const probeIdx = slice.indexOf('hasGitNexusServerOwner(');
      expect(patternIdx).toBeGreaterThanOrEqual(0);
      expect(acquireIdx).toBeGreaterThan(patternIdx);
      expect(probeIdx).toBeGreaterThan(acquireIdx);
    });
  }
});

// ─── Behavior: slot-gated probe + wrapper-reaped orphans (#2163) ─────

describe.skipIf(process.platform === 'win32')(
  'DB-owner probe is gated behind the hook slot (behavior, #2163)',
  () => {
    for (const [label, hookPath] of [
      ['CJS', CJS_HOOK],
      ['Plugin', PLUGIN_HOOK],
    ] as const) {
      it(`${label}: when all slots are full, the lsof probe never runs`, async () => {
        const { spawn } = await import('child_process');
        const lockDir = path.join(gitNexusDir, '.hook-locks');
        fs.mkdirSync(lockDir, { recursive: true });
        // REQUIRED: the probe's first guard is
        // `if (!fs.existsSync(dbPath)) return false;` — without a real lbug
        // file the probe never reaches lsof even before the fix and this
        // test would pass vacuously.
        const lbugPath = path.join(gitNexusDir, 'lbug');
        fs.writeFileSync(lbugPath, '');
        const lsofMarkerPath = path.join(os.tmpdir(), `gn-hook-slotgate-${process.pid}-${label}`);
        fs.rmSync(lsofMarkerPath, { force: true });
        const binDir = createHookToolDir({
          lsofMarkerPath,
          lsofOutput: '12345\n',
          psOutput: 'node /tmp/node_modules/.bin/gitnexus mcp\n',
        });

        // Fill all 3 slots with live sleeper PIDs (same pattern as the
        // concurrency-guard integration tests above).
        const sleepers = [0, 1, 2].map(() =>
          spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], {
            stdio: 'ignore',
            detached: false,
          }),
        );
        const writtenLocks: string[] = [];
        try {
          for (let i = 0; i < sleepers.length; i++) {
            const p = path.join(lockDir, `slot-${i}.lock`);
            fs.writeFileSync(p, String(sleepers[i].pid));
            writtenLocks.push(p);
          }

          const result = runHook(
            hookPath,
            {
              hook_event_name: 'PreToolUse',
              tool_name: 'Grep',
              tool_input: { pattern: 'validateUser' },
              cwd: tmpDir,
            },
            undefined,
            {
              env: {
                ...hookEnv(binDir),
                // The slot gate rejects this invocation before the probe runs
                // at all, so this budget never actually bounds a scan — it is
                // set low only to keep the test fast in the (asserted-absent)
                // case the gate ever regressed and let the probe through.
                GITNEXUS_HOOK_LINUX_PROC_BUDGET_MS: '1',
              },
            },
          );

          expect(result.stdout.trim()).toBe('');
          // Core assertion: the probe (and therefore its lsof child) never
          // ran — the slot gate now sits in front of it. Before the fix the
          // probe ran un-gated and the marker existed.
          expect(fs.existsSync(lsofMarkerPath)).toBe(false);
        } finally {
          for (const child of sleepers) {
            try {
              child.kill();
            } catch {
              /* ignore */
            }
          }
          for (const p of writtenLocks) {
            try {
              fs.unlinkSync(p);
            } catch {
              /* ignore */
            }
          }
          try {
            fs.rmdirSync(lockDir);
          } catch {
            /* ignore */
          }
          fs.rmSync(lbugPath, { force: true });
          fs.rmSync(lsofMarkerPath, { force: true });
          fs.rmSync(binDir, { recursive: true, force: true });
        }
      });
    }

    // F5-3 (#2165 review): behavior-level slot-gate coverage for the
    // ANTIGRAVITY adapter (the loop above only covers CJS/Plugin; the
    // antigravity copy was pinned at source level only). The source adapter
    // requires sibling helpers that live in hooks/claude/ — it is designed to
    // be installed by copy (see the antigravity e2e suite) — so stage adapter
    // + helpers into a temp dir and spawn that copy directly.
    it('Antigravity: when all slots are full, the lsof probe never runs', async () => {
      const { spawn } = await import('child_process');
      const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-antigravity-stage-'));
      const antigravitySrc = path.resolve(
        __dirname,
        '..',
        '..',
        'hooks',
        'antigravity',
        'gitnexus-antigravity-hook.cjs',
      );
      const claudeHooksDir = path.resolve(__dirname, '..', '..', 'hooks', 'claude');
      const stagedHook = path.join(stageDir, 'gitnexus-antigravity-hook.cjs');
      fs.copyFileSync(antigravitySrc, stagedHook);
      for (const helper of [
        'hook-lock.cjs',
        'hook-db-lock-probe.cjs',
        'resolve-analyze-cmd.cjs',
        'win-rm-list-json.ps1',
      ]) {
        fs.copyFileSync(path.join(claudeHooksDir, helper), path.join(stageDir, helper));
      }

      const lockDir = path.join(gitNexusDir, '.hook-locks');
      fs.mkdirSync(lockDir, { recursive: true });
      // REQUIRED: without a real lbug file the probe never reaches lsof even
      // before the fix and this test would pass vacuously.
      const lbugPath = path.join(gitNexusDir, 'lbug');
      fs.writeFileSync(lbugPath, '');
      const lsofMarkerPath = path.join(os.tmpdir(), `gn-hook-slotgate-${process.pid}-antigravity`);
      fs.rmSync(lsofMarkerPath, { force: true });
      const binDir = createHookToolDir({
        lsofMarkerPath,
        lsofOutput: '12345\n',
        psOutput: 'node /tmp/node_modules/.bin/gitnexus mcp\n',
      });

      const sleepers = [0, 1, 2].map(() =>
        spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], {
          stdio: 'ignore',
          detached: false,
        }),
      );
      const writtenLocks: string[] = [];
      try {
        for (let i = 0; i < sleepers.length; i++) {
          const p = path.join(lockDir, `slot-${i}.lock`);
          fs.writeFileSync(p, String(sleepers[i].pid));
          writtenLocks.push(p);
        }

        const result = runHook(
          stagedHook,
          {
            hook_event_name: 'AfterTool',
            tool_name: 'search_file_content',
            tool_input: { pattern: 'validateUser' },
            tool_response: { llmContent: '...' },
            cwd: tmpDir,
          },
          undefined,
          {
            env: {
              ...hookEnv(binDir),
              // '1', NOT '0' — see the CJS/Plugin slot-gate test above.
              GITNEXUS_HOOK_LINUX_PROC_BUDGET_MS: '1',
            },
          },
        );

        // Guards against a vacuous pass: if the staged copy crashes (e.g. a
        // future sibling require missing from the staging list), stdout is
        // empty and the marker absent for the wrong reason.
        expect(result.status).toBe(0);
        expect(result.stdout.trim()).toBe('');
        // Core assertion: the probe (and therefore its lsof child) never ran —
        // runAugment bailed at the slot gate before hasGitNexusServerOwner.
        expect(fs.existsSync(lsofMarkerPath)).toBe(false);
      } finally {
        for (const child of sleepers) {
          try {
            child.kill();
          } catch {
            /* ignore */
          }
        }
        for (const p of writtenLocks) {
          try {
            fs.unlinkSync(p);
          } catch {
            /* ignore */
          }
        }
        try {
          fs.rmdirSync(lockDir);
        } catch {
          /* ignore */
        }
        fs.rmSync(lbugPath, { force: true });
        fs.rmSync(lsofMarkerPath, { force: true });
        fs.rmSync(binDir, { recursive: true, force: true });
        fs.rmSync(stageDir, { recursive: true, force: true });
      }
    });
  },
);

// ─── #2180: the probe no longer spawns lsof on Linux ───────────────
//
// The 'Orphaned lsof is reaped by the timeout wrapper (#2163)' suite that
// lived here (T3 + the env-guard-points-at-a-directory fall-through test)
// drove the Linux probe to spawn a SIGTERM-immune fake lsof and asserted the
// coreutils `timeout -k 1` wrapper reaped it after the hook was SIGKILLed.
// #2180 replaced the O(procs×fds) scan + lsof fallback with a pure cmdline-
// first procfs scan and DELETED the Linux lsof leg entirely, so the probe can
// no longer create an lsof orphan on Linux by construction — there is nothing
// left for those tests to exercise. The wrapper-reaping mechanism they pinned
// is still covered where it still applies: the augment CLI child (the
// direct-exec and npx-grandchild reaping suites below) and the macOS/other-
// Unix lsof+ps path (the `Ladybug DB owner guard` suite, now relaned off
// Linux). The env-guard fall-through self-test behaviour is still pinned by
// the bad-wrapper / dir-guard guard-resolution tests in that relaned suite.

// ─── Behavior: SIGKILLed hook cannot strand the augment CLI (#2163 f-up) ──

describe.skipIf(process.platform !== 'linux')(
  'Orphaned augment CLI is reaped by the timeout wrapper (#2163 follow-up)',
  () => {
    // Same incident mechanism as the lsof reaping suite above, one layer up:
    // the augment CLI is the longest-lived hook child (7s local / 12s npx
    // inner budgets), so a hook SIGKILLed mid-augment used to strand it with
    // nothing left to signal it. These tests pin GITNEXUS_HOOK_CLI_PATH, so
    // they exercise the DIRECT-EXEC branch only (the CLI is the guard's
    // direct child): the fake CLI here is SIGTERM-immune and sleeps 30s;
    // with the wrap in place the guard SIGTERMs it at 8s (= ceil(7000/1000)
    // +1) and the `-k` escalation SIGKILLs it 1s later, so it must be gone
    // well inside the 12s poll window. (The npx branch reaps differently —
    // `-s KILL` group-kills at budget because the CLI is a grandchild there;
    // see the staged npx suite below.) With runGitNexusCli's wrap reverted,
    // nothing can reap it and the poll times out → red. The antigravity
    // adapter shares the identical runGitNexusCli shape and is pinned at
    // source level (see 'Augment CLI guard wrap (source)').
    for (const [label, hookPath] of [
      ['CJS', CJS_HOOK],
      ['Plugin', PLUGIN_HOOK],
    ] as const) {
      it(`${label}: SIGKILLed hook leaves no immortal augment CLI child`, async () => {
        // Guard-availability precheck — see resolveHostGuardForReapingTests.
        expect(resolveHostGuardForReapingTests(), GUARD_PRECHECK_MSG).not.toBeNull();
        const { spawn } = await import('child_process');
        // REQUIRED: a real lbug file means the probe runs. #2180 removed the
        // Linux lsof fallback, so we route the probe at an EMPTY fake /proc
        // (no gitnexus server holding the fd → not-owned) so the augment runs
        // through the same probe-then-spawn flow as production. (Pre-#2180 this
        // used GITNEXUS_HOOK_LINUX_PROC_BUDGET_MS:'1' to fall through to a fake
        // lsof; that path no longer exists on Linux — a '1' budget now fails
        // CLOSED and would skip the augment entirely.)
        const lbugPath = path.join(gitNexusDir, 'lbug');
        fs.writeFileSync(lbugPath, '');
        const emptyProcRoot = createFakeProcRoot([]);
        const pidFile = path.join(os.tmpdir(), `gn-hook-clipid-${process.pid}-${label}`);
        fs.rmSync(pidFile, { force: true });
        const binDir = createHookToolDir({
          gitnexusPidFile: pidFile,
          gitnexusSleepMs: 30000,
          gitnexusIgnoreSigterm: true,
          lsofOutput: '',
          psOutput: '',
        });
        let cliPid = 0;
        let hookChild: ReturnType<typeof spawn> | null = null;

        const isFakeCliAlive = () => {
          try {
            process.kill(cliPid, 0);
          } catch {
            return false; // ESRCH — reaped
          }
          // PID-reuse guard: only count it alive while the cmdline still
          // points at our fake CLI.
          try {
            return fs.readFileSync(`/proc/${cliPid}/cmdline`, 'utf-8').includes(binDir);
          } catch {
            return false;
          }
        };

        try {
          hookChild = spawn(process.execPath, [hookPath], {
            stdio: ['pipe', 'ignore', 'ignore'],
            env: {
              ...hookEnv(binDir),
              // #2180: empty fake /proc → scan completes as not-owned → augment
              // runs (the path under test). Generous budget so the scan never
              // times out and fails closed.
              GITNEXUS_HOOK_PROC_ROOT: emptyProcRoot,
              GITNEXUS_HOOK_LINUX_PROC_BUDGET_MS: '5000',
              // Hermeticity: a dev-shell GITNEXUS_HOOK_TIMEOUT_PATH=disabled
              // would unwrap the CLI and fake-red this test. Empty string
              // falls through to the built-in candidates (the path under test).
              GITNEXUS_HOOK_TIMEOUT_PATH: '',
            },
          });
          hookChild.stdin!.end(
            JSON.stringify({
              hook_event_name: 'PreToolUse',
              tool_name: 'Grep',
              tool_input: { pattern: 'validateUser' },
              cwd: tmpDir,
            }),
          );

          // The fake CLI writes its PID as its FIRST statement; poll tightly.
          const spawnDeadline = Date.now() + 8000;
          while (Date.now() < spawnDeadline) {
            try {
              const raw = fs.readFileSync(pidFile, 'utf-8').trim();
              if (raw) {
                cliPid = Number.parseInt(raw, 10);
                break;
              }
            } catch {
              /* not written yet */
            }
            await new Promise((r) => setTimeout(r, 10));
          }
          expect(cliPid).toBeGreaterThan(0);

          // Kill the hook while its augment CLI child is alive.
          hookChild.kill('SIGKILL');

          // Wrapper budget for the 7000ms call site is 8s, plus 1s `-k`
          // grace — poll past that with margin, far short of the 30s sleep.
          const reapDeadline = Date.now() + 12000;
          let alive = isFakeCliAlive();
          while (alive && Date.now() < reapDeadline) {
            await new Promise((r) => setTimeout(r, 100));
            alive = isFakeCliAlive();
          }
          expect(alive).toBe(false);
        } finally {
          // PID-reuse guard (#2169 review): re-run the detection loop's
          // /proc/<pid>/cmdline identity check before the cleanup SIGKILL,
          // so a PID already reaped and recycled by the OS is never
          // signalled.
          if (cliPid > 0 && isFakeCliAlive()) {
            try {
              process.kill(cliPid, 'SIGKILL');
            } catch {
              /* already gone */
            }
          }
          try {
            hookChild?.kill('SIGKILL');
          } catch {
            /* ignore */
          }
          // The hook claims a slot before probing; it died holding it.
          const lockDir = path.join(gitNexusDir, '.hook-locks');
          try {
            for (const f of fs.readdirSync(lockDir)) fs.unlinkSync(path.join(lockDir, f));
          } catch {
            /* ignore */
          }
          try {
            fs.rmdirSync(lockDir);
          } catch {
            /* ignore */
          }
          fs.rmSync(lbugPath, { force: true });
          fs.rmSync(pidFile, { force: true });
          fs.rmSync(binDir, { recursive: true, force: true });
          fs.rmSync(emptyProcRoot, { recursive: true, force: true });
        }
      }, 30000);
    }
  },
);

// ─── Behavior: npx branch — SIGKILLed hook cannot strand the CLI grandchild ──

describe.skipIf(process.platform !== 'linux')(
  'Orphaned npx-branch CLI grandchild is reaped by the -s KILL wrapper (#2163 follow-up)',
  () => {
    // The npx branch has a DEEPER topology than the direct-exec suite above:
    // guard → npx → CLI, so the CLI is the guard's GRANDCHILD. Under the
    // TERM-first `-k 1` guard the budget's group SIGTERM kills the obedient
    // npx parent; `timeout` reaps its direct child and exits IMMEDIATELY, so
    // its `-k` SIGKILL never fires — and a SIGTERM-immune CLI grandchild
    // survives unbounded (reproduced on coreutils 9.x). The `-s KILL`
    // wrapped arm instead SIGKILLs the whole process group at budget
    // (13s = ceil((7000+5000)/1000)+1 here), which nothing can ignore.
    // Reverting the npx arm to plain `-k 1` TERM-first makes this test red.
    //
    // Topology notes: the hook is STAGED into a bare temp dir together with
    // its sibling helpers (the install-shaped copy, like the antigravity e2e
    // suite uses), so resolveCliPath() finds no local dist/ and no
    // resolvable gitnexus package; with GITNEXUS_HOOK_CLI_PATH cleared the
    // npx fallback branch is the one that runs. A fake `npx` injected on
    // PATH then spawns the SIGTERM-immune fake CLI as its own child and
    // waits on it, mirroring the real npx process tree.
    it('CJS (staged): SIGKILLed hook leaves no immortal CLI grandchild behind npx', async () => {
      // Guard-availability precheck — see resolveHostGuardForReapingTests.
      expect(resolveHostGuardForReapingTests(), GUARD_PRECHECK_MSG).not.toBeNull();
      const { spawn } = await import('child_process');
      // REQUIRED: a real lbug file means the probe runs. #2180 removed the
      // Linux lsof fallback, so we route the probe at an EMPTY fake /proc
      // (not-owned) so the augment runs through the same probe-then-spawn flow
      // as production. (Pre-#2180 this used BUDGET_MS:'1' to fall through to a
      // fake lsof; that path no longer exists on Linux.)
      const lbugPath = path.join(gitNexusDir, 'lbug');
      fs.writeFileSync(lbugPath, '');
      const emptyProcRoot = createFakeProcRoot([]);
      const pidFile = path.join(os.tmpdir(), `gn-hook-npxclipid-${process.pid}`);
      fs.rmSync(pidFile, { force: true });
      // Route self-proof (#2169 review): written by the fake npx as its first
      // statement, so the test fails loudly if a future resolveCliPath /
      // hookEnv change silently re-routes the augment to the direct arm.
      const npxMarkerPath = path.join(os.tmpdir(), `gn-hook-npxmarker-${process.pid}`);
      fs.rmSync(npxMarkerPath, { force: true });
      const binDir = createHookToolDir({
        gitnexusPidFile: pidFile,
        gitnexusSleepMs: 30000,
        gitnexusIgnoreSigterm: true,
        lsofOutput: '',
        psOutput: '',
      });
      // Fake npx: spawns the fake CLI as the guard's grandchild and waits on
      // it like real npx; npx itself stays SIGTERM-obedient (Node default).
      fs.writeFileSync(
        path.join(binDir, 'npx'),
        `#!/usr/bin/env node\n` +
          `require('fs').writeFileSync(${JSON.stringify(npxMarkerPath)}, String(process.pid));\n` +
          `const { spawn } = require('child_process');\n` +
          `const child = spawn(process.execPath, [${JSON.stringify(
            path.join(binDir, 'gitnexus-cli.js'),
          )}], { stdio: 'ignore' });\n` +
          `child.on('exit', (code) => process.exit(code === null ? 1 : code));\n`,
        { mode: 0o755 },
      );
      // Stage the hook + its sibling helpers into a bare dir with no dist/
      // and no reachable node_modules/gitnexus, so resolveCliPath() → ''.
      const stagedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-staged-hook-'));
      const hookSrcDir = path.dirname(CJS_HOOK);
      for (const f of [
        'gitnexus-hook.cjs',
        'hook-lock.cjs',
        'hook-db-lock-probe.cjs',
        'resolve-analyze-cmd.cjs',
      ]) {
        fs.copyFileSync(path.join(hookSrcDir, f), path.join(stagedDir, f));
      }
      const stagedHook = path.join(stagedDir, 'gitnexus-hook.cjs');
      let cliPid = 0;
      let hookChild: ReturnType<typeof spawn> | null = null;

      const isFakeCliAlive = () => {
        try {
          process.kill(cliPid, 0);
        } catch {
          return false; // ESRCH — reaped
        }
        // PID-reuse guard: only count it alive while the cmdline still
        // points at our fake CLI.
        try {
          return fs.readFileSync(`/proc/${cliPid}/cmdline`, 'utf-8').includes(binDir);
        } catch {
          return false;
        }
      };

      try {
        hookChild = spawn(process.execPath, [stagedHook], {
          stdio: ['pipe', 'ignore', 'ignore'],
          env: {
            ...hookEnv(binDir),
            // Force the npx fallback: no CLI-path override (empty string
            // fails resolveCliPath's trim check), and nothing for the staged
            // copy's require.resolve to find via NODE_PATH.
            GITNEXUS_HOOK_CLI_PATH: '',
            NODE_PATH: '',
            // #2180: empty fake /proc → not-owned → augment runs. Generous
            // budget so the scan completes rather than failing closed.
            GITNEXUS_HOOK_PROC_ROOT: emptyProcRoot,
            GITNEXUS_HOOK_LINUX_PROC_BUDGET_MS: '5000',
            // Hermeticity: fall through to the built-in guard candidates.
            GITNEXUS_HOOK_TIMEOUT_PATH: '',
          },
        });
        hookChild.stdin!.end(
          JSON.stringify({
            hook_event_name: 'PreToolUse',
            tool_name: 'Grep',
            tool_input: { pattern: 'validateUser' },
            cwd: tmpDir,
          }),
        );

        // The fake CLI writes its PID as its FIRST statement; poll tightly.
        const spawnDeadline = Date.now() + 8000;
        while (Date.now() < spawnDeadline) {
          try {
            const raw = fs.readFileSync(pidFile, 'utf-8').trim();
            if (raw) {
              cliPid = Number.parseInt(raw, 10);
              break;
            }
          } catch {
            /* not written yet */
          }
          await new Promise((r) => setTimeout(r, 10));
        }
        expect(cliPid).toBeGreaterThan(0);
        // The augment really took the npx fallback arm, not the direct arm.
        expect(fs.existsSync(npxMarkerPath)).toBe(true);

        // Kill the hook while the npx → CLI chain is alive (orphan topology).
        hookChild.kill('SIGKILL');

        // The npx call site's wrapper budget is 13s (= ceil((7000+5000)/
        // 1000)+1) from the guard's start; the group SIGKILL lands then.
        // Poll past it with margin, far short of the CLI's 30s sleep.
        const reapDeadline = Date.now() + 18000;
        let alive = isFakeCliAlive();
        while (alive && Date.now() < reapDeadline) {
          await new Promise((r) => setTimeout(r, 100));
          alive = isFakeCliAlive();
        }
        expect(alive).toBe(false);
      } finally {
        // PID-reuse guard (#2169 review): re-run the detection loop's
        // /proc/<pid>/cmdline identity check before the cleanup SIGKILL, so
        // a PID already reaped and recycled by the OS is never signalled.
        if (cliPid > 0 && isFakeCliAlive()) {
          try {
            process.kill(cliPid, 'SIGKILL');
          } catch {
            /* already gone */
          }
        }
        try {
          hookChild?.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        // The hook claims a slot before probing; it died holding it.
        const lockDir = path.join(gitNexusDir, '.hook-locks');
        try {
          for (const f of fs.readdirSync(lockDir)) fs.unlinkSync(path.join(lockDir, f));
        } catch {
          /* ignore */
        }
        try {
          fs.rmdirSync(lockDir);
        } catch {
          /* ignore */
        }
        fs.rmSync(lbugPath, { force: true });
        fs.rmSync(pidFile, { force: true });
        fs.rmSync(npxMarkerPath, { force: true });
        fs.rmSync(stagedDir, { recursive: true, force: true });
        fs.rmSync(binDir, { recursive: true, force: true });
        fs.rmSync(emptyProcRoot, { recursive: true, force: true });
      }
    }, 45000);
  },
);

// ─── Wrapping equivalence: disabled guard ⇒ pre-wrap augment behavior ──

describe.skipIf(process.platform === 'win32')(
  'Augment CLI guard wrap degrades cleanly when disabled (#2163 follow-up)',
  () => {
    // T6-style equivalence pin for the AUGMENT path: with the wrapper
    // explicitly off (the `disabled` sentinel, NOT a bogus path — invalid
    // values fall through to the real candidate list by design) the augment
    // path must behave exactly as it did before the wrap existed: the probe
    // fails open on an idle DB, the CLI runs unwrapped, and its context is
    // emitted verbatim. (The wrapped arm's equivalence is covered by the
    // whole existing augment suite, which now runs under the host's real
    // guard on the Linux/macOS lanes.)
    for (const [label, hookPath] of [
      ['CJS', CJS_HOOK],
      ['Plugin', PLUGIN_HOOK],
    ] as const) {
      it(`${label}: augment runs and emits context with the wrapper disabled`, () => {
        const markerPath = path.join(os.tmpdir(), `gn-hook-nowrap-aug-${process.pid}-${label}`);
        const lbugPath = path.join(gitNexusDir, 'lbug');
        fs.writeFileSync(lbugPath, '');
        fs.rmSync(markerPath, { force: true });
        const binDir = createHookToolDir({
          gitnexusMarkerPath: markerPath,
          gitnexusStderr: '[GitNexus] 1 related symbol found:\n\nvalidateUser (src/auth.ts)\n',
          lsofOutput: '',
          psOutput: '',
        });
        try {
          const result = runHook(
            hookPath,
            {
              hook_event_name: 'PreToolUse',
              tool_name: 'Grep',
              tool_input: { pattern: 'validateUser' },
              cwd: tmpDir,
            },
            undefined,
            {
              env: {
                ...hookEnv(binDir),
                GITNEXUS_HOOK_TIMEOUT_PATH: 'disabled',
              },
            },
          );
          const output = parseHookOutput(result.stdout);
          expect(output).not.toBeNull();
          expect(output!.additionalContext).toContain('[GitNexus] 1 related symbol found');
          expect(fs.existsSync(markerPath)).toBe(true);
        } finally {
          fs.rmSync(lbugPath, { force: true });
          fs.rmSync(markerPath, { force: true });
          fs.rmSync(binDir, { recursive: true, force: true });
        }
      });
    }
  },
);

// ─── Source: augment CLI guard wrap present in every adapter (#2163 f-up) ──

describe('Augment CLI guard wrap (source, #2163 follow-up)', () => {
  const ANTIGRAVITY_HOOK = path.resolve(
    __dirname,
    '..',
    '..',
    'hooks',
    'antigravity',
    'gitnexus-antigravity-hook.cjs',
  );

  // The cursor integration is deliberately ABSENT from this list: it does
  // not install hook-db-lock-probe.cjs (see gitnexus-cursor-integration/
  // README.md "What's installed manually vs. automated"), so there is no
  // resolver sibling to require — wrapping its augment child is the
  // "cursor probe" item on the #2163 follow-up list.
  for (const [label, hookPath] of [
    ['CJS', CJS_HOOK],
    ['Plugin', PLUGIN_HOOK],
    ['Antigravity', ANTIGRAVITY_HOOK],
  ] as const) {
    it(`${label}: runGitNexusCli wraps via resolveUnixGuardTimeout with a ceil(ms/1000)+1 budget`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      const start = source.indexOf('function runGitNexusCli');
      expect(start).toBeGreaterThanOrEqual(0);
      const end = source.indexOf('\nfunction ', start + 1);
      const fn = source.slice(start, end === -1 ? undefined : end);
      // Consults the probe's exported resolver (memo shared with the probe),
      // and never on Windows — the npx.cmd / gitnexus.cmd argv stay exactly
      // as before the wrap. The typeof check is the probe version-skew guard
      // (#2169 review): an old probe without the resolveUnixGuardTimeout
      // export must degrade to the unwrapped argv, not throw a TypeError
      // that the caller's catch swallows into a silently dead augment.
      expect(fn).toMatch(
        /isWin \|\| typeof resolveUnixGuardTimeout !== 'function'\s*\?\s*null\s*:\s*resolveUnixGuardTimeout\(\)/,
      );
      // Coreutils `-k 1` escalation…
      expect(fn).toContain("'-k',");
      // …with a budget STRICTLY above each branch's inner spawnSync timeout:
      // ceil(inner/1000)+1 for both the direct (timeout) and npx
      // (timeout + 5000) call sites. The direct-budget formula is counted
      // exactly — once per wrapped direct-exec branch (the Plugin adapter has
      // two: GITNEXUS_HOOK_CLI_PATH and the PATH-direct `gitnexus` branch,
      // its most common production path) — so a partial revert of any single
      // branch cannot pass unnoticed.
      const directBudgetCount = (fn.match(/Math\.ceil\(timeout \/ 1000\) \+ 1/g) ?? []).length;
      expect(directBudgetCount).toBe(label === 'Plugin' ? 2 : 1);
      expect(fn).toMatch(/Math\.ceil\(\(timeout \+ 5000\) \/ 1000\) \+ 1/);
      // Argv-order pin (#2169 review): the budget token must appear BEFORE
      // the command word — `timeout … <budget> <cmd>` — or coreutils would
      // parse the command word as its DURATION argument. Token presence and
      // the counts above alone would let a transposed argv pass. Every
      // direct-exec budget must be immediately followed by its command token
      // (process.execPath, or the PATH-direct 'gitnexus' on Plugin), and the
      // npx budget by 'npx'.
      const directOrderCount = (
        fn.match(
          /String\(Math\.ceil\(timeout \/ 1000\) \+ 1\),\s*(?:process\.execPath|'gitnexus')/g,
        ) ?? []
      ).length;
      expect(directOrderCount).toBe(label === 'Plugin' ? 2 : 1);
      expect(fn).toMatch(/String\(Math\.ceil\(\(timeout \+ 5000\) \/ 1000\) \+ 1\),\s*'npx'/);
      // npx-branch grandchild containment (#2169 review): the npx wrapped
      // arm must SIGKILL the process group at budget (`-s KILL`) — a group
      // SIGTERM there kills only the obedient npx parent, `timeout` returns
      // before its `-k` escalation fires, and a SIGTERM-immune CLI
      // grandchild escapes unbounded.
      expect(fn).toMatch(
        /'-s',\s*'KILL',\s*'-k',\s*'1',\s*String\(Math\.ceil\(\(timeout \+ 5000\)/,
      );
      // …and the direct-exec arm(s) must NOT lead with `-s KILL`: TERM-first
      // is gentler and sufficient there (the CLI is the guard's direct
      // child), so `-s` appears exactly once — in the npx arm.
      expect((fn.match(/'-s',/g) ?? []).length).toBe(1);
    });
  }

  for (const [label, probePath] of [
    ['CJS', CJS_HOOK_DB_PROBE],
    ['Plugin', PLUGIN_HOOK_DB_PROBE],
  ] as const) {
    it(`${label} probe exports resolveUnixGuardTimeout`, () => {
      const source = fs.readFileSync(probePath, 'utf-8');
      const exportsSlice = source.slice(source.indexOf('module.exports'));
      expect(exportsSlice).toContain('resolveUnixGuardTimeout');
    });
  }
});

// ─── Source: cursor hook slot-skip diagnostic (#2163 follow-up) ─────

describe('Cursor hook slot-skip diagnostic (source, #2163 follow-up)', () => {
  const CURSOR_HOOK = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    'gitnexus-cursor-integration',
    'hooks',
    'gitnexus-hook.cjs',
  );

  it('debug-gates the slot-saturated skip under the cursor truthy convention', () => {
    const source = fs.readFileSync(CURSOR_HOOK, 'utf-8');
    const idx = source.indexOf('augment skipped: hook slots saturated');
    expect(idx).toBeGreaterThanOrEqual(0);
    // Must sit inside the cursor hook's own debug gate (truthy
    // `process.env.GITNEXUS_DEBUG`, unlike the claude adapters' strict
    // '1'/'true' gate) so the default path stays silent.
    const before = source.slice(Math.max(0, idx - 600), idx);
    expect(before).toContain('process.env.GITNEXUS_DEBUG');
  });
});

// ─── Integration: PreToolUse augmentation filtering (#1492) ─────────

describe('PreToolUse augmentation filtering (integration)', () => {
  for (const [label, hookPath] of [
    ['CJS', CJS_HOOK],
    ['Plugin', PLUGIN_HOOK],
  ] as const) {
    it(`${label}: emits valid GitNexus augmentation context`, () => {
      const binDir = createHookToolDir({
        gitnexusStderr: '[GitNexus] 1 related symbol found:\n\nvalidateUser (src/auth.ts)\n',
      });
      try {
        const result = runHook(
          hookPath,
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'Grep',
            tool_input: { pattern: 'validateUser' },
            cwd: tmpDir,
          },
          undefined,
          { env: hookEnv(binDir) },
        );

        const output = parseHookOutput(result.stdout);
        expect(output).not.toBeNull();
        expect(output!.hookEventName).toBe('PreToolUse');
        expect(output!.additionalContext).toContain('[GitNexus] 1 related symbol found');
      } finally {
        fs.rmSync(binDir, { recursive: true, force: true });
      }
    });

    it(`${label}: suppresses LadybugDB lock warnings from augment stderr`, () => {
      const markerPath = path.join(os.tmpdir(), 'gn-hook-lockwarn-' + process.pid + '-' + label);
      fs.rmSync(markerPath, { force: true });
      const binDir = createHookToolDir({
        gitnexusMarkerPath: markerPath,
        gitnexusStderr:
          'GitNexus: FTS extension load failed: IO exception: Could not set lock on file : /tmp/repo/.gitnexus/lbug\n',
      });
      try {
        const result = runHook(
          hookPath,
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'Grep',
            tool_input: { pattern: 'validateUser' },
            cwd: tmpDir,
          },
          undefined,
          { env: hookEnv(binDir) },
        );

        expect(result.stdout.trim()).toBe('');
        expect(fs.existsSync(markerPath)).toBe(true);

        // Finding #18: when GITNEXUS_DEBUG=1 is set, the discarded prefix is
        // recoverable on the hook's stderr (not silently dropped).
        const debugResult = runHook(
          hookPath,
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'Grep',
            tool_input: { pattern: 'validateUser' },
            cwd: tmpDir,
          },
          undefined,
          { env: { ...hookEnv(binDir), GITNEXUS_DEBUG: '1' } },
        );
        expect(debugResult.stderr).toContain('augment stderr discarded prefix');
        expect(debugResult.stderr).toContain('Could not set lock on file');
      } finally {
        fs.rmSync(markerPath, { force: true });
        fs.rmSync(binDir, { recursive: true, force: true });
      }
    });

    // #2396: when a GitNexus MCP process owns the repo DB the CLI augment can't
    // run, so the hook hands the agent the MCP-query hint on stdout (the sanctioned
    // additionalContext channel). By default (GITNEXUS_DEBUG unset) the stderr skip
    // diagnostic stays silent, so strict hook runners (e.g. Codex `PreToolUse`) see
    // no unexpected diagnostic noise — only the augmentation itself (#1913). This is
    // the GITNEXUS_DEBUG='' owner-hint coverage; the debug variants are below.
    it.skipIf(SKIP_LSOF_PATH)(
      `${label}: emits the MCP-query hint on stdout, stderr silent by default, when a GitNexus MCP process owns the repo DB`,
      () => {
        const markerPath = path.join(os.tmpdir(), `gitnexus-hook-called-${process.pid}-${label}`);
        const lbugPath = path.join(gitNexusDir, 'lbug');
        fs.writeFileSync(lbugPath, '');
        fs.rmSync(markerPath, { force: true });
        const binDir = createHookToolDir({
          gitnexusMarkerPath: markerPath,
          lsofOutput: '12345\n',
          psOutput: 'node /tmp/node_modules/.bin/gitnexus mcp\n',
        });
        try {
          const result = runHook(
            hookPath,
            {
              hook_event_name: 'PreToolUse',
              tool_name: 'Grep',
              tool_input: { pattern: 'validateUser' },
              cwd: tmpDir,
            },
            undefined,
            { env: { ...hookEnv(binDir), GITNEXUS_DEBUG: '' } },
          );

          const output = parseHookOutput(result.stdout);
          expect(output!.additionalContext).toContain('mcp__gitnexus__query');
          expect(output!.additionalContext).toContain('validateUser');
          expect(result.stderr.trim()).toBe('');
          expect(result.status).toBe(0);
          expect(fs.existsSync(markerPath)).toBe(false);
        } finally {
          fs.rmSync(lbugPath, { force: true });
          fs.rmSync(markerPath, { force: true });
          fs.rmSync(binDir, { recursive: true, force: true });
        }
      },
    );

    // #2396: when the MCP server owns the DB the CLI augment can't run, so the
    // hook hands the agent an MCP-query hint on stdout (the sanctioned
    // additionalContext channel) instead of doing nothing. The CLI still never
    // spawns (marker absent). #1913: the stderr skip diagnostic stays gated
    // behind GITNEXUS_DEBUG.
    it.skipIf(SKIP_LSOF_PATH)(
      `${label}: MCP-owner path emits the MCP query hint; stderr reason gated by GITNEXUS_DEBUG`,
      () => {
        const markerPath = path.join(os.tmpdir(), `gitnexus-hook-dbg-${process.pid}-${label}`);
        const lbugPath = path.join(gitNexusDir, 'lbug');
        fs.writeFileSync(lbugPath, '');
        fs.rmSync(markerPath, { force: true });
        const binDir = createHookToolDir({
          gitnexusMarkerPath: markerPath,
          lsofOutput: '12345\n',
          psOutput: 'node /tmp/node_modules/.bin/gitnexus mcp\n',
        });
        try {
          const result = runHook(
            hookPath,
            {
              hook_event_name: 'PreToolUse',
              tool_name: 'Grep',
              tool_input: { pattern: 'validateUser' },
              cwd: tmpDir,
            },
            undefined,
            { env: { ...hookEnv(binDir), GITNEXUS_DEBUG: '1' } },
          );

          const output = parseHookOutput(result.stdout);
          expect(output!.additionalContext).toContain('mcp__gitnexus__query');
          expect(output!.additionalContext).toContain('validateUser');
          expect(result.status).toBe(0);
          expect(result.stderr).toContain('[GitNexus] augment skipped: MCP server owns DB');
          expect(fs.existsSync(markerPath)).toBe(false);
        } finally {
          fs.rmSync(lbugPath, { force: true });
          fs.rmSync(markerPath, { force: true });
          fs.rmSync(binDir, { recursive: true, force: true });
        }
      },
    );

    // #1913: the GITNEXUS_DEBUG contract is strict — ONLY '1' and 'true' enable
    // the stderr diagnostic. Pin that non-canonical truthy-looking values ('0',
    // 'false') are treated as OFF, so stderr stays silent. The #2396 MCP-query
    // hint on stdout is independent of GITNEXUS_DEBUG (it is the augmentation, not
    // a diagnostic) and must still be emitted here.
    for (const debugValue of ['0', 'false']) {
      it.skipIf(SKIP_LSOF_PATH)(
        `${label}: MCP-owner hint emits on stdout; stderr stays silent with GITNEXUS_DEBUG='${debugValue}'`,
        () => {
          const markerPath = path.join(
            os.tmpdir(),
            `gitnexus-hook-dbg-${debugValue}-${process.pid}-${label}`,
          );
          const lbugPath = path.join(gitNexusDir, 'lbug');
          fs.writeFileSync(lbugPath, '');
          fs.rmSync(markerPath, { force: true });
          const binDir = createHookToolDir({
            gitnexusMarkerPath: markerPath,
            lsofOutput: '12345\n',
            psOutput: 'node /tmp/node_modules/.bin/gitnexus mcp\n',
          });
          try {
            const result = runHook(
              hookPath,
              {
                hook_event_name: 'PreToolUse',
                tool_name: 'Grep',
                tool_input: { pattern: 'validateUser' },
                cwd: tmpDir,
              },
              undefined,
              { env: { ...hookEnv(binDir), GITNEXUS_DEBUG: debugValue } },
            );

            const output = parseHookOutput(result.stdout);
            expect(output!.additionalContext).toContain('mcp__gitnexus__query');
            expect(result.stderr.trim()).toBe('');
            expect(result.status).toBe(0);
            expect(fs.existsSync(markerPath)).toBe(false);
          } finally {
            fs.rmSync(lbugPath, { force: true });
            fs.rmSync(markerPath, { force: true });
            fs.rmSync(binDir, { recursive: true, force: true });
          }
        },
      );
    }
  }
});

// #2396: the owner-path hint is throttled to at most once per repo per window
// (GITNEXUS_MCP_HINT_THROTTLE_MS, default 10min) via a per-repo `.mcp-hint-shown`
// marker, so an owner-locked session isn't nudged on every search. macOS/other-
// Unix lsof+ps lane only (SKIP_LSOF_PATH), like the sibling owner tests. hookEnv
// sets the window to 0 (disabled) elsewhere for determinism; here we set a real
// window to exercise the throttle.
describe.skipIf(SKIP_LSOF_PATH)('MCP-owner hint throttle (#2396)', () => {
  for (const [label, hookPath] of [
    ['CJS', CJS_HOOK],
    ['Plugin', PLUGIN_HOOK],
  ] as const) {
    it(`${label}: emits once, then throttles within the window (marker gates it)`, () => {
      const markerPath = path.join(os.tmpdir(), `gn-hook-throttle-${process.pid}-${label}`);
      const lbugPath = path.join(gitNexusDir, 'lbug');
      const throttleMarker = path.join(gitNexusDir, '.mcp-hint-shown');
      fs.writeFileSync(lbugPath, '');
      fs.rmSync(markerPath, { force: true });
      fs.rmSync(throttleMarker, { force: true });
      const binDir = createHookToolDir({
        gitnexusMarkerPath: markerPath,
        lsofOutput: '12345\n',
        psOutput: 'node /tmp/node_modules/.bin/gitnexus mcp\n',
      });
      const runOnce = () =>
        runHook(
          hookPath,
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'Grep',
            tool_input: { pattern: 'validateUser' },
            cwd: tmpDir,
          },
          undefined,
          { env: { ...hookEnv(binDir), GITNEXUS_MCP_HINT_THROTTLE_MS: '600000' } },
        );
      try {
        // First owner-locked search: emits the hint and writes the marker.
        const first = runOnce();
        const out1 = parseHookOutput(first.stdout);
        expect(out1!.additionalContext).toContain('mcp__gitnexus__query');
        expect(first.status).toBe(0);
        expect(fs.existsSync(throttleMarker)).toBe(true);
        // Second search, marker still fresh (10-min window): throttled — no hint.
        const second = runOnce();
        expect(second.stdout.trim()).toBe('');
        expect(second.status).toBe(0);
      } finally {
        fs.rmSync(lbugPath, { force: true });
        fs.rmSync(markerPath, { force: true });
        fs.rmSync(throttleMarker, { force: true });
        fs.rmSync(binDir, { recursive: true, force: true });
      }
    });
  }
});

// #2396: buildMcpQueryHint and its throttle are triplicated across the three hook
// copies (the repo's deliberate no-shared-module hook convention). Guard against
// silent drift with a source-level byte-identity check — runs on every platform,
// unlike the owner-path behavior tests which are macOS-only.
describe('hook copy drift guard (#2396)', () => {
  const ANTIGRAVITY_HOOK = path.resolve(
    __dirname,
    '..',
    '..',
    'hooks',
    'antigravity',
    'gitnexus-antigravity-hook.cjs',
  );
  const HOOK_SOURCES: ReadonlyArray<readonly [string, string]> = [
    ['claude', CJS_HOOK],
    ['plugin', PLUGIN_HOOK],
    ['antigravity', ANTIGRAVITY_HOOK],
  ];

  function extractFn(source: string, name: string): string {
    const match = source.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
    return match ? match[0] : `<${name} not found>`;
  }

  for (const fnName of ['buildMcpQueryHint', 'shouldEmitMcpHint']) {
    it(`${fnName} is byte-identical across all three hook copies`, () => {
      const [claude, plugin, antigravity] = HOOK_SOURCES.map(([, p]) =>
        extractFn(fs.readFileSync(p, 'utf-8'), fnName),
      );
      expect(claude).toContain(`function ${fnName}`);
      expect(plugin).toBe(claude);
      expect(antigravity).toBe(claude);
    });
  }
});

// #2396: an adversarial search pattern (embedded quote + newline) must not break
// the additionalContext JSON envelope — JSON.stringify in the emit path escapes it
// structurally. Owner-path only (macOS/other-Unix lsof+ps lane, SKIP_LSOF_PATH).
describe.skipIf(SKIP_LSOF_PATH)('MCP hint pattern escaping (#2396)', () => {
  for (const [label, hookPath] of [
    ['CJS', CJS_HOOK],
    ['Plugin', PLUGIN_HOOK],
  ] as const) {
    it(`${label}: quote+newline pattern stays JSON-safe in additionalContext`, () => {
      const markerPath = path.join(os.tmpdir(), `gn-hook-esc-${process.pid}-${label}`);
      const lbugPath = path.join(gitNexusDir, 'lbug');
      fs.writeFileSync(lbugPath, '');
      fs.rmSync(markerPath, { force: true });
      const binDir = createHookToolDir({
        gitnexusMarkerPath: markerPath,
        lsofOutput: '12345\n',
        psOutput: 'node /tmp/node_modules/.bin/gitnexus mcp\n',
      });
      const evilPattern = 'foo"bar\nbaz';
      try {
        const result = runHook(
          hookPath,
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'Grep',
            tool_input: { pattern: evilPattern },
            cwd: tmpDir,
          },
          undefined,
          { env: hookEnv(binDir) },
        );
        // parseHookOutput JSON.parses stdout — a broken envelope would throw/return null.
        const output = parseHookOutput(result.stdout);
        expect(output!.additionalContext).toContain('foo"bar');
        expect(output!.additionalContext).toContain('search_query');
        expect(result.status).toBe(0);
      } finally {
        fs.rmSync(lbugPath, { force: true });
        fs.rmSync(markerPath, { force: true });
        fs.rmSync(binDir, { recursive: true, force: true });
      }
    });
  }
});

describe.skipIf(SKIP_LSOF_PATH)(
  'Ladybug DB owner guard — production-shaped ps + failure modes (#1493)',
  () => {
    // These tests assert owner *detection* via the lsof + ps backend: a positive
    // skip is signalled by the `[GitNexus] augment skipped` diagnostic. Since
    // #1913 made that diagnostic debug-gated (silent by default for strict hook
    // runners), they run with GITNEXUS_DEBUG=1 so the discriminator remains
    // observable. Default-silence itself is covered by the 'augmentation
    // filtering' describe above.
    //
    // #2180: skipped on Linux (SKIP_LSOF_PATH) — Linux no longer routes through
    // lsof/ps, so these would no longer exercise the real dispatch there. They
    // stay as the macOS/other-Unix lsof+ps lane; the equivalent Linux owner-
    // detection (incl. the EACCES / cross-user fail-closed edge and the budget
    // timeout fail-closed) is covered directly against a fake /proc in
    // test/unit/hook-db-lock-probe.test.ts.
    for (const [label, hookPath] of [
      ['CJS', CJS_HOOK],
      ['Plugin', PLUGIN_HOOK],
    ] as const) {
      it(`${label}: skips augment for real node_modules/gitnexus ps line (npx child)`, () => {
        const markerPath = path.join(os.tmpdir(), `gn-hook-prodps-${process.pid}-${label}`);
        const lbugPath = path.join(gitNexusDir, 'lbug');
        fs.writeFileSync(lbugPath, '');
        fs.rmSync(markerPath, { force: true });
        const binDir = createHookToolDir({
          gitnexusMarkerPath: markerPath,
          lsofOutput: '99901\n',
          psOutput: 'node /tmp/node_modules/gitnexus/dist/cli/index.js mcp\n',
        });
        try {
          const result = runHook(
            hookPath,
            {
              hook_event_name: 'PreToolUse',
              tool_name: 'Grep',
              tool_input: { pattern: 'validateUser' },
              cwd: tmpDir,
            },
            undefined,
            { env: { ...hookEnv(binDir), GITNEXUS_DEBUG: '1' } },
          );
          // #2396: owner path now hands the agent the MCP-query hint on stdout;
          // the CLI augment is still skipped (marker absent) and the stderr
          // skip diagnostic remains debug-gated.
          const output = parseHookOutput(result.stdout);
          expect(output!.additionalContext).toContain('mcp__gitnexus__query');
          expect(result.status).toBe(0);
          expect(result.stderr).toContain('[GitNexus] augment skipped');
          expect(fs.existsSync(markerPath)).toBe(false);
        } finally {
          fs.rmSync(markerPath, { force: true });
          fs.rmSync(binDir, { recursive: true, force: true });
        }
      });

      it(`${label}: npx parent command line is NOT treated as GitNexus server owner`, () => {
        const markerPath = path.join(os.tmpdir(), `gn-hook-npx-${process.pid}-${label}`);
        const lbugPath = path.join(gitNexusDir, 'lbug');
        fs.writeFileSync(lbugPath, '');
        fs.rmSync(markerPath, { force: true });
        const binDir = createHookToolDir({
          gitnexusMarkerPath: markerPath,
          gitnexusStderr: '[GitNexus] 1 related symbol found:\n\nvalidateUser (src/auth.ts)\n',
          lsofOutput: '99902\n',
          psOutput: 'npx -y gitnexus@latest mcp\n',
        });
        try {
          const result = runHook(
            hookPath,
            {
              hook_event_name: 'PreToolUse',
              tool_name: 'Grep',
              tool_input: { pattern: 'validateUser' },
              cwd: tmpDir,
            },
            undefined,
            { env: hookEnv(binDir) },
          );
          const output = parseHookOutput(result.stdout);
          expect(output).not.toBeNull();
          expect(fs.existsSync(markerPath)).toBe(true);
        } finally {
          fs.rmSync(markerPath, { force: true });
          fs.rmSync(binDir, { recursive: true, force: true });
        }
      });

      it(`${label}: skips augment for gitnexus serve child`, () => {
        const markerPath = path.join(os.tmpdir(), `gn-hook-serve-${process.pid}-${label}`);
        const lbugPath = path.join(gitNexusDir, 'lbug');
        fs.writeFileSync(lbugPath, '');
        fs.rmSync(markerPath, { force: true });
        const binDir = createHookToolDir({
          gitnexusMarkerPath: markerPath,
          lsofOutput: '99903\n',
          psOutput: 'node /repo/node_modules/gitnexus/dist/cli/index.js serve\n',
        });
        try {
          const result = runHook(
            hookPath,
            {
              hook_event_name: 'PreToolUse',
              tool_name: 'Grep',
              tool_input: { pattern: 'validateUser' },
              cwd: tmpDir,
            },
            undefined,
            { env: { ...hookEnv(binDir), GITNEXUS_DEBUG: '1' } },
          );
          // #2396: owner path now hands the agent the MCP-query hint on stdout;
          // the CLI augment is still skipped (marker absent) and the stderr
          // skip diagnostic remains debug-gated.
          const output = parseHookOutput(result.stdout);
          expect(output!.additionalContext).toContain('mcp__gitnexus__query');
          expect(result.status).toBe(0);
          expect(result.stderr).toContain('[GitNexus] augment skipped');
          expect(fs.existsSync(markerPath)).toBe(false);
        } finally {
          fs.rmSync(markerPath, { force: true });
          fs.rmSync(binDir, { recursive: true, force: true });
        }
      });

      it(`${label}: ENOENT lsof → augment still runs (fail-open)`, () => {
        const markerPath = path.join(os.tmpdir(), `gn-hook-enoent-${process.pid}-${label}`);
        const lsofWrapMarkerPath = path.join(
          os.tmpdir(),
          `gn-hook-enoent-lsofwrap-${process.pid}-${label}`,
        );
        const psWrapMarkerPath = path.join(
          os.tmpdir(),
          `gn-hook-enoent-pswrap-${process.pid}-${label}`,
        );
        const lbugPath = path.join(gitNexusDir, 'lbug');
        fs.writeFileSync(lbugPath, '');
        fs.rmSync(markerPath, { force: true });
        fs.rmSync(lsofWrapMarkerPath, { force: true });
        fs.rmSync(psWrapMarkerPath, { force: true });
        const binDir = createHookToolDir({
          gitnexusMarkerPath: markerPath,
          gitnexusStderr: '[GitNexus] 1 related symbol found:\n\nvalidateUser (src/auth.ts)\n',
          lsofOutput: '',
          psOutput: '',
        });
        const guardPath = path.join(binDir, 'marker-guard');
        writeSelfTestingGuardWithMarkers(guardPath, {
          lsof: lsofWrapMarkerPath,
          ps: psWrapMarkerPath,
        });
        try {
          const env = {
            ...hookEnv(binDir),
            GITNEXUS_HOOK_LSOF_PATH: path.join(binDir, '__missing_lsof__'),
            GITNEXUS_HOOK_TIMEOUT_PATH: guardPath,
          };
          const result = runHook(
            hookPath,
            {
              hook_event_name: 'PreToolUse',
              tool_name: 'Grep',
              tool_input: { pattern: 'validateUser' },
              cwd: tmpDir,
            },
            undefined,
            { env },
          );
          const output = parseHookOutput(result.stdout);
          expect(output).not.toBeNull();
          expect(fs.existsSync(markerPath)).toBe(true);
          expect(fs.existsSync(lsofWrapMarkerPath)).toBe(false);
          expect(fs.existsSync(psWrapMarkerPath)).toBe(false);
        } finally {
          fs.rmSync(markerPath, { force: true });
          fs.rmSync(lsofWrapMarkerPath, { force: true });
          fs.rmSync(psWrapMarkerPath, { force: true });
          fs.rmSync(binDir, { recursive: true, force: true });
        }
      });

      it(`${label}: ETIMEDOUT lsof → augment skipped (fail-closed)`, () => {
        const markerPath = path.join(os.tmpdir(), `gn-hook-etime-${process.pid}-${label}`);
        const lbugPath = path.join(gitNexusDir, 'lbug');
        fs.writeFileSync(lbugPath, '');
        fs.rmSync(markerPath, { force: true });
        const binDir = createHookToolDir({
          gitnexusMarkerPath: markerPath,
          lsofSleepMs: 5000,
          psOutput: '',
        });
        try {
          const result = runHook(
            hookPath,
            {
              hook_event_name: 'PreToolUse',
              tool_name: 'Grep',
              tool_input: { pattern: 'validateUser' },
              cwd: tmpDir,
            },
            undefined,
            { env: { ...hookEnv(binDir), GITNEXUS_DEBUG: '1' } },
          );
          // #2396: owner path now hands the agent the MCP-query hint on stdout;
          // the CLI augment is still skipped (marker absent) and the stderr
          // skip diagnostic remains debug-gated.
          const output = parseHookOutput(result.stdout);
          expect(output!.additionalContext).toContain('mcp__gitnexus__query');
          expect(result.status).toBe(0);
          expect(result.stderr).toContain('[GitNexus] augment skipped');
          expect(fs.existsSync(markerPath)).toBe(false);
        } finally {
          fs.rmSync(markerPath, { force: true });
          fs.rmSync(binDir, { recursive: true, force: true });
        }
      });

      // #2396/#1913: the fail-closed (probe-timeout) skip routes through the SAME
      // owner branch, so it now emits the conditional MCP-query hint on stdout —
      // truthful here because the hint only asks the agent to use the MCP tools
      // "if they are live". The stderr diagnostic stays debug-gated (empty by
      // default), so strict runners still see no unexpected diagnostic. Symmetric
      // counterpart to the debug-on test above.
      it(`${label}: ETIMEDOUT lsof → emits hint on stdout, stderr silent by default`, () => {
        const markerPath = path.join(os.tmpdir(), `gn-hook-etime-silent-${process.pid}-${label}`);
        const lbugPath = path.join(gitNexusDir, 'lbug');
        fs.writeFileSync(lbugPath, '');
        fs.rmSync(markerPath, { force: true });
        const binDir = createHookToolDir({
          gitnexusMarkerPath: markerPath,
          lsofSleepMs: 5000,
          psOutput: '',
        });
        try {
          const result = runHook(
            hookPath,
            {
              hook_event_name: 'PreToolUse',
              tool_name: 'Grep',
              tool_input: { pattern: 'validateUser' },
              cwd: tmpDir,
            },
            undefined,
            { env: { ...hookEnv(binDir), GITNEXUS_DEBUG: '' } },
          );
          const output = parseHookOutput(result.stdout);
          expect(output!.additionalContext).toContain('mcp__gitnexus__query');
          expect(result.stderr.trim()).toBe('');
          expect(result.status).toBe(0);
          expect(fs.existsSync(markerPath)).toBe(false);
        } finally {
          fs.rmSync(lbugPath, { force: true });
          fs.rmSync(markerPath, { force: true });
          fs.rmSync(binDir, { recursive: true, force: true });
        }
      });

      // T6 (#2163): with the timeout wrapper explicitly disabled the probe must
      // degrade to EXACTLY the pre-wrapper behavior — lsof ETIMEDOUT stays
      // fail-closed and the augment is silently skipped. Uses the `disabled`
      // sentinel, NOT a bogus path: an invalid GITNEXUS_HOOK_TIMEOUT_PATH falls
      // through to the real candidate list by design. CI lane note: the sibling
      // wrapped ETIMEDOUT tests above exercise GNU /usr/bin/timeout on the
      // Linux lane, and on macos-latest hit BSD /usr/bin/timeout (macOS ≥13,
      // `-k`-compatible) or Homebrew gtimeout — a de-facto BSD-wrapper
      // regression test.
      it(`${label}: ETIMEDOUT lsof with wrapper disabled → identical fail-closed skip`, () => {
        const markerPath = path.join(os.tmpdir(), `gn-hook-nowrap-${process.pid}-${label}`);
        const lbugPath = path.join(gitNexusDir, 'lbug');
        fs.writeFileSync(lbugPath, '');
        fs.rmSync(markerPath, { force: true });
        const binDir = createHookToolDir({
          gitnexusMarkerPath: markerPath,
          lsofSleepMs: 5000,
          psOutput: '',
        });
        try {
          const result = runHook(
            hookPath,
            {
              hook_event_name: 'PreToolUse',
              tool_name: 'Grep',
              tool_input: { pattern: 'validateUser' },
              cwd: tmpDir,
            },
            undefined,
            {
              env: {
                ...hookEnv(binDir),
                GITNEXUS_DEBUG: '1',
                GITNEXUS_HOOK_TIMEOUT_PATH: 'disabled',
              },
            },
          );
          // #2396: owner path now hands the agent the MCP-query hint on stdout;
          // the CLI augment is still skipped (marker absent) and the stderr
          // skip diagnostic remains debug-gated.
          const output = parseHookOutput(result.stdout);
          expect(output!.additionalContext).toContain('mcp__gitnexus__query');
          expect(result.status).toBe(0);
          expect(result.stderr).toContain('[GitNexus] augment skipped');
          expect(fs.existsSync(markerPath)).toBe(false);
        } finally {
          fs.rmSync(lbugPath, { force: true });
          fs.rmSync(markerPath, { force: true });
          fs.rmSync(binDir, { recursive: true, force: true });
        }
      });

      // T7 (#2163): a wrapper that fails the `-k` self-test (busybox <1.34,
      // toybox, broken symlink…) must be REJECTED — resolution falls through
      // to the built-in candidates (or, with none usable, to the unwrapped
      // status quo); either way ETIMEDOUT stays fail-closed. Adopted blindly,
      // the bad wrapper would exit with a usage error before ever running
      // lsof — empty stdout, status≠0, no ETIMEDOUT — silently flipping the
      // fail-closed contract to fail-open.
      it(`${label}: bad wrapper (no -k support) is rejected by the self-test → still fail-closed`, () => {
        const markerPath = path.join(os.tmpdir(), `gn-hook-badwrap-${process.pid}-${label}`);
        const lbugPath = path.join(gitNexusDir, 'lbug');
        fs.writeFileSync(lbugPath, '');
        fs.rmSync(markerPath, { force: true });
        const binDir = createHookToolDir({
          gitnexusMarkerPath: markerPath,
          lsofSleepMs: 5000,
          psOutput: '',
        });
        // Models busybox <1.34: `-k` unsupported → usage error, exit 2.
        const badTimeout = path.join(binDir, 'bad-timeout');
        fs.writeFileSync(
          badTimeout,
          `#!/usr/bin/env node\nprocess.stderr.write('usage: timeout [-t SECS] [-s SIG] PROG ARGS\\n');\nprocess.exit(2);\n`,
          { mode: 0o755 },
        );
        try {
          const result = runHook(
            hookPath,
            {
              hook_event_name: 'PreToolUse',
              tool_name: 'Grep',
              tool_input: { pattern: 'validateUser' },
              cwd: tmpDir,
            },
            undefined,
            {
              env: {
                ...hookEnv(binDir),
                GITNEXUS_DEBUG: '1',
                GITNEXUS_HOOK_TIMEOUT_PATH: badTimeout,
              },
            },
          );
          // #2396: owner path now hands the agent the MCP-query hint on stdout;
          // the CLI augment is still skipped (marker absent) and the stderr
          // skip diagnostic remains debug-gated.
          const output = parseHookOutput(result.stdout);
          expect(output!.additionalContext).toContain('mcp__gitnexus__query');
          expect(result.status).toBe(0);
          expect(result.stderr).toContain('[GitNexus] augment skipped');
          expect(fs.existsSync(markerPath)).toBe(false);
        } finally {
          fs.rmSync(lbugPath, { force: true });
          fs.rmSync(markerPath, { force: true });
          fs.rmSync(binDir, { recursive: true, force: true });
        }
      });

      // F5-1 (#2165 review): pin the LIVE arm of the 124 mapping — a guard
      // that passes the `-k` self-test and then reports coreutils budget
      // expiry (exit 124) must map to "unresponsive holder" → fail-closed
      // skip. The fake guard distinguishes the self-test invocation
      // (`-k 1 1 /bin/sh -c 'exit 42'`) from a real wrap by the `exit 42`
      // argv token, and PROPAGATES the requested status — the self-test now
      // demands exit-status propagation (status 42), not just exit 0
      // (#2169 review).
      it(`${label}: guard exit 124 (budget expiry) → fail-closed skip`, () => {
        const markerPath = path.join(os.tmpdir(), `gn-hook-guard124-${process.pid}-${label}`);
        const lbugPath = path.join(gitNexusDir, 'lbug');
        fs.writeFileSync(lbugPath, '');
        fs.rmSync(markerPath, { force: true });
        const binDir = createHookToolDir({
          gitnexusMarkerPath: markerPath,
          gitnexusStderr: '[GitNexus] 1 related symbol found:\n\nvalidateUser (src/auth.ts)\n',
          lsofOutput: '',
          psOutput: '',
        });
        const fakeGuard = path.join(binDir, 'guard-exit-124');
        fs.writeFileSync(
          fakeGuard,
          `#!/usr/bin/env node\nif (process.argv.includes('exit 42')) process.exit(42);\nprocess.exit(124);\n`,
          { mode: 0o755 },
        );
        try {
          const result = runHook(
            hookPath,
            {
              hook_event_name: 'PreToolUse',
              tool_name: 'Grep',
              tool_input: { pattern: 'validateUser' },
              cwd: tmpDir,
            },
            undefined,
            {
              env: {
                ...hookEnv(binDir),
                GITNEXUS_DEBUG: '1',
                GITNEXUS_HOOK_TIMEOUT_PATH: fakeGuard,
                // '1', NOT '0' — see the slot-gate test above.
                GITNEXUS_HOOK_LINUX_PROC_BUDGET_MS: '1',
              },
            },
          );
          // #2396: owner path now hands the agent the MCP-query hint on stdout;
          // the CLI augment is still skipped (marker absent) and the stderr
          // skip diagnostic remains debug-gated.
          const output = parseHookOutput(result.stdout);
          expect(output!.additionalContext).toContain('mcp__gitnexus__query');
          expect(result.status).toBe(0);
          expect(result.stderr).toContain('[GitNexus] augment skipped');
          expect(fs.existsSync(markerPath)).toBe(false);
        } finally {
          fs.rmSync(lbugPath, { force: true });
          fs.rmSync(markerPath, { force: true });
          fs.rmSync(binDir, { recursive: true, force: true });
        }
      });

      // F5-2 (#2165 review): a guard-wrapped probe that dies BY SIGNAL with
      // no spawnSync .error must fail closed. coreutils timeout SELF-RAISES
      // the signal when `-k` escalates to SIGKILL, so spawnSync sees
      // {status: null, signal: 'SIGKILL'} — NOT exit 137. The same shape
      // appears when the hook is frozen >2s (SIGSTOP / laptop suspend) and
      // resumes after the guard expired. Before the F1 patch this shape fell
      // through every check → empty stdout → fail-open, silently inverting
      // this call's fail-closed contract.
      it(`${label}: guard signal-death (status null + signal, no error) → fail-closed skip`, () => {
        const markerPath = path.join(os.tmpdir(), `gn-hook-guardsig-${process.pid}-${label}`);
        const lbugPath = path.join(gitNexusDir, 'lbug');
        fs.writeFileSync(lbugPath, '');
        fs.rmSync(markerPath, { force: true });
        const binDir = createHookToolDir({
          gitnexusMarkerPath: markerPath,
          gitnexusStderr: '[GitNexus] 1 related symbol found:\n\nvalidateUser (src/auth.ts)\n',
          lsofOutput: '',
          psOutput: '',
        });
        const fakeGuard = path.join(binDir, 'guard-sigkill');
        fs.writeFileSync(
          fakeGuard,
          `#!/usr/bin/env node\nif (process.argv.includes('exit 42')) process.exit(42);\nprocess.kill(process.pid, 'SIGKILL');\n`,
          { mode: 0o755 },
        );
        try {
          const result = runHook(
            hookPath,
            {
              hook_event_name: 'PreToolUse',
              tool_name: 'Grep',
              tool_input: { pattern: 'validateUser' },
              cwd: tmpDir,
            },
            undefined,
            {
              env: {
                ...hookEnv(binDir),
                GITNEXUS_DEBUG: '1',
                GITNEXUS_HOOK_TIMEOUT_PATH: fakeGuard,
                // '1', NOT '0' — see the slot-gate test above.
                GITNEXUS_HOOK_LINUX_PROC_BUDGET_MS: '1',
              },
            },
          );
          // #2396: owner path now hands the agent the MCP-query hint on stdout;
          // the CLI augment is still skipped (marker absent) and the stderr
          // skip diagnostic remains debug-gated.
          const output = parseHookOutput(result.stdout);
          expect(output!.additionalContext).toContain('mcp__gitnexus__query');
          expect(result.status).toBe(0);
          expect(result.stderr).toContain('[GitNexus] augment skipped');
          expect(fs.existsSync(markerPath)).toBe(false);
        } finally {
          fs.rmSync(lbugPath, { force: true });
          fs.rmSync(markerPath, { force: true });
          fs.rmSync(binDir, { recursive: true, force: true });
        }
      });

      // F5-4 (#2169 review; F5-3 was taken by the #2165 slot-gate test
      // above): an always-exit-0 stub (/bin/true shape) at
      // GITNEXUS_HOOK_TIMEOUT_PATH must be REJECTED by the self-test. The
      // old self-test only demanded exit 0, which such a stub satisfies
      // without ever RUNNING the wrapped command — once adopted it instantly
      // "succeeds" every wrapped spawn with empty output, turning the probe
      // into a constant no-owner answer and, worse, the augment into a
      // silent no-op (status 0 + empty stderr passes the success check with
      // no context, so the feature dies without a trace). The propagation
      // self-test (`sh -c 'exit 42'` must yield 42) rejects the stub;
      // resolution falls through to the built-in candidates (or, with none
      // usable, to the unwrapped status quo) and the augment runs for real.
      it(`${label}: always-exit-0 stub guard is rejected → augment still runs and emits context`, () => {
        const markerPath = path.join(os.tmpdir(), `gn-hook-stubguard-${process.pid}-${label}`);
        const lbugPath = path.join(gitNexusDir, 'lbug');
        fs.writeFileSync(lbugPath, '');
        fs.rmSync(markerPath, { force: true });
        const binDir = createHookToolDir({
          gitnexusMarkerPath: markerPath,
          gitnexusStderr: '[GitNexus] 1 related symbol found:\n\nvalidateUser (src/auth.ts)\n',
          lsofOutput: '',
          psOutput: '',
        });
        // Models /bin/true: exits 0 for ANY argv without running anything.
        const stubGuard = path.join(binDir, 'true-stub');
        fs.writeFileSync(stubGuard, `#!/usr/bin/env node\nprocess.exit(0);\n`, { mode: 0o755 });
        try {
          const result = runHook(
            hookPath,
            {
              hook_event_name: 'PreToolUse',
              tool_name: 'Grep',
              tool_input: { pattern: 'validateUser' },
              cwd: tmpDir,
            },
            undefined,
            {
              env: {
                ...hookEnv(binDir),
                GITNEXUS_HOOK_TIMEOUT_PATH: stubGuard,
                // '1', NOT '0' — see the slot-gate test above.
                GITNEXUS_HOOK_LINUX_PROC_BUDGET_MS: '1',
              },
            },
          );
          const output = parseHookOutput(result.stdout);
          expect(output).not.toBeNull();
          expect(output!.additionalContext).toContain('[GitNexus] 1 related symbol found');
          expect(fs.existsSync(markerPath)).toBe(true);
        } finally {
          fs.rmSync(lbugPath, { force: true });
          fs.rmSync(markerPath, { force: true });
          fs.rmSync(binDir, { recursive: true, force: true });
        }
      });

      it(`${label}: non-GitNexus ps line → augment runs`, () => {
        const markerPath = path.join(os.tmpdir(), `gn-hook-other-${process.pid}-${label}`);
        const lbugPath = path.join(gitNexusDir, 'lbug');
        fs.writeFileSync(lbugPath, '');
        fs.rmSync(markerPath, { force: true });
        const binDir = createHookToolDir({
          gitnexusMarkerPath: markerPath,
          gitnexusStderr: '[GitNexus] 1 related symbol found:\n\nvalidateUser (src/auth.ts)\n',
          lsofOutput: '99904\n',
          psOutput: '/usr/bin/bash -l\n',
        });
        try {
          const result = runHook(
            hookPath,
            {
              hook_event_name: 'PreToolUse',
              tool_name: 'Grep',
              tool_input: { pattern: 'validateUser' },
              cwd: tmpDir,
            },
            undefined,
            { env: hookEnv(binDir) },
          );
          const output = parseHookOutput(result.stdout);
          expect(output).not.toBeNull();
          expect(fs.existsSync(markerPath)).toBe(true);
        } finally {
          fs.rmSync(markerPath, { force: true });
          fs.rmSync(binDir, { recursive: true, force: true });
        }
      });

      it(`${label}: multiple PIDs — skip if any ps line is GitNexus MCP`, () => {
        const markerPath = path.join(os.tmpdir(), `gn-hook-multi-${process.pid}-${label}`);
        const lbugPath = path.join(gitNexusDir, 'lbug');
        fs.writeFileSync(lbugPath, '');
        fs.rmSync(markerPath, { force: true });
        const binDir = createHookToolDir({
          gitnexusMarkerPath: markerPath,
          gitnexusStderr: '[GitNexus] 1 related symbol found:\n\nvalidateUser (src/auth.ts)\n',
          lsofOutputLines: ['111', '222'],
          psOutputByPid: {
            '111': 'vim /tmp/x\n',
            '222': 'node /x/node_modules/gitnexus/dist/cli/index.js mcp\n',
          },
        });
        try {
          const result = runHook(
            hookPath,
            {
              hook_event_name: 'PreToolUse',
              tool_name: 'Grep',
              tool_input: { pattern: 'validateUser' },
              cwd: tmpDir,
            },
            undefined,
            { env: { ...hookEnv(binDir), GITNEXUS_DEBUG: '1' } },
          );
          // #2396: owner path now hands the agent the MCP-query hint on stdout;
          // the CLI augment is still skipped (marker absent) and the stderr
          // skip diagnostic remains debug-gated.
          const output = parseHookOutput(result.stdout);
          expect(output!.additionalContext).toContain('mcp__gitnexus__query');
          expect(result.status).toBe(0);
          expect(result.stderr).toContain('[GitNexus] augment skipped');
          expect(fs.existsSync(markerPath)).toBe(false);
        } finally {
          fs.rmSync(markerPath, { force: true });
          fs.rmSync(binDir, { recursive: true, force: true });
        }
      });

      it(`${label}: ps ENOENT → augment runs (ignore that PID)`, () => {
        const markerPath = path.join(os.tmpdir(), `gn-hook-pseno-${process.pid}-${label}`);
        const lsofWrapMarkerPath = path.join(
          os.tmpdir(),
          `gn-hook-pseno-lsofwrap-${process.pid}-${label}`,
        );
        const psWrapMarkerPath = path.join(
          os.tmpdir(),
          `gn-hook-pseno-pswrap-${process.pid}-${label}`,
        );
        const lbugPath = path.join(gitNexusDir, 'lbug');
        fs.writeFileSync(lbugPath, '');
        fs.rmSync(markerPath, { force: true });
        fs.rmSync(lsofWrapMarkerPath, { force: true });
        fs.rmSync(psWrapMarkerPath, { force: true });
        const binDir = createHookToolDir({
          gitnexusMarkerPath: markerPath,
          gitnexusStderr: '[GitNexus] 1 related symbol found:\n\nvalidateUser (src/auth.ts)\n',
          lsofOutput: '99905\n',
          psOutputByPid: {
            '99905': 'node /x/node_modules/gitnexus/dist/cli/index.js mcp\n',
          },
        });
        const guardPath = path.join(binDir, 'marker-guard');
        writeSelfTestingGuardWithMarkers(guardPath, {
          lsof: lsofWrapMarkerPath,
          ps: psWrapMarkerPath,
        });
        try {
          const env = {
            ...hookEnv(binDir),
            GITNEXUS_HOOK_PS_PATH: path.join(binDir, '__missing_ps__'),
            GITNEXUS_HOOK_TIMEOUT_PATH: guardPath,
          };
          const result = runHook(
            hookPath,
            {
              hook_event_name: 'PreToolUse',
              tool_name: 'Grep',
              tool_input: { pattern: 'validateUser' },
              cwd: tmpDir,
            },
            undefined,
            { env },
          );
          const output = parseHookOutput(result.stdout);
          expect(output).not.toBeNull();
          expect(fs.existsSync(markerPath)).toBe(true);
          expect(fs.existsSync(lsofWrapMarkerPath)).toBe(true);
          expect(fs.existsSync(psWrapMarkerPath)).toBe(false);
        } finally {
          fs.rmSync(markerPath, { force: true });
          fs.rmSync(lsofWrapMarkerPath, { force: true });
          fs.rmSync(psWrapMarkerPath, { force: true });
          fs.rmSync(binDir, { recursive: true, force: true });
        }
      });
    }
  },
);

// ─── Integration: PostToolUse staleness detection ───────────────────

describe('PostToolUse staleness detection (integration)', () => {
  for (const [label, hookPath] of [
    ['CJS', CJS_HOOK],
    ['Plugin', PLUGIN_HOOK],
  ] as const) {
    it(`${label}: emits stale notification when HEAD differs from meta`, () => {
      // Write meta.json with a different commit
      fs.writeFileSync(
        path.join(gitNexusDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'aaaaaaa0000000000000000000000000deadbeef', stats: {} }),
      );

      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "test"' },
        tool_output: { exit_code: 0 },
        cwd: tmpDir,
      });

      const output = parseHookOutput(result.stdout);
      expect(output).not.toBeNull();
      expect(output!.hookEventName).toBe('PostToolUse');
      expect(output!.additionalContext).toContain('stale');
      expect(output!.additionalContext).toContain('aaaaaaa');
    });

    it(`${label}: silent when HEAD matches meta lastCommit`, () => {
      const head = getHeadCommit();
      fs.writeFileSync(
        path.join(gitNexusDir, 'meta.json'),
        JSON.stringify({ lastCommit: head, stats: {} }),
      );

      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "test"' },
        tool_output: { exit_code: 0 },
        cwd: tmpDir,
      });

      expect(result.stdout.trim()).toBe('');
    });

    it(`${label}: silent when tool is not Bash`, () => {
      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Grep',
        tool_input: { command: 'git commit -m "test"' },
        cwd: tmpDir,
      });
      expect(result.stdout.trim()).toBe('');
    });

    it(`${label}: silent when command is not a git mutation`, () => {
      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git status' },
        tool_output: { exit_code: 0 },
        cwd: tmpDir,
      });
      expect(result.stdout.trim()).toBe('');
    });

    it(`${label}: silent when exit code is non-zero`, () => {
      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "fail"' },
        tool_output: { exit_code: 1 },
        cwd: tmpDir,
      });
      expect(result.stdout.trim()).toBe('');
    });

    it(`${label}: includes --embeddings in suggestion when meta had embeddings`, () => {
      fs.writeFileSync(
        path.join(gitNexusDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'deadbeef', stats: { embeddings: 42 } }),
      );

      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git merge feature' },
        tool_output: { exit_code: 0 },
        cwd: tmpDir,
      });

      const output = parseHookOutput(result.stdout);
      expect(output).not.toBeNull();
      expect(output!.additionalContext).toContain('--embeddings');
    });

    it(`${label}: omits --embeddings when meta had no embeddings`, () => {
      fs.writeFileSync(
        path.join(gitNexusDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'deadbeef', stats: { embeddings: 0 } }),
      );

      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "test"' },
        tool_output: { exit_code: 0 },
        cwd: tmpDir,
      });

      const output = parseHookOutput(result.stdout);
      expect(output).not.toBeNull();
      expect(output!.additionalContext).not.toContain('--embeddings');
    });

    it(`${label}: detects git rebase as a mutation`, () => {
      fs.writeFileSync(
        path.join(gitNexusDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'oldcommit', stats: {} }),
      );

      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git rebase main' },
        tool_output: { exit_code: 0 },
        cwd: tmpDir,
      });

      const output = parseHookOutput(result.stdout);
      expect(output).not.toBeNull();
      expect(output!.additionalContext).toContain('stale');
    });

    it(`${label}: detects git cherry-pick as a mutation`, () => {
      fs.writeFileSync(
        path.join(gitNexusDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'oldcommit', stats: {} }),
      );

      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git cherry-pick abc123' },
        tool_output: { exit_code: 0 },
        cwd: tmpDir,
      });

      const output = parseHookOutput(result.stdout);
      expect(output).not.toBeNull();
    });

    it(`${label}: detects git pull as a mutation`, () => {
      fs.writeFileSync(
        path.join(gitNexusDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'oldcommit', stats: {} }),
      );

      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git pull origin main' },
        tool_output: { exit_code: 0 },
        cwd: tmpDir,
      });

      const output = parseHookOutput(result.stdout);
      expect(output).not.toBeNull();
    });
  }
});

// ─── Integration: PostToolUse staleness detection with gitnexus.json ────
// (the current primary metadata filename; meta.json is a dual-written
// compatibility mirror — see repo-manager.ts's saveMeta/loadMeta)

describe('PostToolUse staleness detection with gitnexus.json (integration)', () => {
  for (const [label, hookPath] of [
    ['CJS', CJS_HOOK],
    ['Plugin', PLUGIN_HOOK],
  ] as const) {
    it(`${label}: emits stale notification when HEAD differs from gitnexus.json`, () => {
      const gitnexusJsonPath = path.join(gitNexusDir, 'gitnexus.json');
      const metaJsonPath = path.join(gitNexusDir, 'meta.json');
      fs.rmSync(metaJsonPath, { force: true });
      fs.writeFileSync(
        gitnexusJsonPath,
        JSON.stringify({ lastCommit: 'aaaaaaa0000000000000000000000000deadbeef', stats: {} }),
      );

      try {
        const result = runHook(hookPath, {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'git commit -m "test"' },
          tool_output: { exit_code: 0 },
          cwd: tmpDir,
        });

        const output = parseHookOutput(result.stdout);
        expect(output).not.toBeNull();
        expect(output!.additionalContext).toContain('stale');
        expect(output!.additionalContext).toContain('aaaaaaa');
      } finally {
        fs.rmSync(gitnexusJsonPath, { force: true });
        fs.writeFileSync(metaJsonPath, JSON.stringify({ lastCommit: 'old', stats: {} }));
      }
    });

    it(`${label}: silent when HEAD matches gitnexus.json lastCommit`, () => {
      const gitnexusJsonPath = path.join(gitNexusDir, 'gitnexus.json');
      const metaJsonPath = path.join(gitNexusDir, 'meta.json');
      const head = getHeadCommit();
      fs.rmSync(metaJsonPath, { force: true });
      fs.writeFileSync(gitnexusJsonPath, JSON.stringify({ lastCommit: head, stats: {} }));

      try {
        const result = runHook(hookPath, {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'git commit -m "test"' },
          tool_output: { exit_code: 0 },
          cwd: tmpDir,
        });

        expect(result.stdout.trim()).toBe('');
      } finally {
        fs.rmSync(gitnexusJsonPath, { force: true });
        fs.writeFileSync(metaJsonPath, JSON.stringify({ lastCommit: 'old', stats: {} }));
      }
    });

    it(`${label}: prefers gitnexus.json over meta.json when both are present (dual-write steady state)`, () => {
      const gitnexusJsonPath = path.join(gitNexusDir, 'gitnexus.json');
      const metaJsonPath = path.join(gitNexusDir, 'meta.json');
      fs.writeFileSync(gitnexusJsonPath, JSON.stringify({ lastCommit: 'freshcommit', stats: {} }));
      fs.writeFileSync(metaJsonPath, JSON.stringify({ lastCommit: 'stalecommit', stats: {} }));

      try {
        const result = runHook(hookPath, {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'git commit -m "test"' },
          tool_output: { exit_code: 0 },
          cwd: tmpDir,
        });

        const output = parseHookOutput(result.stdout);
        expect(output).not.toBeNull();
        // Reports staleness against gitnexus.json's commit, not meta.json's —
        // proves gitnexus.json is consulted first.
        expect(output!.additionalContext).toContain('freshco');
      } finally {
        fs.rmSync(gitnexusJsonPath, { force: true });
        fs.writeFileSync(metaJsonPath, JSON.stringify({ lastCommit: 'old', stats: {} }));
      }
    });

    it(`${label}: falls back to meta.json when gitnexus.json is corrupt`, () => {
      const gitnexusJsonPath = path.join(gitNexusDir, 'gitnexus.json');
      const metaJsonPath = path.join(gitNexusDir, 'meta.json');
      const head = getHeadCommit();
      fs.writeFileSync(gitnexusJsonPath, 'not valid json!!!');
      fs.writeFileSync(metaJsonPath, JSON.stringify({ lastCommit: head, stats: {} }));

      try {
        const result = runHook(hookPath, {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'git commit -m "test"' },
          tool_output: { exit_code: 0 },
          cwd: tmpDir,
        });

        // meta.json's lastCommit matches HEAD, so a correct fallback stays silent.
        expect(result.stdout.trim()).toBe('');
      } finally {
        fs.rmSync(gitnexusJsonPath, { force: true });
        fs.writeFileSync(metaJsonPath, JSON.stringify({ lastCommit: 'old', stats: {} }));
      }
    });
  }
});

// ─── Integration: cwd validation rejects relative paths ─────────────

describe('cwd validation (integration)', () => {
  for (const [label, hookPath] of [
    ['CJS', CJS_HOOK],
    ['Plugin', PLUGIN_HOOK],
  ] as const) {
    it(`${label}: PostToolUse silent when cwd is relative`, () => {
      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "test"' },
        tool_output: { exit_code: 0 },
        cwd: 'relative/path',
      });
      expect(result.stdout.trim()).toBe('');
    });

    it(`${label}: PreToolUse silent when cwd is relative`, () => {
      const result = runHook(hookPath, {
        hook_event_name: 'PreToolUse',
        tool_name: 'Grep',
        tool_input: { pattern: 'validateUser' },
        cwd: 'relative/path',
      });
      expect(result.stdout.trim()).toBe('');
    });
  }
});

// ─── Integration: global registry lookup ────────────────────────────

describe('Global registry lookup', () => {
  for (const [label, hookPath] of [
    ['CJS', CJS_HOOK],
    ['Plugin', PLUGIN_HOOK],
  ] as const) {
    it(`${label}: PostToolUse stays silent for unindexed repo under global registry`, () => {
      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-home-'));
      const repoDir = path.join(homeDir, 'work', 'unindexed');
      try {
        createGlobalRegistry(homeDir);
        fs.mkdirSync(repoDir, { recursive: true });
        initGitRepo(repoDir);

        const result = runHook(hookPath, {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'git commit -m "test"' },
          tool_output: { exit_code: 0 },
          cwd: repoDir,
        });

        expect(result.stdout.trim()).toBe('');
      } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
      }
    });

    it(`${label}: PreToolUse stays silent for unindexed repo under global registry`, () => {
      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-home-'));
      const repoDir = path.join(homeDir, 'work', 'unindexed');
      try {
        createGlobalRegistry(homeDir);
        fs.mkdirSync(repoDir, { recursive: true });
        initGitRepo(repoDir);

        const result = runHook(hookPath, {
          hook_event_name: 'PreToolUse',
          tool_name: 'Grep',
          tool_input: { pattern: 'validateUser' },
          cwd: repoDir,
        });

        expect(result.stdout.trim()).toBe('');
      } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
      }
    });

    it(`${label}: PostToolUse emits stale for indexed repo under parent global registry`, () => {
      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-home-'));
      const repoDir = path.join(homeDir, 'work', 'indexed-repo');
      try {
        createGlobalRegistry(homeDir);
        fs.mkdirSync(path.join(repoDir, '.gitnexus'), { recursive: true });
        initGitRepo(repoDir);
        fs.writeFileSync(
          path.join(repoDir, '.gitnexus', 'meta.json'),
          JSON.stringify({ lastCommit: 'oldcommit', stats: {} }),
        );

        const result = runHook(hookPath, {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'git commit -m "test"' },
          tool_output: { exit_code: 0 },
          cwd: repoDir,
        });

        const output = parseHookOutput(result.stdout);
        expect(output).not.toBeNull();
        expect(output!.additionalContext).toContain('stale');
      } finally {
        fs.rmSync(homeDir, { recursive: true, force: true });
      }
    });

    for (const marker of ['registry', 'repos'] as const) {
      it(`${label}: PostToolUse skips global registry with only ${marker} marker`, () => {
        const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-home-'));
        const repoDir = path.join(homeDir, 'work', `unindexed-${marker}`);
        try {
          createGlobalRegistry(homeDir, marker);
          fs.mkdirSync(repoDir, { recursive: true });
          initGitRepo(repoDir);

          const result = runHook(hookPath, {
            hook_event_name: 'PostToolUse',
            tool_name: 'Bash',
            tool_input: { command: 'git commit -m "test"' },
            tool_output: { exit_code: 0 },
            cwd: repoDir,
          });

          expect(result.stdout.trim()).toBe('');
        } finally {
          fs.rmSync(homeDir, { recursive: true, force: true });
        }
      });
    }
  }
});

// ─── Integration: linked-worktree resolution (#1224) ───────────────

describe('Linked git worktree resolution', () => {
  for (const [label, hookPath] of [
    ['CJS', CJS_HOOK],
    ['Plugin', PLUGIN_HOOK],
  ] as const) {
    it(`${label}: PostToolUse emits stale from a linked worktree pointing at an indexed canonical repo`, () => {
      // Layout mirrors `git worktree add ../<repo>-worktrees/feature-x`:
      //   <root>/main-repo/.git              (canonical)
      //   <root>/main-repo/.gitnexus/        (only here)
      //   <root>/main-repo-worktrees/feat/   (linked worktree, no .gitnexus)
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-worktree-'));
      const mainRepo = path.join(root, 'main-repo');
      const worktreePath = path.join(root, 'main-repo-worktrees', 'feat');
      try {
        fs.mkdirSync(mainRepo, { recursive: true });
        initGitRepo(mainRepo);
        fs.mkdirSync(path.join(mainRepo, '.gitnexus'), { recursive: true });
        fs.writeFileSync(
          path.join(mainRepo, '.gitnexus', 'meta.json'),
          JSON.stringify({ lastCommit: 'oldcommit', stats: {} }),
        );

        // Create the linked worktree on a new branch.
        fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
        runGit(mainRepo, ['worktree', 'add', '-b', 'feat', worktreePath]);

        // Sanity: walking up from the worktree never reaches `.gitnexus`.
        expect(fs.existsSync(path.join(worktreePath, '.gitnexus'))).toBe(false);
        expect(fs.existsSync(path.join(path.dirname(worktreePath), '.gitnexus'))).toBe(false);

        const result = runHook(hookPath, {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'git commit -m "test"' },
          tool_output: { exit_code: 0 },
          cwd: worktreePath,
        });

        const output = parseHookOutput(result.stdout);
        expect(output).not.toBeNull();
        expect(output!.additionalContext).toContain('stale');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it(`${label}: PostToolUse silent from a linked worktree when canonical repo has no .gitnexus`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-worktree-'));
      const mainRepo = path.join(root, 'main-repo');
      const worktreePath = path.join(root, 'main-repo-worktrees', 'feat');
      try {
        fs.mkdirSync(mainRepo, { recursive: true });
        initGitRepo(mainRepo);
        // Note: NO .gitnexus/ in the canonical repo.

        fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
        runGit(mainRepo, ['worktree', 'add', '-b', 'feat', worktreePath]);

        const result = runHook(hookPath, {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'git commit -m "test"' },
          tool_output: { exit_code: 0 },
          cwd: worktreePath,
        });

        expect(result.stdout.trim()).toBe('');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

// ─── Integration: dispatch map routes correctly ─────────────────────

describe('Dispatch map routing (integration)', () => {
  for (const [label, hookPath] of [
    ['CJS', CJS_HOOK],
    ['Plugin', PLUGIN_HOOK],
  ] as const) {
    it(`${label}: unknown hook_event_name produces no output`, () => {
      const result = runHook(hookPath, {
        hook_event_name: 'UnknownEvent',
        tool_name: 'Bash',
        tool_input: { command: 'echo hello' },
        cwd: tmpDir,
      });
      expect(result.stdout.trim()).toBe('');
      expect(result.status).toBe(0);
    });

    it(`${label}: empty hook_event_name produces no output`, () => {
      const result = runHook(hookPath, {
        hook_event_name: '',
        tool_name: 'Bash',
        cwd: tmpDir,
      });
      expect(result.stdout.trim()).toBe('');
      expect(result.status).toBe(0);
    });

    it(`${label}: missing hook_event_name produces no output`, () => {
      const result = runHook(hookPath, {
        tool_name: 'Bash',
        cwd: tmpDir,
      });
      expect(result.stdout.trim()).toBe('');
      expect(result.status).toBe(0);
    });

    it(`${label}: invalid JSON input exits cleanly`, () => {
      const result = spawnSync(process.execPath, [hookPath], {
        input: 'not json at all',
        encoding: 'utf-8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('');
    });

    it(`${label}: empty stdin exits cleanly`, () => {
      const result = spawnSync(process.execPath, [hookPath], {
        input: '',
        encoding: 'utf-8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      expect(result.status).toBe(0);
    });
  }
});

// ─── Integration: PostToolUse with missing meta.json ────────────────

describe('PostToolUse with missing/corrupt meta.json', () => {
  for (const [label, hookPath] of [
    ['CJS', CJS_HOOK],
    ['Plugin', PLUGIN_HOOK],
  ] as const) {
    it(`${label}: emits stale when meta.json does not exist`, () => {
      const metaPath = path.join(gitNexusDir, 'meta.json');
      const hadMeta = fs.existsSync(metaPath);
      if (hadMeta) fs.unlinkSync(metaPath);

      try {
        const result = runHook(hookPath, {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'git commit -m "test"' },
          tool_output: { exit_code: 0 },
          cwd: tmpDir,
        });

        const output = parseHookOutput(result.stdout);
        expect(output).not.toBeNull();
        expect(output!.additionalContext).toContain('never');
      } finally {
        // Restore meta.json for subsequent tests
        fs.writeFileSync(metaPath, JSON.stringify({ lastCommit: 'old', stats: {} }));
      }
    });

    it(`${label}: emits stale when meta.json is corrupt`, () => {
      const metaPath = path.join(gitNexusDir, 'meta.json');
      fs.writeFileSync(metaPath, 'not valid json!!!');

      const result = runHook(hookPath, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "test"' },
        tool_output: { exit_code: 0 },
        cwd: tmpDir,
      });

      const output = parseHookOutput(result.stdout);
      expect(output).not.toBeNull();
      expect(output!.additionalContext).toContain('never');

      // Restore
      fs.writeFileSync(metaPath, JSON.stringify({ lastCommit: 'old', stats: {} }));
    });
  }
});

// ─── Drift guard: every shipped hook must know about gitnexus.json ──
// This repo has hit the "N mirrored copies silently drift" failure mode
// twice for skills (#2356/#2360/#2362) — this test is the same class of
// guardrail for the four hook copies.

describe('Hook metadata-filename drift guard', () => {
  const ANTIGRAVITY_HOOK = path.resolve(
    __dirname,
    '..',
    '..',
    'hooks',
    'antigravity',
    'gitnexus-antigravity-hook.cjs',
  );
  const CURSOR_HOOK = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    'gitnexus-cursor-integration',
    'hooks',
    'gitnexus-hook.cjs',
  );

  for (const [label, hookPath] of [
    ['CJS (claude)', CJS_HOOK],
    ['Plugin', PLUGIN_HOOK],
    ['Antigravity', ANTIGRAVITY_HOOK],
    ['Cursor', CURSOR_HOOK],
  ] as const) {
    it(`${label}: source references gitnexus.json, not only meta.json`, () => {
      const source = fs.readFileSync(hookPath, 'utf-8');
      expect(source).toContain('gitnexus.json');
    });
  }
});
