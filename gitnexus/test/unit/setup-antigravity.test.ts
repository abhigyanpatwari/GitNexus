/**
 * Regression Tests: Antigravity setup + hook adapter
 *
 * Covers:
 * - setupAntigravity: detection of ~/.gemini/antigravity, MCP write, preserve
 *   existing keys, corrupt-file handling, skips when not installed.
 * - installAntigravityHooks: writes ~/.gemini/settings.json with an
 *   AfterTool entry under the canonical Gemini CLI / Antigravity 2.0 layout
 *   (https://geminicli.com/docs/hooks/reference/); copies the adapter and
 *   lock helpers to ~/.gemini/config/hooks/gitnexus/; idempotent across
 *   re-runs; preserves existing user hooks ("polite neighbor").
 * - installAntigravitySkills: lays out skills under ~/.gemini/antigravity/skills/.
 * - hook adapter: AfterTool emits `{hookSpecificOutput.additionalContext}`
 *   with graph context after search-like tools; emits a stale-index hint
 *   after a successful `git commit/merge/rebase/cherry-pick/pull`; ignores
 *   unrelated tools silently.
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
  let platformDescriptor: PropertyDescriptor | undefined;

  const setPlatform = (value: NodeJS.Platform) => {
    Object.defineProperty(process, 'platform', {
      value,
      configurable: true,
    });
  };

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

    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    // Default to a non-win32 platform so the MCP entry shape is deterministic
    // across CI runners. Tests that need win32 behavior override this.
    setPlatform('darwin');

    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();

    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor);
    }

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

  it('writes win32 MCP entry with cmd wrapper', async () => {
    setPlatform('win32');

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(
      path.join(tempHome, '.gemini', 'antigravity', 'mcp_config.json'),
      'utf-8',
    );
    const config = JSON.parse(raw);

    expect(config.mcpServers.gitnexus).toEqual({
      command: 'cmd',
      args: ['/c', 'npx', '-y', NPX_REF, 'mcp'],
    });
  });

  it('skips when ~/.gemini/antigravity does not exist', async () => {
    await fs.rm(path.join(tempHome, '.gemini'), { recursive: true, force: true });

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    await expect(
      fs.access(path.join(tempHome, '.gemini', 'antigravity', 'mcp_config.json')),
    ).rejects.toThrow();
    await expect(fs.access(path.join(tempHome, '.gemini', 'settings.json'))).rejects.toThrow();
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

  it('writes ~/.gemini/settings.json with an AfterTool entry under hooks', async () => {
    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(path.join(tempHome, '.gemini', 'settings.json'), 'utf-8');
    const config = JSON.parse(raw);

    expect(config.hooks.AfterTool).toBeInstanceOf(Array);
    expect(config.hooks.AfterTool[0].matcher).toBe('search_file_content|glob|run_shell_command');
    expect(config.hooks.AfterTool[0].hooks[0].command).toMatch(/gitnexus-antigravity-hook\.cjs/);
    expect(config.hooks.AfterTool[0].hooks[0].timeout).toBe(10000);
    expect(config.hooks.AfterTool[0].hooks[0].name).toBe('gitnexus');
  });

  it('is idempotent — re-running setup does not duplicate hook entries', async () => {
    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();
    await setupCommand();

    const raw = await fs.readFile(path.join(tempHome, '.gemini', 'settings.json'), 'utf-8');
    const config = JSON.parse(raw);

    expect(config.hooks.AfterTool).toHaveLength(1);
  });

  it('preserves existing user hooks in settings.json (polite-neighbor merge)', async () => {
    const settingsPath = path.join(tempHome, '.gemini', 'settings.json');
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        theme: 'dark',
        hooks: {
          AfterTool: [
            {
              matcher: 'write_file',
              hooks: [{ type: 'command', command: 'echo "user-hook"', name: 'user-formatter' }],
            },
          ],
        },
      }),
      'utf-8',
    );

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(settingsPath, 'utf-8');
    const config = JSON.parse(raw);

    // Unrelated keys preserved
    expect(config.theme).toBe('dark');

    // User's hook still present
    expect(config.hooks.AfterTool).toHaveLength(2);
    expect(config.hooks.AfterTool[0].hooks[0].command).toBe('echo "user-hook"');
    // Our entry appended after, not replacing
    expect(config.hooks.AfterTool[1].hooks[0].command).toMatch(/gitnexus-antigravity-hook\.cjs/);
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
    // Required by hook-db-lock-probe.cjs on Windows; without it the MCP
    // server ownership probe silently fails open.
    await expect(fs.access(path.join(destDir, 'win-rm-list-json.ps1'))).resolves.toBeUndefined();
    // The adapter top-level require()s this; the production install path must
    // co-locate it next to the adapter (symmetric with the Claude install).
    await expect(fs.access(path.join(destDir, 'resolve-analyze-cmd.cjs'))).resolves.toBeUndefined();
  });

  it('installs skills under ~/.gemini/antigravity/skills/<name>/SKILL.md', async () => {
    // Stage a fixture skills tree so the assertion does not depend on
    // installSkillsTo's __dirname resolution (which is brittle under
    // Vitest on Windows). Production reads the real gitnexus/skills/ dir.
    const fixtureSkillsRoot = path.join(tempHome, 'fixture-skills');
    await fs.mkdir(fixtureSkillsRoot, { recursive: true });
    await fs.writeFile(
      path.join(fixtureSkillsRoot, 'gitnexus-test.md'),
      '---\nname: gitnexus-test\ndescription: fixture\n---\nbody\n',
      'utf-8',
    );
    process.env.GITNEXUS_TEST_SKILLS_ROOT = fixtureSkillsRoot;

    try {
      const { setupCommand } = await import('../../src/cli/setup.js');
      await setupCommand();

      const skillsDir = path.join(tempHome, '.gemini', 'antigravity', 'skills');
      const entries = await fs.readdir(skillsDir, { withFileTypes: true });
      const skillDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

      expect(skillDirs).toContain('gitnexus-test');
      await expect(
        fs.access(path.join(skillsDir, 'gitnexus-test', 'SKILL.md')),
      ).resolves.toBeUndefined();
    } finally {
      delete process.env.GITNEXUS_TEST_SKILLS_ROOT;
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
const WIN_RM_SRC = path.join(PROJECT_ROOT, 'hooks', 'claude', 'win-rm-list-json.ps1');
const RESOLVE_SRC = path.join(PROJECT_ROOT, 'hooks', 'claude', 'resolve-analyze-cmd.cjs');

async function stageAdapter(): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-antigravity-adapter-'));
  await fs.copyFile(ADAPTER_SRC, path.join(tmp, 'gitnexus-antigravity-hook.cjs'));
  await fs.copyFile(LOCK_SRC, path.join(tmp, 'hook-lock.cjs'));
  await fs.copyFile(PROBE_SRC, path.join(tmp, 'hook-db-lock-probe.cjs'));
  // hook-db-lock-probe.cjs loads this PowerShell script on Windows; without it,
  // the lock probe silently fails open and the adapter's Windows DB-lock path
  // would be untested in child-process smoke tests.
  await fs.copyFile(WIN_RM_SRC, path.join(tmp, 'win-rm-list-json.ps1'));
  // The adapter top-level `require('./resolve-analyze-cmd.cjs')`s this helper;
  // without staging it the spawned adapter crashes with MODULE_NOT_FOUND.
  await fs.copyFile(RESOLVE_SRC, path.join(tmp, 'resolve-analyze-cmd.cjs'));
  return path.join(tmp, 'gitnexus-antigravity-hook.cjs');
}

function runAdapter(
  hookPath: string,
  input: Record<string, any>,
  cwd?: string,
  env?: Record<string, string>,
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    timeout: 10000,
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { stdout: result.stdout || '', stderr: result.stderr || '', status: result.status };
}

// A staged adapter that fails to load (e.g. a missing sibling helper) exits
// non-zero and prints MODULE_NOT_FOUND — a state that otherwise masquerades as
// "no stdout" in the silent-path tests below. Assert the process actually ran.
function expectAdapterLoaded(stderr: string, status: number | null): void {
  expect(status).toBe(0);
  expect(stderr).not.toMatch(/MODULE_NOT_FOUND|Cannot find module/);
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

  it('AfterTool with no .gitnexus/ produces no stdout', async () => {
    const { stdout, stderr, status } = runAdapter(
      adapter,
      {
        hook_event_name: 'AfterTool',
        tool_name: 'search_file_content',
        tool_input: { pattern: 'someSymbol' },
        tool_response: { llmContent: '...' },
        cwd: workdir,
      },
      workdir,
    );
    expect(stdout.trim()).toBe('');
    expectAdapterLoaded(stderr, status);
  });

  it('AfterTool ignores unrelated tools silently', async () => {
    const { stdout, stderr, status } = runAdapter(
      adapter,
      {
        hook_event_name: 'AfterTool',
        tool_name: 'read_file',
        tool_input: { path: 'README.md' },
        tool_response: { llmContent: '...' },
        cwd: workdir,
      },
      workdir,
    );
    expect(stdout.trim()).toBe('');
    expect(stderr).not.toMatch(/\[GitNexus\]/);
    expectAdapterLoaded(stderr, status);
  });

  it('AfterTool ignores non-git run_shell_command silently', async () => {
    const gnDir = path.join(workdir, '.gitnexus');
    await fs.mkdir(gnDir, { recursive: true });
    await fs.writeFile(
      path.join(gnDir, 'meta.json'),
      JSON.stringify({ lastCommit: 'deadbeef', stats: {} }),
      'utf-8',
    );

    const { stdout, stderr, status } = runAdapter(
      adapter,
      {
        hook_event_name: 'AfterTool',
        tool_name: 'run_shell_command',
        tool_input: { command: 'npm test' },
        tool_response: { llmContent: '...' },
        cwd: workdir,
      },
      workdir,
    );
    expect(stdout.trim()).toBe('');
    expect(stderr).not.toMatch(/\[GitNexus\]/);
    expectAdapterLoaded(stderr, status);
  });

  it('AfterTool emits stale-index hint after a successful git commit', async () => {
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

    const input = {
      hook_event_name: 'AfterTool',
      tool_name: 'run_shell_command',
      tool_input: { command: 'git commit -m "x"' },
      tool_response: { llmContent: '[committed]' },
      cwd: workdir,
    };
    // Force a deterministic invocation mode: the emitted analyze command varies
    // by what's installed on each CI runner (gitnexus/pnpm/npx); only the
    // `gitnexus` mode yields the bare `gitnexus analyze` form.
    const { stdout, stderr } = runAdapter(adapter, input, workdir, {
      GITNEXUS_INVOCATION: 'gitnexus',
      GITNEXUS_DEBUG: '',
    });

    // #1913: by default the hint reaches the agent via additionalContext (stdout
    // JSON) but is NOT mirrored to stderr, so strict hook runners stay clean.
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('AfterTool');
    expect(parsed.hookSpecificOutput.additionalContext).toMatch(/index is stale/);
    expect(parsed.hookSpecificOutput.additionalContext).toMatch(/gitnexus analyze/);
    expect(stderr).not.toMatch(/\[GitNexus\] index is stale/);

    // The terminal mirror remains available under GITNEXUS_DEBUG=1.
    const debug = runAdapter(adapter, input, workdir, {
      GITNEXUS_INVOCATION: 'gitnexus',
      GITNEXUS_DEBUG: '1',
    });
    expect(debug.stderr).toMatch(/\[GitNexus\] index is stale/);
    expect(debug.stderr).toMatch(/gitnexus analyze/);
  });

  it('AfterTool skips augment when the tool failed', async () => {
    const gnDir = path.join(workdir, '.gitnexus');
    await fs.mkdir(gnDir, { recursive: true });
    await fs.writeFile(
      path.join(gnDir, 'meta.json'),
      JSON.stringify({ lastCommit: 'deadbeef', stats: {} }),
      'utf-8',
    );

    const { stdout, stderr, status } = runAdapter(
      adapter,
      {
        hook_event_name: 'AfterTool',
        tool_name: 'search_file_content',
        tool_input: { pattern: 'someSymbol' },
        tool_response: { error: 'boom' },
        cwd: workdir,
      },
      workdir,
    );
    expect(stdout.trim()).toBe('');
    expectAdapterLoaded(stderr, status);
  });

  it('ignores unknown tool names without crashing', async () => {
    const { status } = runAdapter(
      adapter,
      {
        hook_event_name: 'AfterTool',
        tool_name: 'unknown_tool',
        tool_input: {},
        tool_response: { llmContent: '' },
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
