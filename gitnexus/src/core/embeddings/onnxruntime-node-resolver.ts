/**
 * Redirect `@huggingface/transformers`' `onnxruntime-node` import to whichever
 * bundled copy's CUDA build matches this host's CUDA runtime (CUDA 12 vs 13).
 *
 * ## Why
 * transformers exact-pins `onnxruntime-node` (e.g. `1.24.3`, a CUDA **12**
 * build), while gitnexus' own `onnxruntime-node: ^1.24.0` floats to the latest
 * 1.x (a CUDA **13** build). npm/pnpm cannot dedupe an exact pin against a
 * range, so a `npm i -g` install ends up with TWO copies: gitnexus' top-level
 * CUDA-13 build (unused) and transformers' nested CUDA-12 build (the one that
 * actually loads). gitnexus' `overrides` block that would collapse them is
 * honoured only from a *root* manifest, so it is inert once gitnexus is a
 * dependency — the same transitive-override limitation documented in
 * {@link ./onnxruntime-common-resolver.ts} (#307).
 *
 * The consequence on a CUDA-13-only host: the nested CUDA-12 provider cannot
 * find `libcublasLt.so.12`, the CUDA execution provider fails to load, and
 * embeddings silently fall back to CPU (~5-6x slower) even with
 * `--embedding-device cuda`.
 *
 * ## What this does
 * Best-effort, before transformers is imported: if the system's cuBLASLt major
 * (12 or 13) does NOT match the CUDA build transformers would load by default,
 * but gitnexus' own top-level `onnxruntime-node` copy DOES match, install a
 * synchronous ESM resolution hook (`module.registerHooks`, Node >= 22.15) that
 * redirects both `onnxruntime-node` and `onnxruntime-common` to that matching
 * copy. onnxruntime-common is redirected alongside so the `Tensor` surface
 * stays a single identity, version-matched to the redirected binding.
 *
 * ## Safety
 * Detection-based and conservative — it acts ONLY when it is a net improvement:
 *   - system CUDA major == default build major  -> NO-OP (already correct)
 *   - no system CUDA libs / non-linux           -> NO-OP (CPU path)
 *   - only one copy present                     -> NO-OP
 *   - neither copy matches the system           -> NO-OP (never makes it worse)
 * So CUDA-12 hosts, Windows (DirectML), macOS, and CPU-only hosts are
 * untouched. Idempotent; any failure is swallowed and leaves the default
 * resolution exactly as before. `module.registerHooks` requires Node >= 22.15
 * (the gitnexus engines floor is >= 22.0.0); on older runtimes the redirect is
 * a no-op, but the default copy's CUDA major is still probed so an
 * already-matching host (e.g. CUDA 12 + transformers' CUDA-12 build) keeps
 * auto-selecting the GPU.
 * `npm link` / symlinked local-dev checkouts are a known caveat: `resolveOurOrtNodeDir`/
 * `resolveDefaultOrtNodeDir` are anchored to this module's own real (post-symlink)
 * location via `import.meta.url`, so a linked dev checkout may resolve against
 * its own `node_modules` rather than the consuming app's — narrow, dev-only
 * blast radius; regular npm/pnpm installs are unaffected.
 *
 * The CUDA-major decision is exposed via {@link getEffectiveOnnxRuntimeNodeDir}
 * so the embedder's CUDA probe can inspect the SAME copy that will actually be
 * loaded (the probe uses CJS `require.resolve`, which an ESM hook does not
 * affect) — keeping probe and runtime consistent.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { logger } from '../logger.js';
import { getEmbeddingRuntimeDir } from './runtime-install.js';
import { getRegisterHooks } from './node-module-compat.js';

export type CudaMajor = 12 | 13;

const require = createRequire(import.meta.url);

/**
 * Read a shared object's NEEDED entries, tolerating ldd's non-zero exit when a
 * lib is unresolved (that case still yields a usable "=> not found" stdout).
 * `failed: true` means ldd produced no usable output at all (missing `ldd`
 * binary, permission-denied `.so`, sandboxed exec) — distinct from "ldd ran
 * fine and simply found no matching NEEDED entry" (`failed: false`, `needed: ''`),
 * so callers don't have to treat "detection failed" identically to "definitely
 * no CUDA provider".
 */
const readSoNeeded = (soPath: string): { needed: string; failed: boolean } => {
  try {
    return {
      needed: execFileSync('ldd', [soPath], {
        timeout: 5000,
        encoding: 'utf-8',
        windowsHide: true,
      }),
      failed: false,
    };
  } catch (err) {
    const out = (err as { stdout?: string } | null | undefined)?.stdout;
    if (typeof out === 'string' && out.length > 0) return { needed: out, failed: false };
    return { needed: '', failed: true };
  }
};

/** The CUDA major an onnxruntime-node copy's CUDA provider links against, or null (Linux/x64 only ships one). */
export const ortCudaMajor = (ortNodeDir: string): CudaMajor | null => {
  const so = join(
    ortNodeDir,
    'bin',
    'napi-v6',
    'linux',
    process.arch,
    'libonnxruntime_providers_cuda.so',
  );
  // A pre-PR CUDA-12 host relied only on this existence check (no `ldd`
  // dependency) — retained here as the first, unconditional signal so a host
  // whose CUDA provider `.so` is genuinely present but merely un-inspectable
  // (see the `failed` case below) is never treated identically to a host that
  // never shipped a CUDA provider at all.
  if (!existsSync(so)) return null;
  const { needed, failed } = readSoNeeded(so);
  if (failed) {
    logger.warn(
      { so },
      'Could not read CUDA provider dependencies (ldd failed to run) — CUDA-major detection ' +
        'is unknown, not necessarily absent; embeddings will fall back to CPU either way',
    );
  }
  if (/libcublasLt\.so\.13/.test(needed)) return 13;
  if (/libcublasLt\.so\.12/.test(needed)) return 12;
  return null;
};

/** The cuBLASLt major installed on this system, or null. Linux only. */
export const detectSystemCudaMajor = (): CudaMajor | null => {
  if (process.platform !== 'linux') return null;
  try {
    const out = execFileSync('ldconfig', ['-p'], {
      timeout: 3000,
      encoding: 'utf-8',
      windowsHide: true,
    });
    if (out.includes('libcublasLt.so.13')) return 13;
    if (out.includes('libcublasLt.so.12')) return 12;
  } catch {
    // ldconfig not available (e.g. non-standard container) — fall through to path scan.
  }
  // Prefer CUDA 13 across the ENTIRE search space, not just within one
  // dir/sub pair — a `.so.12` found early (e.g. a stale CUDA_PATH entry from
  // a prior install) must not shadow a genuine `.so.13` found later in
  // LD_LIBRARY_PATH. Return immediately on a 13 (the best possible answer);
  // remember a 12 and keep scanning in case a later entry still has a 13.
  let found: CudaMajor | null = null;
  for (const envVar of ['CUDA_PATH', 'LD_LIBRARY_PATH']) {
    const val = process.env[envVar];
    if (!val) continue;
    for (const dir of val.split(':').filter(Boolean))
      for (const sub of ['lib64', 'lib', ''])
        for (const maj of [13, 12] as const)
          if (existsSync(join(dir, sub, `libcublasLt.so.${maj}`))) {
            if (maj === 13) return 13;
            found = maj;
          }
  }
  return found;
};

/** onnxruntime-node dir transformers loads by default (its own nested/pinned copy). */
const resolveDefaultOrtNodeDir = (): string | null => {
  try {
    const transformersMain = require.resolve('@huggingface/transformers');
    return dirname(createRequire(transformersMain).resolve('onnxruntime-node/package.json'));
  } catch {
    // On-demand runtime prefix (#2370): when the optional stack was pruned at
    // install time and fetched on demand, the copy that actually loads (via
    // ensureEmbeddingStackResolvable's fallback hook) lives in the prefix — so
    // it IS the effective default and must be the one the CUDA probe inspects.
    try {
      const prefixRequire = createRequire(join(getEmbeddingRuntimeDir(), 'noop.js'));
      const transformersMain = prefixRequire.resolve('@huggingface/transformers');
      return dirname(createRequire(transformersMain).resolve('onnxruntime-node/package.json'));
    } catch {
      return null;
    }
  }
};

/** gitnexus' own direct top-level onnxruntime-node dir. */
const resolveOurOrtNodeDir = (): string | null => {
  try {
    return dirname(require.resolve('onnxruntime-node/package.json'));
  } catch {
    // On-demand runtime prefix (#2370): when gitnexus' own onnxruntime-node was
    // pruned at install time and fetched on demand, the prefix copy IS our
    // effective top-level build — so the CUDA-major redirect must be able to
    // target it (mirrors resolveDefaultOrtNodeDir's fallback above). Without
    // this, `embeddings install --cuda` on a pruned install downloads the GPU
    // binaries but the probe still can't see them and embeddings run on CPU.
    try {
      const prefixRequire = createRequire(join(getEmbeddingRuntimeDir(), 'noop.js'));
      return dirname(prefixRequire.resolve('onnxruntime-node/package.json'));
    } catch {
      return null;
    }
  }
};

interface Decision {
  redirect: boolean;
  effectiveDir: string | null; // the onnxruntime-node dir that WILL be used (default, or ours)
  effectiveMajor: CudaMajor | null; // effectiveDir's own CUDA major, already probed — never re-probe it
  systemMajor: CudaMajor | null;
}

let cached: Decision | null = null;

const decide = (): Decision => {
  if (cached) return cached;
  const defaultDir = resolveDefaultOrtNodeDir();

  // Node < 22.15 has no `registerHooks` API, so a redirect can never actually
  // install (see ensureOnnxRuntimeNodeMatchesSystem below) — the probe must
  // agree with that up front, never reporting a redirect target that won't be
  // loaded. But the DEFAULT copy still loads and needs no hook, so its CUDA
  // major is still probed: a CUDA-12 host on Node 22.0–22.14 whose default
  // build already matches must keep auto-selecting the GPU exactly as it did
  // before this redirect existed.
  const canRedirect = typeof getRegisterHooks() === 'function';

  const systemMajor = detectSystemCudaMajor();
  // `defaultDir` resolving is NOT a precondition for checking `ourDir` below —
  // if transformers' own resolution fails outright (defaultMajor stays null),
  // that still counts as "the default doesn't match", so a working `ourDir`
  // should still be picked up as the effective target instead of leaving
  // `effectiveDir` stuck at `null`. Gated behind `systemMajor != null` (as
  // before) so a non-CUDA host never pays for a provider-.so probe at all.
  const defaultMajor = systemMajor != null && defaultDir ? ortCudaMajor(defaultDir) : null;
  let decision: Decision = {
    redirect: false,
    effectiveDir: defaultDir,
    effectiveMajor: defaultMajor,
    systemMajor,
  };

  if (canRedirect && systemMajor != null && defaultMajor !== systemMajor) {
    const ourDir = resolveOurOrtNodeDir();
    if (ourDir && ourDir !== defaultDir) {
      const ourMajor = ortCudaMajor(ourDir);
      if (ourMajor === systemMajor) {
        decision = { redirect: true, effectiveDir: ourDir, effectiveMajor: ourMajor, systemMajor };
      }
    }
  }
  cached = decision;
  return decision;
};

/**
 * The onnxruntime-node dir that will actually back transformers at runtime once
 * {@link ensureOnnxRuntimeNodeMatchesSystem} has run — i.e. the redirected copy
 * when a redirect applies, otherwise transformers' default. The CUDA probe must
 * inspect THIS dir (not transformers' CJS-resolved default) so probe and
 * runtime agree. Returns null only when neither copy resolves.
 */
export const getEffectiveOnnxRuntimeNodeDir = (): string | null => decide().effectiveDir;

/**
 * Whether the onnxruntime-node copy that will actually load ships a CUDA
 * provider matching this host's CUDA major — reads straight from the cached
 * `decide()` result rather than re-probing `ortCudaMajor`/`detectSystemCudaMajor`
 * a second time (both are already computed above). `systemMajor` is checked
 * for non-null explicitly so two absent majors (null === null) never count
 * as a match.
 */
export const isEffectiveCudaAvailable = (): boolean => {
  const d = decide();
  return d.systemMajor !== null && d.systemMajor === d.effectiveMajor;
};

/**
 * CUDA-build-redirect status for the `doctor` Embeddings section — pure
 * summary of decide()'s already-computed decision, matching
 * doctor.ts's `localEmbeddingDoctorStatus`'s `{status, detail}` shape so an
 * operator can tell "why is my CUDA-13 host still on CPU" apart from
 * "there's no system CUDA to redirect for" at a glance.
 */
export const cudaRedirectDoctorStatus = (): { status: string; detail: string | null } => {
  const d = decide();
  if (d.systemMajor === null) {
    return { status: 'n/a (no system CUDA detected)', detail: null };
  }
  if (d.redirect) {
    return {
      status: `✓ redirected onnxruntime-node to the CUDA ${d.systemMajor} build`,
      detail: d.effectiveDir,
    };
  }
  if (d.systemMajor === d.effectiveMajor) {
    return {
      status: `✓ default onnxruntime-node build already matches CUDA ${d.systemMajor}`,
      detail: null,
    };
  }
  return {
    status: `✗ no CUDA ${d.systemMajor}-matched onnxruntime-node build found (falling back to CPU)`,
    detail: d.effectiveDir,
  };
};

let attempted = false;

/**
 * Idempotently install the CUDA-build-matching redirect. Call once immediately
 * before the dynamic `import('@huggingface/transformers')` on the local
 * embedding path (after the runtime guard, alongside the onnxruntime-common
 * fallback). No-op unless a strictly-better matching copy exists.
 */
export const ensureOnnxRuntimeNodeMatchesSystem = (): void => {
  if (attempted) return;
  attempted = true;
  try {
    const registerHooks = getRegisterHooks();
    if (typeof registerHooks !== 'function') return; // Node < 22.15 / < 23.5: graceful no-op
    const d = decide();
    if (!d.redirect || !d.effectiveDir) return;

    const nodeUrl = pathToFileURL(
      createRequire(join(d.effectiveDir, 'package.json')).resolve('onnxruntime-node'),
    ).href;
    let commonUrl: string | null = null;
    try {
      commonUrl = pathToFileURL(
        createRequire(join(d.effectiveDir, 'package.json')).resolve('onnxruntime-common'),
      ).href;
    } catch {
      commonUrl = null; // fall back to the onnxruntime-common-resolver for common
    }

    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === 'onnxruntime-node') return { url: nodeUrl, shortCircuit: true };
        if (commonUrl && specifier === 'onnxruntime-common')
          return { url: commonUrl, shortCircuit: true };
        return nextResolve(specifier, context);
      },
    });
    // info (not debug): this is the one signal an operator has that CUDA
    // embeddings are actually using the GPU on this host — the common/no-op
    // paths below stay at debug since they're the expected default.
    logger.info(
      { systemMajor: d.systemMajor, effectiveDir: d.effectiveDir },
      'Redirected onnxruntime-node to system-matched CUDA build',
    );
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'onnxruntime-node CUDA-build redirect not installed',
    );
  }
};
