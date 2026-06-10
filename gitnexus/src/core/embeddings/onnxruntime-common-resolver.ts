/**
 * Make `@huggingface/transformers`' phantom `onnxruntime-common` import
 * resolvable under strict package-manager layouts (#307, #2069).
 *
 * ## Why
 * transformers' shipped `dist/transformers.node.mjs` does a bare
 * `import 'onnxruntime-common'`, but transformers' `package.json` never declares
 * onnxruntime-common (it lists onnxruntime-node / onnxruntime-web / sharp). With
 * npm's flat `node_modules` — or pnpm with hoisting — the package is hoisted to
 * a directory on transformers' resolution path and the import resolves by
 * accident. Under pnpm's isolated store (and therefore `pnpm dlx` / `pnpx`), a
 * package only sees its *declared* deps, so the import dies with
 * `ERR_MODULE_NOT_FOUND` before `analyze --embeddings` can run.
 *
 * Declaring onnxruntime-common in gitnexus' own dependencies (#2074) does NOT
 * fix this under pnpm: Node resolves the bare specifier from *transformers'*
 * module scope, not ours, and overrides/resolutions can only re-version an
 * existing edge, never add the missing one.
 *
 * ## What this does
 * Install a synchronous, in-thread ESM resolution hook (`module.registerHooks`,
 * Node >= 22.15) that redirects `onnxruntime-common` to a copy gitnexus can
 * resolve — but only when the default resolver fails. The redirect target is
 * preferentially the `onnxruntime-common` that `onnxruntime-node` (the native
 * binding transformers actually loads) itself depends on, so the redirected copy
 * is version-matched to that binding even under `pnpm dlx` — where gitnexus'
 * npm-style `overrides` block does NOT apply, because it is honoured only from a
 * root manifest and gitnexus is a transitive dependency there. It falls back to
 * gitnexus' own direct `onnxruntime-common` dependency when that chain can't be
 * walked. onnxruntime-common is a stable, pure-JS package whose `Tensor` surface
 * is unchanged across 1.24–1.26, so either target is API-compatible. On working
 * layouts the default resolver succeeds first and the hook never fires, so
 * behaviour is unchanged.
 *
 * `registerHooks` (synchronous, in-thread) is preferred over the older
 * `module.register` (async, off-thread, now deprecated — DEP0205, removed in
 * Node 26): the redirect is a one-line conditional that needs no worker thread,
 * no separate hook module, and no `data` marshalling.
 *
 * ## Safety
 * Best-effort and idempotent. The hook is installed lazily, only on the
 * local-embedding code path (after parsing), so it is never registered during
 * analysis, in the parse workers, or in HTTP embedding mode. Once installed it
 * is process-global: its resolve closure runs for every subsequent module
 * resolution, but it passes all of them through untouched and only substitutes a
 * result for the exact `onnxruntime-common` specifier when that specifier is
 * genuinely absent — so it cannot mask an unrelated resolution error, and the
 * per-resolution cost is a single string comparison.
 *
 * `module.registerHooks` is marked `@experimental` and requires Node >= 22.15
 * (the gitnexus engines floor is >= 22.0.0). On older runtimes it is absent and
 * this is a graceful no-op: embeddings then resolve onnxruntime-common exactly
 * as before — fine on hoisted layouts. Any failure during installation is
 * swallowed.
 */
import { registerHooks, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { logger } from '../logger.js';

let attempted = false;

/**
 * Compute the file: URL the hook redirects `onnxruntime-common` to.
 *
 * Prefer the copy `onnxruntime-node` (the native binding transformers loads)
 * depends on, so the redirected module is version-matched to the binding even
 * under `pnpm dlx`, where transformers keeps its own pinned onnxruntime-node.
 * The walk resolves transformers' MAIN entry — NOT `@huggingface/transformers/
 * package.json`, which transformers' `exports` map blocks
 * (`ERR_PACKAGE_PATH_NOT_EXPORTED`) — then onnxruntime-node, then its
 * onnxruntime-common. Falls back to gitnexus' own direct dependency (always
 * resolvable from our scope) when any step fails.
 */
const resolveOnnxRuntimeCommonUrl = (): string => {
  const require = createRequire(import.meta.url);
  try {
    const transformersMain = require.resolve('@huggingface/transformers');
    const ortNodePkg = createRequire(transformersMain).resolve('onnxruntime-node/package.json');
    const common = createRequire(ortNodePkg).resolve('onnxruntime-common');
    return pathToFileURL(common).href;
  } catch {
    return pathToFileURL(require.resolve('onnxruntime-common')).href;
  }
};

/**
 * Idempotently install the onnxruntime-common resolution fallback. Call once
 * immediately before the dynamic `import('@huggingface/transformers')` on the
 * local-embedding path.
 */
export const ensureOnnxRuntimeCommonResolvable = (): void => {
  if (attempted) return;
  // Mark attempted up-front: a failed attempt must not retry on every
  // initEmbedder() call, and the hook is process-global — once is enough.
  attempted = true;

  try {
    // Node < 22.15 (the gitnexus engines floor is >= 22.0.0): no synchronous
    // hooks API. Degrade gracefully — the import still works on hoisted layouts.
    if (typeof registerHooks !== 'function') return;

    const redirectUrl = resolveOnnxRuntimeCommonUrl();

    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier !== 'onnxruntime-common') return nextResolve(specifier, context);
        // Honour a real, package-manager-provided copy when one is on the path
        // (npm / hoisted pnpm); only substitute ours when the specifier is
        // genuinely absent.
        try {
          return nextResolve(specifier, context);
        } catch (err) {
          // The phantom import surfaces as ERR_MODULE_NOT_FOUND (or, for a
          // present-but-exports-broken copy, ERR_PACKAGE_PATH_NOT_EXPORTED).
          // Rethrow anything else so a genuinely broken install is not masked.
          const code = (err as { code?: string } | null | undefined)?.code;
          if (code === 'ERR_MODULE_NOT_FOUND' || code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
            return { url: redirectUrl, shortCircuit: true };
          }
          throw err;
        }
      },
    });
    logger.debug({ redirectUrl }, 'Installed onnxruntime-common resolution fallback (#307)');
  } catch (err) {
    // Never block embeddings on the fallback. On layouts where the package
    // manager already resolves onnxruntime-common this is unnecessary anyway.
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'onnxruntime-common resolution fallback not installed',
    );
  }
};
