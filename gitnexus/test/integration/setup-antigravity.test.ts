/**
 * Integration Tests: setupCommand — Antigravity end-to-end
 *
 * Exercises the real `setupCommand()` (no mocks) against a temp HOME with
 * `~/.gemini/antigravity/` present and verifies the on-disk artifacts: MCP
 * config, ~/.gemini/settings.json hooks entry, hook adapter + helpers
 * (including win-rm-list-json.ps1), and installed skills.
 *
 * Complements the unit-level setup-antigravity test by running the actual
 * setup pipeline end-to-end with real filesystem state rather than mocked
 * spawn/spawnSync.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { setupCommand } from '../../src/cli/setup.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDir, '..', '..');
const adapterSource = path.join(
  packageRoot,
  'hooks',
  'antigravity',
  'gitnexus-antigravity-hook.cjs',
);

describe('setupCommand Antigravity integration', () => {
  let tempHome: string;
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  let antigravityDir: string;
  let geminiDir: string;

  beforeAll(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-antigravity-int-'));
    process.env.HOME = tempHome;
    // os.homedir() honors USERPROFILE on Windows
    process.env.USERPROFILE = tempHome;
    geminiDir = path.join(tempHome, '.gemini');
    antigravityDir = path.join(geminiDir, 'antigravity');
  });

  afterAll(async () => {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Reset ~/.gemini between tests so each starts from a clean slate but
    // keeps the antigravity/ marker dir present (so setupAntigravity runs).
    // Tests that need to verify the "not installed" skip path remove the
    // marker themselves and restore it at the end.
    await fs.rm(geminiDir, { recursive: true, force: true });
    await fs.mkdir(antigravityDir, { recursive: true });
  });

  it('writes mcp_config.json with a valid mcpServers.gitnexus entry', async () => {
    await setupCommand();

    const raw = await fs.readFile(path.join(antigravityDir, 'mcp_config.json'), 'utf-8');
    const config = JSON.parse(raw);

    expect(config.mcpServers).toBeDefined();
    expect(config.mcpServers.gitnexus).toBeDefined();
    expect(typeof config.mcpServers.gitnexus.command).toBe('string');
    expect(Array.isArray(config.mcpServers.gitnexus.args)).toBe(true);
    // mcp is always the final positional regardless of which command shape
    // (global binary, npx, or cmd /c npx wrapper) is chosen
    expect(config.mcpServers.gitnexus.args).toContain('mcp');
  });

  it('registers an AfterTool entry in ~/.gemini/settings.json with the canonical matcher', async () => {
    await setupCommand();

    const settingsPath = path.join(geminiDir, 'settings.json');
    const config = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));

    expect(config.hooks).toBeDefined();
    expect(config.hooks.AfterTool).toBeInstanceOf(Array);
    expect(config.hooks.AfterTool).toHaveLength(1);

    const entry = config.hooks.AfterTool[0];
    expect(entry.matcher).toBe('search_file_content|glob|run_shell_command');
    expect(Array.isArray(entry.hooks)).toBe(true);
    expect(entry.hooks).toHaveLength(1);

    const hook = entry.hooks[0];
    expect(hook.type).toBe('command');
    expect(hook.name).toBe('gitnexus');
    expect(hook.command).toMatch(/gitnexus-antigravity-hook\.cjs/);
    // ms — Gemini CLI uses milliseconds; 10000 ms = 10 s
    expect(hook.timeout).toBe(10000);
  });

  it('copies the adapter and all required helpers (including win-rm-list-json.ps1) to ~/.gemini/config/hooks/gitnexus/', async () => {
    await setupCommand();

    const hooksDir = path.join(geminiDir, 'config', 'hooks', 'gitnexus');
    for (const file of [
      'gitnexus-antigravity-hook.cjs',
      'hook-lock.cjs',
      'hook-db-lock-probe.cjs',
      // Required by hook-db-lock-probe.cjs on Windows; without it the MCP
      // server ownership probe silently fails open and the adapter can race
      // the MCP server on the LadybugDB.
      'win-rm-list-json.ps1',
    ]) {
      await expect(
        fs.access(path.join(hooksDir, file)),
        `expected ${file} to be installed`,
      ).resolves.toBeUndefined();
    }
  });

  it('rewrites the adapter cliPath to an absolute resolved path at install time', async () => {
    await setupCommand();

    const installed = await fs.readFile(
      path.join(geminiDir, 'config', 'hooks', 'gitnexus', 'gitnexus-antigravity-hook.cjs'),
      'utf-8',
    );
    const source = await fs.readFile(adapterSource, 'utf-8');

    // The source default uses path.resolve(__dirname, '..', '..', 'dist', ...)
    // which would resolve incorrectly when the adapter is installed outside
    // the gitnexus package tree (issue #108 regression class). Setup must
    // replace it with a JSON-string absolute literal pointing at the real CLI.
    // Under vitest/tsx the resolved __dirname of setup.ts is src/cli/, so the
    // rewrite resolves to src/cli/index.js; under a packaged install it
    // resolves to dist/cli/index.js. Accept either.
    expect(source).toMatch(
      /path\.resolve\(__dirname, '\.\.', '\.\.', 'dist', 'cli', 'index\.js'\)/,
    );
    expect(installed).not.toMatch(
      /let cliPath = path\.resolve\(__dirname, '\.\.', '\.\.', 'dist', 'cli', 'index\.js'\)/,
    );
    expect(installed).toMatch(/let cliPath = "[^"]*(?:src|dist)\/cli\/index\.js"/);
  });

  it('installs gitnexus skills into ~/.gemini/antigravity/skills/<name>/SKILL.md', async () => {
    await setupCommand();

    const skillsDir = path.join(antigravityDir, 'skills');
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    const skillNames = entries.filter((e) => e.isDirectory()).map((e) => e.name);

    expect(skillNames).toContain('gitnexus-cli');

    const cliSkill = await fs.readFile(path.join(skillsDir, 'gitnexus-cli', 'SKILL.md'), 'utf-8');
    expect(cliSkill).toMatch(/GitNexus/i);
  });

  it('preserves user hooks under BeforeTool and other AfterTool matchers (polite-neighbor merge)', async () => {
    const settingsPath = path.join(geminiDir, 'settings.json');
    await fs.writeFile(
      settingsPath,
      JSON.stringify(
        {
          theme: 'dark',
          hooks: {
            BeforeTool: [
              {
                matcher: 'write_file',
                hooks: [{ type: 'command', command: 'echo before', name: 'user-fmt' }],
              },
            ],
            AfterTool: [
              {
                matcher: 'write_file',
                hooks: [{ type: 'command', command: 'echo after', name: 'user-fmt' }],
              },
            ],
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    await setupCommand();

    const config = JSON.parse(await fs.readFile(settingsPath, 'utf-8'));

    // Unrelated keys preserved
    expect(config.theme).toBe('dark');

    // User's BeforeTool entry untouched
    expect(config.hooks.BeforeTool).toHaveLength(1);
    expect(config.hooks.BeforeTool[0].hooks[0].command).toBe('echo before');

    // Our AfterTool entry appended after the user's
    expect(config.hooks.AfterTool).toHaveLength(2);
    expect(config.hooks.AfterTool[0].hooks[0].command).toBe('echo after');
    expect(config.hooks.AfterTool[1].hooks[0].command).toMatch(/gitnexus-antigravity-hook/);
  });

  it('is idempotent — re-running setupCommand does not duplicate the AfterTool entry', async () => {
    await setupCommand();
    await setupCommand();
    await setupCommand();

    const config = JSON.parse(await fs.readFile(path.join(geminiDir, 'settings.json'), 'utf-8'));
    expect(config.hooks.AfterTool).toHaveLength(1);

    const mcpConfig = JSON.parse(
      await fs.readFile(path.join(antigravityDir, 'mcp_config.json'), 'utf-8'),
    );
    // Re-running setup should also leave mcpServers.gitnexus as the single
    // canonical entry, not duplicate it.
    expect(Object.keys(mcpConfig.mcpServers)).toEqual(['gitnexus']);
  });

  it('skips Antigravity setup entirely when ~/.gemini/antigravity is absent', async () => {
    await fs.rm(geminiDir, { recursive: true, force: true });

    await setupCommand();

    // Neither the MCP config nor the hooks settings should be created when
    // Antigravity is not installed.
    await expect(fs.access(path.join(geminiDir, 'settings.json'))).rejects.toThrow();
    await expect(fs.access(path.join(antigravityDir, 'mcp_config.json'))).rejects.toThrow();
  });

  it('preserves existing keys and other servers when merging into mcp_config.json', async () => {
    await fs.writeFile(
      path.join(antigravityDir, 'mcp_config.json'),
      JSON.stringify(
        {
          existingKey: 'keep-me',
          mcpServers: { other: { command: 'foo', args: ['bar'] } },
        },
        null,
        2,
      ),
      'utf-8',
    );

    await setupCommand();

    const config = JSON.parse(
      await fs.readFile(path.join(antigravityDir, 'mcp_config.json'), 'utf-8'),
    );
    expect(config.existingKey).toBe('keep-me');
    expect(config.mcpServers.other).toEqual({ command: 'foo', args: ['bar'] });
    expect(config.mcpServers.gitnexus).toBeDefined();
  });

  it('leaves a corrupt mcp_config.json untouched rather than overwriting user data', async () => {
    const mcpPath = path.join(antigravityDir, 'mcp_config.json');
    const corrupt = '{ definitely not json !!!';
    await fs.writeFile(mcpPath, corrupt, 'utf-8');

    await setupCommand();

    const raw = await fs.readFile(mcpPath, 'utf-8');
    expect(raw).toBe(corrupt);
  });
});
