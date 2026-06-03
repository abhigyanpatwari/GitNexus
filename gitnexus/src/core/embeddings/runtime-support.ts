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
 */

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
