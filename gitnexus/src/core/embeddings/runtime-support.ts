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
import { isPrefixRuntimeLoadable, resolveEmbeddingRuntime } from './runtime-install.js';

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
      '  - Run GitNexus on Linux or Apple Silicon (darwin/arm64), then',
      '    `gitnexus embeddings install`. Official CLI Docker images no longer',
      '    ship onnxruntime-node; bind-mount a prefix or use HTTP.',
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
  'Local semantic embeddings are unavailable: the local embedding stack is not installed.';

/**
 * Guidance when transformers / onnxruntime-node are not resolvable.
 * Default npm install no longer fetches those packages. Primary heal is
 * `gitnexus embeddings install`. A leftover 1.6.12 package-first tree in
 * gitnexus node_modules is residual until a clean reinstall; `--force`
 * only refreshes the prefix overrides.
 */
export const localEmbeddingStackMissingMessage = (): string =>
  [
    LOCAL_EMBEDDING_STACK_MISSING_LEAD,
    '@huggingface/transformers and onnxruntime-node are not part of a default',
    'gitnexus install. Everything except local embeddings still works.',
    '',
    'To enable local embeddings:',
    '  - Run `gitnexus embeddings install` — fetches the stack through your npm',
    '    registry config into ~/.gitnexus/embedding-runtime (or',
    '    GITNEXUS_EMBEDDING_RUNTIME_DIR when set; mirrors and proxies',
    '    apply; no NuGet download). `gitnexus analyze --embeddings` and',
    '    `gitnexus embeddings sync` do this automatically.',
    '    Add --cuda on CUDA GPU hosts (behind a proxy, also set',
    '    GLOBAL_AGENT_HTTPS_PROXY=<proxy-url> for the NuGet download).',
    '  - A leftover 1.6.12 install that still has those packages under',
    '    gitnexus node_modules is residual. `--force` only refreshes prefix',
    '    overrides; remove leftover packages with a clean reinstall.',
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
    '>= 22.15 (on the 22.x line) or >= 23.5 (on the 23.x line). Upgrade this',
    'Node to a build that has module.registerHooks. Installing the prefix from',
    'another Node cannot add that API here. A leftover 1.6.12 package-first',
    'tree still loads without the hook; the prefix path does not.',
  ].join('\n');

export type LocalEmbeddingRuntimeAssessment =
  | { status: 'blocked'; message: string }
  | { status: 'prefix-unloadable'; message: string }
  | { status: 'needs-install' }
  | { status: 'ready' };

/**
 * Shared local-runtime preflight for analyze and embeddings-sync.
 * Callers keep their own error routing (CLI vs thrown Error).
 */
export const assessLocalEmbeddingRuntime = (): LocalEmbeddingRuntimeAssessment => {
  const runtimeBlocker = getLocalEmbeddingRuntimeBlocker();
  if (runtimeBlocker) return { status: 'blocked', message: runtimeBlocker };
  const resolved = resolveEmbeddingRuntime();
  if (!isPrefixRuntimeLoadable() && (resolved === null || resolved.source === 'runtime-prefix')) {
    return { status: 'prefix-unloadable', message: localEmbeddingPrefixUnloadableMessage() };
  }
  if (resolved === null) return { status: 'needs-install' };
  return { status: 'ready' };
};

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

/** Lead line when the embedding sidecar has been marked permanently unavailable. */
export const LOCAL_EMBEDDING_SIDECAR_ABORT_LEAD =
  'Local embeddings are unavailable after the sidecar aborted';

/** Lead of `EmbeddingSidecarDeadError` — native abort / unexpected child exit. */
export const EMBEDDING_SIDECAR_DIED_LEAD = 'Embedding sidecar died';

/**
 * True when `message` is a sidecar-abort or sidecar-dead error. MCP `query()`
 * must treat these like a missing stack so agents see the degradation.
 */
export const isLocalEmbeddingSidecarAbortMessage = (message: string): boolean =>
  message.includes(LOCAL_EMBEDDING_SIDECAR_ABORT_LEAD) ||
  message.includes(EMBEDDING_SIDECAR_DIED_LEAD);

/**
 * True when the optional local embedding stack resolves from this install —
 * either the normally-installed packages or the on-demand runtime prefix.
 * Resolution only — nothing is imported, so this is safe on every platform
 * (including macOS Intel, where *loading* onnxruntime-node would crash).
 * Used by `doctor` to surface a missing local stack (default install excludes it).
 */
export const isLocalEmbeddingStackInstalled = (): boolean => resolveEmbeddingRuntime() !== null;
