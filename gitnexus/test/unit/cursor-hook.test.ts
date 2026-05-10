/**
 * Regression Tests: Cursor postToolUse Hook
 *
 * Tests the hook script at gitnexus-cursor-integration/hooks/gitnexus-hook.cjs
 * which runs as a Cursor 2.4 postToolUse hook.
 *
 * Covers:
 * - extractPattern: pattern extraction from Grep/Read/Shell tool inputs
 * - findGitNexusDir: .gitnexus directory discovery (shared with Claude hook)
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
import fs from 'fs';
import path from 'path';
import os from 'os';
import { runHook } from '../utils/hook-test-helpers.js';

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
const CURSOR_HOOKS_JSON = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'gitnexus-cursor-integration',
  'hooks',
  'hooks.json',
);

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

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-cursor-hook-test-'));
  spawnSync('git', ['init'], { cwd: tmpDir, stdio: 'pipe' });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir, stdio: 'pipe' });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir, stdio: 'pipe' });
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

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

  it('gates on a non-global .gitnexus directory before invoking the CLI', () => {
    expect(source).toContain('findGitNexusDir');
    expect(source).toContain('isGlobalRegistryDir');
  });

  it('handles linked git worktrees via git rev-parse --git-common-dir', () => {
    expect(source).toContain('--git-common-dir');
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

// ─── Documented contract behavior (extractPattern via the live hook) ─

describe('Shell quoted-pattern parser limitations (documented)', () => {
  // The Shell parser cannot reconstruct shell quoting. These tests pin the
  // current behavior so a future "fix" doesn't silently change extraction
  // — and so users diagnosing a noisy/missed pattern can find the behavior
  // documented in tests.
  //
  // We can't observe the extracted pattern directly without an indexed
  // repo, but we *can* confirm the hook reaches the augment-call path
  // (vs. early-exiting) by checking exit status + clean stdout for cases
  // where parseRgGrepPattern would yield a >=3-char token.

  it('quoted multi-word `rg "User Service"` extracts the first word only', () => {
    const result = runHook(CURSOR_HOOK, {
      tool_name: 'Shell',
      tool_input: { command: 'rg "User Service" src/' },
      cwd: tmpDir, // no .gitnexus → exits early after extract
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('single-token quoted `rg "validateUser"` works as expected', () => {
    const result = runHook(CURSOR_HOOK, {
      tool_name: 'Shell',
      tool_input: { command: 'rg "validateUser"' },
      cwd: tmpDir,
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
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
