/**
 * Local embedding runtime support guard.
 *
 * The bundled local embedding stack (`@huggingface/transformers` →
 * `onnxruntime-node`) only ships native ONNX Runtime bindings for a subset of
 * platform/arch pairs. On macOS Intel (`darwin`/`x64`), `onnxruntime-node`
 * ships no `bin/napi-v6/darwin/x64/onnxruntime_binding.node`, so *importing*
 * transformers.js throws a raw `Cannot find module ...onnxruntime_binding.node`
 * before any device/backend selection can run (#1515). `ONNX_WEB_BACKEND=wasm`
 * cannot rescue this — the failure is at native-module import time, not backend
 * selection (#1516).
 *
 * This module is intentionally free of any native or transformers.js import (at
 * module scope or inside its functions) so it can be consulted *before* the
 * dynamic import that would crash. HTTP embedding mode never touches the native
 * runtime, so callers in HTTP mode must skip this guard.
 * (The runtime-install import below only resolves paths — it never loads the
 * embedding stack.)
 */
import { resolveEmbeddingRuntime } from './runtime-install.js';

/**
 * Stable lead line of the macOS-Intel blocker message. Also used to recognise
 * the thrown error in the CLI error handler without coupling to the full
 * wording (see {@link isLocalEmbeddingRuntimeBlockerMessage}).
 */
const LOCAL_EMBEDDING_BLOCKER_LEAD =
  'Local semantic embeddings are unavailable on macOS Intel (darwin/x64).';

export interface LocalEmbeddingRuntimeOptions {
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
}

/**
 * Return a human-readable explanation when the *local* embedding runtime cannot
 * load on this platform, or `null` when local embeddings are expected to work.
 *
 * Only `darwin`/`x64` is blocked today: it is the one platform/arch pair where
 * the bundled `onnxruntime-node` ships no native binding (#1515). Every other
 * platform returns `null` and follows the normal device-probe path, so genuine
 * ONNX failures on supported platforms are never masked by this message.
 *
 * Accepts an explicit `{ platform, arch }` for testing; defaults to the current
 * process values.
 */
export const getLocalEmbeddingRuntimeBlocker = (
  options: LocalEmbeddingRuntimeOptions = {},
): string | null => {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;

  if (platform === 'darwin' && arch === 'x64') {
    return [
      LOCAL_EMBEDDING_BLOCKER_LEAD,
      'The bundled ONNX Runtime package (onnxruntime-node) does not ship a',
      'darwin/x64 native binding, so the local embedding model cannot load here.',
      'ONNX_WEB_BACKEND=wasm does not help: the failure happens while importing',
      'the native runtime, before any backend can be selected. Forcing',
      'GITNEXUS_EMBEDDING_DEVICE=wasm (or cpu) does not help either, for the same reason.',
      '',
      'Use one of these instead:',
      '  - Run analyze without --embeddings (all other indexing still works).',
      '  - Point GITNEXUS_EMBEDDING_URL (with GITNEXUS_EMBEDDING_MODEL) at an',
      '    OpenAI-compatible /v1/embeddings endpoint to embed over HTTP.',
      '  - Run GitNexus on Linux or in Docker, where the native binding ships.',
      '  - Run GitNexus on Apple Silicon (darwin/arm64), which ships a binding.',
      '  - Use a future GitNexus build that restores darwin/x64 ONNX support.',
    ].join('\n');
  }

  return null;
};

/**
 * True when `message` is the macOS-Intel local-embedding blocker produced by
 * {@link getLocalEmbeddingRuntimeBlocker}. Lets the CLI surface a clean,
 * actionable message instead of a raw stack trace, without coupling to the
 * full wording.
 */
export const isLocalEmbeddingRuntimeBlockerMessage = (message: string): boolean =>
  message.includes(LOCAL_EMBEDDING_BLOCKER_LEAD);

/**
 * Stable lead line of the missing-optional-stack message. Mirrors
 * {@link LOCAL_EMBEDDING_BLOCKER_LEAD}: the CLI error handler matches on this
 * line (see {@link isMissingLocalEmbeddingStackMessage}).
 */
const LOCAL_EMBEDDING_STACK_MISSING_LEAD =
  'Local semantic embeddings are unavailable: the optional embedding stack is not installed.';

/**
 * The full guidance shown when the optional local embedding stack
 * (`@huggingface/transformers` → `onnxruntime-node`) is missing at runtime.
 *
 * Both packages are `optionalDependencies` (#2370): `onnxruntime-node`'s
 * postinstall downloads CUDA support binaries from api.nuget.org, which fails
 * behind HTTP proxies and regional firewalls (its `global-agent` proxy layer
 * ignores the standard HTTP_PROXY/HTTPS_PROXY vars and rejects 302 redirects).
 * npm then skips the optional subtree instead of failing the whole install —
 * every GitNexus feature except local embeddings keeps working.
 */
export const localEmbeddingStackMissingMessage = (): string =>
  [
    LOCAL_EMBEDDING_STACK_MISSING_LEAD,
    'npm skipped the optional packages @huggingface/transformers / onnxruntime-node',
    "during install — usually because onnxruntime-node's postinstall could not",
    'download its CUDA support binaries from api.nuget.org (common behind HTTP',
    'proxies and regional firewalls, #2370). Everything except local embeddings',
    'still works.',
    '',
    'To enable local embeddings:',
    '  - Run `gitnexus embeddings install` — fetches the stack on demand through',
    '    your npm registry config (mirrors and proxies apply; no NuGet download).',
    '    `gitnexus analyze --embeddings` does this automatically.',
    '    Add --cuda on CUDA GPU hosts (behind a proxy, also set',
    '    GLOBAL_AGENT_HTTPS_PROXY=<proxy-url> for the NuGet download).',
    '  - Or reinstall with the CUDA download skipped (CPU embeddings need no CUDA):',
    '      ONNXRUNTIME_NODE_INSTALL=skip npm install -g gitnexus',
    '      (Windows: set ONNXRUNTIME_NODE_INSTALL=skip && npm install -g gitnexus)',
    '  - Or point GITNEXUS_EMBEDDING_URL (with GITNEXUS_EMBEDDING_MODEL) at an',
    '    OpenAI-compatible /v1/embeddings endpoint to embed over HTTP.',
  ].join('\n');

/** Stable lead line of the prefix-unloadable message (mirrors the leads above). */
const LOCAL_EMBEDDING_PREFIX_UNLOADABLE_LEAD =
  'The on-demand embedding runtime cannot be loaded on this Node build.';

/**
 * Guidance when the runtime-prefix stack cannot be used because this Node lacks
 * `module.registerHooks` (added in 22.15 / 23.5) — whether the prefix is already
 * populated or not, this Node's ESM loader can never reach a prefix-installed
 * copy (#2372). A normally-installed (package) stack never needs the hook and
 * never hits this. State-neutral lead (it applies both when the prefix is
 * populated and when nothing is installed) plus capability-first wording — a
 * bare ">= 22.15" is untruthful for a 23.0–23.4 user whose version is
 * numerically greater yet still lacks the API.
 */
export const localEmbeddingPrefixUnloadableMessage = (): string =>
  [
    LOCAL_EMBEDDING_PREFIX_UNLOADABLE_LEAD,
    'The runtime prefix loads via module.registerHooks, which needs Node',
    '>= 22.15 (on the 22.x line) or >= 23.5 (on the 23.x line). Either:',
    '  - Upgrade Node to a build that has module.registerHooks, or',
    '  - Reinstall the packages normally (works on every supported Node):',
    '      ONNXRUNTIME_NODE_INSTALL=skip npm install -g gitnexus',
    '      (Windows: set ONNXRUNTIME_NODE_INSTALL=skip && npm install -g gitnexus)',
  ].join('\n');

/** Module specifiers whose absence means the optional embedding stack was pruned. */
const EMBEDDING_STACK_SPECIFIERS = ['@huggingface/transformers', 'onnxruntime-node'] as const;

/**
 * When `err` is a module-not-found failure for the optional local embedding
 * stack, return the actionable {@link localEmbeddingStackMissingMessage};
 * otherwise `null` so genuine load errors surface unchanged.
 *
 * Matches on the error `code` (ERR_MODULE_NOT_FOUND for ESM `import()`,
 * MODULE_NOT_FOUND for CJS require) plus the missing specifier in the message,
 * so an unrelated module-not-found inside transformers.js is not misreported
 * as a pruned install.
 */
export const getMissingLocalEmbeddingStackMessage = (err: unknown): string | null => {
  if (!(err instanceof Error)) return null;
  const code = (err as NodeJS.ErrnoException).code;
  if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') return null;
  const namesStack = EMBEDDING_STACK_SPECIFIERS.some((s) => err.message.includes(`'${s}'`));
  return namesStack ? localEmbeddingStackMissingMessage() : null;
};

/**
 * True when `message` is the missing-optional-stack message produced by
 * {@link localEmbeddingStackMissingMessage}. CLI counterpart of
 * {@link isLocalEmbeddingRuntimeBlockerMessage}.
 */
export const isMissingLocalEmbeddingStackMessage = (message: string): boolean =>
  message.includes(LOCAL_EMBEDDING_STACK_MISSING_LEAD);

/**
 * True when the optional local embedding stack resolves from this install —
 * either the normally-installed packages or the on-demand runtime prefix.
 * Resolution only — nothing is imported, so this is safe on every platform
 * (including macOS Intel, where *loading* onnxruntime-node would crash).
 * Used by `doctor` to surface a pruned optional install (#2370) up front.
 */
export const isLocalEmbeddingStackInstalled = (): boolean => resolveEmbeddingRuntime() !== null;
