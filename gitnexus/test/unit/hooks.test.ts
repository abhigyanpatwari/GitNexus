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
import fs from 'fs';
import path from 'path';
import os from 'os';
import { runHook, parseHookOutput } from '../utils/hook-test-helpers.js';

// ─── Paths to both hook variants ────────────────────────────────────

const CJS_HOOK = path.resolve(__dirname, '..', '..', 'hooks', 'claude', 'gitnexus-hook.cjs');
const CJS_HOOK_LOCK = path.resolve(__dirname, '..', '..', 'hooks', 'claude', 'hook-lock.cjs');
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

// ─── Test fixtures: temporary .gitnexus directory ───────────────────

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

function writeExecutable(filePath: string, content: string) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

function createHookToolDir(options: {
  gitnexusStderr?: string;
  gitnexusMarkerPath?: string;
  lsofOutput?: string;
  lsofOutputLines?: string[];
  psOutput?: string;
  psOutputByPid?: Record<string, string>;
  lsofSleepMs?: number;
}) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-hook-bin-'));
  const gitnexusStderr = JSON.stringify(options.gitnexusStderr ?? '');
  const markerPath = JSON.stringify(options.gitnexusMarkerPath ?? '');

  const fakeGitNexus = `#!/usr/bin/env node\nconst fs = require('fs');\nconst marker = ${markerPath};\nif (marker) fs.writeFileSync(marker, 'called');\nprocess.stderr.write(${gitnexusStderr});\n`;
  writeExecutable(path.join(binDir, 'gitnexus'), fakeGitNexus);
  writeExecutable(path.join(binDir, 'gitnexus-cli.js'), fakeGitNexus);

  const lsofOutput =
    options.lsofOutputLines != null
      ? options.lsofOutputLines.join('\n') + (options.lsofOutputLines.length ? '\n' : '')
      : (options.lsofOutput ?? '');
  const lsofBody =
    options.lsofSleepMs != null
      ? `#!/usr/bin/env node\nsetTimeout(() => {}, ${Number(options.lsofSleepMs)});\n`
      : `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(lsofOutput)});\nprocess.exit(0);\n`;
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

function hookEnv(binDir: string) {
  return {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
    GITNEXUS_HOOK_CLI_PATH: path.join(binDir, 'gitnexus-cli.js'),
    GITNEXUS_HOOK_LSOF_PATH: path.join(binDir, 'lsof'),
    GITNEXUS_HOOK_PS_PATH: path.join(binDir, 'ps'),
  };
}

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

describe('PreToolUse concurrency guard (integration)', () => {
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
    });
  }
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

    it.skipIf(process.platform === 'win32')(
      `${label}: skips augment when a GitNexus MCP process owns the repo DB`,
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
            { env: hookEnv(binDir) },
          );

          expect(result.stdout.trim()).toBe('');
          expect(result.status).toBe(0);
          expect(result.stderr).toContain('[GitNexus] augment skipped');
          expect(fs.existsSync(markerPath)).toBe(false);
        } finally {
          fs.rmSync(markerPath, { force: true });
          fs.rmSync(binDir, { recursive: true, force: true });
        }
      },
    );
  }
});

describe.skipIf(process.platform === 'win32')(
  'Ladybug DB owner guard — production-shaped ps + failure modes (#1493)',
  () => {
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
            { env: hookEnv(binDir) },
          );
          expect(result.stdout.trim()).toBe('');
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
            { env: hookEnv(binDir) },
          );
          expect(result.stdout.trim()).toBe('');
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
          const env = {
            ...hookEnv(binDir),
            GITNEXUS_HOOK_LSOF_PATH: path.join(binDir, '__missing_lsof__'),
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
        } finally {
          fs.rmSync(markerPath, { force: true });
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
            { env: hookEnv(binDir) },
          );
          expect(result.stdout.trim()).toBe('');
          expect(result.status).toBe(0);
          expect(result.stderr).toContain('[GitNexus] augment skipped');
          expect(fs.existsSync(markerPath)).toBe(false);
        } finally {
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
            { env: hookEnv(binDir) },
          );
          expect(result.stdout.trim()).toBe('');
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
        const lbugPath = path.join(gitNexusDir, 'lbug');
        fs.writeFileSync(lbugPath, '');
        fs.rmSync(markerPath, { force: true });
        const binDir = createHookToolDir({
          gitnexusMarkerPath: markerPath,
          gitnexusStderr: '[GitNexus] 1 related symbol found:\n\nvalidateUser (src/auth.ts)\n',
          lsofOutput: '99905\n',
          psOutput: '',
        });
        try {
          const env = {
            ...hookEnv(binDir),
            GITNEXUS_HOOK_PS_PATH: path.join(binDir, '__missing_ps__'),
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
        } finally {
          fs.rmSync(markerPath, { force: true });
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
