/**
 * Regression Tests: Cursor postToolUse Hook
 *
 * Tests the hook script at gitnexus-cursor-integration/hooks/gitnexus-hook.cjs
 * which runs as a Cursor 2.4 postToolUse hook.
 *
 * Covers:
 * - extractPattern: pattern extraction from Grep/Read/Shell tool inputs
 * - findRegisteredRepo: registry-backed repository discovery
 * - cwd validation: rejects relative paths
 * - shell injection: verifies no `shell: true` in spawnSync calls
 * - cross-platform: Windows .cmd extension handling
 * - output shape: top-level `additional_context` (NOT Claude's `hookSpecificOutput.additionalContext`)
 * - hooks.json wiring matches the script's actual handlers
 *
 * Cursor hooks reach the augment CLI only when cwd is inside an indexed
 * repo, so behavior tests stick to early-exit paths to avoid spawning
 * `npx gitnexus`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { runHook as spawnHook } from '../utils/hook-test-helpers.js';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';

// ─── Path to the Cursor hook + manifest ─────────────────────────────

const CURSOR_HOOK = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'gitnexus-cursor-integration',
  'hooks',
  'gitnexus-hook.cjs',
);
const CURSOR_HOOK_LOCK = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'gitnexus-cursor-integration',
  'hooks',
  'hook-lock.cjs',
);
const CURSOR_HOOKS_JSON = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'gitnexus-cursor-integration',
  'hooks',
  'hooks.json',
);

const require = createRequire(import.meta.url);
const { parseRgGrepPattern, tokenizeShellWords } = require(CURSOR_HOOK) as {
  parseRgGrepPattern: (command: string) => string | null;
  tokenizeShellWords: (command: string) => string[];
};

// ─── Cursor-specific output parser ──────────────────────────────────
// Cursor postToolUse output shape: { "additional_context": "..." }

function parseCursorOutput(stdout: string): { additional_context?: string } | null {
  if (!stdout.trim()) return null;
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return null;
  }
}

// ─── Test fixtures ──────────────────────────────────────────────────

let tmpDir: string;
// Separate fixture for the concurrency guard tests: this one has a real
// `.gitnexus/` so the hook reaches acquireHookSlot. The base tmpDir above
// deliberately has no .gitnexus so unrelated early-exit tests stay cheap.
let guardTmpDir: string;
let guardGitNexusDir: string;
let hookHome: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-cursor-hook-test-'));
  initGitRepo(tmpDir, { name: 'Test', email: 'test@test.com' });

  guardTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-cursor-hook-guard-'));
  guardGitNexusDir = path.join(guardTmpDir, '.gitnexus');
  fs.mkdirSync(guardGitNexusDir, { recursive: true });
  initGitRepo(guardTmpDir, { name: 'Test', email: 'test@test.com' });
  fs.writeFileSync(path.join(guardTmpDir, 'dummy.txt'), 'hello');
  commitAll(guardTmpDir, 'init');

  hookHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-cursor-hook-home-'));
  fs.writeFileSync(
    path.join(hookHome, 'registry.json'),
    JSON.stringify([
      {
        name: 'cursor-guard',
        path: guardTmpDir,
        storagePath: guardGitNexusDir,
      },
    ]),
  );
});

afterAll(() => {
  fs.rmSync(hookHome, { recursive: true, force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(guardTmpDir, { recursive: true, force: true });
});

function runHook(
  hookPath: string,
  input: Record<string, any>,
  cwd?: string,
  options: { env?: NodeJS.ProcessEnv } = {},
) {
  return spawnHook(hookPath, input, cwd, {
    ...options,
    env: { ...(options.env ?? process.env), GITNEXUS_HOME: hookHome },
  });
}

// ─── Manifest + hook file presence ───────────────────────────────────

describe('Cursor integration files', () => {
  it('hook script exists', () => {
    expect(fs.existsSync(CURSOR_HOOK)).toBe(true);
  });

  it('hooks.json exists', () => {
    expect(fs.existsSync(CURSOR_HOOKS_JSON)).toBe(true);
  });

  it('legacy augment-shell.sh has been removed', () => {
    const legacy = path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      'gitnexus-cursor-integration',
      'hooks',
      'augment-shell.sh',
    );
    expect(fs.existsSync(legacy)).toBe(false);
  });
});

// ─── hooks.json wiring ──────────────────────────────────────────────

describe('hooks.json wiring', () => {
  const manifest = JSON.parse(fs.readFileSync(CURSOR_HOOKS_JSON, 'utf-8'));

  it('declares version 1', () => {
    expect(manifest.version).toBe(1);
  });

  it('registers a postToolUse hook (not legacy beforeShellExecution)', () => {
    expect(manifest.hooks.postToolUse).toBeDefined();
    expect(Array.isArray(manifest.hooks.postToolUse)).toBe(true);
    expect(manifest.hooks.beforeShellExecution).toBeUndefined();
  });

  it('matches Shell, Read, and Grep tools', () => {
    const matcher: string = manifest.hooks.postToolUse[0].matcher;
    expect(matcher).toMatch(/Shell/);
    expect(matcher).toMatch(/Read/);
    expect(matcher).toMatch(/Grep/);
  });

  it('points command at the new Node hook', () => {
    const command: string = manifest.hooks.postToolUse[0].command;
    expect(command).toContain('gitnexus-hook.cjs');
    expect(command).not.toContain('augment-shell.sh');
  });

  it('declares timeout in seconds (not milliseconds)', () => {
    // Cursor's `timeout` field is in seconds per
    // https://cursor.com/docs/agent/hooks. Regression guard: a value of
    // 1000+ here would be a >16-minute timeout, almost certainly a ms/s mixup.
    const timeout: number = manifest.hooks.postToolUse[0].timeout;
    expect(typeof timeout).toBe('number');
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThan(120);
  });
});

// ─── Source code regressions ────────────────────────────────────────

describe('Cursor hook source regressions', () => {
  const source = fs.readFileSync(CURSOR_HOOK, 'utf-8');

  it('does not pass shell: true to spawnSync', () => {
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
      if (/shell:\s*(true|isWin)/.test(line)) {
        throw new Error(`Cursor hook line ${i + 1} has shell injection risk: ${line.trim()}`);
      }
    }
  });

  it('uses npx.cmd for Windows', () => {
    expect(source).toContain('npx.cmd');
  });

  it('validates cwd is an absolute path', () => {
    expect(source).toMatch(/path\.isAbsolute\(cwd\)/);
  });

  it('truncates debug error messages to 200 chars', () => {
    expect(source).toContain('.slice(0, 200)');
  });

  it('emits Cursor-shape additional_context (not Claude hookSpecificOutput)', () => {
    expect(source).toContain('additional_context');
    expect(source).not.toContain('hookSpecificOutput');
    expect(source).not.toContain('hookEventName');
  });

  it('rejects patterns shorter than 3 chars', () => {
    expect(source).toMatch(/length\s*>=\s*3/);
  });

  it('passes pattern after end-of-options marker (--)', () => {
    // Regression for #200 — augment patterns starting with `-` would
    // otherwise be parsed as CLI flags by the gitnexus CLI.
    expect(source).toMatch(/'augment',\s*'--',\s*pattern/);
  });

  it('gates on a registry entry before invoking the CLI', () => {
    expect(source).toContain('resolveHookRepo');
    expect(source).toContain('registry-query.cjs');
  });

  it('handles linked git worktrees via git rev-parse --git-common-dir', () => {
    const resolver = fs.readFileSync(
      path.resolve(
        __dirname,
        '..',
        '..',
        '..',
        'gitnexus-cursor-integration',
        'hooks',
        'registry-query.cjs',
      ),
      'utf-8',
    );
    expect(resolver).toContain('--git-common-dir');
  });
});

// ─── extractPattern coverage (source-level) ─────────────────────────

describe('Cursor hook extractPattern coverage', () => {
  const source = fs.readFileSync(CURSOR_HOOK, 'utf-8');

  it("handles 'grep' tool (Cursor matcher: Grep)", () => {
    expect(source).toMatch(/t === 'grep'/);
  });

  it('probes a wide alias set for Grep query field (Cursor contract not formally specified)', () => {
    // Cursor 2.4 docs at https://cursor.com/docs/agent/hooks list the
    // matchers but not the per-tool tool_input field names. If Cursor
    // changes the contract, we want the hook to still extract *something*
    // — these aliases plus the longest-string fallback give us coverage.
    for (const alias of ['query', 'pattern', 'regex', 'q', 'search', 'searchQuery']) {
      expect(source).toContain(`toolInput.${alias}`);
    }
    expect(source).toContain('pickLongestStringValue');
  });

  it("handles 'read' tool (Cursor matcher: Read)", () => {
    expect(source).toMatch(/t === 'read'/);
    for (const alias of ['target_file', 'file_path', 'filePath', 'path', 'file']) {
      expect(source).toContain(`toolInput.${alias}`);
    }
  });

  it("handles 'shell' tool (Cursor matcher: Shell)", () => {
    expect(source).toMatch(/t === 'shell'/);
    expect(source).toMatch(/\\brg\\b\|\\bgrep\\b/);
  });

  it('logs raw payload to stderr when GITNEXUS_DEBUG is set (for contract diagnostics)', () => {
    expect(source).toContain('GITNEXUS_DEBUG');
    expect(source).toContain('GitNexus Cursor hook stdin:');
  });
});

// ─── Behavior: graceful no-op paths (no augment CLI invocation) ─────

describe('Cursor hook behavior — early-exit paths', () => {
  it('exits cleanly on empty stdin', () => {
    const result = spawnSync(process.execPath, [CURSOR_HOOK], {
      input: '',
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('exits cleanly on invalid JSON stdin', () => {
    const result = spawnSync(process.execPath, [CURSOR_HOOK], {
      input: 'not json at all',
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('produces no output when cwd is relative', () => {
    const result = runHook(CURSOR_HOOK, {
      tool_name: 'Grep',
      tool_input: { query: 'validateUser' },
      cwd: 'relative/path',
    });
    expect(result.stdout.trim()).toBe('');
    expect(result.status).toBe(0);
  });

  it('produces no output when cwd has no .gitnexus dir', () => {
    const result = runHook(CURSOR_HOOK, {
      tool_name: 'Grep',
      tool_input: { query: 'validateUser' },
      cwd: tmpDir,
    });
    expect(result.stdout.trim()).toBe('');
    expect(result.status).toBe(0);
  });

  it('produces no output for unknown tool names', () => {
    const result = runHook(CURSOR_HOOK, {
      tool_name: 'TotallyMadeUpTool',
      tool_input: { foo: 'bar' },
      cwd: tmpDir,
    });
    expect(result.stdout.trim()).toBe('');
    expect(result.status).toBe(0);
  });

  it('produces no output for Shell commands without rg/grep', () => {
    const result = runHook(CURSOR_HOOK, {
      tool_name: 'Shell',
      tool_input: { command: 'ls -la' },
      cwd: tmpDir,
    });
    expect(result.stdout.trim()).toBe('');
    expect(result.status).toBe(0);
  });

  it('produces no output for Grep with a 2-char query', () => {
    const result = runHook(CURSOR_HOOK, {
      tool_name: 'Grep',
      tool_input: { query: 'is' },
      cwd: tmpDir,
    });
    expect(result.stdout.trim()).toBe('');
    expect(result.status).toBe(0);
  });

  it('produces no output for Read whose basename has no identifier chars', () => {
    const result = runHook(CURSOR_HOOK, {
      tool_name: 'Read',
      tool_input: { target_file: '/tmp/--.md' },
      cwd: tmpDir,
    });
    expect(result.stdout.trim()).toBe('');
    expect(result.status).toBe(0);
  });

  it('produces no output for Read with no file path', () => {
    const result = runHook(CURSOR_HOOK, {
      tool_name: 'Read',
      tool_input: {},
      cwd: tmpDir,
    });
    expect(result.stdout.trim()).toBe('');
    expect(result.status).toBe(0);
  });

  it('treats tool_name case-insensitively (Grep vs grep)', () => {
    // Both should reach the same handler — and both should early-exit silently
    // because tmpDir has no .gitnexus.
    for (const toolName of ['Grep', 'grep', 'GREP']) {
      const result = runHook(CURSOR_HOOK, {
        tool_name: toolName,
        tool_input: { query: 'validateUser' },
        cwd: tmpDir,
      });
      expect(result.stdout.trim()).toBe('');
      expect(result.status).toBe(0);
    }
  });
});

// ─── Behavior: GITNEXUS_DEBUG payload logging ────────────────────────

describe('Cursor hook debug logging', () => {
  it('echoes the payload to stderr only when GITNEXUS_DEBUG is set', () => {
    const payload = {
      tool_name: 'Grep',
      tool_input: { query: 'validateUser' },
      cwd: tmpDir,
    };

    // GITNEXUS_DEBUG unset → stderr quiet.
    const quiet = spawnSync(process.execPath, [CURSOR_HOOK], {
      input: JSON.stringify(payload),
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GITNEXUS_DEBUG: '' },
    });
    expect(quiet.status).toBe(0);
    expect(quiet.stderr).not.toContain('GitNexus Cursor hook stdin');

    // GITNEXUS_DEBUG=1 → payload echoed to stderr (stdout still empty for
    // unindexed cwd, so the hook output contract is preserved).
    const verbose = spawnSync(process.execPath, [CURSOR_HOOK], {
      input: JSON.stringify(payload),
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GITNEXUS_DEBUG: '1' },
    });
    expect(verbose.status).toBe(0);
    expect(verbose.stderr).toContain('GitNexus Cursor hook stdin');
    expect(verbose.stderr).toContain('"tool_name":"Grep"');
    expect(verbose.stdout.trim()).toBe('');
  });
});

// ─── Source code regression: npx fallback stays under the host budget ─────

describe('Cursor hook npx fallback host budget', () => {
  const source = fs.readFileSync(CURSOR_HOOK, 'utf-8');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(path.dirname(CURSOR_HOOK), 'hooks.json'), 'utf-8'),
  );

  it('ships a postToolUse timeout with room for a cold npx install', () => {
    // Cold `npx -y gitnexus` has to download + install the package; the
    // original 10s budget killed the hook before the child could ever
    // finish. The existing manifest test only pins (0, 120).
    const seconds = manifest.hooks.postToolUse[0].timeout;
    expect(seconds).toBeGreaterThanOrEqual(30);
    expect(seconds).toBeLessThan(120);
  });

  it('sizes the npx timeout from the host budget with headroom', () => {
    // Extract runGitNexusCli so the assertions are tied to the actual
    // spawn wiring, not just to unrelated substrings elsewhere.
    const fnStart = source.indexOf('function runGitNexusCli');
    const fnBody = source.slice(fnStart, source.indexOf('\n}\n', fnStart));

    // budget comes from hooks.json (seconds → ms) and the elapsed hook time
    // is handed to the pure resolver, which owns the headroom arithmetic
    expect(fnBody).toContain('resolveNpxTimeoutMs(resolveCursorHostBudgetMs(), elapsed)');
    // the computed budget is what reaches spawnSync (not a bare +5000)
    expect(fnBody).toContain('timeout: npxTimeout');
    expect(fnBody).not.toMatch(/timeout:\s*timeout\s*\+\s*5000/);
    // npx grandchild is killed outright so it cannot keep the DB lock
    expect(fnBody).toMatch(/['"]-s['"]/);
    expect(fnBody).toMatch(/['"]KILL['"]/);
  });

  it('reads the shipped timeout value, not a detached literal', () => {
    // resolveCursorHostBudgetMs must parse hooks.json so changing the
    // manifest cannot silently desync from the hook budget.
    expect(source).toContain('postToolUse[0].timeout');
    expect(source).toContain('return seconds * 1000;');
  });
});

// ─── Behavioral: npx fallback budget arithmetic ─────────────────────
// resolveNpxTimeoutMs is the whole decision, pure and exported, so these
// assert the real numbers rather than grepping the hook for substrings.

describe('Cursor hook npx fallback budget', () => {
  const hook = require(CURSOR_HOOK) as {
    resolveNpxTimeoutMs: (hostBudgetMs: number, elapsedMs: number) => number | null;
  };
  const manifest = JSON.parse(
    fs.readFileSync(path.join(path.dirname(CURSOR_HOOK), 'hooks.json'), 'utf-8'),
  );
  const hostBudgetMs: number = manifest.hooks.postToolUse[0].timeout * 1000;
  const source = fs.readFileSync(CURSOR_HOOK, 'utf-8');
  // Same reason as below: the budget comments quote `timeout + 5000` to
  // explain what was removed, so strip `//` comments before matching code.
  const sourceCode = source
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');

  it('is no longer hard-capped at the old inner+5s budget', () => {
    // main() calls runGitNexusCli(..., 7000), so the previous
    // `Math.min(timeout + 5000, ...)` ceiling pinned every npx fallback at
    // 12000ms — exactly the cold `npx -y gitnexus` download the 60s manifest
    // was raised to accommodate. The budget must now follow the host window.
    const fresh = hook.resolveNpxTimeoutMs(hostBudgetMs, 0);
    expect(fresh).not.toBeNull();
    expect(fresh as number).toBeGreaterThan(7000 + 5000);
  });

  it('shrinks as the hook burns its host window', () => {
    // Past the MAX clamp the budget tracks the remaining window one-for-one:
    // each elapsed millisecond is one less millisecond for npx.
    const early = hook.resolveNpxTimeoutMs(hostBudgetMs, 20_000) as number;
    const later = hook.resolveNpxTimeoutMs(hostBudgetMs, 30_000) as number;
    expect(later).toBeLessThan(early);
    expect(early - later).toBe(10_000);
  });

  it('returns null once no usable budget remains, instead of a 1s floor', () => {
    // `Math.max(1000, ...)` used to hand the guard 1000ms of an ALREADY
    // EXPIRED window (plus a 2000ms spawnSync allowance), so the host killed
    // the hook before the guard could return or the final stdout write could
    // land. Exhausted must mean "do not start npx", never "start it anyway".
    expect(hook.resolveNpxTimeoutMs(hostBudgetMs, hostBudgetMs)).toBeNull();
    expect(hook.resolveNpxTimeoutMs(hostBudgetMs, hostBudgetMs + 5_000)).toBeNull();
    // 1ms of window left after CURSOR_NPX_HEADROOM_MS — still unusable
    expect(hook.resolveNpxTimeoutMs(hostBudgetMs, hostBudgetMs - 5_000 - 1)).toBeNull();
  });

  it('still allows a real budget right at the documented floor', () => {
    // Floor is CURSOR_NPX_MIN_BUDGET_MS (5000ms of window left after
    // CURSOR_NPX_HEADROOM_MS); one millisecond less skips. Pins the boundary
    // so the skip cannot drift into rejecting a budget that could actually
    // have completed.
    const windowLeft = hostBudgetMs - 5_000; // after headroom
    expect(hook.resolveNpxTimeoutMs(hostBudgetMs, windowLeft - 5_000)).toBe(5_000);
    expect(hook.resolveNpxTimeoutMs(hostBudgetMs, windowLeft - 4_999)).toBeNull();
  });

  it('clamps to a sane upper bound rather than the whole host window', () => {
    // One pathological install must not hold a per-repo hook slot for the
    // full 60s window and starve concurrent edits in the same repo.
    expect(hook.resolveNpxTimeoutMs(hostBudgetMs, 0)).toBe(45_000);
    // ...and the clamp only binds once the remaining window exceeds it
    expect(hook.resolveNpxTimeoutMs(hostBudgetMs, 15_000)).toBe(40_000);
  });

  it('no longer mentions the removed inner+5s ceiling anywhere', () => {
    expect(sourceCode).not.toMatch(/timeout\s*\+\s*5000/);
  });

  it('skips the npx spawn before resolving a guard when the budget is gone', () => {
    // Wiring check (the decision itself is covered behaviourally above):
    // the null return has to happen BEFORE the guard self-test spawn and
    // before any npx spawnSync, otherwise an exhausted window would still
    // pay for a self-test it has no budget to use.
    const fnStart = source.indexOf('function runGitNexusCli');
    const fnBody = source.slice(fnStart, source.indexOf('\n}\n', fnStart));
    const skipAt = fnBody.indexOf('if (npxTimeout === null)');
    expect(skipAt).toBeGreaterThan(-1);
    expect(fnBody.indexOf('resolveUnixGuardTimeout()')).toBeGreaterThan(skipAt);
    expect(fnBody.indexOf('npx.cmd')).toBeGreaterThan(skipAt);
  });
});

// ─── Behavioral: guard timeout resolution (F1 + F2) ────────────────
// resolveUnixGuardTimeout memoizes per module instance, so each case loads
// a FRESH copy of the hook rather than reusing the top-of-file require.

describe('Cursor hook guard timeout resolution', () => {
  const isUnix = process.platform !== 'win32';
  const source = fs.readFileSync(CURSOR_HOOK, 'utf-8');

  // This hook is deliberately dense with explanatory comments — several of
  // them quote the very paths being asserted on (to explain what an earlier
  // revision got wrong). Strip `//` comments so these source assertions
  // describe CODE, and cannot pass or fail on the prose around it.
  function codeOf(fnSignature: string): string {
    const start = source.indexOf(fnSignature);
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('\n}\n', start));
    return body
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
  }

  function freshHook(): {
    resolveUnixGuardTimeout: () => string | null;
  } {
    delete require.cache[require.resolve(CURSOR_HOOK)];
    return require(CURSOR_HOOK) as { resolveUnixGuardTimeout: () => string | null };
  }

  function withTimeoutPath<T>(value: string | undefined, fn: () => T): T {
    const prior = process.env.GITNEXUS_HOOK_TIMEOUT_PATH;
    if (value === undefined) delete process.env.GITNEXUS_HOOK_TIMEOUT_PATH;
    else process.env.GITNEXUS_HOOK_TIMEOUT_PATH = value;
    try {
      return fn();
    } finally {
      if (prior === undefined) delete process.env.GITNEXUS_HOOK_TIMEOUT_PATH;
      else process.env.GITNEXUS_HOOK_TIMEOUT_PATH = prior;
    }
  }

  it('looks for Homebrew gtimeout, not a Homebrew timeout', () => {
    // Homebrew's coreutils keg installs the GNU binary as `gtimeout`. Listing
    // `/opt/homebrew/bin/timeout` (as an earlier revision did) meant the
    // `-s KILL` orphan-containment wrap silently never engaged on Apple
    // Silicon, because every candidate is an absolute path and so the old
    // `which` fallback could never discover `gtimeout` either.
    const fnBody = codeOf('function resolveUnixGuardTimeout');
    expect(fnBody).toContain('/opt/homebrew/bin/gtimeout');
    expect(fnBody).toContain('/usr/local/bin/gtimeout');
    expect(fnBody).toContain('/usr/bin/timeout');
    expect(fnBody).toContain('/bin/timeout');
    expect(fnBody).not.toContain('/opt/homebrew/bin/timeout');
    expect(fnBody).not.toContain('/usr/local/bin/timeout');
    // The `which` probe is gone: it could never fire for absolute paths and
    // would only re-introduce PATH-dependent, unvalidated adoption.
    expect(fnBody).not.toContain('which');
  });

  it.skipIf(!isUnix)('does not adopt an always-exit-0 stub as the guard', () => {
    // GITNEXUS_HOOK_TIMEOUT_PATH=/bin/true passes a bare existsSync
    // check. The wrapped spawn then "succeeded" instantly without ever
    // running npx, and status 0 + empty stderr satisfies main()'s
    // `!child.error && child.status === 0` check — so the hook emitted NO
    // augmentation at all: a silently dead hook, not a visible failure.
    // Hermetic stub (not /bin/true, which macOS 15+ no longer ships).
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-guard-stub-'));
    const stub = path.join(stubDir, 'stub-timeout');
    try {
      fs.writeFileSync(stub, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const resolved = withTimeoutPath(stub, () => freshHook().resolveUnixGuardTimeout());
      expect(resolved).not.toBe(stub);
    } finally {
      fs.rmSync(stubDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!isUnix)('resolves a relative override against this process, not the tool cwd', () => {
    // runGitNexusCli spawns with the tool request's cwd, so a relative
    // override would ENOENT there — or, slashless, silently become a PATH
    // lookup. path.resolve makes the adopted path absolute.
    const resolved = withTimeoutPath('some/wrapper', () => freshHook().resolveUnixGuardTimeout());
    expect(resolved).not.toBe('some/wrapper');
  });

  it.skipIf(!isUnix)('honours the disabled sentinel', () => {
    expect(withTimeoutPath('disabled', () => freshHook().resolveUnixGuardTimeout())).toBeNull();
  });

  it.skipIf(!isUnix)(
    'only ever adopts a guard that runs the command AND propagates its exit status',
    () => {
      // Independent re-derivation of the contract: whatever the resolver
      // returns must be a real coreutils timeout/gtimeout AND must actually
      // propagate a non-zero exit. null is also a valid answer (no wrapper
      // installed here), but never a silently-dead substitute.
      const resolved = withTimeoutPath(undefined, () => freshHook().resolveUnixGuardTimeout());
      if (resolved === null) return; // nothing installed to validate
      expect(path.basename(resolved)).toMatch(/^g?timeout$/);
      const probe = spawnSync(resolved, ['-k', '1', '1', '/bin/sh', '-c', 'exit 42'], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      expect(probe.error).toBeUndefined();
      expect(probe.status).toBe(42);
    },
  );

  it.skipIf(!isUnix)('self-tests candidates with the -k exit-propagation probe', () => {
    // The adoption test itself, pinned so it cannot be weakened back to an
    // existence check: it must run a wrapped /bin/sh and observe exit 42.
    expect(source).toContain("['-k', '1', '1', '/bin/sh', '-c', 'exit 42']");
    expect(source).toContain('!selfTest.error && selfTest.status === 42');
  });
});

// ─── Source code regression: concurrency guard (#1486) ─────────────

describe('Cursor hook concurrency guard', () => {
  const source = fs.readFileSync(CURSOR_HOOK, 'utf-8');
  const lockSource = fs.readFileSync(CURSOR_HOOK_LOCK, 'utf-8');

  it('loads acquireHookSlot helper module', () => {
    expect(source).toContain('acquireHookSlot');
    expect(source).toContain('hook-lock.cjs');
  });

  it('helper defines acquireHookSlot with MAX_INFLIGHT constant', () => {
    expect(lockSource).toContain('function acquireHookSlot');
    expect(lockSource).toContain('HOOK_LOCK_MAX_INFLIGHT');
  });

  it('calls acquireHookSlot in main() and releases via finally', () => {
    // The Cursor hook uses a flat main() dispatcher rather than a separate
    // handlePreToolUse — assert the guard call + finally release wiring is
    // present so a future refactor cannot accidentally skip it.
    expect(source).toContain('acquireHookSlot(');
    expect(source).toMatch(/finally\s*\{[^}]*release\(\)/s);
  });

  it('uses atomic fixed-name slot files (hard cap, not soft TOCTOU cap)', () => {
    expect(lockSource).toMatch(/slot-\$\{slot\}\.lock|`slot-/);
    const slotFn = lockSource.slice(
      lockSource.indexOf('function acquireHookSlot'),
      lockSource.indexOf('function', lockSource.indexOf('function acquireHookSlot') + 1),
    );
    expect(slotFn).not.toContain('readdirSync');
  });

  it('fails closed when lock dir cannot be created', () => {
    // Regression: see hooks.test.ts. The mkdirSync catch must return null
    // (skip augment) rather than `() => {}` (proceed unguarded), so that
    // a read-only or cross-user `.gitnexus/` cannot reintroduce #1486.
    const slotFn = lockSource.slice(
      lockSource.indexOf('function acquireHookSlot'),
      lockSource.indexOf('function', lockSource.indexOf('function acquireHookSlot') + 1),
    );
    const mkdirCatch = slotFn.slice(
      slotFn.indexOf('fs.mkdirSync(lockDir'),
      slotFn.indexOf('const myPidStr'),
    );
    expect(mkdirCatch).toContain('return null');
    expect(mkdirCatch).not.toMatch(/return\s*\(\s*\)\s*=>\s*\{\s*\}/);
  });

  // Note: the 10-concurrent-spawner burst test that validates `wx`
  // (O_CREAT|O_EXCL) under simultaneous contention lives in
  // hooks.test.ts. The Cursor hook uses byte-for-byte the same
  // acquireHookSlot, so duplicating the burst test here would only test
  // the OS primitive, not Cursor-specific wiring. The source-level checks
  // above guarantee the Cursor hook keeps calling that same algorithm.
});

// ─── Integration: concurrency guard skips when slots are full ──────

describe('Cursor hook concurrency guard (integration)', () => {
  it('exits silently when all MAX_INFLIGHT slots hold live pids', async () => {
    const { spawn } = await import('child_process');
    const lockDir = path.join(guardGitNexusDir, '.hook-locks');
    fs.mkdirSync(lockDir, { recursive: true });

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

      const result = runHook(CURSOR_HOOK, {
        tool_name: 'Grep',
        tool_input: { query: 'validateUser' },
        cwd: guardTmpDir,
      });

      expect(result.stdout.trim()).toBe('');
      for (let i = 0; i < sleepers.length; i++) {
        const p = path.join(lockDir, `slot-${i}.lock`);
        expect(fs.existsSync(p)).toBe(true);
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

  it('reclaims a slot held by a dead pid', () => {
    const lockDir = path.join(guardGitNexusDir, '.hook-locks');
    fs.mkdirSync(lockDir, { recursive: true });
    const deadPid = 2_147_483_640;
    const stalePath = path.join(lockDir, 'slot-0.lock');
    try {
      fs.writeFileSync(stalePath, String(deadPid));
      expect(fs.readFileSync(stalePath, 'utf-8').trim()).toBe(String(deadPid));

      runHook(CURSOR_HOOK, {
        tool_name: 'Grep',
        tool_input: { query: 'validateUser' },
        cwd: guardTmpDir,
      });

      // The hook reclaimed and then released slot-0 — either gone (released)
      // or no longer owned by the dead pid.
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
});

// ─── Shell pattern parsing ──────────────────────────────────────────

describe('Shell quoted-pattern parser', () => {
  it.each([
    ['rg "User Service" src/', 'User Service'],
    ["grep 'error boundary' -- src/", 'error boundary'],
    ['rg User\\ Service src/', 'User Service'],
    [String.raw`rg "C:\Users" src/`, String.raw`C:\Users`],
    ['rg -e "User Service" src/', 'User Service'],
    ['rg --regexp=UserService src/', 'UserService'],
    ['grep -eUserService src/', 'UserService'],
    ['rg -e x -e LongPattern src/', 'LongPattern'],
    ['rg -ex -eLongPattern src/', 'LongPattern'],
    ['rg --regexp=x --regexp=LongPattern src/', 'LongPattern'],
    ['/usr/bin/rg -- "User Service" src/', 'User Service'],
    ['rg -- -error src/', '-error'],
    [String.raw`C:\Users\me\bin\rg.exe UserService src/`, 'UserService'],
    ['rg.exe "validateUser" src/', 'validateUser'],
    ['grep.cmd -e LongPattern src/', 'LongPattern'],
    ['cd grep && rg LongPattern src/', 'LongPattern'],
    ['npx rg "User Service" src/', 'User Service'],
    ['npx --yes rg UserService src/', 'UserService'],
    ['npx --package rg grep LongPattern src/', 'LongPattern'],
    ['rg UserService; echo done', 'UserService'],
    ['rg UserService&& echo done', 'UserService'],
    ['rg --max-count 100 UserService src/', 'UserService'],
    ['grep -r UserService src/', 'UserService'],
    ['rg --replace x UserService src/', 'UserService'],
    ['git grep UserService src/', 'UserService'],
  ])('extracts %j from %j', (command, expected) => {
    expect(parseRgGrepPattern(command)).toBe(expected);
  });

  it.each([
    ['rg --regexp= src/'],
    ['rg --regexp="" src/'],
    ['rg -e x -- LongPattern src/'],
    ['rg -f patterns.txt src/'],
    ['rg --file=patterns.txt src/'],
    ['rg -eab src/'],
    ['sudo echo rg UserService src/'],
  ])('extracts no pattern from %j', (command) => {
    expect(parseRgGrepPattern(command)).toBeNull();
  });

  it('does not treat a path after a short explicit pattern as the pattern', () => {
    expect(parseRgGrepPattern('rg -e x src/')).toBeNull();
  });

  it('keeps single-token quoted patterns intact', () => {
    expect(parseRgGrepPattern('rg "validateUser"')).toBe('validateUser');
  });

  it('keeps backslashes in unquoted Windows paths but honours escaped spaces', () => {
    expect(tokenizeShellWords(String.raw`C:\foo\bar`)).toEqual([String.raw`C:\foo\bar`]);
    expect(tokenizeShellWords('User\\ Service')).toEqual(['User Service']);
    expect(tokenizeShellWords('trailing\\')).toEqual(['trailing\\']);
  });

  it('splits unquoted shell operators from adjacent arguments', () => {
    expect(tokenizeShellWords('rg UserService; echo done')).toEqual([
      'rg',
      'UserService',
      ';',
      'echo',
      'done',
    ]);
    expect(tokenizeShellWords("rg 'UserService; echo done'")).toEqual([
      'rg',
      'UserService; echo done',
    ]);
  });
});

// ─── Install docs ─────────────────────────────────────────────────────

describe('Cursor integration install docs', () => {
  const integrationReadme = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    'gitnexus-cursor-integration',
    'README.md',
  );

  it('install README exists', () => {
    expect(fs.existsSync(integrationReadme)).toBe(true);
  });

  it('install README documents the hook install path', () => {
    const body = fs.readFileSync(integrationReadme, 'utf-8');
    expect(body).toContain('.cursor/hooks.json');
    expect(body).toContain('hooks/gitnexus-hook.cjs');
    expect(body).toContain('hooks/hook-lock.cjs');
    expect(body).toContain('Hook install');
  });

  it('install README documents GITNEXUS_DEBUG for payload diagnostics', () => {
    const body = fs.readFileSync(integrationReadme, 'utf-8');
    expect(body).toContain('GITNEXUS_DEBUG');
  });
});

// ─── Output parser sanity (synthetic JSON) ──────────────────────────

describe('parseCursorOutput', () => {
  it('parses a well-formed { additional_context } payload', () => {
    const parsed = parseCursorOutput('{"additional_context":"hello"}');
    expect(parsed).not.toBeNull();
    expect(parsed?.additional_context).toBe('hello');
  });

  it('returns null on empty stdout', () => {
    expect(parseCursorOutput('')).toBeNull();
    expect(parseCursorOutput('   \n')).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    expect(parseCursorOutput('not json')).toBeNull();
  });
});
