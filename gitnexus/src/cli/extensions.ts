import { cliError, cliInfo, cliWarn } from './cli-message.js';
import {
  getExtensionInstallTimeoutMs,
  installDuckDbExtensionOutOfProcess,
} from '../core/lbug/extension-loader.js';

export interface ExtensionsInstallOptions {
  timeout?: string;
}

// Exact identifiers `extensionManager.ensure(...)` already passes at each
// extension's call site (lbug-adapter.ts's loadFTSExtension/
// loadVectorExtension) -- kept in sync with those rather than re-derived, so
// `INSTALL <name>` here always matches what `LOAD EXTENSION <name>` looks for
// later at query time.
const KNOWN_EXTENSIONS = ['fts', 'VECTOR'] as const;
type KnownExtension = (typeof KNOWN_EXTENSIONS)[number];

function resolveTargets(name: string | undefined): KnownExtension[] {
  if (!name || name === 'all') return [...KNOWN_EXTENSIONS];
  const match = KNOWN_EXTENSIONS.find((k) => k.toLowerCase() === name.toLowerCase());
  if (!match) {
    throw new Error(
      `Unknown extension "${name}" -- must be one of: ${KNOWN_EXTENSIONS.join(', ')}, or "all"`,
    );
  }
  return [match];
}

/**
 * `gitnexus extensions install [name|all] [--timeout <ms>]` (#FTS-warm-cache).
 *
 * Query/serve/MCP paths run with `load-only` install policy by design
 * (offline-first, PR #1161): they will `LOAD` an extension already on disk
 * but will never reach the network to install one, so a query against a
 * machine/container that never had a chance to install FTS/VECTOR degrades
 * silently to "index missing" results forever, no matter how good the query
 * is. This command is the sanctioned, explicit way to warm that cache once
 * -- a Dockerfile `RUN gitnexus extensions install fts` layer, a CI
 * image-build step, or a one-time run on a fresh dev machine -- so every
 * later query on that same machine/image finds the extension already
 * resident and never touches the network at all.
 *
 * Deliberately opt-in and separate from `analyze`/`postinstall`: an install
 * command that ran automatically and required network would turn a
 * currently-offline-safe operation into one that can fail or hang for
 * air-gapped users. This only ever runs when explicitly invoked.
 */
export const extensionsInstallCommand = async (
  name: string | undefined,
  options: ExtensionsInstallOptions = {},
): Promise<void> => {
  let targets: KnownExtension[];
  try {
    targets = resolveTargets(name);
  } catch (err) {
    cliError(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  const timeoutMs = options.timeout ? Number(options.timeout) : getExtensionInstallTimeoutMs();
  if (options.timeout !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    cliError(`--timeout must be a positive number of milliseconds, got "${options.timeout}"`);
    process.exitCode = 1;
    return;
  }

  let anyFailed = false;
  for (const ext of targets) {
    cliInfo(`Installing LadybugDB extension "${ext}" …`);
    const result = await installDuckDbExtensionOutOfProcess(ext, timeoutMs);
    if (result.success) {
      cliInfo(`✓ ${ext} installed and cached — future queries load it from disk, no network needed.`);
    } else {
      anyFailed = true;
      cliWarn(`✗ ${ext}: ${result.message}`);
    }
  }

  if (anyFailed) {
    process.exitCode = 1;
  }
};
