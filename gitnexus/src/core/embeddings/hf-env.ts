import os from 'node:os';
import { join } from 'node:path';

/**
 * @internal Exported only for unit tests and the two embedder entry points
 * (`core/embeddings/embedder.ts` + `mcp/core/embedder.ts`). Not part of the
 * public package API.
 *
 * Minimal subset of `@huggingface/transformers`' `env` object that gitnexus
 * mutates. Defining a local structural type keeps this helper free of a
 * transitive dependency on transformers' generated `.d.ts` while still
 * giving full type-checking on the two fields we actually touch.
 */
export interface HfEnvSubset {
  cacheDir: string;
  remoteHost: string;
}

/**
 * @internal Exported only for unit tests and the two embedder entry points
 * (`core/embeddings/embedder.ts` + `mcp/core/embedder.ts`). Not part of the
 * public package API.
 *
 * Apply user-controlled HuggingFace environment overrides to the
 * `@huggingface/transformers` `env` object. Centralises the two env-var
 * bridges so every gitnexus embedder entry point (the analyze pipeline
 * and the MCP server) behaves identically.
 *
 * - **`HF_HOME`** → `env.cacheDir` (default: `~/.cache/huggingface`).
 *   transformers.js otherwise defaults to `./node_modules/.cache` inside
 *   its own install dir, which is unwritable when gitnexus is installed
 *   globally (e.g. `/usr/lib/node_modules/`).
 *
 * - **`HF_ENDPOINT`** → `env.remoteHost` (#1205). transformers.js does
 *   not read `HF_ENDPOINT` on its own — it reads `env.remoteHost` —
 *   even though `HF_ENDPOINT` is the standard env var the upstream
 *   `huggingface_hub` Python client and the official HF mirror docs
 *   tell users to set. Bridging the two unblocks `--embeddings` for
 *   users behind networks where `huggingface.co` is unreachable
 *   (corporate proxies, the GFW, air-gapped mirrors). The trailing
 *   slash is normalised because transformers.js builds URLs by string
 *   concatenation and a missing slash silently falls through to its
 *   default `huggingface.co/...` host.
 *
 * Mutation rather than return-and-apply because callers already hold a
 * reference to the live `env` object imported from
 * `@huggingface/transformers` — passing the same reference in keeps the
 * call site a single line at each entry point.
 */
export function applyHfEnvOverrides(env: HfEnvSubset): void {
  env.cacheDir = process.env.HF_HOME ?? join(os.homedir(), '.cache', 'huggingface');
  // `.trim()` guards against the common copy-paste failure mode of
  // `HF_ENDPOINT="  https://hf-mirror.com  "` (leading/trailing whitespace
  // from shell scripts or docs) — without it, a whitespace-only value
  // would be truthy and produce an invalid `env.remoteHost = '   /'` that
  // silently misroutes downloads. Empty string remains falsy in JS so the
  // truthy guard already handles the unset/empty cases.
  const endpoint = process.env.HF_ENDPOINT?.trim();
  if (endpoint) {
    env.remoteHost = endpoint.endsWith('/') ? endpoint : endpoint + '/';
  }
}
