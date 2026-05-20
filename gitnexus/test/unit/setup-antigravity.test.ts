/**
 * Regression Tests: Antigravity setup + hook adapter
 *
 * Covers:
 * - setupAntigravity: detection of ~/.gemini/antigravity, MCP write, preserve
 *   existing keys, corrupt-file handling, skips when not installed.
 * - installAntigravityHooks: writes ~/.gemini/config/hooks.json with the
 *   `gitnexus` group containing PreToolUse + PostToolUse entries; copies
 *   the adapter and lock helpers to ~/.gemini/config/hooks/gitnexus/;
 *   idempotent across re-runs.
 * - installAntigravitySkills: lays out skills under ~/.gemini/antigravity/skills/.
 * - hook adapter: PostToolUse stdout is always `{}`; stale-index hint lands
 *   on stderr; ignores non-git run_command invocations.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';

const PKG_VERSION = (createRequire(import.meta.url)('../../package.json') as { version: string })
  .version;
const NPX_REF = `gitnexus@${PKG_VERSION}`;

// vi.hoisted lets the mock factory below (which is hoisted by Vitest) see
// these vi.fn instances. Plain top-level consts would be unreachable at
// hoist time, hence the error this pattern avoids.
const mocks = vi.hoisted(() => ({
  execFileMock: vi.fn((...args: any[]) => {
    const callback = args.at(-1);
    if (typeof callback === 'function') callback(null, '', '');
  }),
  execFileSyncMock: vi.fn(() => {
    throw new Error('not found');
  }),
}));

vi.mock('child_process', async () => {
  // Partial mock: real spawnSync is needed for the hook-adapter tests below
  // to actually invoke the .cjs script as a child process.
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFile: mocks.execFileMock,
    execFileSync: mocks.execFileSyncMock,
  };
});

describe('setupAntigravity', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-antigravity-setup-'));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;

    // Only create ~/.gemini/antigravity — no other editor dirs so their
    // setup branches skip and don't pollute assertions.
    await fs.mkdir(path.join(tempHome, '.gemini', 'antigravity'), { recursive: true });

    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it('writes MCP config to ~/.gemini/antigravity/mcp_config.json', async () => {
    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(
      path.join(tempHome, '.gemini', 'antigravity', 'mcp_config.json'),
      'utf-8',
    );
    const config = JSON.parse(raw);

    expect(config.mcpServers.gitnexus).toEqual({
      command: 'npx',
      args: ['-y', NPX_REF, 'mcp'],
    });
  });

  it('skips when ~/.gemini/antigravity does not exist', async () => {
    await fs.rm(path.join(tempHome, '.gemini'), { recursive: true, force: true });

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    await expect(
      fs.access(path.join(tempHome, '.gemini', 'antigravity', 'mcp_config.json')),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(tempHome, '.gemini', 'config', 'hooks.json')),
    ).rejects.toThrow();
  });

  it('preserves existing keys in mcp_config.json', async () => {
    const mcpPath = path.join(tempHome, '.gemini', 'antigravity', 'mcp_config.json');
    await fs.writeFile(
      mcpPath,
      JSON.stringify({ existingKey: 'keep-me', mcpServers: { other: { command: 'foo' } } }),
      'utf-8',
    );

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(mcpPath, 'utf-8');
    const config = JSON.parse(raw);

    expect(config.existingKey).toBe('keep-me');
    expect(config.mcpServers.other).toEqual({ command: 'foo' });
    expect(config.mcpServers.gitnexus).toBeDefined();
  });

  it('leaves a corrupt mcp_config.json untouched', async () => {
    const mcpPath = path.join(tempHome, '.gemini', 'antigravity', 'mcp_config.json');
    const corrupt = '{ definitely not json !!!';
    await fs.writeFile(mcpPath, corrupt, 'utf-8');

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(mcpPath, 'utf-8');
    expect(raw).toBe(corrupt);
  });

  it('writes hooks.json with PreToolUse and PostToolUse under gitnexus group', async () => {
    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(path.join(tempHome, '.gemini', 'config', 'hooks.json'), 'utf-8');
    const config = JSON.parse(raw);

    expect(config.gitnexus.PreToolUse).toBeInstanceOf(Array);
    expect(config.gitnexus.PreToolUse[0].matcher).toBe('grep_search|run_command');
    expect(config.gitnexus.PreToolUse[0].hooks[0].command).toMatch(
      /gitnexus-antigravity-hook\.cjs/,
    );

    expect(config.gitnexus.PostToolUse).toBeInstanceOf(Array);
    expect(config.gitnexus.PostToolUse[0].matcher).toBe('run_command');
    expect(config.gitnexus.PostToolUse[0].hooks[0].command).toMatch(
      /gitnexus-antigravity-hook\.cjs/,
    );
  });

  it('is idempotent — re-running setup does not duplicate hook entries', async () => {
    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();
    await setupCommand();

    const raw = await fs.readFile(path.join(tempHome, '.gemini', 'config', 'hooks.json'), 'utf-8');
    const config = JSON.parse(raw);

    expect(config.gitnexus.PreToolUse).toHaveLength(1);
    expect(config.gitnexus.PostToolUse).toHaveLength(1);
  });

  it('copies adapter + lock helpers to ~/.gemini/config/hooks/gitnexus/', async () => {
    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const destDir = path.join(tempHome, '.gemini', 'config', 'hooks', 'gitnexus');
    await expect(
      fs.access(path.join(destDir, 'gitnexus-antigravity-hook.cjs')),
    ).resolves.toBeUndefined();
    await expect(fs.access(path.join(destDir, 'hook-lock.cjs'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(destDir, 'hook-db-lock-probe.cjs'))).resolves.toBeUndefined();
  });

  it('installs skills under ~/.gemini/antigravity/skills/<name>/SKILL.md', async () => {
    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const skillsDir = path.join(tempHome, '.gemini', 'antigravity', 'skills');
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    const skillDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    expect(skillDirs.length).toBeGreaterThan(0);

    // Spot-check that each installed skill has a SKILL.md
    for (const name of skillDirs) {
      await expect(fs.access(path.join(skillsDir, name, 'SKILL.md'))).resolves.toBeUndefined();
    }
  });
});

// ─── Hook adapter smoke tests ──────────────────────────────────────
//
// The adapter relies on sibling helpers (hook-lock.cjs, hook-db-lock-probe.cjs).
// For tests we lay out a self-contained copy in a temp dir and spawn it.

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const ADAPTER_SRC = path.join(
  PROJECT_ROOT,
  'hooks',
  'antigravity',
  'gitnexus-antigravity-hook.cjs',
);
const LOCK_SRC = path.join(PROJECT_ROOT, 'hooks', 'claude', 'hook-lock.cjs');
const PROBE_SRC = path.join(PROJECT_ROOT, 'hooks', 'claude', 'hook-db-lock-probe.cjs');

async function stageAdapter(): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-antigravity-adapter-'));
  await fs.copyFile(ADAPTER_SRC, path.join(tmp, 'gitnexus-antigravity-hook.cjs'));
  await fs.copyFile(LOCK_SRC, path.join(tmp, 'hook-lock.cjs'));
  await fs.copyFile(PROBE_SRC, path.join(tmp, 'hook-db-lock-probe.cjs'));
  return path.join(tmp, 'gitnexus-antigravity-hook.cjs');
}

function runAdapter(
  hookPath: string,
  input: Record<string, any>,
  cwd?: string,
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    timeout: 10000,
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { stdout: result.stdout || '', stderr: result.stderr || '', status: result.status };
}

describe('gitnexus-antigravity-hook adapter', () => {
  let adapter: string;
  let workdir: string;

  beforeEach(async () => {
    adapter = await stageAdapter();
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-antigravity-work-'));
  });

  afterEach(async () => {
    await fs.rm(path.dirname(adapter), { recursive: true, force: true });
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it('PostToolUse always writes `{}` to stdout (Antigravity contract)', async () => {
    const { stdout } = runAdapter(
      adapter,
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'run_command',
        tool_input: { command: 'ls -la' },
        cwd: workdir,
      },
      workdir,
    );
    expect(stdout.trim()).toBe('{}');
  });

  it('PostToolUse ignores non-git commands silently', async () => {
    const { stdout, stderr } = runAdapter(
      adapter,
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'run_command',
        tool_input: { command: 'npm test' },
        cwd: workdir,
      },
      workdir,
    );
    expect(stdout.trim()).toBe('{}');
    expect(stderr).not.toMatch(/\[GitNexus\]/);
  });

  it('PostToolUse emits stale-index hint on stderr when .gitnexus is out of date', async () => {
    // Initialize a git repo and a stale .gitnexus/meta.json.
    spawnSync('git', ['init', '-q'], { cwd: workdir });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workdir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: workdir });
    await fs.writeFile(path.join(workdir, 'a.txt'), 'hello', 'utf-8');
    spawnSync('git', ['add', '.'], { cwd: workdir });
    spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: workdir });

    const gnDir = path.join(workdir, '.gitnexus');
    await fs.mkdir(gnDir, { recursive: true });
    await fs.writeFile(
      path.join(gnDir, 'meta.json'),
      JSON.stringify({ lastCommit: '0000000000000000000000000000000000000000', stats: {} }),
      'utf-8',
    );

    const { stdout, stderr } = runAdapter(
      adapter,
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'run_command',
        tool_input: { command: 'git commit -m "x"' },
        tool_output: { exit_code: 0 },
        cwd: workdir,
      },
      workdir,
    );

    expect(stdout.trim()).toBe('{}');
    expect(stderr).toMatch(/\[GitNexus\] index is stale/);
    expect(stderr).toMatch(/gitnexus analyze/);
  });

  it('PreToolUse with no .gitnexus/ produces no stdout', async () => {
    const { stdout } = runAdapter(
      adapter,
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'grep_search',
        tool_input: { query: 'someSymbol' },
        cwd: workdir,
      },
      workdir,
    );
    expect(stdout.trim()).toBe('');
  });

  it('ignores unknown tool names without crashing', async () => {
    const { status } = runAdapter(
      adapter,
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'unknown_tool',
        tool_input: {},
        cwd: workdir,
      },
      workdir,
    );
    expect(status).toBe(0);
  });

  it('does not crash on empty stdin', () => {
    const result = spawnSync(process.execPath, [adapter], {
      input: '',
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(result.status).toBe(0);
  });
});
