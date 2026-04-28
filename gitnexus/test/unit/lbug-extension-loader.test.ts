import { describe, expect, it, vi } from 'vitest';
import {
  ExtensionManager,
  getExtensionInstallChildProcessArgs,
  getExtensionInstallTimeoutMs,
  type ExtensionInstallResult,
} from '../../src/core/lbug/extension-loader.js';

const okInstall: ExtensionInstallResult = {
  success: true,
  timedOut: false,
  message: 'installed',
};
const failedInstall: ExtensionInstallResult = {
  success: false,
  timedOut: false,
  message: 'install failed',
};
const timedOutInstall: ExtensionInstallResult = {
  success: false,
  timedOut: true,
  message: 'INSTALL vector timed out after 10ms',
};

const noopWarn = (): void => {};

describe('ExtensionManager — LOAD-first behavior', () => {
  it('uses LOAD only and never invokes INSTALL when the extension is already available', async () => {
    const installExtension = vi.fn();
    const manager = new ExtensionManager({ policy: 'auto', installExtension });
    const query = vi.fn().mockResolvedValue({});

    await expect(manager.ensure(query, 'fts', 'FTS')).resolves.toBe(true);

    expect(query.mock.calls.map(([sql]) => sql)).toEqual(['LOAD EXTENSION fts']);
    expect(installExtension).not.toHaveBeenCalled();
    expect(manager.getCapabilities()).toEqual([{ name: 'fts', loaded: true }]);
  });

  it('treats "already loaded" load errors as success', async () => {
    const installExtension = vi.fn();
    const manager = new ExtensionManager({ policy: 'auto', installExtension });
    const query = vi.fn().mockRejectedValue(new Error('Extension fts is already loaded'));

    await expect(manager.ensure(query, 'fts', 'FTS')).resolves.toBe(true);
    expect(installExtension).not.toHaveBeenCalled();
  });
});

describe('ExtensionManager — install policies', () => {
  it('runs bounded out-of-process INSTALL and retries LOAD when policy=auto', async () => {
    const installExtension = vi.fn().mockResolvedValue(okInstall);
    const manager = new ExtensionManager({ policy: 'auto', installExtension });
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error('Extension "fts" not found'))
      .mockResolvedValueOnce({});

    await expect(manager.ensure(query, 'fts', 'FTS', { installTimeoutMs: 1234 })).resolves.toBe(
      true,
    );

    expect(installExtension).toHaveBeenCalledWith('fts', 1234);
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'LOAD EXTENSION fts',
      'LOAD EXTENSION fts',
    ]);
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith('INSTALL '))).toBe(false);
  });

  it('skips INSTALL and warns when policy=load-only', async () => {
    const installExtension = vi.fn();
    const warn = vi.fn();
    const manager = new ExtensionManager({ policy: 'load-only', installExtension, warn });
    const query = vi.fn().mockRejectedValue(new Error('Extension "fts" not found'));

    await expect(manager.ensure(query, 'fts', 'FTS')).resolves.toBe(false);

    expect(installExtension).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('continuing without FTS features'));
    expect(manager.getCapabilities()).toEqual([
      { name: 'fts', loaded: false, reason: expect.stringContaining('load-only') },
    ]);
  });

  it('short-circuits LOAD and INSTALL when policy=never', async () => {
    const installExtension = vi.fn();
    const warn = vi.fn();
    const manager = new ExtensionManager({ policy: 'never', installExtension, warn });
    const query = vi.fn();

    await expect(manager.ensure(query, 'vector', 'VECTOR')).resolves.toBe(false);

    expect(query).not.toHaveBeenCalled();
    expect(installExtension).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('continuing without VECTOR features'),
    );
  });

  it('per-call options override manager defaults', async () => {
    const installExtension = vi.fn().mockResolvedValue(okInstall);
    const manager = new ExtensionManager({
      policy: 'auto',
      installExtension,
      warn: noopWarn,
    });
    const query = vi.fn().mockRejectedValue(new Error('Extension "vector" not found'));

    await expect(manager.ensure(query, 'vector', 'VECTOR', { policy: 'load-only' })).resolves.toBe(
      false,
    );

    expect(installExtension).not.toHaveBeenCalled();
  });

  it('returns false and warns when bounded install times out', async () => {
    const installExtension = vi.fn().mockResolvedValue(timedOutInstall);
    const warn = vi.fn();
    const manager = new ExtensionManager({ policy: 'auto', installExtension, warn });
    const query = vi.fn().mockRejectedValue(new Error('Extension "vector" not found'));

    await expect(manager.ensure(query, 'vector', 'VECTOR', { installTimeoutMs: 10 })).resolves.toBe(
      false,
    );

    expect(query.mock.calls.map(([sql]) => sql)).toEqual(['LOAD EXTENSION vector']);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('continuing without VECTOR features'),
    );
  });
});

describe('ExtensionManager — caching', () => {
  it('caches install attempt outcome to avoid retrying within the same process', async () => {
    const installExtension = vi.fn().mockResolvedValue(timedOutInstall);
    const manager = new ExtensionManager({
      policy: 'auto',
      installExtension,
      warn: noopWarn,
    });
    const query = vi.fn().mockRejectedValue(new Error('Extension "vector" not found'));

    await expect(manager.ensure(query, 'vector', 'VECTOR')).resolves.toBe(false);
    await expect(manager.ensure(query, 'vector', 'VECTOR')).resolves.toBe(false);

    expect(installExtension).toHaveBeenCalledOnce();
  });

  it('reset() clears capability and install state so install is retried', async () => {
    const installExtension = vi.fn().mockResolvedValue(failedInstall);
    const manager = new ExtensionManager({
      policy: 'auto',
      installExtension,
      warn: noopWarn,
    });
    const query = vi.fn().mockRejectedValue(new Error('Extension "fts" not found'));

    await manager.ensure(query, 'fts', 'FTS');
    expect(manager.getCapabilities()).toHaveLength(1);

    manager.reset();
    expect(manager.getCapabilities()).toEqual([]);

    await manager.ensure(query, 'fts', 'FTS');
    expect(installExtension).toHaveBeenCalledTimes(2);
  });
});

describe('ExtensionManager — observability', () => {
  it('exposes per-extension capability snapshot', async () => {
    const manager = new ExtensionManager({ policy: 'load-only', warn: noopWarn });
    const okQuery = vi.fn().mockResolvedValue({});
    const failQuery = vi.fn().mockRejectedValue(new Error('Extension "vector" not found'));

    await manager.ensure(okQuery, 'fts', 'FTS');
    await manager.ensure(failQuery, 'vector', 'VECTOR');

    expect(manager.getCapabilities()).toEqual([
      { name: 'fts', loaded: true },
      { name: 'vector', loaded: false, reason: expect.stringContaining('load-only') },
    ]);
  });

  it('warns at most once per (extension, reason) pair', async () => {
    const installExtension = vi.fn();
    const warn = vi.fn();
    const manager = new ExtensionManager({ policy: 'load-only', installExtension, warn });
    const query = vi.fn().mockRejectedValue(new Error('Extension "fts" not found'));

    await manager.ensure(query, 'fts', 'FTS');
    await manager.ensure(query, 'fts', 'FTS');

    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('ExtensionManager — input validation', () => {
  it('rejects extension names that are not bare identifiers', async () => {
    const manager = new ExtensionManager({ policy: 'auto' });
    const query = vi.fn();

    await expect(manager.ensure(query, 'fts; DROP TABLE x', 'FTS')).rejects.toThrow(/Invalid/);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('installDuckDbExtensionOutOfProcess child process', () => {
  it('spawns the stable packaged installer script instead of inline -e code', () => {
    const args = getExtensionInstallChildProcessArgs('fts');

    expect(args).not.toContain('-e');
    expect(args).not.toContain('--input-type=module');
    expect(args[0]).toContain('scripts');
    expect(args[0]).toContain('install-duckdb-extension.mjs');
    expect(args.at(-1)).toBe('fts');
  });
});

describe('getExtensionInstallTimeoutMs', () => {
  it('reads a positive override from the environment', () => {
    const original = process.env.GITNEXUS_LBUG_EXTENSION_INSTALL_TIMEOUT_MS;
    process.env.GITNEXUS_LBUG_EXTENSION_INSTALL_TIMEOUT_MS = '42';
    try {
      expect(getExtensionInstallTimeoutMs()).toBe(42);
    } finally {
      if (original === undefined) {
        delete process.env.GITNEXUS_LBUG_EXTENSION_INSTALL_TIMEOUT_MS;
      } else {
        process.env.GITNEXUS_LBUG_EXTENSION_INSTALL_TIMEOUT_MS = original;
      }
    }
  });

  it('falls back to the default when the env var is missing or invalid', () => {
    const original = process.env.GITNEXUS_LBUG_EXTENSION_INSTALL_TIMEOUT_MS;
    delete process.env.GITNEXUS_LBUG_EXTENSION_INSTALL_TIMEOUT_MS;
    try {
      expect(getExtensionInstallTimeoutMs()).toBe(15_000);
      process.env.GITNEXUS_LBUG_EXTENSION_INSTALL_TIMEOUT_MS = 'notanumber';
      expect(getExtensionInstallTimeoutMs()).toBe(15_000);
      process.env.GITNEXUS_LBUG_EXTENSION_INSTALL_TIMEOUT_MS = '0';
      expect(getExtensionInstallTimeoutMs()).toBe(15_000);
    } finally {
      if (original === undefined) {
        delete process.env.GITNEXUS_LBUG_EXTENSION_INSTALL_TIMEOUT_MS;
      } else {
        process.env.GITNEXUS_LBUG_EXTENSION_INSTALL_TIMEOUT_MS = original;
      }
    }
  });
});
