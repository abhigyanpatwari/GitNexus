import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { packageVersion } from '../../src/core/package-version.js';

const PKG_VERSION = packageVersion();
const NPX_REF = `gitnexus@${PKG_VERSION}`;

const execFileMock = vi.fn((...args: any[]) => {
  const callback = args.at(-1);
  if (typeof callback === 'function') {
    callback(null, '', '');
  }
});

const execFileSyncMock = vi.fn(() => {
  throw new Error('not found');
});

vi.mock('child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
}));

describe('setupCommand codex execution', () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let originalCodexHome: string | undefined;
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
    originalCodexHome = process.env.CODEX_HOME;
    delete process.env.CODEX_HOME;
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-codex-setup-'));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;

    await fs.mkdir(path.join(tempHome, '.codex'), { recursive: true });

    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    setPlatform('win32');
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();

    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor);
    }

    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it('invokes codex mcp add with shell enabled on Windows', async () => {
    const { setupCommand } = await import('../../src/cli/setup.js');

    await setupCommand();

    expect(execFileMock).toHaveBeenCalledWith(
      'codex',
      ['mcp', 'add', 'gitnexus', '--', 'cmd', '/c', 'npx', '-y', NPX_REF, 'mcp'],
      { shell: true, windowsHide: true },
      expect.any(Function),
    );
  });

  it('uses Windows npx fallback arguments when where returns only a non-wrapper shim', async () => {
    execFileSyncMock.mockReturnValueOnce('C:\\Users\\dev\\AppData\\Roaming\\npm\\gitnexus\n');

    const { setupCommand } = await import('../../src/cli/setup.js');

    await setupCommand();

    expect(execFileMock).toHaveBeenCalledWith(
      'codex',
      ['mcp', 'add', 'gitnexus', '--', 'cmd', '/c', 'npx', '-y', NPX_REF, 'mcp'],
      { shell: true, windowsHide: true },
      expect.any(Function),
    );
  });

  it('invokes codex mcp add without shell on non-Windows and does not write fallback config', async () => {
    setPlatform('darwin');

    const { setupCommand } = await import('../../src/cli/setup.js');

    await setupCommand();

    expect(execFileMock).toHaveBeenCalledWith(
      'codex',
      ['mcp', 'add', 'gitnexus', '--', 'npx', '-y', NPX_REF, 'mcp'],
      { shell: false, windowsHide: true },
      expect.any(Function),
    );

    await expect(fs.access(path.join(tempHome, '.codex', 'config.toml'))).rejects.toThrow();
  });

  it('keeps an existing HTTP entry and its bearer-token setting without invoking codex mcp add', async () => {
    const configPath = path.join(tempHome, '.codex', 'config.toml');
    const raw =
      '[mcp_servers.gitnexus]\nurl = "http://127.0.0.1:4748/mcp"\nbearer_token_env_var = "GITNEXUS_TOKEN"\n';
    await fs.writeFile(configPath, raw, 'utf-8');

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand({ codingAgent: 'codex' });

    expect(execFileMock).not.toHaveBeenCalled();
    expect(await fs.readFile(configPath, 'utf-8')).toBe(raw);
    expect(
      await fs.stat(path.join(tempHome, '.agents', 'skills', 'gitnexus-guide', 'SKILL.md')),
    ).toBeDefined();
  });

  it('does not mistake an HTTP entry in the default home for the active CODEX_HOME entry', async () => {
    const defaultConfig = path.join(tempHome, '.codex', 'config.toml');
    const activeHome = path.join(tempHome, 'active-codex');
    await fs.writeFile(defaultConfig, '[mcp_servers.gitnexus]\nurl = "https://example.test/mcp"\n');
    await fs.mkdir(activeHome);
    process.env.CODEX_HOME = activeHome;

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand({ codingAgent: 'codex' });

    expect(execFileMock).toHaveBeenCalledWith(
      'codex',
      ['mcp', 'add', 'gitnexus', '--', 'cmd', '/c', 'npx', '-y', NPX_REF, 'mcp'],
      { shell: true, windowsHide: true },
      expect.any(Function),
    );
  });

  it('preserves an HTTP entry in the active CODEX_HOME even when the default home is empty', async () => {
    const activeHome = path.join(tempHome, 'active-codex');
    const activeConfig = path.join(activeHome, 'config.toml');
    const raw = '[mcp_servers.gitnexus]\nurl = "https://example.test/mcp"\n';
    await fs.mkdir(activeHome);
    await fs.writeFile(activeConfig, raw);
    process.env.CODEX_HOME = activeHome;

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand({ codingAgent: 'codex' });

    expect(execFileMock).not.toHaveBeenCalled();
    expect(await fs.readFile(activeConfig, 'utf-8')).toBe(raw);
  });

  it('writes the fallback entry to the active CODEX_HOME when the Codex CLI is unavailable', async () => {
    const activeHome = path.join(tempHome, 'active-codex');
    process.env.CODEX_HOME = activeHome;
    execFileMock.mockImplementationOnce((...args: unknown[]) => {
      const callback = args.at(-1);
      if (typeof callback === 'function') callback(new Error('codex unavailable'));
    });

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand({ codingAgent: 'codex' });

    expect(await fs.readFile(path.join(activeHome, 'config.toml'), 'utf-8')).toContain(
      '[mcp_servers.gitnexus]',
    );
    await expect(fs.access(path.join(tempHome, '.codex', 'config.toml'))).rejects.toThrow();
  });

  it('does not print TOML source or nearby credentials when the active config is malformed', async () => {
    const activeHome = path.join(tempHome, 'active-codex');
    const configPath = path.join(activeHome, 'config.toml');
    const token = 'Bearer FAKE_PR3460_REVIEW_TOKEN';
    await fs.mkdir(activeHome);
    await fs.writeFile(
      configPath,
      `[mcp_servers.gitnexus]\nhttp_headers = { Authorization = "${token}" }\ninvalid =\n`,
    );
    process.env.CODEX_HOME = activeHome;

    const { setupCommand } = await import('../../src/cli/setup.js');
    await setupCommand({ codingAgent: 'codex' });

    const output = JSON.stringify(vi.mocked(console.log).mock.calls);
    expect(output).toMatch(/invalid config\.toml \(line 3, column \d+\)/);
    expect(output).not.toContain(token);
    expect(execFileMock).not.toHaveBeenCalled();
    expect(await fs.readFile(configPath, 'utf-8')).toContain(token);
  });

  it('skips Codex setup entirely when ~/.codex is missing', async () => {
    await fs.rm(path.join(tempHome, '.codex'), { recursive: true, force: true });

    const { setupCommand } = await import('../../src/cli/setup.js');

    await setupCommand();

    expect(execFileMock).not.toHaveBeenCalled();
    await expect(fs.access(path.join(tempHome, '.agents', 'skills'))).rejects.toThrow();
  });
});
