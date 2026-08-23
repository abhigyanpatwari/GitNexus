/**
 * Tests: GitNexus Factory AI (Droid) plugin
 *
 * Covers the standalone `gitnexus-factory-plugin/` used by `droid plugin
 * install`:
 * - manifest + hook wiring (plugin.json / mcp.json / hooks.json)
 * - the PostToolUse search-augment hook's guard reuse and early-exit behavior
 * - a drift guard proving the bundled guard modules are byte-identical to the
 *   canonical Claude-adapter copies (so a fix to one can't silently skip the
 *   other)
 *
 * The augment fan-out guard (acquireHookSlot) and the LadybugDB owner probe are
 * the exact modules the Claude/Codex adapter ships; their internals are covered
 * by hooks.test.ts and hook-db-lock-probe.test.ts. Here we assert the Factory
 * hook WIRES them and behaves correctly on the Factory-specific paths.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  runHook,
  parseHookOutput,
  createHookToolDir,
  hookEnv,
} from '../utils/hook-test-helpers.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const PLUGIN_DIR = path.join(REPO_ROOT, 'gitnexus-factory-plugin');
const HOOK = path.join(PLUGIN_DIR, 'hooks', 'gitnexus-hook.js');
const HOOKS_JSON = path.join(PLUGIN_DIR, 'hooks', 'hooks.json');
const PLUGIN_JSON = path.join(PLUGIN_DIR, '.factory-plugin', 'plugin.json');
const MCP_JSON = path.join(PLUGIN_DIR, 'mcp.json');
const CLAUDE_HOOKS = path.join(REPO_ROOT, 'gitnexus-claude-plugin', 'hooks');

// Guard modules bundled into the Factory plugin, kept byte-identical to the
// canonical Claude-adapter copies.
const BUNDLED_GUARDS = ['hook-lock.js', 'hook-db-lock-probe.cjs', 'win-rm-list-json.ps1'] as const;

const require_ = createRequire(import.meta.url);
const { parseRgGrepPattern } = require_(HOOK) as {
  parseRgGrepPattern: (command: string) => string | null;
};

// ─── Manifest / file presence ───────────────────────────────────────

describe('Factory plugin files', () => {
  it('ships the hook, its guards, and both manifests', () => {
    for (const p of [
      HOOK,
      HOOKS_JSON,
      PLUGIN_JSON,
      MCP_JSON,
      ...BUNDLED_GUARDS.map((f) => path.join(PLUGIN_DIR, 'hooks', f)),
    ]) {
      expect(fs.existsSync(p), `${p} should exist`).toBe(true);
    }
  });

  it('.factory-plugin holds only plugin.json (Factory manifest contract)', () => {
    expect(fs.readdirSync(path.join(PLUGIN_DIR, '.factory-plugin'))).toEqual(['plugin.json']);
  });
});

// ─── Drift guard: bundled guards === canonical Claude copies ─────────

describe('Factory plugin bundled guards stay in lockstep with the Claude adapter', () => {
  for (const f of BUNDLED_GUARDS) {
    it(`${f} is byte-identical to the canonical copy`, () => {
      const bundled = fs.readFileSync(path.join(PLUGIN_DIR, 'hooks', f));
      const canonical = fs.readFileSync(path.join(CLAUDE_HOOKS, f));
      expect(bundled.equals(canonical)).toBe(true);
    });
  }
});

// ─── plugin.json ────────────────────────────────────────────────────

describe('Factory plugin.json', () => {
  const manifest = JSON.parse(fs.readFileSync(PLUGIN_JSON, 'utf-8'));

  it('is named gitnexus', () => {
    expect(manifest.name).toBe('gitnexus');
  });

  it('version matches gitnexus/package.json (single source of truth)', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'gitnexus', 'package.json'), 'utf-8'),
    );
    expect(manifest.version).toBe(pkg.version);
  });
});

// ─── mcp.json ───────────────────────────────────────────────────────

describe('Factory mcp.json', () => {
  const mcp = JSON.parse(fs.readFileSync(MCP_JSON, 'utf-8'));

  it('registers the gitnexus MCP server under mcpServers', () => {
    expect(mcp.mcpServers?.gitnexus?.command).toBe('npx');
    expect(mcp.mcpServers.gitnexus.args).toContain('mcp');
  });

  // Executed state, not quickstart docs: `@latest` would let a future registry
  // upload run on MCP connect without a plugin revision.
  it('pins the CLI to the released version instead of a mutable tag', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'gitnexus', 'package.json'), 'utf-8'),
    );
    expect(mcp.mcpServers.gitnexus.args).toContain(`gitnexus@${pkg.version}`);
    expect(JSON.stringify(mcp)).not.toContain('gitnexus@latest');
  });
});

// ─── hooks.json wiring ──────────────────────────────────────────────

describe('Factory hooks.json wiring', () => {
  const manifest = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf-8'));
  const entry = manifest.PostToolUse[0];

  it('registers a PostToolUse hook', () => {
    expect(Array.isArray(manifest.PostToolUse)).toBe(true);
  });

  it('matches Factory search tools (Grep, Glob, Execute — not Bash)', () => {
    expect(entry.matcher).toBe('Grep|Glob|Execute');
    expect(entry.matcher).not.toMatch(/\bBash\b/);
  });

  it('invokes the hook via the ${DROID_PLUGIN_ROOT} plugin-root variable', () => {
    const command: string = entry.hooks[0].command;
    expect(command).toContain('${DROID_PLUGIN_ROOT}');
    expect(command).toContain('hooks/gitnexus-hook.js');
  });

  it('declares timeout in seconds (not milliseconds)', () => {
    const timeout: number = entry.hooks[0].timeout;
    expect(typeof timeout).toBe('number');
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThan(120);
  });
});

// ─── Source regressions ─────────────────────────────────────────────

describe('Factory hook source regressions', () => {
  const source = fs.readFileSync(HOOK, 'utf-8');

  it('wires the augment fan-out guard (acquireHookSlot + finally release)', () => {
    expect(source).toContain("require('./hook-lock.js')");
    expect(source).toContain('acquireHookSlot(');
    expect(source).toMatch(/finally\s*\{[^}]*release\(\)/s);
  });

  it('wires the LadybugDB owner probe before running augment', () => {
    expect(source).toContain("require('./hook-db-lock-probe.cjs')");
    expect(source).toContain('hasGitNexusDbLockedByGitNexusServer(');
  });

  it('never passes shell: true / shell: isWin to spawnSync (injection risk)', () => {
    for (const line of source.split('\n')) {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*')) continue;
      expect(/shell:\s*(true|isWin)/.test(line), `injection risk: ${t}`).toBe(false);
    }
  });

  it('invokes npx.cmd directly on Windows instead of a shell', () => {
    expect(source).toContain('npx.cmd');
  });

  // The npx fallback runs on ordinary tool calls whenever the CLI is not on
  // PATH, so an unpinned ref would execute whatever currently owns the tag.
  it('pins the npx fallback to the manifest version, never a mutable tag', () => {
    expect(source).not.toContain('gitnexus@latest');
    expect(source).toContain("require('../.factory-plugin/plugin.json')");
    expect(source).toContain('`gitnexus@${PINNED_VERSION}`');
  });

  // Windows regression: Node refuses to spawn the .cmd launcher shims without a
  // shell (CVE-2024-27980), so `node <cliPath>` is the only branch that runs
  // there. Same escape hatch the Claude adapter honors.
  it('prefers GITNEXUS_HOOK_CLI_PATH via process.execPath', () => {
    expect(source).toContain('GITNEXUS_HOOK_CLI_PATH');
    expect(source).toMatch(/spawnSync\(\s*process\.execPath/);
  });

  it('passes the pattern after the -- end-of-options marker', () => {
    expect(source).toMatch(/'augment',\s*'--',\s*pattern/);
  });

  it('validates cwd is absolute and gates on a non-registry .gitnexus dir', () => {
    expect(source).toMatch(/path\.isAbsolute\(cwd\)/);
    expect(source).toContain('isGlobalRegistryDir');
  });

  it('emits Factory-shape hookSpecificOutput.additionalContext', () => {
    expect(source).toContain('hookSpecificOutput');
    expect(source).toContain('additionalContext');
  });

  it('rejects patterns shorter than 3 chars', () => {
    expect(source).toMatch(/length\s*<\s*3/);
  });
});

// ─── Execute pattern parsing (shares the Cursor adapter's #2938 matrix) ─

describe('Factory Execute pattern parser', () => {
  it.each([
    ['rg "User Service" src/', 'User Service'],
    ["grep 'error boundary' -- src/", 'error boundary'],
    ['rg User\\ Service src/', 'User Service'],
    [String.raw`rg "C:\Users" src/`, String.raw`C:\Users`],
    ['rg -e "User Service" src/', 'User Service'],
    ['rg --regexp=UserService src/', 'UserService'],
    ['grep -eUserService src/', 'UserService'],
    ['/usr/bin/rg -- "User Service" src/', 'User Service'],
    ['rg -- -error src/', '-error'],
    ['rg "validateUser"', 'validateUser'],
    ['rg -t ts UserService src/', 'UserService'],
    ['rg --glob "*.ts" UserService', 'UserService'],
    ['rg ab src/', null],
  ])('extracts %j from %j', (command, expected) => {
    expect(parseRgGrepPattern(command)).toBe(expected);
  });
});

// ─── Behavior: early-exit paths (no augment spawned) ────────────────

describe('Factory hook behavior — early exits', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-factory-early-'));
  });
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('exits cleanly on empty stdin', () => {
    const r = spawnSync(process.execPath, [HOOK], {
      input: '',
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('exits cleanly on invalid JSON stdin', () => {
    const r = spawnSync(process.execPath, [HOOK], {
      input: 'not json',
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('ignores non-PostToolUse events', () => {
    const r = runHook(HOOK, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Grep',
      tool_input: { pattern: 'validateUser' },
      cwd: tmpDir,
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('produces no output when cwd is relative', () => {
    const r = runHook(HOOK, {
      hook_event_name: 'PostToolUse',
      tool_name: 'Grep',
      tool_input: { pattern: 'validateUser' },
      cwd: 'relative/path',
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('produces no output when cwd has no .gitnexus index', () => {
    const r = runHook(HOOK, {
      hook_event_name: 'PostToolUse',
      tool_name: 'Grep',
      tool_input: { pattern: 'validateUser' },
      cwd: tmpDir,
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('produces no output for unmatched tools or Execute without rg/grep', () => {
    for (const input of [
      { tool_name: 'MadeUpTool', tool_input: { foo: 'bar' } },
      { tool_name: 'Execute', tool_input: { command: 'ls -la' } },
      { tool_name: 'Grep', tool_input: { pattern: 'is' } }, // < 3 chars
    ]) {
      const r = runHook(HOOK, { hook_event_name: 'PostToolUse', cwd: tmpDir, ...input });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    }
  });
});

// ─── Behavior: happy path (augment via a fake gitnexus on PATH) ─────

describe('Factory hook behavior — augment', () => {
  let repoDir: string;
  let binDir: string;

  beforeAll(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-factory-repo-'));
    // Bare .gitnexus/ (no registry.json/repos) → treated as a repo index; no
    // `lbug` file → the DB-owner probe short-circuits false and augment runs.
    fs.mkdirSync(path.join(repoDir, '.gitnexus'), { recursive: true });
    binDir = createHookToolDir({ gitnexusStderr: '[GitNexus] graph context for validateUser' });
  });
  afterAll(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  it('emits augment stderr as additionalContext for a Grep search', () => {
    const r = runHook(
      HOOK,
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Grep',
        tool_input: { pattern: 'validateUser' },
        cwd: repoDir,
      },
      undefined,
      { env: hookEnv(binDir) },
    );
    expect(r.status).toBe(0);
    const out = parseHookOutput(r.stdout);
    expect(out?.hookEventName).toBe('PostToolUse');
    expect(out?.additionalContext).toContain('graph context for validateUser');
  });
});

// ─── Behavior: fan-out guard skips when all slots are held ──────────

describe('Factory hook behavior — augment fan-out guard', () => {
  it('exits silently when all MAX_INFLIGHT slots hold live pids', async () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-factory-slots-'));
    const lockDir = path.join(repoDir, '.gitnexus', '.hook-locks');
    fs.mkdirSync(lockDir, { recursive: true });
    const binDir = createHookToolDir({ gitnexusStderr: 'should never be emitted' });

    const { spawn } = await import('child_process');
    const sleepers = [0, 1, 2].map(() =>
      spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' }),
    );
    try {
      sleepers.forEach((s, i) =>
        fs.writeFileSync(path.join(lockDir, `slot-${i}.lock`), String(s.pid)),
      );

      const r = runHook(
        HOOK,
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'Grep',
          tool_input: { pattern: 'validateUser' },
          cwd: repoDir,
        },
        undefined,
        { env: hookEnv(binDir) },
      );

      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    } finally {
      for (const s of sleepers) {
        try {
          s.kill();
        } catch {
          /* ignore */
        }
      }
      fs.rmSync(repoDir, { recursive: true, force: true });
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });
});
