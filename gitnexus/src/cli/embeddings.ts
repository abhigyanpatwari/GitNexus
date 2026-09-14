import { cliError, cliInfo, cliWarn } from './cli-message.js';
import {
  getEmbeddingRuntimeDir,
  getEmbeddingStackSpecs,
  installEmbeddingRuntime,
  isPrefixRuntimeLoadable,
  resolveEmbeddingRuntime,
} from '../core/embeddings/runtime-install.js';
import {
  getLocalEmbeddingRuntimeBlocker,
  localEmbeddingPrefixUnloadableMessage,
} from '../core/embeddings/runtime-support.js';

export interface EmbeddingsInstallOptions {
  cuda?: boolean;
  force?: boolean;
}

/**
 * `gitnexus embeddings install [--cuda] [--force]` — fetch the local
 * embedding stack. Default npm install does not include it. Goes through the
 * user's npm registry config (mirrors/proxies apply); with --cuda it
 * additionally runs onnxruntime-node's postinstall to download the CUDA GPU
 * binaries from NuGet (set GLOBAL_AGENT_HTTPS_PROXY behind a proxy).
 * `--force` refreshes prefix overrides; it does not replace a leftover
 * 1.6.12 package-first tree in gitnexus node_modules.
 */
export const embeddingsInstallCommand = async (
  options: EmbeddingsInstallOptions = {},
): Promise<void> => {
  const runtimeBlocker = getLocalEmbeddingRuntimeBlocker();
  if (runtimeBlocker) {
    cliError(`${runtimeBlocker}\n`, { recoveryHint: 'local-embedding-unsupported' });
    process.exitCode = 1;
    return;
  }

  const resolved = resolveEmbeddingRuntime();
  if (resolved?.source === 'package' && !options.force) {
    cliInfo(
      'The embedding stack already resolves from this gitnexus install (leftover package-first tree) — nothing to do.\n' +
        '(Use --force to refresh prefix overrides; a clean reinstall removes leftover packages.)',
    );
    return;
  }

  const specs = Object.entries(getEmbeddingStackSpecs())
    .map(([name, spec]) => `${name}@${spec}`)
    .join(', ');
  cliInfo(`Installing ${specs} into ${getEmbeddingRuntimeDir()} …`);
  cliInfo(
    options.cuda
      ? 'CUDA mode: onnxruntime-node will download GPU binaries from NuGet ' +
          '(set GLOBAL_AGENT_HTTPS_PROXY=<proxy-url> behind a proxy).'
      : 'CPU mode: install scripts are skipped — only your npm registry is contacted.',
  );

  try {
    await installEmbeddingRuntime({ cuda: options.cuda, onOutput: (line) => cliInfo(`  ${line}`) });
  } catch (err) {
    cliError(`${err instanceof Error ? err.message : String(err)}\n`, {
      recoveryHint: 'local-embedding-stack-missing',
    });
    process.exitCode = 1;
    return;
  }

  const postInstall = resolveEmbeddingRuntime();
  if (postInstall === null) {
    cliInfo('✗ Install completed but the stack still does not resolve — check the output above.');
    process.exitCode = 1;
    return;
  }
  if (postInstall.source === 'runtime-prefix' && !isPrefixRuntimeLoadable()) {
    // The packages are in the prefix, but this Node has no module.registerHooks
    // to load them — don't claim readiness the loader can't honour.
    cliWarn(`${localEmbeddingPrefixUnloadableMessage()}\n`);
    return;
  }
  cliInfo('✓ Embedding runtime installed. `gitnexus analyze --embeddings` is ready.');
};
