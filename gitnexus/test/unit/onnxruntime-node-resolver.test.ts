import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';

/**
 * Tests for the CUDA-build-matching onnxruntime-node redirect.
 *
 * `@huggingface/transformers` exact-pins a CUDA-12 `onnxruntime-node`, while
 * gitnexus' own dep floats to a CUDA-13 build; on a CUDA-13 host this module
 * redirects transformers to the matching copy so embeddings use the GPU instead
 * of silently falling back to CPU. The detection primitives (`ldconfig` / `ldd`
 * / path scan) and `module.registerHooks` are mocked so the pure decision logic
 * is asserted without touching the real loader or the host's CUDA install.
 */

const RESOLVER = '../../src/core/embeddings/onnxruntime-node-resolver.js';

const REAL_PLATFORM = process.platform;
const REAL_ENV = { ...process.env };

/**
 * Node's `path` module is bound to `path.win32` or `path.posix` based on the
 * REAL host OS at process start — stubbing `process.platform` later (as this
 * file's tests do, for the resolver's OWN platform branching) has no effect
 * on it. So on a genuine Windows CI runner, the resolver's `join(...)` calls
 * normalize our forward-slash fake dirs to backslash-separated strings,
 * which would silently fail to match the forward-slash fixtures/prefixes
 * below. Normalize before every comparison so these tests are host-OS-agnostic.
 */
const toPosix = (p: string): string => p.replace(/\\/g, '/');

/** Three fake, distinct onnxruntime-node locations for driving decide() into redirect:true. */
interface FakeDirs {
  /** gitnexus' own top-level onnxruntime-node dir (resolved via the module's own require). */
  ourDir: string;
  /** transformers' pinned/nested onnxruntime-node dir (resolved via createRequire(transformersMain)). */
  defaultDir: string;
  /** fake resolved path for require.resolve('@huggingface/transformers'). */
  transformersMain: string;
  /** When false, createRequire(transformersMain).resolve('onnxruntime-node/package.json') throws
   *  (simulating resolveDefaultOrtNodeDir() failing outright) instead of resolving to `defaultDir`. */
  defaultResolvable?: boolean;
  /** When false, gitnexus' own top-level onnxruntime-node does NOT resolve (pruned install),
   *  so resolveOurOrtNodeDir falls back to the on-demand prefix (#2372). */
  ourResolvable?: boolean;
  /** The runtime prefix dir the test set via GITNEXUS_EMBEDDING_RUNTIME_DIR; its `<dir>/noop.js`
   *  createRequire anchor is routed to a require that resolves onnxruntime-node to `prefixOrtNodeDir`. */
  prefixDir?: string;
  /** onnxruntime-node dir the prefix-anchored require resolves to (the #2372 fallback target). */
  prefixOrtNodeDir?: string;
}

interface LoadOpts {
  registerHooks?: unknown;
  platform?: NodeJS.Platform;
  execFileSync?: (cmd: string, args: string[]) => string;
  existsSync?: (p: string) => boolean;
  fakeDirs?: FakeDirs;
  /** Force the resolver's `join`/`dirname` calls to use `path.win32` semantics
   *  (backslash-normalized output) regardless of the real host OS — proves the
   *  `toPosix()` normalization above actually works, rather than merely being
   *  argued for (#2341 follow-up). */
  forceWin32Path?: boolean;
}

/** A require()-like function whose .resolve() is driven entirely by a specifier -> path map. */
function fakeRequire(resolveMap: Record<string, string>) {
  return Object.assign(
    (specifier: string) => {
      throw new Error(`fakeRequire: unexpected require(${specifier})`);
    },
    {
      resolve: (specifier: string) => {
        const hit = resolveMap[specifier];
        if (!hit) {
          throw Object.assign(new Error(`Cannot find module '${specifier}'`), {
            code: 'MODULE_NOT_FOUND',
          });
        }
        return hit;
      },
    },
  );
}

/**
 * (Re)load the resolver with detection primitives + `registerHooks` mocked.
 * `vi.resetModules()` clears the module-level decision cache and one-shot guard,
 * so each test gets a pristine resolver.
 *
 * When `fakeDirs` is supplied, `createRequire` is also mocked so the module's
 * two CJS resolve-walks (`resolveOurOrtNodeDir`/`resolveDefaultOrtNodeDir`, and
 * the nodeUrl/commonUrl lookup inside `ensureOnnxRuntimeNodeMatchesSystem`) each
 * resolve against a distinct fake directory instead of whatever's actually
 * installed in this test's real node_modules — the only way to drive
 * `decide() -> redirect:true` deterministically without touching production code.
 */
async function loadResolver(opts: LoadOpts = {}) {
  vi.resetModules();
  // Destructuring defaults (`= vi.fn()`) only apply when the property is
  // `undefined` — but callers pass `registerHooks: undefined` specifically to
  // simulate Node < 22.15 (no synchronous-hooks API), so a plain destructuring
  // default would silently substitute a real mock function and defeat that.
  // `'registerHooks' in opts` distinguishes "omitted → default to a spy" from
  // "explicitly undefined → simulate its absence".
  const registerHooks = 'registerHooks' in opts ? opts.registerHooks : vi.fn();
  const {
    platform = 'linux',
    execFileSync = () => {
      throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
    },
    existsSync = () => false,
    fakeDirs,
    forceWin32Path = false,
  } = opts;

  if (forceWin32Path) {
    vi.doMock('node:path', () => ({ ...path.win32, default: path.win32 }));
  }

  vi.doMock('node:module', async (io) => {
    const orig = await io<typeof import('node:module')>();
    if (!fakeDirs) return { ...orig, registerHooks };

    const ourRequire = fakeRequire({
      '@huggingface/transformers': fakeDirs.transformersMain,
      ...(fakeDirs.ourResolvable === false
        ? {}
        : { 'onnxruntime-node/package.json': `${fakeDirs.ourDir}/package.json` }),
    });
    const defaultRequire = fakeRequire(
      fakeDirs.defaultResolvable === false
        ? {}
        : { 'onnxruntime-node/package.json': `${fakeDirs.defaultDir}/package.json` },
    );
    const effectiveRequire = fakeRequire({
      'onnxruntime-node': `${fakeDirs.ourDir}/index.js`,
      'onnxruntime-common': `${fakeDirs.ourDir}/node_modules/onnxruntime-common/index.js`,
    });
    // The on-demand prefix's require (anchored at `<prefixDir>/noop.js`) resolves
    // gitnexus' effective top-level onnxruntime-node when the real one was pruned (#2372).
    const prefixRequire = fakeRequire(
      fakeDirs.prefixOrtNodeDir
        ? { 'onnxruntime-node/package.json': `${fakeDirs.prefixOrtNodeDir}/package.json` }
        : {},
    );
    return {
      ...orig,
      registerHooks,
      createRequire: (from: string) => {
        // `from` is produced by the resolver's own `join(effectiveDir, 'package.json')`
        // call — backslash-normalized on a real Windows host even though
        // `fakeDirs.ourDir` etc. are forward-slash fixtures; normalize before comparing.
        const normalizedFrom = toPosix(from);
        if (normalizedFrom === fakeDirs.transformersMain) return defaultRequire;
        if (normalizedFrom === `${fakeDirs.ourDir}/package.json`) return effectiveRequire;
        // The runtime-prefix anchor is the only createRequire `from` ending in
        // noop.js; match by suffix so a real-Windows `path.resolve` drive prefix
        // (C:\…) on the env-set prefix dir doesn't defeat an exact-path compare.
        if (fakeDirs.prefixDir && normalizedFrom.endsWith('/noop.js')) return prefixRequire;
        return ourRequire;
      },
    };
  });
  vi.doMock('node:child_process', async (io) => ({
    ...(await io<typeof import('node:child_process')>()),
    // Normalize args (the `.so` path for `ldd`) so callers' forward-slash
    // prefix checks match regardless of which path module the resolver's
    // own `join(...)` calls were bound to on the host running this test.
    execFileSync: (cmd: string, args: string[]) => execFileSync(cmd, args.map(toPosix)),
  }));
  vi.doMock('node:fs', async (io) => ({
    ...(await io<typeof import('node:fs')>()),
    existsSync: (p: unknown) => existsSync(toPosix(String(p))),
  }));

  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  return import(RESOLVER);
}

afterEach(() => {
  vi.doUnmock('node:module');
  vi.doUnmock('node:child_process');
  vi.doUnmock('node:fs');
  vi.doUnmock('node:path');
  Object.defineProperty(process, 'platform', { value: REAL_PLATFORM, configurable: true });
  process.env = { ...REAL_ENV };
});

describe('detectSystemCudaMajor', () => {
  it.each(['darwin', 'win32'] as const)(
    'returns null on non-linux platforms (%s)',
    async (platform) => {
      const mod = await loadResolver({ platform });
      expect(mod.detectSystemCudaMajor()).toBeNull();
    },
  );

  it('prefers CUDA 13 over 12 when ldconfig lists both', async () => {
    const mod = await loadResolver({
      execFileSync: () =>
        'libcublasLt.so.13 (libc6,x86-64) => /usr/local/cuda/lib64/libcublasLt.so.13\n' +
        'libcublasLt.so.12 (libc6,x86-64) => /old/libcublasLt.so.12',
    });
    expect(mod.detectSystemCudaMajor()).toBe(13);
  });

  it('detects CUDA 12 when only .so.12 is present', async () => {
    const mod = await loadResolver({
      execFileSync: () => 'libcublasLt.so.12 (libc6,x86-64) => /usr/lib/libcublasLt.so.12',
    });
    expect(mod.detectSystemCudaMajor()).toBe(12);
  });

  it('falls back to an LD_LIBRARY_PATH scan when ldconfig is unavailable', async () => {
    process.env.LD_LIBRARY_PATH = '/opt/cuda/lib64';
    const mod = await loadResolver({
      execFileSync: () => {
        throw new Error('ldconfig missing');
      },
      existsSync: (p) => p === '/opt/cuda/lib64/libcublasLt.so.13',
    });
    expect(mod.detectSystemCudaMajor()).toBe(13);
  });

  it('returns null when no cuBLASLt is found anywhere', async () => {
    const mod = await loadResolver({ execFileSync: () => 'libfoo.so => /x/libfoo.so' });
    expect(mod.detectSystemCudaMajor()).toBeNull();
  });

  it('falls back to a CUDA_PATH scan when ldconfig is unavailable (#2341 follow-up)', async () => {
    // Mirrors the existing LD_LIBRARY_PATH-only test above — CUDA_PATH is
    // scanned first in the fallback loop and was previously untested on its own.
    process.env.CUDA_PATH = '/opt/cuda';
    const mod = await loadResolver({
      execFileSync: () => {
        throw new Error('ldconfig missing');
      },
      existsSync: (p) => p === '/opt/cuda/lib64/libcublasLt.so.13',
    });
    expect(mod.detectSystemCudaMajor()).toBe(13);
  });

  it('returns null (not a false match) when the ldconfig output is garbled/unrecognized', async () => {
    const mod = await loadResolver({
      execFileSync: () => 'some-corrupted-binary-output-\x00\xff-not-a-cuda-lib-line',
    });
    expect(mod.detectSystemCudaMajor()).toBeNull();
  });

  it('prefers a CUDA 13 found later in the search path over a CUDA 12 found earlier (#2341 follow-up)', async () => {
    // A stale CUDA_PATH entry (e.g. left over from a prior install) only has
    // .so.12; LD_LIBRARY_PATH, scanned after it, has the genuine .so.13. The
    // scan must not stop at the first match — it must keep looking for a
    // better (13) answer across the WHOLE search space.
    process.env.CUDA_PATH = '/opt/old-cuda-12';
    process.env.LD_LIBRARY_PATH = '/opt/cuda-13/lib64';
    const mod = await loadResolver({
      execFileSync: () => {
        throw new Error('ldconfig missing');
      },
      existsSync: (p) =>
        p === '/opt/old-cuda-12/libcublasLt.so.12' || p === '/opt/cuda-13/lib64/libcublasLt.so.13',
    });
    expect(mod.detectSystemCudaMajor()).toBe(13);
  });
});

describe('ortCudaMajor', () => {
  it('returns null when the CUDA provider .so is absent', async () => {
    const mod = await loadResolver({ existsSync: () => false });
    expect(mod.ortCudaMajor('/pkg/onnxruntime-node')).toBeNull();
  });

  it('reads CUDA 13 from the provider .so NEEDED entries', async () => {
    const mod = await loadResolver({
      existsSync: () => true,
      execFileSync: () => 'libcublasLt.so.13 => /usr/local/cuda/lib64/libcublasLt.so.13',
    });
    expect(mod.ortCudaMajor('/pkg/onnxruntime-node')).toBe(13);
  });

  it('reads CUDA 12 even when the NEEDED lib is unresolved (ldd non-zero exit)', async () => {
    const mod = await loadResolver({
      existsSync: () => true,
      execFileSync: () => {
        // ldd exits non-zero with the "=> not found" line on stdout
        throw Object.assign(new Error('ldd failed'), {
          stdout: 'libcublasLt.so.12 => not found',
        });
      },
    });
    expect(mod.ortCudaMajor('/pkg/onnxruntime-node')).toBe(12);
  });

  it('returns null (not a false match) when the ldd output is garbled/unrecognized (#2341 follow-up)', async () => {
    const mod = await loadResolver({
      existsSync: () => true,
      execFileSync: () => 'libunrelated.so.1 => /x/libunrelated.so.1\nlibc.so.6 => /lib/libc.so.6',
    });
    expect(mod.ortCudaMajor('/pkg/onnxruntime-node')).toBeNull();
  });

  it('warns (detection failed) when ldd produces no usable output at all, distinct from the silent no-provider case (#2341 follow-up)', async () => {
    // Capture AFTER loadResolver() so the capture targets the same (freshly
    // reset) logger.js instance the resolver module itself imports — the
    // module registry is cleared by loadResolver()'s vi.resetModules().
    const mod = await loadResolver({
      existsSync: () => true,
      // Simulates a missing `ldd` binary (ENOENT) or a permission-denied
      // `.so`: execFileSync throws with no `stdout` at all, unlike the
      // "=> not found" case above which still yields usable text.
      execFileSync: () => {
        throw Object.assign(new Error('spawn ldd ENOENT'), { code: 'ENOENT' });
      },
    });
    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    try {
      expect(mod.ortCudaMajor('/pkg/onnxruntime-node')).toBeNull();

      const records = cap.records();
      expect(
        records.some((r) => r.msg?.includes('Could not read CUDA provider dependencies')),
      ).toBe(true);
    } finally {
      cap.restore();
    }
  });

  it('does not warn when the CUDA provider .so is simply absent (no detection was even attempted)', async () => {
    const mod = await loadResolver({ existsSync: () => false });
    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    try {
      expect(mod.ortCudaMajor('/pkg/onnxruntime-node')).toBeNull();

      const records = cap.records();
      expect(
        records.some((r) => r.msg?.includes('Could not read CUDA provider dependencies')),
      ).toBe(false);
    } finally {
      cap.restore();
    }
  });
});

describe('ensureOnnxRuntimeNodeMatchesSystem', () => {
  it('no-ops gracefully when registerHooks is unavailable (Node < 22.15), leaving the module otherwise functional', async () => {
    const mod = await loadResolver({ registerHooks: undefined });
    expect(() => mod.ensureOnnxRuntimeNodeMatchesSystem()).not.toThrow();
    // The one-shot guard tripping (or not) must not corrupt decide()'s cache —
    // subsequent calls to the other exports still work normally afterward.
    expect(() => mod.getEffectiveOnnxRuntimeNodeDir()).not.toThrow();
    expect(mod.isEffectiveCudaAvailable()).toBe(false); // redirect can never be active without registerHooks
  });

  it('installs no hook when there is no system CUDA (no redirect needed)', async () => {
    const spy = vi.fn();
    // non-linux → detectSystemCudaMajor() === null → decide() → redirect: false
    const mod = await loadResolver({ registerHooks: spy, platform: 'darwin' });
    mod.ensureOnnxRuntimeNodeMatchesSystem();
    expect(spy).not.toHaveBeenCalled();
  });

  it('is idempotent in the no-redirect case: a second call is still a no-op (registerHooks never called)', async () => {
    const spy = vi.fn();
    const mod = await loadResolver({ registerHooks: spy, platform: 'darwin' });
    mod.ensureOnnxRuntimeNodeMatchesSystem();
    mod.ensureOnnxRuntimeNodeMatchesSystem();
    // (True install-once idempotency, where a redirect WOULD fire without the
    // guard, is covered by "installs registerHooks exactly once when the
    // redirect is active" below — this case only proves repeated calls stay
    // side-effect-free when there's nothing to install.)
    expect(spy).not.toHaveBeenCalled();
  });

  it('exposes an effective onnxruntime-node dir (string or null) for the CUDA probe, never throwing', async () => {
    const mod = await loadResolver({ platform: 'darwin' });
    // Non-linux: no redirect, so the effective dir is transformers' default —
    // a string when resolvable in the test tree (it really is, in this repo),
    // or null if resolution ever genuinely fails.
    let result: string | null | undefined;
    expect(() => {
      result = mod.getEffectiveOnnxRuntimeNodeDir();
    }).not.toThrow();
    expect(result === null || typeof result === 'string').toBe(true);
  });
});

describe('decide() — registerHooks gating (#2341 follow-up)', () => {
  // ensureOnnxRuntimeNodeMatchesSystem() can never install a redirect on
  // Node < 22.15 (no registerHooks), so decide() must never report `ourDir`
  // as the effective target there. But transformers' DEFAULT copy still loads
  // without any hook, so its CUDA major must still be probed: a CUDA-12 host
  // on Node 22.0–22.14 whose default build already matches has to keep the
  // GPU it auto-selected before this redirect existed (pre-PR
  // isCudaAvailable() behavior), not silently fall back to CPU.
  const fakeDirs = {
    ourDir: '/fake/our/onnxruntime-node',
    defaultDir: '/fake/transformers-nested/onnxruntime-node',
    transformersMain: '/fake/transformers/dist/transformers.node.mjs',
  };
  const soPrefix = (dir: string) => `${dir}/bin/napi-v6/linux`;

  // System CUDA major is the parameter; the two bundled copies are fixed at
  // ours=13 / default=12 (the PR's own documented layout).
  function loadOldNodeResolver(systemMajor: 12 | 13) {
    return loadResolver({
      registerHooks: undefined,
      platform: 'linux',
      fakeDirs,
      existsSync: (p) =>
        p.startsWith(soPrefix(fakeDirs.ourDir)) || p.startsWith(soPrefix(fakeDirs.defaultDir)),
      execFileSync: (cmd, args) => {
        if (cmd === 'ldconfig')
          return `libcublasLt.so.${systemMajor} (libc6,x86-64) => /usr/local/cuda/lib64/libcublasLt.so.${systemMajor}`;
        if (cmd === 'ldd') {
          const target = args[0] ?? '';
          if (target.startsWith(soPrefix(fakeDirs.ourDir)))
            return 'libcublasLt.so.13 => /usr/local/cuda-13/lib64/libcublasLt.so.13';
          if (target.startsWith(soPrefix(fakeDirs.defaultDir)))
            return 'libcublasLt.so.12 => /usr/local/cuda-12/lib64/libcublasLt.so.12';
        }
        throw new Error(`unexpected execFileSync(${cmd}, ${JSON.stringify(args)})`);
      },
    });
  }

  it('never reports a redirect target that cannot be installed (CUDA-13 host, mismatched default)', async () => {
    const mod = await loadOldNodeResolver(13);
    expect(toPosix(String(mod.getEffectiveOnnxRuntimeNodeDir()))).toBe(fakeDirs.defaultDir);
    expect(mod.isEffectiveCudaAvailable()).toBe(false);
    expect(() => mod.ensureOnnxRuntimeNodeMatchesSystem()).not.toThrow();
  });

  it('still probes the default copy: a CUDA-12 host whose default build matches keeps the GPU', async () => {
    const mod = await loadOldNodeResolver(12);
    expect(toPosix(String(mod.getEffectiveOnnxRuntimeNodeDir()))).toBe(fakeDirs.defaultDir);
    expect(mod.isEffectiveCudaAvailable()).toBe(true);
  });
});

describe('ensureOnnxRuntimeNodeMatchesSystem — redirect:true (#2341 follow-up)', () => {
  // The prior test suite never drove decide() into redirect:true (it never
  // faked createRequire), so the actual installed resolve() closure — the PR's
  // real shipped behavior — had zero test coverage. Reproduce the PR's own
  // documented common case: system has CUDA 13, transformers' default build is
  // CUDA 12, gitnexus' own top-level build is CUDA 13.
  const fakeDirs = {
    ourDir: '/fake/our/onnxruntime-node',
    defaultDir: '/fake/transformers-nested/onnxruntime-node',
    transformersMain: '/fake/transformers/dist/transformers.node.mjs',
  };

  const soPath = (dir: string) => `${dir}/bin/napi-v6/linux`; // arch-agnostic prefix match below

  function loadRedirectActiveResolver(registerHooksSpy: unknown) {
    return loadResolver({
      registerHooks: registerHooksSpy,
      platform: 'linux',
      fakeDirs,
      existsSync: (p) =>
        p.startsWith(soPath(fakeDirs.ourDir)) || p.startsWith(soPath(fakeDirs.defaultDir)),
      execFileSync: (cmd, args) => {
        if (cmd === 'ldconfig')
          return 'libcublasLt.so.13 (libc6,x86-64) => /usr/local/cuda/lib64/libcublasLt.so.13';
        if (cmd === 'ldd') {
          const target = args[0] ?? '';
          if (target.startsWith(soPath(fakeDirs.ourDir))) {
            return 'libcublasLt.so.13 => /usr/local/cuda-13/lib64/libcublasLt.so.13';
          }
          if (target.startsWith(soPath(fakeDirs.defaultDir))) {
            return 'libcublasLt.so.12 => /usr/local/cuda-12/lib64/libcublasLt.so.12';
          }
        }
        throw new Error(`unexpected execFileSync(${cmd}, ${JSON.stringify(args)})`);
      },
    });
  }

  it('reports the redirect-active effective dir as our own CUDA-13 build', async () => {
    const mod = await loadRedirectActiveResolver(vi.fn());
    expect(mod.getEffectiveOnnxRuntimeNodeDir()).toBe(fakeDirs.ourDir);
  });

  it('installs registerHooks exactly once when the redirect is active', async () => {
    const spy = vi.fn();
    const mod = await loadRedirectActiveResolver(spy);
    mod.ensureOnnxRuntimeNodeMatchesSystem();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(typeof spy.mock.calls[0][0].resolve).toBe('function');
  });

  it('the installed resolve() closure redirects onnxruntime-node and onnxruntime-common, and passes through everything else', async () => {
    const spy = vi.fn();
    const mod = await loadRedirectActiveResolver(spy);
    mod.ensureOnnxRuntimeNodeMatchesSystem();
    const resolve = spy.mock.calls[0][0].resolve as (
      s: string,
      c: never,
      n: (s: string, c: never) => unknown,
    ) => unknown;
    const ctx = {} as never;
    const next = vi.fn(() => ({ url: 'file:///should-not-be-used', shortCircuit: true }));

    const nodeResult = resolve('onnxruntime-node', ctx, next) as {
      url: string;
      shortCircuit: boolean;
    };
    expect(nodeResult).toEqual({
      url: expect.stringContaining('/fake/our/onnxruntime-node/index.js'),
      shortCircuit: true,
    });
    expect(next).not.toHaveBeenCalled();

    const commonResult = resolve('onnxruntime-common', ctx, next) as {
      url: string;
      shortCircuit: boolean;
    };
    expect(commonResult).toEqual({
      url: expect.stringContaining(
        '/fake/our/onnxruntime-node/node_modules/onnxruntime-common/index.js',
      ),
      shortCircuit: true,
    });
    expect(next).not.toHaveBeenCalled();

    resolve('some-other-package', ctx, next);
    expect(next).toHaveBeenCalledWith('some-other-package', ctx);
  });

  it('isEffectiveCudaAvailable() reports true when the redirect-active effective build matches the system', async () => {
    const mod = await loadRedirectActiveResolver(vi.fn());
    expect(mod.isEffectiveCudaAvailable()).toBe(true);
  });

  it('logs the successful redirect at info level (#2341 follow-up)', async () => {
    const mod = await loadRedirectActiveResolver(vi.fn());
    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger();
    try {
      mod.ensureOnnxRuntimeNodeMatchesSystem();
      const record = cap
        .records()
        .find((r) => r.msg?.includes('Redirected onnxruntime-node to system-matched CUDA build'));
      expect(record).toBeDefined();
      expect(record?.level).toBe(30); // pino 'info'
    } finally {
      cap.restore();
    }
  });

  it('does not log at info when no redirect is needed (common, expected path)', async () => {
    // Non-linux -> no system CUDA -> decide() never redirects.
    const mod = await loadResolver({ registerHooks: vi.fn(), platform: 'darwin' });
    const { _captureLogger } = await import('../../src/core/logger.js');
    const cap = _captureLogger('debug'); // capture below the default 'info' to prove nothing else fires either
    try {
      mod.ensureOnnxRuntimeNodeMatchesSystem();
      const infoOrAboveRecords = cap.records().filter((r) => (r.level ?? 0) >= 30);
      expect(infoOrAboveRecords).toHaveLength(0);
    } finally {
      cap.restore();
    }
  });
});

describe('resolveOurOrtNodeDir — on-demand prefix fallback (#2372)', () => {
  // When gitnexus' own top-level onnxruntime-node was pruned and fetched into the
  // runtime prefix, `embeddings install --cuda` puts the CUDA build there — so the
  // redirect must be able to target the prefix copy, not silently run on CPU.
  const prefixDir = '/fake/prefix-rt';
  const prefixOrtNodeDir = '/fake/prefix-rt/node_modules/onnxruntime-node';
  const defaultDir = '/fake/transformers-nested/onnxruntime-node';
  const soPath = (dir: string): string => `${dir}/bin/napi-v6/linux`;

  const baseFakeDirs = {
    ourDir: '/fake/our/onnxruntime-node', // unused: ourResolvable=false
    defaultDir,
    transformersMain: '/fake/transformers/dist/transformers.node.mjs',
    ourResolvable: false,
    prefixDir,
  };

  const cudaEnv = {
    existsSync: (p: string): boolean =>
      p.startsWith(soPath(prefixOrtNodeDir)) || p.startsWith(soPath(defaultDir)),
    execFileSync: (cmd: string, args: string[]): string => {
      if (cmd === 'ldconfig')
        return 'libcublasLt.so.13 (libc6,x86-64) => /usr/local/cuda/lib64/libcublasLt.so.13';
      if (cmd === 'ldd') {
        const target = args[0] ?? '';
        if (target.startsWith(soPath(prefixOrtNodeDir)))
          return 'libcublasLt.so.13 => /usr/local/cuda-13/lib64/libcublasLt.so.13';
        if (target.startsWith(soPath(defaultDir)))
          return 'libcublasLt.so.12 => /usr/local/cuda-12/lib64/libcublasLt.so.12';
      }
      throw new Error(`unexpected execFileSync(${cmd}, ${JSON.stringify(args)})`);
    },
  };

  it('redirects to the prefix onnxruntime-node when our own top-level was pruned', async () => {
    process.env.GITNEXUS_EMBEDDING_RUNTIME_DIR = prefixDir;
    const mod = await loadResolver({
      registerHooks: vi.fn(),
      platform: 'linux',
      fakeDirs: { ...baseFakeDirs, prefixOrtNodeDir },
      ...cudaEnv,
    });
    expect(toPosix(String(mod.getEffectiveOnnxRuntimeNodeDir()))).toBe(prefixOrtNodeDir);
  });

  it('leaves the effective dir at the default when neither our copy nor the prefix resolves', async () => {
    process.env.GITNEXUS_EMBEDDING_RUNTIME_DIR = prefixDir;
    const mod = await loadResolver({
      registerHooks: vi.fn(),
      platform: 'linux',
      fakeDirs: { ...baseFakeDirs }, // no prefixOrtNodeDir → prefix require misses too
      ...cudaEnv,
    });
    expect(toPosix(String(mod.getEffectiveOnnxRuntimeNodeDir()))).toBe(defaultDir);
  });
});

describe('cudaRedirectDoctorStatus (#2341 follow-up)', () => {
  it('reports n/a when there is no system CUDA', async () => {
    const mod = await loadResolver({ registerHooks: vi.fn(), platform: 'darwin' });
    expect(mod.cudaRedirectDoctorStatus()).toEqual({
      status: 'n/a (no system CUDA detected)',
      detail: null,
    });
  });

  it('reports the redirect-active status with the effective dir as detail', async () => {
    const fakeDirs = {
      ourDir: '/fake/our/onnxruntime-node-doctor',
      defaultDir: '/fake/transformers-nested/onnxruntime-node-doctor',
      transformersMain: '/fake/transformers/doctor/index.js',
    };
    const soPath = (dir: string) => `${dir}/bin/napi-v6/linux`;
    const mod = await loadResolver({
      registerHooks: vi.fn(),
      platform: 'linux',
      fakeDirs,
      existsSync: (p) =>
        p.startsWith(soPath(fakeDirs.ourDir)) || p.startsWith(soPath(fakeDirs.defaultDir)),
      execFileSync: (cmd, args) => {
        if (cmd === 'ldconfig')
          return 'libcublasLt.so.13 (libc6,x86-64) => /usr/local/cuda/lib64/libcublasLt.so.13';
        if (cmd === 'ldd') {
          const target = args[0] ?? '';
          if (target.startsWith(soPath(fakeDirs.ourDir)))
            return 'libcublasLt.so.13 => /a/libcublasLt.so.13';
          if (target.startsWith(soPath(fakeDirs.defaultDir)))
            return 'libcublasLt.so.12 => /a/libcublasLt.so.12';
        }
        throw new Error(`unexpected execFileSync(${cmd}, ${JSON.stringify(args)})`);
      },
    });

    expect(mod.cudaRedirectDoctorStatus()).toEqual({
      status: expect.stringContaining('redirected onnxruntime-node to the CUDA 13 build'),
      detail: fakeDirs.ourDir,
    });
  });

  it('reports a mismatch status (with no fix available) when neither copy ships a matching CUDA provider', async () => {
    const mod = await loadResolver({
      registerHooks: vi.fn(),
      platform: 'linux',
      existsSync: () => false, // no onnxruntime-node copy ships a CUDA provider .so at all
      execFileSync: (cmd) => {
        if (cmd === 'ldconfig')
          return 'libcublasLt.so.13 (libc6,x86-64) => /usr/local/cuda/lib64/libcublasLt.so.13';
        throw new Error('ldd should not be reached when existsSync is false');
      },
    });

    // `detail` (the resolved effectiveDir) isn't asserted here — resolveDefaultOrtNodeDir()
    // isn't mocked in this test, so it resolves against this sandbox's real
    // node_modules and its exact value isn't the point of this case; the
    // redirect-active test above already covers `detail` precisely.
    expect(mod.cudaRedirectDoctorStatus().status).toContain(
      'no CUDA 13-matched onnxruntime-node build found',
    );
  });
});

describe('isEffectiveCudaAvailable — no redundant subprocess spawns (#2341 follow-up)', () => {
  it('probes ldconfig/ldd only once total, regardless of how many times the effective dir and CUDA match are queried', async () => {
    const fakeDirs = {
      ourDir: '/fake/our/onnxruntime-node-u8',
      defaultDir: '/fake/transformers-nested/onnxruntime-node-u8',
      transformersMain: '/fake/transformers/u8/index.js',
    };
    const soPath = (dir: string) => `${dir}/bin/napi-v6/linux`;
    const existsSyncSpy = vi.fn(
      (p: string) =>
        p.startsWith(soPath(fakeDirs.ourDir)) || p.startsWith(soPath(fakeDirs.defaultDir)),
    );
    const execFileSyncSpy = vi.fn((cmd: string, args: string[]) => {
      if (cmd === 'ldconfig')
        return 'libcublasLt.so.13 (libc6,x86-64) => /usr/local/cuda/lib64/libcublasLt.so.13';
      if (cmd === 'ldd') {
        const target = args[0] ?? '';
        if (target.startsWith(soPath(fakeDirs.ourDir))) {
          return 'libcublasLt.so.13 => /usr/local/cuda-13/lib64/libcublasLt.so.13';
        }
        if (target.startsWith(soPath(fakeDirs.defaultDir))) {
          return 'libcublasLt.so.12 => /usr/local/cuda-12/lib64/libcublasLt.so.12';
        }
      }
      throw new Error(`unexpected execFileSync(${cmd}, ${JSON.stringify(args)})`);
    });

    const mod = await loadResolver({
      registerHooks: vi.fn(),
      platform: 'linux',
      fakeDirs,
      existsSync: existsSyncSpy,
      execFileSync: execFileSyncSpy,
    });

    // Query the decision through both public entry points, each more than once.
    mod.getEffectiveOnnxRuntimeNodeDir();
    mod.isEffectiveCudaAvailable();
    mod.getEffectiveOnnxRuntimeNodeDir();
    expect(mod.isEffectiveCudaAvailable()).toBe(true);

    // decide() is memoized: exactly one ldconfig call (system major) and one
    // ldd call per onnxruntime-node dir actually probed (default + ours) —
    // never re-invoked across the 4 queries above.
    const ldconfigCalls = execFileSyncSpy.mock.calls.filter(([cmd]) => cmd === 'ldconfig');
    const lddCalls = execFileSyncSpy.mock.calls.filter(([cmd]) => cmd === 'ldd');
    expect(ldconfigCalls).toHaveLength(1);
    expect(lddCalls).toHaveLength(2); // defaultDir once, ourDir once
  });
});

describe('decide() — ourDir checked independently of defaultDir (#2341 follow-up)', () => {
  it("picks ourDir as the effective target when transformers' own onnxruntime-node resolution fails outright", async () => {
    const fakeDirs = {
      ourDir: '/fake/our/onnxruntime-node-u5',
      defaultDir: '/fake/unreachable/onnxruntime-node-u5',
      transformersMain: '/fake/transformers/u5/index.js',
      defaultResolvable: false, // createRequire(transformersMain).resolve(...) throws -> defaultDir stays null
    };
    const soPrefix = (dir: string) => `${dir}/bin/napi-v6/linux`;

    const mod = await loadResolver({
      registerHooks: vi.fn(),
      platform: 'linux',
      fakeDirs,
      existsSync: (p) => p.startsWith(soPrefix(fakeDirs.ourDir)),
      execFileSync: (cmd, args) => {
        if (cmd === 'ldconfig') {
          return 'libcublasLt.so.13 (libc6,x86-64) => /usr/local/cuda/lib64/libcublasLt.so.13';
        }
        if (cmd === 'ldd' && (args[0] ?? '').startsWith(soPrefix(fakeDirs.ourDir))) {
          return 'libcublasLt.so.13 => /usr/local/cuda-13/lib64/libcublasLt.so.13';
        }
        throw new Error(`unexpected execFileSync(${cmd}, ${JSON.stringify(args)})`);
      },
    });

    // Before this fix, the ourDir fallback lookup was nested inside
    // `if (systemMajor != null && defaultDir)`, so a null defaultDir skipped
    // checking ourDir entirely and this would incorrectly return null.
    expect(mod.getEffectiveOnnxRuntimeNodeDir()).toBe(fakeDirs.ourDir);
  });
});

describe('cross-platform path handling (#2341 follow-up)', () => {
  // This test file was added to cross-platform-tests.ts's PLATFORM_LOGIC list
  // (so it now runs on the Windows CI matrix, not just Ubuntu). Node's `path`
  // module is bound to path.win32 on a real Windows host regardless of any
  // process.platform stub — so the resolver's own join(effectiveDir,
  // 'package.json') calls backslash-normalize even when these tests fake
  // platform: 'linux'. forceWin32Path proves the toPosix() normalization
  // added above actually handles that, rather than merely being argued for.
  const fakeDirs = {
    ourDir: '/fake/our/onnxruntime-node',
    defaultDir: '/fake/transformers-nested/onnxruntime-node',
    transformersMain: '/fake/transformers/dist/transformers.node.mjs',
  };
  const soPath = (dir: string) => `${dir}/bin/napi-v6/linux`;

  it('resolves the redirect-active dir and installs the resolve() closure correctly even when join()/dirname() backslash-normalize (simulated real Windows)', async () => {
    const spy = vi.fn();
    const mod = await loadResolver({
      registerHooks: spy,
      platform: 'linux',
      fakeDirs,
      forceWin32Path: true,
      existsSync: (p) =>
        p.startsWith(soPath(fakeDirs.ourDir)) || p.startsWith(soPath(fakeDirs.defaultDir)),
      execFileSync: (cmd, args) => {
        if (cmd === 'ldconfig')
          return 'libcublasLt.so.13 (libc6,x86-64) => /usr/local/cuda/lib64/libcublasLt.so.13';
        if (cmd === 'ldd') {
          const target = args[0] ?? '';
          if (target.startsWith(soPath(fakeDirs.ourDir)))
            return 'libcublasLt.so.13 => /a/libcublasLt.so.13';
          if (target.startsWith(soPath(fakeDirs.defaultDir)))
            return 'libcublasLt.so.12 => /a/libcublasLt.so.12';
        }
        throw new Error(`unexpected execFileSync(${cmd}, ${JSON.stringify(args)})`);
      },
    });

    expect(mod.getEffectiveOnnxRuntimeNodeDir()).toBe(fakeDirs.ourDir);
    expect(mod.isEffectiveCudaAvailable()).toBe(true);

    mod.ensureOnnxRuntimeNodeMatchesSystem();
    // The real proof: registerHooks must actually fire. Before the toPosix()
    // fix, the createRequire dispatcher's `from === ...` comparison would
    // mismatch against a backslash-joined `from` under forceWin32Path,
    // ensureOnnxRuntimeNodeMatchesSystem's outer try/catch would silently
    // swallow the resulting MODULE_NOT_FOUND, and this would never fire.
    expect(spy).toHaveBeenCalledTimes(1);

    const resolve = spy.mock.calls[0][0].resolve as (
      s: string,
      c: never,
      n: (s: string, c: never) => unknown,
    ) => unknown;
    const ctx = {} as never;
    const next = vi.fn();
    const nodeResult = resolve('onnxruntime-node', ctx, next) as {
      url: string;
      shortCircuit: boolean;
    };
    expect(nodeResult.shortCircuit).toBe(true);
    expect(toPosix(nodeResult.url)).toContain('/fake/our/onnxruntime-node/index.js');
    expect(next).not.toHaveBeenCalled();
  });
});
