import { describe, it, expect, vi, afterEach } from 'vitest';

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

interface LoadOpts {
  registerHooks?: unknown;
  platform?: NodeJS.Platform;
  execFileSync?: (cmd: string, args: string[]) => string;
  existsSync?: (p: string) => boolean;
}

/**
 * (Re)load the resolver with detection primitives + `registerHooks` mocked.
 * `vi.resetModules()` clears the module-level decision cache and one-shot guard,
 * so each test gets a pristine resolver.
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
  } = opts;

  vi.doMock('node:module', async (io) => ({
    ...(await io<typeof import('node:module')>()),
    registerHooks,
  }));
  vi.doMock('node:child_process', async (io) => ({
    ...(await io<typeof import('node:child_process')>()),
    execFileSync: (cmd: string, args: string[]) => execFileSync(cmd, args),
  }));
  vi.doMock('node:fs', async (io) => ({
    ...(await io<typeof import('node:fs')>()),
    existsSync: (p: unknown) => existsSync(String(p)),
  }));

  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  return import(RESOLVER);
}

afterEach(() => {
  vi.doUnmock('node:module');
  vi.doUnmock('node:child_process');
  vi.doUnmock('node:fs');
  Object.defineProperty(process, 'platform', { value: REAL_PLATFORM, configurable: true });
  process.env = { ...REAL_ENV };
});

describe('detectSystemCudaMajor', () => {
  it('returns null on non-linux platforms', async () => {
    const mod = await loadResolver({ platform: 'darwin' });
    expect(mod.detectSystemCudaMajor()).toBeNull();
  });

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
});

describe('ensureOnnxRuntimeNodeMatchesSystem', () => {
  it('no-ops gracefully (never throws) when registerHooks is unavailable (Node < 22.15)', async () => {
    const mod = await loadResolver({ registerHooks: undefined });
    expect(() => mod.ensureOnnxRuntimeNodeMatchesSystem()).not.toThrow();
  });

  it('installs no hook when there is no system CUDA (no redirect needed)', async () => {
    const spy = vi.fn();
    // non-linux → detectSystemCudaMajor() === null → decide() → redirect: false
    const mod = await loadResolver({ registerHooks: spy, platform: 'darwin' });
    mod.ensureOnnxRuntimeNodeMatchesSystem();
    expect(spy).not.toHaveBeenCalled();
  });

  it('is best-effort and idempotent — never throws, and a second call is a no-op', async () => {
    const spy = vi.fn();
    const mod = await loadResolver({ registerHooks: spy, platform: 'darwin' });
    expect(() => {
      mod.ensureOnnxRuntimeNodeMatchesSystem();
      mod.ensureOnnxRuntimeNodeMatchesSystem();
    }).not.toThrow();
  });

  it('exposes an effective onnxruntime-node dir (or null) for the CUDA probe', async () => {
    const mod = await loadResolver({ platform: 'darwin' });
    // Non-linux: no redirect, so the effective dir is transformers' default
    // (a string when resolvable in the test tree) or null — never throws.
    expect(() => mod.getEffectiveOnnxRuntimeNodeDir()).not.toThrow();
  });
});

describe('decide() — registerHooks gating (#2341 follow-up)', () => {
  // getEffectiveOnnxRuntimeNodeDir()/isCudaAvailable() must agree with whether
  // ensureOnnxRuntimeNodeMatchesSystem() can actually install a redirect. On
  // Node < 22.15 (registerHooks unavailable) it never can, so the decision must
  // fall back to the default dir — and skip CUDA-major probing entirely, since
  // the answer wouldn't change the outcome — rather than reporting a redirect
  // target that will never be loaded.
  it('reports no redirect (and never probes CUDA majors) when registerHooks is unavailable', async () => {
    const execFileSync = vi.fn(() => {
      throw Object.assign(new Error('enoent'), { code: 'ENOENT' });
    });
    const existsSync = vi.fn(() => false);
    const mod = await loadResolver({
      registerHooks: undefined,
      platform: 'linux',
      execFileSync,
      existsSync,
    });

    expect(() => mod.getEffectiveOnnxRuntimeNodeDir()).not.toThrow();
    expect(execFileSync).not.toHaveBeenCalled();
    expect(existsSync).not.toHaveBeenCalled();
  });
});
