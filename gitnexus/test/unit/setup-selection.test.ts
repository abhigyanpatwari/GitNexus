import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const execFileMock = vi.fn((...args: any[]) => {
  const callback = args.at(-1);
  if (typeof callback === 'function') callback(null, '', '');
});

vi.mock('child_process', () => ({
  execFile: execFileMock,
  execFileSync: vi.fn(() => {
    throw new Error('not found');
  }),
}));

describe('setupCommand coding-agent selection', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let originalExitCode: number | string | null | undefined;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    originalExitCode = process.exitCode;
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-setup-selection-'));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.exitCode = undefined;
    await Promise.all([
      fs.mkdir(path.join(tempHome, '.cursor'), { recursive: true }),
      fs.mkdir(path.join(tempHome, '.claude'), { recursive: true }),
      fs.mkdir(path.join(tempHome, '.gemini', 'antigravity'), { recursive: true }),
      fs.mkdir(path.join(tempHome, '.config', 'opencode'), { recursive: true }),
      fs.mkdir(path.join(tempHome, '.codex'), { recursive: true }),
    ]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    process.exitCode = originalExitCode;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it('explicit -c codebuddy succeeds when only a legacy root config exists (no dot-dir)', async () => {
    const legacy = path.join(tempHome, '.codebuddy.json');
    await fs.writeFile(
      legacy,
      JSON.stringify({ mcpServers: { other: { command: 'foo' } } }),
      'utf-8',
    );

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand({ codingAgent: ['codebuddy'] });

    const config = JSON.parse(await fs.readFile(legacy, 'utf-8'));
    expect(config.mcpServers.gitnexus).toBeDefined();
    expect(config.mcpServers.other).toEqual({ command: 'foo' });
    // Explicit selection that configures something must not exit 1.
    expect(process.exitCode).not.toBe(1);
  });

  it('configures only the requested coding agent', async () => {
    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand({ codingAgent: ['opencode'] });

    await expect(
      fs.access(path.join(tempHome, '.config', 'opencode', 'opencode.json')),
    ).resolves.toBeUndefined();
    await expect(fs.access(path.join(tempHome, '.cursor', 'mcp.json'))).rejects.toThrow();
    await expect(fs.access(path.join(tempHome, '.claude.json'))).rejects.toThrow();
    await expect(
      fs.access(path.join(tempHome, '.gemini', 'antigravity', 'mcp_config.json')),
    ).rejects.toThrow();
    await expect(fs.access(path.join(tempHome, '.codex', 'config.toml'))).rejects.toThrow();
  });

  it('accepts comma-separated and repeated selections without configuring others', async () => {
    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand({ codingAgent: ['cursor,opencode', 'cursor'] });

    await expect(fs.access(path.join(tempHome, '.cursor', 'mcp.json'))).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(tempHome, '.config', 'opencode', 'opencode.json')),
    ).resolves.toBeUndefined();
    await expect(fs.access(path.join(tempHome, '.claude.json'))).rejects.toThrow();
  });

  it('rejects unknown values before writing configuration', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand({ codingAgent: ['opencode,unknown'] });

    expect(process.exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining(
        'Valid values: cursor, claude, antigravity, opencode, codebuddy, qoder, codex',
      ),
    );
    await expect(
      fs.access(path.join(tempHome, '.config', 'opencode', 'opencode.json')),
    ).rejects.toThrow();
  });

  it.each([
    ['an empty string', ''],
    ['an empty array', []],
  ])('rejects %s before writing configuration', async (_label, codingAgent) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { setupCommand } = await import('../../src/cli/setup.js');

    await setupCommand({ codingAgent });

    expect(process.exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('No coding agents were provided.'));
    await expect(fs.access(path.join(tempHome, '.cursor', 'mcp.json'))).rejects.toThrow();
  });

  it('fails clearly when an explicitly selected agent is not installed', async () => {
    await fs.rm(path.join(tempHome, '.codex'), { recursive: true, force: true });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { setupCommand } = await import('../../src/cli/setup.js');

    await setupCommand({ codingAgent: ['codex'] });

    expect(process.exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      'None of the explicitly selected coding agents were configured.\n',
    );
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).not.toContain('MCP is ready!');
  });

  it('preserves the no-flag default of configuring every detected agent', async () => {
    const { setupCommand } = await import('../../src/cli/setup.js');

    await setupCommand();

    await expect(fs.access(path.join(tempHome, '.cursor', 'mcp.json'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(tempHome, '.claude.json'))).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(tempHome, '.config', 'opencode', 'opencode.json')),
    ).resolves.toBeUndefined();
  });
});
