import { cliError, cliInfo, cliWarn } from './cli-message.js';
import {
  getEmbeddingRuntimeDir,
  getEmbeddingStackSpecs,
  installEmbeddingRuntime,
  isPrefixRuntimeLoadable,
  resolveEmbeddingRuntime,
} from '../core/embeddings/runtime-install.js';
import { localEmbeddingPrefixUnloadableMessage } from '../core/embeddings/runtime-support.js';

export interface EmbeddingsInstallOptions {
  cuda?: boolean;
  force?: boolean;
}

/**
 * `gitnexus embeddings install [--cuda] [--force]` — fetch the optional local
 * embedding stack on demand (#2370). Goes through the user's npm registry
 * config (mirrors/proxies apply); with --cuda it additionally runs
 * onnxruntime-node's postinstall to download the CUDA GPU binaries from NuGet
 * (set GLOBAL_AGENT_HTTPS_PROXY behind a proxy).
 */
export const embeddingsInstallCommand = async (
  options: EmbeddingsInstallOptions = {},
): Promise<void> => {
  const resolved = resolveEmbeddingRuntime();
  if (resolved?.source === 'package' && !options.force) {
    cliInfo(
      'The embedding stack is already installed with gitnexus itself — nothing to do.\n' +
        '(Use --force to install a copy into the runtime prefix anyway.)',
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
