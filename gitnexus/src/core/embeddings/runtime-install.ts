/**
 * On-demand install of the optional local embedding stack (#2370).
 *
 * `@huggingface/transformers` and `onnxruntime-node` are optionalDependencies:
 * npm prunes them (instead of failing the whole install) when
 * `onnxruntime-node`'s postinstall cannot download its CUDA binaries from
 * api.nuget.org — common behind HTTP proxies and regional firewalls, where
 * that download ignores standard proxy env vars and 302 redirects.
 *
 * This module heals such an install without a reinstall: it fetches the stack
 * into a user-level runtime prefix (`~/.gitnexus/embedding-runtime`) straight
 * from the user's configured npm registry — honouring their mirror and proxy
 * settings, the part of their network setup that demonstrably works — with
 * `--ignore-scripts`, so no NuGet download is attempted at all. The CPU ONNX
 * binding ships inside the npm tarball; only CUDA GPU acceleration needs the
 * postinstall, and `installEmbeddingRuntime({ cuda: true })` opts into it.
 *
 * Resolution is package-first: a normally-installed stack always wins, and the
 * runtime prefix is only consulted when the bare specifier does not resolve.
 */
import { createRequire, registerHooks } from 'node:module';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../logger.js';

const require = createRequire(import.meta.url);

/** The stack the runtime prefix provides; resolution fallback covers all three. */
const EMBEDDING_STACK_PACKAGES = [
  '@huggingface/transformers',
  'onnxruntime-node',
  'onnxruntime-common',
] as const;

/** User-level prefix the on-demand stack installs into. */
export const getEmbeddingRuntimeDir = (): string =>
  process.env.GITNEXUS_EMBEDDING_RUNTIME_DIR ?? join(homedir(), '.gitnexus', 'embedding-runtime');

/**
 * The version specs to install — read from gitnexus' own package.json
 * `optionalDependencies` so the on-demand install can never drift from what a
 * normal install would have provided. (The manifest ships in the tarball even
 * when npm pruned the packages themselves.)
 */
export const getEmbeddingStackSpecs = (): Record<string, string> => {
  const manifest = require('../../../package.json') as {
    optionalDependencies?: Record<string, string>;
  };
  const optional = manifest.optionalDependencies ?? {};
  return Object.fromEntries(
    ['@huggingface/transformers', 'onnxruntime-node']
      .filter((name) => optional[name] !== undefined)
      .map((name) => [name, optional[name]]),
  );
};

export interface EmbeddingRuntimeResolution {
  /** 'package': the normally-installed copy; 'runtime-prefix': the on-demand copy. */
  source: 'package' | 'runtime-prefix';
}

/** Resolution anchored inside the runtime prefix (`<dir>/node_modules`). */
const prefixRequire = () => createRequire(join(getEmbeddingRuntimeDir(), 'noop.js'));

/**
 * Where the embedding stack resolves from, or `null` when it is not installed
 * at all. Resolution only — nothing is imported, so this never loads native
 * code and is safe on every platform.
 */
export const resolveEmbeddingRuntime = (): EmbeddingRuntimeResolution | null => {
  try {
    require.resolve('@huggingface/transformers');
    return { source: 'package' };
  } catch {
    /* fall through to the runtime prefix */
  }
  try {
    prefixRequire().resolve('@huggingface/transformers');
    return { source: 'runtime-prefix' };
  } catch {
    return null;
  }
};

let hookAttempted = false;

/**
 * Idempotently register the resolution fallback that redirects the embedding
 * stack's bare specifiers to the runtime prefix when normal resolution fails.
 * Mirrors the onnxruntime-common fallback hook (#307): try the default
 * resolution first so a real, package-manager-installed copy always wins, and
 * only re-anchor at the prefix on ERR_MODULE_NOT_FOUND.
 *
 * Must be registered BEFORE the CUDA-13 redirect hook
 * (`ensureOnnxRuntimeNodeMatchesSystem`) — `registerHooks` runs the most
 * recently registered hook first, so registering this one earliest makes it
 * the last-resort fallback in the chain.
 */
export const ensureEmbeddingStackResolvable = (): void => {
  if (hookAttempted) return;
  hookAttempted = true;

  try {
    // Node < 22.15 (engines floor is >= 22.0.0): no synchronous hooks API.
    // Degrade gracefully — normally-installed stacks still resolve; only the
    // runtime-prefix fallback is unavailable.
    if (typeof registerHooks !== 'function') return;

    const prefixAnchor = pathToFileURL(join(getEmbeddingRuntimeDir(), 'noop.js')).href;

    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (!(EMBEDDING_STACK_PACKAGES as readonly string[]).includes(specifier)) {
          return nextResolve(specifier, context);
        }
        try {
          return nextResolve(specifier, context);
        } catch (err) {
          const code = (err as { code?: string } | null | undefined)?.code;
          if (code === 'ERR_MODULE_NOT_FOUND' || code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
            // Re-anchor at the runtime prefix so Node applies the package's
            // own exports conditions (ESM/CJS) exactly as a normal install would.
            return nextResolve(specifier, { ...context, parentURL: prefixAnchor });
          }
          throw err;
        }
      },
    });
    logger.debug(
      { prefix: getEmbeddingRuntimeDir() },
      'Installed embedding-runtime resolution fallback (#2370)',
    );
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'embedding-runtime resolution fallback not installed',
    );
  }
};

export interface EmbeddingInstallOptions {
  /**
   * Also fetch the CUDA GPU binaries: runs onnxruntime-node's postinstall
   * (NuGet download — set GLOBAL_AGENT_HTTPS_PROXY behind a proxy). Default
   * false: `--ignore-scripts` + ONNXRUNTIME_NODE_INSTALL=skip, so the install
   * touches only the npm registry and CPU embeddings work everywhere.
   */
  cuda?: boolean;
  /** Progress sink for npm's output lines. */
  onOutput?: (line: string) => void;
}

/** Pure command builder, exported for tests. */
export const buildEmbeddingInstallCommand = (
  opts: EmbeddingInstallOptions = {},
): { args: string[]; env: NodeJS.ProcessEnv } => {
  const specs = getEmbeddingStackSpecs();
  const args = [
    'install',
    '--prefix',
    getEmbeddingRuntimeDir(),
    '--no-fund',
    '--no-audit',
    '--loglevel',
    'error',
    ...(opts.cuda ? [] : ['--ignore-scripts']),
    ...Object.entries(specs).map(([name, spec]) => `${name}@${spec}`),
  ];
  const env: NodeJS.ProcessEnv = opts.cuda
    ? { ...process.env }
    : { ...process.env, ONNXRUNTIME_NODE_INSTALL: 'skip' };
  return { args, env };
};

/**
 * Install (or update) the embedding stack into the runtime prefix via the
 * user's npm — registry, mirror, and proxy configuration all apply. Rejects
 * with npm's tail output when the install fails.
 */
export const installEmbeddingRuntime = async (
  opts: EmbeddingInstallOptions = {},
): Promise<void> => {
  const { args, env } = buildEmbeddingInstallCommand(opts);
  await new Promise<void>((resolve, reject) => {
    const child = spawn('npm', args, {
      env,
      windowsHide: true,
      // Windows `npm` is a `.cmd` shim; without a shell spawn ENOENTs
      // (mirrors getNpmMajorVersion in cli/resolve-invocation.ts).
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    const onChunk = (chunk: Buffer) => {
      const text = chunk.toString();
      tail = (tail + text).slice(-2000);
      if (opts.onOutput) text.split('\n').filter(Boolean).forEach(opts.onOutput);
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('error', reject);
    child.on('close', (exitCode) => {
      if (exitCode === 0) resolve();
      else
        reject(
          new Error(`npm install of the embedding runtime failed (exit ${exitCode}):\n${tail}`),
        );
    });
  });
};
