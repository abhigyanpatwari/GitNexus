import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  ExtensionManager,
  getExtensionInstallChildProcessArgs,
  getExtensionInstallPolicy,
  getExtensionInstallTimeoutMs,
  type ExtensionInstallResult,
} from '../../src/core/lbug/extension-loader.js';
import { diagnoseExtensionLoad } from '../../src/core/lbug/extension-load-error.js';

const emptyVendor = mkdtempSync(path.join(tmpdir(), 'gn-fts-empty-vendor-'));
const noVendored = { vendorRoot: emptyVendor };

afterAll(() => {
  rmSync(emptyVendor, { recursive: true, force: true });
});

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

    await expect(manager.ensure(query, 'fts', 'FTS', noVendored)).resolves.toBe(true);

    expect(query.mock.calls.map(([sql]) => sql)).toEqual(['LOAD EXTENSION fts']);
    expect(installExtension).not.toHaveBeenCalled();
    expect(manager.getCapabilities()).toEqual([{ name: 'fts', loaded: true }]);
  });

  it('treats "already loaded" load errors as success', async () => {
    const installExtension = vi.fn();
    const manager = new ExtensionManager({ policy: 'auto', installExtension });
    const query = vi.fn().mockRejectedValue(new Error('Extension fts is already loaded'));

    await expect(manager.ensure(query, 'fts', 'FTS', noVendored)).resolves.toBe(true);
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

    await expect(
      manager.ensure(query, 'fts', 'FTS', { ...noVendored, installTimeoutMs: 1234 }),
    ).resolves.toBe(true);

    // The LOAD failure reason is threaded to the installer so it can pick
    // INSTALL vs FORCE INSTALL from the error class (#2374, PR #2375).
    expect(installExtension).toHaveBeenCalledWith('fts', 1234, 'Extension "fts" not found');
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

    await expect(manager.ensure(query, 'fts', 'FTS', noVendored)).resolves.toBe(false);

    expect(installExtension).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('continuing without FTS features'));
    expect(manager.getCapabilities()).toMatchObject([
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

describe('ExtensionManager — reason strings carry the real LOAD error (#2374)', () => {
  it('load-only failure reason includes the underlying LadybugDB error, collapsed to one line', async () => {
    const warn = vi.fn();
    const manager = new ExtensionManager({ policy: 'load-only', warn });
    const query = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'IO exception: Failed to load library: /x/libfts.lbug_extension.\ninvalid ELF header',
        ),
      );

    await expect(manager.ensure(query, 'fts', 'FTS', noVendored)).resolves.toBe(false);

    expect(manager.getCapabilities()).toMatchObject([
      {
        name: 'fts',
        loaded: false,
        reason: expect.stringContaining(
          'LOAD fts failed: IO exception: Failed to load library: /x/libfts.lbug_extension. invalid ELF header',
        ),
      },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid ELF header'));
  });

  it('failed-install reason includes both the install message and the original LOAD error', async () => {
    const installExtension = vi.fn().mockResolvedValue(failedInstall);
    const manager = new ExtensionManager({ policy: 'auto', installExtension, warn: noopWarn });
    const query = vi.fn().mockRejectedValue(new Error('Extension "fts" not found'));

    await expect(manager.ensure(query, 'fts', 'FTS', noVendored)).resolves.toBe(false);

    expect(manager.getCapabilities()).toMatchObject([
      {
        name: 'fts',
        loaded: false,
        reason: 'install failed; LOAD fts had failed: Extension "fts" not found',
      },
    ]);
  });

  it('post-install LOAD failure reason includes the retry error', async () => {
    const installExtension = vi.fn().mockResolvedValue(okInstall);
    const manager = new ExtensionManager({ policy: 'auto', installExtension, warn: noopWarn });
    const query = vi
      .fn()
      .mockRejectedValue(new Error('version mismatch: extension built for 0.17.0'));

    await expect(manager.ensure(query, 'fts', 'FTS', noVendored)).resolves.toBe(false);

    expect(manager.getCapabilities()).toMatchObject([
      {
        name: 'fts',
        loaded: false,
        reason:
          'LOAD fts failed after successful INSTALL: version mismatch: extension built for 0.17.0',
      },
    ]);
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

    await manager.ensure(query, 'fts', 'FTS', noVendored);
    expect(manager.getCapabilities()).toHaveLength(1);

    manager.reset();
    expect(manager.getCapabilities()).toEqual([]);

    await manager.ensure(query, 'fts', 'FTS', noVendored);
    expect(installExtension).toHaveBeenCalledTimes(2);
  });
});

describe('ExtensionManager — observability', () => {
  it('exposes per-extension capability snapshot', async () => {
    const manager = new ExtensionManager({ policy: 'load-only', warn: noopWarn });
    const okQuery = vi.fn().mockResolvedValue({});
    const failQuery = vi.fn().mockRejectedValue(new Error('Extension "vector" not found'));

    await manager.ensure(okQuery, 'fts', 'FTS', noVendored);
    await manager.ensure(failQuery, 'vector', 'VECTOR');

    expect(manager.getCapabilities()).toMatchObject([
      { name: 'fts', loaded: true },
      { name: 'vector', loaded: false, reason: expect.stringContaining('load-only') },
    ]);
  });

  it('warns at most once per (extension, reason) pair', async () => {
    const installExtension = vi.fn();
    const warn = vi.fn();
    const manager = new ExtensionManager({ policy: 'load-only', installExtension, warn });
    const query = vi.fn().mockRejectedValue(new Error('Extension "fts" not found'));

    await manager.ensure(query, 'fts', 'FTS', noVendored);
    await manager.ensure(query, 'fts', 'FTS', noVendored);

    expect(warn).toHaveBeenCalledTimes(1);
  });

  // initLbug's writable FTS pre-load is a speculative probe — on a cold
  // machine it misses, then analyze Phase 3 installs and every FTS index builds.
  // The probe must not report a degradation that the same run repairs.
  it('stays silent on a quiet probe that a later install-capable call repairs', async () => {
    const installExtension = vi.fn().mockResolvedValue(okInstall);
    const warn = vi.fn();
    const manager = new ExtensionManager({ installExtension, warn });
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error('Extension "fts" not found'))
      .mockRejectedValueOnce(new Error('Extension "fts" not found'))
      .mockResolvedValueOnce({});

    await expect(
      manager.ensure(query, 'fts', 'FTS', { ...noVendored, policy: 'load-only', quiet: true }),
    ).resolves.toBe(false);
    expect(warn).not.toHaveBeenCalled();

    await expect(
      manager.ensure(query, 'fts', 'FTS', { ...noVendored, policy: 'auto' }),
    ).resolves.toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(manager.getCapabilities()).toEqual([{ name: 'fts', loaded: true }]);
  });

  it('still warns on a genuine load-only miss that follows a quiet probe of the same reason', async () => {
    const warn = vi.fn();
    const manager = new ExtensionManager({ policy: 'load-only', warn });
    const query = vi.fn().mockRejectedValue(new Error('Extension "fts" not found'));

    await manager.ensure(query, 'fts', 'FTS', { ...noVendored, quiet: true });
    await manager.ensure(query, 'fts', 'FTS', noVendored);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('continuing without FTS features'));
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
    expect(args[1]).toBe('fts');
    expect(Number(args[2])).toBeGreaterThan(0);
  });

  it('passes the resolved LadybugDB max DB size to the installer child', () => {
    expect(getExtensionInstallChildProcessArgs('fts', 1234).at(-1)).toBe('1234');
  });
});

describe('getExtensionInstallPolicy', () => {
  it('defaults to load-only when env var is unset', () => {
    const original = process.env.GITNEXUS_LBUG_EXTENSION_INSTALL;
    delete process.env.GITNEXUS_LBUG_EXTENSION_INSTALL;
    try {
      expect(getExtensionInstallPolicy()).toBe('load-only');
    } finally {
      if (original === undefined) {
        delete process.env.GITNEXUS_LBUG_EXTENSION_INSTALL;
      } else {
        process.env.GITNEXUS_LBUG_EXTENSION_INSTALL = original;
      }
    }
  });

  it('returns auto when env var is set to auto', () => {
    const original = process.env.GITNEXUS_LBUG_EXTENSION_INSTALL;
    process.env.GITNEXUS_LBUG_EXTENSION_INSTALL = 'auto';
    try {
      expect(getExtensionInstallPolicy()).toBe('auto');
    } finally {
      if (original === undefined) {
        delete process.env.GITNEXUS_LBUG_EXTENSION_INSTALL;
      } else {
        process.env.GITNEXUS_LBUG_EXTENSION_INSTALL = original;
      }
    }
  });

  it('returns never when env var is set to never', () => {
    const original = process.env.GITNEXUS_LBUG_EXTENSION_INSTALL;
    process.env.GITNEXUS_LBUG_EXTENSION_INSTALL = 'never';
    try {
      expect(getExtensionInstallPolicy()).toBe('never');
    } finally {
      if (original === undefined) {
        delete process.env.GITNEXUS_LBUG_EXTENSION_INSTALL;
      } else {
        process.env.GITNEXUS_LBUG_EXTENSION_INSTALL = original;
      }
    }
  });

  it('falls back to load-only for invalid env var values', () => {
    const original = process.env.GITNEXUS_LBUG_EXTENSION_INSTALL;
    process.env.GITNEXUS_LBUG_EXTENSION_INSTALL = 'bogus';
    try {
      expect(getExtensionInstallPolicy()).toBe('load-only');
    } finally {
      if (original === undefined) {
        delete process.env.GITNEXUS_LBUG_EXTENSION_INSTALL;
      } else {
        process.env.GITNEXUS_LBUG_EXTENSION_INSTALL = original;
      }
    }
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

const writeVendorArtifact = (
  root: string,
  tuple: string,
  filename = 'libfts.lbug_extension',
): string => {
  const dir = path.join(root, 'lbug-fts', 'prebuilds', tuple);
  mkdirSync(dir, { recursive: true });
  const artifact = path.join(dir, filename);
  writeFileSync(artifact, 'placeholder');
  writeFileSync(
    path.join(root, 'lbug-fts', 'manifest.json'),
    JSON.stringify({
      filename,
      unsupportedTuples: [{ tuple: 'win32-arm64', reason: 'none' }],
    }),
  );
  return artifact;
};

describe('ExtensionManager — vendored-first FTS (U2)', () => {
  const tmpRoots: string[] = [];
  const makeRoot = (): string => {
    const root = mkdtempSync(path.join(tmpdir(), 'gn-fts-vendor-'));
    tmpRoots.push(root);
    return root;
  };

  afterAll(() => {
    for (const root of tmpRoots) rmSync(root, { recursive: true, force: true });
  });

  it('loads a present artifact without spawning an installer child', async () => {
    const vendorRoot = makeRoot();
    const artifact = writeVendorArtifact(vendorRoot, 'linux-x64');
    const installExtension = vi.fn();
    const manager = new ExtensionManager({ policy: 'auto', installExtension });
    const query = vi.fn().mockResolvedValue({});

    await expect(
      manager.ensure(query, 'fts', 'FTS', { vendorRoot, platformTuple: 'linux-x64' }),
    ).resolves.toBe(true);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toBe(`LOAD EXTENSION '${artifact}'`);
    expect(installExtension).not.toHaveBeenCalled();
    expect(JSON.stringify(manager.getCapabilities())).not.toContain(vendorRoot);
  });

  it('still loads under load-only when the artifact is present', async () => {
    const vendorRoot = makeRoot();
    writeVendorArtifact(vendorRoot, 'linux-x64');
    const installExtension = vi.fn();
    const manager = new ExtensionManager({ policy: 'load-only', installExtension });
    const query = vi.fn().mockResolvedValue({});

    await expect(
      manager.ensure(query, 'fts', 'FTS', { vendorRoot, platformTuple: 'linux-x64' }),
    ).resolves.toBe(true);
    expect(installExtension).not.toHaveBeenCalled();
  });

  it('attempts nothing under never, even with a packaged artifact', async () => {
    const vendorRoot = makeRoot();
    writeVendorArtifact(vendorRoot, 'linux-x64');
    const query = vi.fn();
    const installExtension = vi.fn();
    const manager = new ExtensionManager({ policy: 'never', installExtension, warn: noopWarn });

    await expect(
      manager.ensure(query, 'fts', 'FTS', { vendorRoot, platformTuple: 'linux-x64' }),
    ).resolves.toBe(false);
    expect(query).not.toHaveBeenCalled();
    expect(installExtension).not.toHaveBeenCalled();
    expect(manager.getCapabilities()[0]?.reason).toContain('never');
  });

  it('names an unsupported tuple and still tries the named load', async () => {
    const vendorRoot = makeRoot();
    writeVendorArtifact(vendorRoot, 'linux-x64');
    const query = vi.fn().mockRejectedValue(new Error('Extension "fts" not found'));
    const manager = new ExtensionManager({ policy: 'load-only', warn: noopWarn });

    await expect(
      manager.ensure(query, 'fts', 'FTS', { vendorRoot, platformTuple: 'win32-arm64' }),
    ).resolves.toBe(false);
    expect(query.mock.calls.map(([sql]) => sql)).toEqual(['LOAD EXTENSION fts']);
    expect(manager.getCapabilities()[0]?.reason).toContain('win32-arm64');
    expect(manager.getCapabilities()[0]?.reason).not.toContain(vendorRoot);
  });

  it('diagnoses a truncated home copy as corrupt, not missing_dependency (KTD7)', async () => {
    const vendorRoot = makeRoot();
    const artifact = writeVendorArtifact(vendorRoot, 'linux-x64');
    const homeCopy = path.join(makeRoot(), 'truncated.lbug_extension');
    writeFileSync(homeCopy, 'short');
    const query = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(`Failed to load library: ${artifact} which is needed by extension: fts`),
      )
      .mockRejectedValueOnce(
        new Error(
          `Failed to load library: ${homeCopy} which is needed by extension: fts. file too short`,
        ),
      );
    const manager = new ExtensionManager({
      policy: 'auto',
      installExtension: vi.fn().mockResolvedValue(failedInstall),
      warn: noopWarn,
    });

    await expect(
      manager.ensure(query, 'fts', 'FTS', { vendorRoot, platformTuple: 'linux-x64' }),
    ).resolves.toBe(false);

    const cap = manager.getCapabilities()[0];
    expect(cap?.reason).not.toContain(artifact);
    expect(cap?.diagnosis?.kind).toBe('corrupt_file');
    expect(diagnoseExtensionLoad(cap?.reason, 'FTS', homeCopy).kind).toBe('corrupt_file');
  });

  it('escapes a vendored path that contains a quote', async () => {
    const vendorRoot = mkdtempSync(path.join(tmpdir(), "gn-fts-it's-"));
    tmpRoots.push(vendorRoot);
    const artifact = writeVendorArtifact(vendorRoot, 'linux-x64');
    const query = vi.fn().mockResolvedValue({});
    const manager = new ExtensionManager({ policy: 'load-only', warn: noopWarn });

    await expect(
      manager.ensure(query, 'fts', 'FTS', { vendorRoot, platformTuple: 'linux-x64' }),
    ).resolves.toBe(true);
    expect(query.mock.calls[0][0]).toBe(`LOAD EXTENSION '${artifact.replace(/'/g, "\\'")}'`);
  });

  it('rejects a sibling directory that only shares the vendor prefix', async () => {
    const parent = makeRoot();
    const vendorRoot = path.join(parent, 'vendor');
    const evil = path.join(parent, 'vendor-evil', 'lbug-fts', 'prebuilds', 'linux-x64');
    mkdirSync(path.join(vendorRoot, 'lbug-fts'), { recursive: true });
    mkdirSync(evil, { recursive: true });
    writeFileSync(path.join(evil, 'libfts.lbug_extension'), 'evil');
    writeFileSync(
      path.join(vendorRoot, 'lbug-fts', 'manifest.json'),
      JSON.stringify({ filename: 'libfts.lbug_extension' }),
    );
    mkdirSync(path.join(vendorRoot, 'lbug-fts', 'prebuilds', 'linux-x64'), { recursive: true });

    const query = vi.fn().mockRejectedValue(new Error('Extension "fts" not found'));
    const manager = new ExtensionManager({ policy: 'load-only', warn: noopWarn });
    await manager.ensure(query, 'fts', 'FTS', { vendorRoot, platformTuple: 'linux-x64' });
    expect(query.mock.calls.map(([sql]) => sql)).toEqual(['LOAD EXTENSION fts']);
    expect(String(query.mock.calls[0][0])).not.toContain('vendor-evil');
  });

  it('does not try a vendored path for VECTOR and records no tuple', async () => {
    const vendorRoot = makeRoot();
    writeVendorArtifact(vendorRoot, 'linux-x64');
    const query = vi.fn().mockResolvedValue({});
    const manager = new ExtensionManager({ policy: 'auto' });

    await expect(
      manager.ensure(query, 'vector', 'VECTOR', { vendorRoot, platformTuple: 'linux-x64' }),
    ).resolves.toBe(true);
    expect(query.mock.calls.map(([sql]) => sql)).toEqual(['LOAD EXTENSION vector']);
    expect(manager.getCapabilities()[0]?.attempts).toBeUndefined();
  });
});
