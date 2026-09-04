import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { updateEligibleInstall } from '../../src/core/install-context.js';
import { isNewerVersion } from '../../src/core/update-cache.js';
import { armUpdateRefreshScheduler, evaluate, refresh } from '../../src/core/update-check.js';
import { acquireFileLock } from '../../src/storage/file-lock.js';

const DAY_MS = 24 * 60 * 60 * 1_000;
const NOW = Date.parse('2026-09-04T05:00:00.000Z');
const REGISTRY = 'https://registry.npmjs.org';
const tempDirs: string[] = [];

async function tempHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-update-check-'));
  tempDirs.push(dir);
  vi.stubEnv('GITNEXUS_HOME', dir);
  return dir;
}

function cachePath(home: string): string {
  return path.join(home, 'update-check.json');
}

async function writeCache(
  home: string,
  body: { lastCheckAt: string; registry: string; latestVersion?: string },
): Promise<void> {
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(cachePath(home), JSON.stringify(body));
}

async function readCache(home: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(cachePath(home), 'utf8')) as Record<string, unknown>;
}

function registryResponse(version = '1.7.0'): Response {
  return new Response(JSON.stringify({ version }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.stubEnv('npm_config_registry', REGISTRY);
  // GitHub Actions sets CI=true; the checker treats that as a hard opt-out.
  vi.stubEnv('CI', '');
  vi.stubEnv('GITNEXUS_NO_UPDATE_NOTIFIER', '');
  vi.stubEnv('NO_UPDATE_NOTIFIER', '');
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('update check cache and versions', () => {
  it('returns a newer version from a fresh cache', async () => {
    const home = await tempHome();
    await writeCache(home, {
      lastCheckAt: new Date(NOW).toISOString(),
      registry: REGISTRY,
      latestVersion: '1.7.0',
    });

    await expect(
      evaluate({ eligible: true, installedVersion: '1.6.10', now: NOW }),
    ).resolves.toEqual({ updateAvailable: true, latestVersion: '1.7.0' });
  });

  it('returns stale valid state and starts one stale-while-revalidate refresh', async () => {
    const home = await tempHome();
    await writeCache(home, {
      lastCheckAt: new Date(NOW - DAY_MS - 1).toISOString(),
      registry: REGISTRY,
      latestVersion: '1.7.0',
    });
    const fetchMock = vi.fn().mockResolvedValue(registryResponse('1.8.0'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      evaluate({ eligible: true, installedVersion: '1.6.10', now: NOW }),
    ).resolves.toEqual({ updateAvailable: true, latestVersion: '1.7.0' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => expect((await readCache(home)).latestVersion).toBe('1.8.0'));
  });

  it.each(['1.6.10', '1.6.9'])('is silent for fresh equal/lower latest %s', async (latest) => {
    const home = await tempHome();
    await writeCache(home, {
      lastCheckAt: new Date(NOW).toISOString(),
      registry: REGISTRY,
      latestVersion: latest,
    });

    await expect(
      evaluate({ eligible: true, installedVersion: '1.6.10', now: NOW }),
    ).resolves.toEqual({ updateAvailable: false, latestVersion: latest });
  });

  it('treats corrupt JSON as a miss and refresh overwrites it', async () => {
    const home = await tempHome();
    await fs.writeFile(cachePath(home), '{broken');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(registryResponse()));

    await expect(
      evaluate({ eligible: true, installedVersion: '1.6.10', now: NOW }),
    ).resolves.toBeNull();
    await vi.waitFor(async () => expect((await readCache(home)).latestVersion).toBe('1.7.0'));
  });

  it('never propagates a latestVersion with a non-strict format', async () => {
    const home = await tempHome();
    await writeCache(home, {
      lastCheckAt: new Date(NOW).toISOString(),
      registry: REGISTRY,
      latestVersion: 'v1.7.0',
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    await expect(
      evaluate({ eligible: true, installedVersion: '1.6.10', now: NOW }),
    ).resolves.toBeNull();
    await vi.waitFor(async () => expect((await readCache(home)).latestVersion).toBeUndefined());
  });

  it('treats a future timestamp as stale', async () => {
    const home = await tempHome();
    await writeCache(home, {
      lastCheckAt: new Date(NOW + 1).toISOString(),
      registry: REGISTRY,
      latestVersion: '1.7.0',
    });
    const fetchMock = vi.fn().mockResolvedValue(registryResponse());
    vi.stubGlobal('fetch', fetchMock);

    await evaluate({ eligible: true, installedVersion: '1.6.10', now: NOW });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => expect((await readCache(home)).latestVersion).toBe('1.7.0'));
  });

  it('writes a negative entry after failure and suppresses retries inside the TTL', async () => {
    const home = await tempHome();
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);

    await refresh({ eligible: true, now: NOW });
    expect(await readCache(home)).toEqual({
      lastCheckAt: new Date(NOW).toISOString(),
      registry: REGISTRY,
    });
    await evaluate({ eligible: true, installedVersion: '1.6.10', now: NOW + 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips fetch when another process holds the refresh lock', async () => {
    const home = await tempHome();
    const release = await acquireFileLock(path.join(home, 'update-check.lock'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      await refresh({ eligible: true, now: NOW });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await release();
    }
  });

  it('returns stale cache state without fetching when refreshIfStale is false', async () => {
    const home = await tempHome();
    await writeCache(home, {
      lastCheckAt: new Date(NOW - DAY_MS - 1).toISOString(),
      registry: REGISTRY,
      latestVersion: '1.7.0',
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      evaluate({
        eligible: true,
        installedVersion: '1.6.10',
        now: NOW,
        refreshIfStale: false,
      }),
    ).resolves.toEqual({ updateAvailable: true, latestVersion: '1.7.0' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('replaces a future-dated cache timestamp instead of preserving it', async () => {
    const home = await tempHome();
    await writeCache(home, {
      lastCheckAt: '2099-01-01T00:00:00.000Z',
      registry: REGISTRY,
      latestVersion: '9.9.9',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(registryResponse('1.8.0')));

    await refresh({ eligible: true, installedVersion: '1.6.10', now: NOW });

    expect(await readCache(home)).toEqual({
      lastCheckAt: new Date(NOW).toISOString(),
      registry: REGISTRY,
      latestVersion: '1.8.0',
    });
  });

  it('dedupes concurrent refresh() callers onto one fetch', async () => {
    await tempHome();
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const first = refresh({ eligible: true, installedVersion: '1.6.10', now: NOW });
    const second = refresh({ eligible: true, installedVersion: '1.6.10', now: NOW });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    resolveFetch(registryResponse('1.8.0'));

    await expect(Promise.all([first, second])).resolves.toEqual([
      { updateAvailable: true, latestVersion: '1.8.0' },
      { updateAvailable: true, latestVersion: '1.8.0' },
    ]);
    expect(first).toBe(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not let a late failed attempt overwrite a newer success', async () => {
    const home = await tempHome();
    let rejectFetch!: (error: Error) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((_resolve, reject) => {
            rejectFetch = reject;
          }),
      ),
    );

    // Relative to the real clock: publishMonotonically only preserves a newer
    // on-disk timestamp when it is not in the future (`currentAt <= Date.now()`).
    const wall = Date.now();
    const olderAttempt = wall - 10_000;
    const newerSuccess = wall - 1;
    const pending = refresh({ eligible: true, now: olderAttempt });
    await vi.waitFor(() => expect(rejectFetch).toBeTypeOf('function'));
    await writeCache(home, {
      lastCheckAt: new Date(newerSuccess).toISOString(),
      registry: REGISTRY,
      latestVersion: '1.8.0',
    });
    rejectFetch(new Error('late failure'));
    await pending;

    expect(await readCache(home)).toEqual({
      lastCheckAt: new Date(newerSuccess).toISOString(),
      registry: REGISTRY,
      latestVersion: '1.8.0',
    });
  });

  it('treats a cache from another registry as a miss', async () => {
    const home = await tempHome();
    await writeCache(home, {
      lastCheckAt: new Date(NOW).toISOString(),
      registry: 'https://registry.example.test/custom',
      latestVersion: '9.0.0',
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    await expect(
      evaluate({
        eligible: true,
        installedVersion: '1.6.10',
        now: NOW,
        refreshIfStale: false,
      }),
    ).resolves.toBeNull();
  });

  it('handles prerelease and lower versions with the strict comparator', () => {
    expect(isNewerVersion('1.7.0-rc.1', '1.6.10')).toBe(false);
    expect(isNewerVersion('1.7.0', '1.6.10')).toBe(false);
    expect(isNewerVersion('1.6.10', '1.6.9')).toBe(false);
    expect(isNewerVersion('1.6.10', '1.7.0')).toBe(true);
    expect(isNewerVersion('1.0.9007199254740992', '1.0.9007199254740993')).toBe(true);
  });
});

describe('hardened registry request', () => {
  it('strips registry userinfo and sends no credentials', async () => {
    await tempHome();
    vi.stubEnv('npm_config_registry', 'https://user:secret@registry.example.test/custom/');
    const fetchMock = vi.fn().mockResolvedValue(registryResponse());
    vi.stubGlobal('fetch', fetchMock);

    await refresh({ eligible: true, now: NOW });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://registry.example.test/custom/gitnexus/latest');
    expect(url).not.toContain('user');
    expect(new Headers(init.headers).has('authorization')).toBe(false);
  });

  it('refuses a redirect to loopback/private addresses', async () => {
    const home = await tempHome();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/latest' } }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await refresh({ eligible: true, now: NOW });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await readCache(home)).not.toHaveProperty('latestVersion');
  });

  it('caps an oversized response body', async () => {
    const home = await tempHome();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('x'.repeat(70_000), { status: 200 })),
    );

    await refresh({ eligible: true, now: NOW });

    expect(await readCache(home)).not.toHaveProperty('latestVersion');
  });
});

describe('guards and scheduler', () => {
  it.each(['GITNEXUS_NO_UPDATE_NOTIFIER', 'NO_UPDATE_NOTIFIER', 'CI'])(
    '%s skips cache refresh and network with truthy-env semantics',
    async (name) => {
      await tempHome();
      vi.stubEnv(name, 'yes');
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      await expect(evaluate({ eligible: true, now: NOW })).resolves.toBeNull();
      await refresh({ eligible: true, now: NOW });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('ignoreOptOut still fetches when CI/opt-out env is set', async () => {
    await tempHome();
    vi.stubEnv('CI', 'true');
    const fetchMock = vi.fn().mockResolvedValue(registryResponse());
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      refresh({
        eligible: true,
        ignoreOptOut: true,
        installedVersion: '1.6.10',
        now: NOW,
      }),
    ).resolves.toEqual({ updateAvailable: true, latestVersion: '1.7.0' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('an ineligible install skips network', async () => {
    await tempHome();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(evaluate({ eligible: false, now: NOW })).resolves.toBeNull();
    await refresh({ eligible: false, now: NOW });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an unwritable cache path fails open', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-update-unwritable-'));
    tempDirs.push(root);
    const blocker = path.join(root, 'not-a-directory');
    await fs.writeFile(blocker, 'x');
    vi.stubEnv('GITNEXUS_HOME', path.join(blocker, 'child'));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    await expect(evaluate({ eligible: true, now: NOW })).resolves.toBeNull();
    await expect(refresh({ eligible: true, now: NOW })).resolves.toBeNull();
  });

  it('arms an unrefd, clearable, single-flight scheduler', async () => {
    await tempHome();
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onState = vi.fn();
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const clearA = armUpdateRefreshScheduler(onState, { eligible: true, now: () => NOW });
    const clearB = armUpdateRefreshScheduler(onState, { eligible: true, now: () => NOW });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const immediateHandles = timeoutSpy.mock.results
      .map((result) => result.value as NodeJS.Timeout)
      .filter((handle) => typeof handle?.hasRef === 'function');
    expect(immediateHandles.some((handle) => !handle.hasRef())).toBe(true);
    resolveFetch(registryResponse());
    await vi.waitFor(() => expect(onState).toHaveBeenCalled());
    clearA();
    clearB();
  });

  it('backs off when refresh is lock-busy instead of spinning at 1ms', async () => {
    const home = await tempHome();
    await writeCache(home, {
      lastCheckAt: new Date(NOW - DAY_MS - 1).toISOString(),
      registry: REGISTRY,
      latestVersion: '1.7.0',
    });
    const release = await acquireFileLock(path.join(home, 'update-check.lock'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const onState = vi.fn();
    try {
      const clear = armUpdateRefreshScheduler(onState, { eligible: true, now: () => NOW });
      await vi.waitFor(() => expect(onState).toHaveBeenCalled());
      const retryDelay = timeoutSpy.mock.calls
        .map(([, delay]) => delay)
        .find(
          (delay): delay is number =>
            typeof delay === 'number' && delay >= 30_000 && delay <= 60_000,
        );
      expect(retryDelay).toBeDefined();
      expect(fetchMock).not.toHaveBeenCalled();
      clear();
    } finally {
      await release();
    }
  });
});

describe('updateEligibleInstall', () => {
  async function entry(relative: string): Promise<{ root: string; entry: string }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-install-context-'));
    tempDirs.push(root);
    const entryPath = path.join(root, relative);
    await fs.mkdir(path.dirname(entryPath), { recursive: true });
    await fs.writeFile(entryPath, '');
    return { root, entry: entryPath };
  }

  it('classifies global, local, ephemeral, dev, and Docker layouts', async () => {
    const global = await entry('prefix/lib/node_modules/gitnexus/dist/cli/index.js');
    expect(
      await updateEligibleInstall(global.entry, {
        npm_config_prefix: path.join(global.root, 'prefix'),
      }),
    ).toBe(true);

    const local = await entry('project/node_modules/gitnexus/dist/cli/index.js');
    expect(await updateEligibleInstall(local.entry, {})).toBe(true);

    const namedDlx = await entry('dlx/project/node_modules/gitnexus/dist/cli/index.js');
    expect(await updateEligibleInstall(namedDlx.entry, {})).toBe(true);

    for (const relative of [
      'cache/_npx/123/node_modules/gitnexus/dist/cli/index.js',
      'cache/_cacache/tmp/node_modules/gitnexus/dist/cli/index.js',
      'pnpm/dlx/123/node_modules/gitnexus/dist/cli/index.js',
      '.bun/install/cache/gitnexus@1.0.0/node_modules/gitnexus/dist/cli/index.js',
    ]) {
      const ephemeral = await entry(relative);
      expect(
        await updateEligibleInstall(ephemeral.entry, {
          npm_config_cache: path.join(ephemeral.root, 'cache'),
          npm_execpath: path.join(ephemeral.root, relative),
        }),
      ).toBe(false);
    }

    const dev = await entry('checkout/gitnexus/src/cli/index.ts');
    await fs.mkdir(path.join(dev.root, 'checkout', '.git'));
    expect(await updateEligibleInstall(dev.entry, {})).toBe(false);

    const docker = await entry('usr/local/lib/node_modules/gitnexus/dist/cli/index.js');
    expect(
      await updateEligibleInstall(docker.entry, {
        npm_config_prefix: path.join(docker.root, 'usr/local'),
      }),
    ).toBe(true);
  });
});
