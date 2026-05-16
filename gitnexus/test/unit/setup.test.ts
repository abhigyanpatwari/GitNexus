import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

// Match what setup.ts emits — read the version from the same package.json
// so the test never goes stale on a release bump.
const PKG_VERSION = (createRequire(import.meta.url)('../../package.json') as { version: string })
  .version;
const NPX_REF = `gitnexus@${PKG_VERSION}`;

const execFileMock = vi.fn((...args: any[]) => {
  const callback = args.at(-1);
  if (typeof callback === 'function') {
    callback(null, '', '');
  }
});

// By default, execFileSync throws (simulating `which gitnexus` not found)
// so getMcpEntry() falls back to the npx path.
const execFileSyncMock = vi.fn(() => {
  throw new Error('not found');
});

vi.mock('child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
}));

describe('setupClaudeCode', () => {
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
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-claude-setup-'));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;

    // Only create ~/.claude — no other editor directories so their
    // setup functions skip and don't pollute assertions.
    await fs.mkdir(path.join(tempHome, '.claude'), { recursive: true });

    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
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

  it('writes win32 MCP entry with cmd wrapper', async () => {
    setPlatform('win32');

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(path.join(tempHome, '.claude.json'), 'utf-8');
    const config = JSON.parse(raw);

    expect(config.mcpServers.gitnexus).toEqual({
      command: 'cmd',
      args: ['/c', 'npx', '-y', NPX_REF, 'mcp'],
    });
  });

  it('writes non-win32 MCP entry with npx directly', async () => {
    setPlatform('darwin');

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(path.join(tempHome, '.claude.json'), 'utf-8');
    const config = JSON.parse(raw);

    expect(config.mcpServers.gitnexus).toEqual({
      command: 'npx',
      args: ['-y', NPX_REF, 'mcp'],
    });
  });

  it('skips when ~/.claude directory does not exist', async () => {
    await fs.rm(path.join(tempHome, '.claude'), { recursive: true, force: true });

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    await expect(fs.access(path.join(tempHome, '.claude.json'))).rejects.toThrow();
  });

  it('preserves existing keys in ~/.claude.json', async () => {
    setPlatform('linux');

    await fs.writeFile(
      path.join(tempHome, '.claude.json'),
      JSON.stringify({ existingKey: 'keep-me', mcpServers: { other: { command: 'foo' } } }),
      'utf-8',
    );

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(path.join(tempHome, '.claude.json'), 'utf-8');
    const config = JSON.parse(raw);

    expect(config.existingKey).toBe('keep-me');
    expect(config.mcpServers.other).toEqual({ command: 'foo' });
    expect(config.mcpServers.gitnexus).toBeDefined();
  });

  it('handles missing ~/.claude.json (creates fresh)', async () => {
    setPlatform('linux');

    // Ensure no pre-existing file
    await fs.rm(path.join(tempHome, '.claude.json'), { force: true });

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(path.join(tempHome, '.claude.json'), 'utf-8');
    const config = JSON.parse(raw);

    expect(config.mcpServers.gitnexus).toBeDefined();
  });

  it('handles corrupt JSON gracefully', async () => {
    setPlatform('linux');

    const corrupt = '{ this is not valid json !!!';
    await fs.writeFile(path.join(tempHome, '.claude.json'), corrupt, 'utf-8');

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    // mergeJsoncFile leaves corrupt files untouched (safer than overwriting)
    const raw = await fs.readFile(path.join(tempHome, '.claude.json'), 'utf-8');
    expect(raw).toBe(corrupt);
  });

  it('uses global binary path when gitnexus is on PATH', async () => {
    setPlatform('darwin');
    execFileSyncMock.mockReturnValueOnce('/usr/local/bin/gitnexus\n');

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(path.join(tempHome, '.claude.json'), 'utf-8');
    const config = JSON.parse(raw);

    expect(config.mcpServers.gitnexus).toEqual({
      command: '/usr/local/bin/gitnexus',
      args: ['mcp'],
    });
  });

  it('falls back to npx when gitnexus is not on PATH', async () => {
    setPlatform('darwin');
    execFileSyncMock.mockImplementationOnce(() => {
      throw new Error('not found');
    });

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(path.join(tempHome, '.claude.json'), 'utf-8');
    const config = JSON.parse(raw);

    expect(config.mcpServers.gitnexus).toEqual({
      command: 'npx',
      args: ['-y', NPX_REF, 'mcp'],
    });
  });

  it('picks .cmd wrapper from Windows where output (multiple lines)', async () => {
    setPlatform('win32');
    // `where gitnexus` on Windows returns the POSIX script first, then .cmd
    execFileSyncMock.mockReturnValueOnce(
      'C:\\Users\\dev\\AppData\\Roaming\\npm\\gitnexus\nC:\\Users\\dev\\AppData\\Roaming\\npm\\gitnexus.cmd\n',
    );

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(path.join(tempHome, '.claude.json'), 'utf-8');
    const config = JSON.parse(raw);

    expect(config.mcpServers.gitnexus).toEqual({
      command: 'C:\\Users\\dev\\AppData\\Roaming\\npm\\gitnexus.cmd',
      args: ['mcp'],
    });
  });

  it('handles CRLF line endings from Windows where output', async () => {
    setPlatform('win32');
    // Windows `where` produces CRLF line endings
    execFileSyncMock.mockReturnValueOnce(
      'C:\\Users\\dev\\AppData\\Roaming\\npm\\gitnexus\r\nC:\\Users\\dev\\AppData\\Roaming\\npm\\gitnexus.cmd\r\n',
    );

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(path.join(tempHome, '.claude.json'), 'utf-8');
    const config = JSON.parse(raw);

    expect(config.mcpServers.gitnexus).toEqual({
      command: 'C:\\Users\\dev\\AppData\\Roaming\\npm\\gitnexus.cmd',
      args: ['mcp'],
    });
  });

  it('picks .bat wrapper when .cmd is not present', async () => {
    setPlatform('win32');
    execFileSyncMock.mockReturnValueOnce(
      'C:\\Users\\dev\\AppData\\Roaming\\npm\\gitnexus\nC:\\Users\\dev\\AppData\\Roaming\\npm\\gitnexus.bat\n',
    );

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(path.join(tempHome, '.claude.json'), 'utf-8');
    const config = JSON.parse(raw);

    expect(config.mcpServers.gitnexus).toEqual({
      command: 'C:\\Users\\dev\\AppData\\Roaming\\npm\\gitnexus.bat',
      args: ['mcp'],
    });
  });

  it('handles uppercase .CMD extension (case-insensitive match)', async () => {
    setPlatform('win32');
    execFileSyncMock.mockReturnValueOnce(
      'C:\\Users\\dev\\AppData\\Roaming\\npm\\gitnexus\nC:\\Users\\dev\\AppData\\Roaming\\npm\\gitnexus.CMD\n',
    );

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(path.join(tempHome, '.claude.json'), 'utf-8');
    const config = JSON.parse(raw);

    expect(config.mcpServers.gitnexus).toEqual({
      command: 'C:\\Users\\dev\\AppData\\Roaming\\npm\\gitnexus.CMD',
      args: ['mcp'],
    });
  });

  it('copies hook-db-lock-probe.cjs and win-rm-list-json.ps1 to ~/.claude/hooks/gitnexus/', async () => {
    setPlatform('linux');

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const destHooksDir = path.join(tempHome, '.claude', 'hooks', 'gitnexus');
    await expect(
      fs.access(path.join(destHooksDir, 'hook-db-lock-probe.cjs')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(destHooksDir, 'win-rm-list-json.ps1')),
    ).resolves.toBeUndefined();
  });

  it('falls back to first line on Windows when no .cmd/.bat wrapper found', async () => {
    setPlatform('win32');
    // Edge case: where returns only the POSIX script (no .cmd wrapper)
    execFileSyncMock.mockReturnValueOnce('C:\\Users\\dev\\AppData\\Roaming\\npm\\gitnexus\n');

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand();

    const raw = await fs.readFile(path.join(tempHome, '.claude.json'), 'utf-8');
    const config = JSON.parse(raw);

    expect(config.mcpServers.gitnexus).toEqual({
      command: 'C:\\Users\\dev\\AppData\\Roaming\\npm\\gitnexus',
      args: ['mcp'],
    });
  });
});
