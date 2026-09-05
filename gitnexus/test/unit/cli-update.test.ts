import { afterEach, describe, expect, it, vi } from 'vitest';

import { updateCommand, updateInstallArgs, updateInstallCommand } from '../../src/cli/update.js';
import { setCliLanguage } from '../../src/cli/i18n/index.js';

describe('gitnexus update', () => {
  afterEach(() => {
    setCliLanguage(null);
  });

  it('pins npm i -g to a stable x.y.z spec', () => {
    expect(updateInstallArgs('1.7.0')).toEqual(['i', '-g', 'gitnexus@1.7.0']);
    expect(updateInstallCommand('1.7.0')).toBe('npm i -g gitnexus@1.7.0');
  });

  it('installs the discovered version when a newer release exists', async () => {
    setCliLanguage('en');
    const refresh = vi.fn().mockResolvedValue({
      updateAvailable: true,
      latestVersion: '1.7.0',
    });
    const runInstall = vi.fn().mockResolvedValue(0);
    const writeStdout = vi.fn();
    const setExitCode = vi.fn();

    await updateCommand({
      installedVersion: '1.6.10',
      refresh,
      runInstall,
      writeStdout,
      setExitCode,
    });

    expect(refresh).toHaveBeenCalledWith({
      eligible: true,
      ignoreOptOut: true,
      installedVersion: '1.6.10',
    });
    expect(runInstall).toHaveBeenCalledWith('1.7.0');
    expect(writeStdout).toHaveBeenCalledWith(
      'GitNexus 1.7.0 is available (you are running 1.6.10).',
    );
    expect(writeStdout).toHaveBeenCalledWith('Installing with npm i -g gitnexus@1.7.0…');
    expect(writeStdout).toHaveBeenCalledWith(
      'Installed gitnexus@1.7.0. Restart long-running mcp/serve processes.',
    );
    expect(setExitCode).not.toHaveBeenCalled();
  });

  it('does not install when already current', async () => {
    setCliLanguage('en');
    const runInstall = vi.fn();
    const writeStdout = vi.fn();

    await updateCommand({
      installedVersion: '1.7.0',
      refresh: vi.fn().mockResolvedValue({
        updateAvailable: false,
        latestVersion: '1.7.0',
      }),
      runInstall,
      writeStdout,
    });

    expect(runInstall).not.toHaveBeenCalled();
    expect(writeStdout).toHaveBeenCalledWith(
      'GitNexus 1.7.0 is current or newer than the latest stable version.',
    );
    expect(writeStdout).toHaveBeenCalledTimes(1);
  });

  it('does not install when newer than the registry latest', async () => {
    setCliLanguage('en');
    const runInstall = vi.fn();
    const writeStdout = vi.fn();

    await updateCommand({
      installedVersion: '1.7.0',
      refresh: vi.fn().mockResolvedValue({
        updateAvailable: false,
        latestVersion: '1.6.10',
      }),
      runInstall,
      writeStdout,
    });

    expect(runInstall).not.toHaveBeenCalled();
    expect(writeStdout).toHaveBeenCalledWith(
      'GitNexus 1.7.0 is current or newer than the latest stable version.',
    );
    expect(writeStdout).toHaveBeenCalledTimes(1);
  });

  it('does not install a non x.y.z spec', async () => {
    setCliLanguage('en');
    const runInstall = vi.fn();
    const writeStdout = vi.fn();

    await updateCommand({
      installedVersion: '1.6.10',
      refresh: vi.fn().mockResolvedValue({
        updateAvailable: true,
        latestVersion: '1.7.0-rc.1',
      }),
      runInstall,
      writeStdout,
    });

    expect(runInstall).not.toHaveBeenCalled();
    expect(writeStdout).toHaveBeenCalledWith(
      'Could not check for updates (offline, private registry, or the check failed open).',
    );
  });

  it('does not install when the check fails open', async () => {
    setCliLanguage('en');
    const runInstall = vi.fn();
    const writeStdout = vi.fn();

    await updateCommand({
      installedVersion: '1.6.10',
      refresh: vi.fn().mockResolvedValue(null),
      runInstall,
      writeStdout,
    });

    expect(runInstall).not.toHaveBeenCalled();
    expect(writeStdout).toHaveBeenCalledWith(
      'Could not check for updates (offline, private registry, or the check failed open).',
    );
  });

  it('forwards a non-zero npm exit code', async () => {
    setCliLanguage('en');
    const writeStdout = vi.fn();
    const setExitCode = vi.fn();

    await updateCommand({
      installedVersion: '1.6.10',
      refresh: vi.fn().mockResolvedValue({
        updateAvailable: true,
        latestVersion: '1.7.0',
      }),
      runInstall: vi.fn().mockResolvedValue(7),
      writeStdout,
      setExitCode,
    });

    expect(writeStdout).toHaveBeenCalledWith(
      'npm install failed. You can retry: npm i -g gitnexus@1.7.0',
    );
    expect(setExitCode).toHaveBeenCalledWith(7);
  });

  it('fails open when npm cannot be spawned', async () => {
    setCliLanguage('en');
    const writeStdout = vi.fn();
    const setExitCode = vi.fn();

    await updateCommand({
      installedVersion: '1.6.10',
      refresh: vi.fn().mockResolvedValue({
        updateAvailable: true,
        latestVersion: '1.7.0',
      }),
      runInstall: vi.fn().mockRejectedValue(new Error('spawn npm ENOENT')),
      writeStdout,
      setExitCode,
    });

    expect(writeStdout).toHaveBeenCalledWith('Could not run npm: spawn npm ENOENT');
    expect(setExitCode).toHaveBeenCalledWith(1);
  });
});
