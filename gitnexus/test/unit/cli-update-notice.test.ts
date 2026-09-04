import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  runCliUpdateNotice,
  type CliUpdateNoticeDependencies,
} from '../../src/cli/update-notice.js';
import { cachedUpdateDoctorLine } from '../../src/cli/doctor.js';
import { setCliLanguage } from '../../src/cli/i18n/index.js';
import { readProcessStartTime } from '../../src/utils/process-identity.js';

const tempHomes: string[] = [];

function dependencies(
  overrides: Partial<CliUpdateNoticeDependencies> = {},
): CliUpdateNoticeDependencies {
  // Isolate the refresh-lock probe from the real GITNEXUS_HOME.
  const gitnexusHome = fs.mkdtempSync(path.join(os.tmpdir(), 'update-notice-test-'));
  tempHomes.push(gitnexusHome);
  return {
    argv: ['/usr/bin/node', '/prefix/lib/node_modules/gitnexus/dist/cli/index.js', 'status'],
    env: { GITNEXUS_HOME: gitnexusHome },
    installedVersion: '1.6.10',
    isTTY: true,
    eligible: true,
    now: 2_000,
    readCache: vi.fn(() => ({
      lastCheckAt: 1_500,
      latestVersion: '1.7.0',
      stale: false,
    })),
    writeStderr: vi.fn(),
    spawn: vi.fn(() => ({ unref: vi.fn() })),
    ...overrides,
  };
}

describe('CLI cached update notice', () => {
  beforeEach(() => {
    setCliLanguage('en');
  });

  afterEach(() => {
    setCliLanguage(null);
    for (const dir of tempHomes.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes exactly one localized line to stderr for a TTY and keeps stdout untouched', () => {
    const writeStderr = vi.fn();
    const stdoutWrite = vi.spyOn(process.stdout, 'write');
    const deps = dependencies({ writeStderr });

    runCliUpdateNotice(deps);

    expect(writeStderr).toHaveBeenCalledOnce();
    expect(writeStderr).toHaveBeenCalledWith(
      'GitNexus 1.7.0 is available (you are running 1.6.10).\n',
    );
    expect(stdoutWrite).not.toHaveBeenCalled();
    expect(deps.spawn).not.toHaveBeenCalled();
    stdoutWrite.mockRestore();
  });

  it('displays stale valid state and starts one detached, ignored, unrefd refresh child', () => {
    const unref = vi.fn();
    const deps = dependencies({
      readCache: vi.fn(() => ({
        lastCheckAt: 0,
        latestVersion: '1.7.0',
        stale: true,
      })),
      spawn: vi.fn(() => ({ unref })),
    });

    runCliUpdateNotice(deps);

    expect(deps.writeStderr).toHaveBeenCalledOnce();
    expect(deps.spawn).toHaveBeenCalledWith(
      process.execPath,
      ['/prefix/lib/node_modules/gitnexus/dist/cli/index.js', '__update-check'],
      { detached: true, stdio: 'ignore' },
    );
    expect(unref).toHaveBeenCalledOnce();
  });

  it('refreshes a stale unknown/current cache without printing a notice', () => {
    for (const latestVersion of [undefined, '1.6.10', '1.5.0']) {
      const deps = dependencies({
        readCache: vi.fn(() => ({ lastCheckAt: 0, latestVersion, stale: true })),
      });

      runCliUpdateNotice(deps);

      expect(deps.writeStderr).not.toHaveBeenCalled();
      expect(deps.spawn).toHaveBeenCalledOnce();
    }
  });

  it('spawns one refresh child when the cache is missing entirely', () => {
    const unref = vi.fn();
    const deps = dependencies({
      readCache: vi.fn(() => null),
      spawn: vi.fn(() => ({ unref })),
    });

    runCliUpdateNotice(deps);

    expect(deps.writeStderr).not.toHaveBeenCalled();
    expect(deps.spawn).toHaveBeenCalledOnce();
    expect(deps.spawn).toHaveBeenCalledWith(
      process.execPath,
      ['/prefix/lib/node_modules/gitnexus/dist/cli/index.js', '__update-check'],
      { detached: true, stdio: 'ignore' },
    );
    expect(unref).toHaveBeenCalledOnce();
  });

  it('skips the refresh spawn when a live process holds the refresh lock', () => {
    const deps = dependencies({
      readCache: vi.fn(() => ({ lastCheckAt: 0, latestVersion: '1.7.0', stale: true })),
    });
    const lockPath = path.join(deps.env.GITNEXUS_HOME as string, 'update-check.lock');
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: process.pid, ownerId: 'test', processStartTime: readProcessStartTime(process.pid), hostname: os.hostname() })}\n`,
    );

    runCliUpdateNotice(deps);

    // The live holder's refresh covers this invocation.
    expect(deps.spawn).not.toHaveBeenCalled();
    // Display from the stale-but-valid cache is unaffected.
    expect(deps.writeStderr).toHaveBeenCalledOnce();
  });

  it('spawns when a live PID is reuse with a different process start time', () => {
    const deps = dependencies({
      readCache: vi.fn(() => ({ lastCheckAt: 0, latestVersion: '1.7.0', stale: true })),
    });
    const lockPath = path.join(deps.env.GITNEXUS_HOME as string, 'update-check.lock');
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: process.pid, ownerId: 'reused', processStartTime: 'not-this-process', hostname: os.hostname() })}\n`,
    );

    runCliUpdateNotice(deps);

    expect(deps.spawn).toHaveBeenCalledOnce();
    expect(deps.writeStderr).toHaveBeenCalledOnce();
  });

  it('spawns when the lock owner is dead so the child can reclaim it', () => {
    const deps = dependencies({
      readCache: vi.fn(() => null),
    });
    const lockPath = path.join(deps.env.GITNEXUS_HOME as string, 'update-check.lock');
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: 99999999, ownerId: 'stale', processStartTime: 'x', hostname: os.hostname() })}\n`,
    );

    runCliUpdateNotice(deps);

    expect(deps.spawn).toHaveBeenCalledOnce();
  });

  it('does nothing for non-TTY stderr, including no cache read or child spawn', () => {
    const deps = dependencies({ isTTY: false });

    runCliUpdateNotice(deps);

    expect(deps.readCache).not.toHaveBeenCalled();
    expect(deps.writeStderr).not.toHaveBeenCalled();
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it.each(['CI', 'GITNEXUS_NO_UPDATE_NOTIFIER', 'NO_UPDATE_NOTIFIER'])(
    'does nothing when %s is truthy',
    (name) => {
      const deps = dependencies({ env: { [name]: '1' } });

      runCliUpdateNotice(deps);

      expect(deps.readCache).not.toHaveBeenCalled();
      expect(deps.writeStderr).not.toHaveBeenCalled();
      expect(deps.spawn).not.toHaveBeenCalled();
    },
  );

  it('uses truthy-env semantics rather than treating "0" as opted out', () => {
    const deps = dependencies({
      env: {
        CI: '0',
        GITNEXUS_NO_UPDATE_NOTIFIER: 'false',
        NO_UPDATE_NOTIFIER: 'off',
      },
    });

    runCliUpdateNotice(deps);

    expect(deps.writeStderr).toHaveBeenCalledOnce();
  });

  it('does nothing for ineligible dev and Docker contexts', () => {
    for (const env of [{}, { GITNEXUS_NO_UPDATE_NOTIFIER: '1' }]) {
      const deps = dependencies({ eligible: false, env });

      runCliUpdateNotice(deps);

      expect(deps.readCache).not.toHaveBeenCalled();
      expect(deps.spawn).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['augment'],
    ['--help'],
    ['status', '--help'],
    ['--version'],
    ['mcp'],
    ['serve'],
    ['eval-server'],
    ['__update-check'],
  ])('excludes command identity %j from display and refresh', (...args) => {
    const deps = dependencies({ argv: ['/usr/bin/node', '/entry.js', ...args] });

    runCliUpdateNotice(deps);

    expect(deps.readCache).not.toHaveBeenCalled();
    expect(deps.writeStderr).not.toHaveBeenCalled();
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it('swallows cache and spawn failures before Commander parsing', () => {
    expect(() =>
      runCliUpdateNotice(
        dependencies({
          readCache: () => {
            throw new Error('cache unavailable');
          },
        }),
      ),
    ).not.toThrow();

    expect(() =>
      runCliUpdateNotice(
        dependencies({
          readCache: () => ({ lastCheckAt: 0, stale: true }),
          spawn: () => {
            throw new Error('spawn unavailable');
          },
        }),
      ),
    ).not.toThrow();
  });
});

describe('doctor cached update line', () => {
  beforeEach(() => {
    setCliLanguage('en');
  });

  afterEach(() => {
    setCliLanguage(null);
  });

  it('shows installed and latest versions from cache without triggering refresh', () => {
    const readCache = vi.fn(() => ({
      lastCheckAt: 0,
      latestVersion: '1.7.0',
      stale: true,
    }));

    expect(
      cachedUpdateDoctorLine({
        installedVersion: '1.6.10',
        eligible: true,
        env: {},
        readCache,
      }),
    ).toBe('GitNexus 1.7.0 is available (you are running 1.6.10).');
    expect(readCache).toHaveBeenCalledOnce();
  });

  it('is silent for current, invalid, opted-out, and ineligible states', () => {
    expect(
      cachedUpdateDoctorLine({
        installedVersion: '1.6.10',
        eligible: true,
        env: {},
        readCache: () => ({ lastCheckAt: 0, latestVersion: '1.6.10', stale: false }),
      }),
    ).toBeNull();
    expect(
      cachedUpdateDoctorLine({
        installedVersion: '1.6.10',
        eligible: false,
        env: {},
        readCache: vi.fn(),
      }),
    ).toBeNull();
    expect(
      cachedUpdateDoctorLine({
        installedVersion: '1.6.10',
        eligible: true,
        env: { CI: '1' },
        readCache: vi.fn(),
      }),
    ).toBeNull();
  });

  it.each(['v1.7.0', '1.7.0-rc.1'])(
    'is silent for non-strict latestVersion %s',
    (latestVersion) => {
      expect(
        cachedUpdateDoctorLine({
          installedVersion: '1.6.10',
          eligible: true,
          env: {},
          readCache: () => ({ lastCheckAt: 0, latestVersion, stale: false }),
        }),
      ).toBeNull();
    },
  );
});
