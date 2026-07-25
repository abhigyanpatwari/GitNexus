import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import type { MoveCompilerIdentity } from './constants.js';
import {
  createMoveFlowClient,
  tryResolveMoveFlowClient,
  type MoveFlowMcpClient,
  type ResolvedMoveFlowClient,
} from './mcp-client.js';
import {
  findCachedMoveFlowBinary,
  installMoveFlow,
  type MoveFlowInstallResult,
  type VerifiedMoveFlowBinary,
} from './install.js';
import { isCompatibleMoveFlowVersion, MOVE_FLOW_RELEASE } from './release.js';

const installAttempts = new WeakMap<
  MoveFlowProvisionDependencies,
  Promise<MoveFlowInstallResult>
>();

export interface ProvisionedMoveFlow {
  client: MoveFlowMcpClient;
  identity: MoveCompilerIdentity;
}

export interface MoveFlowProvisionOptions {
  onLog?: (message: string) => void;
  install?: boolean;
}

export interface MoveFlowProvisionDependencies {
  resolveClient: (binaryPath?: string) => ResolvedMoveFlowClient | null;
  createClient: (binaryPath: string) => MoveFlowMcpClient;
  findCached: () => Promise<VerifiedMoveFlowBinary | null>;
  install: () => Promise<MoveFlowInstallResult>;
}

const defaultDependencies: MoveFlowProvisionDependencies = {
  resolveClient: tryResolveMoveFlowClient,
  createClient: createMoveFlowClient,
  findCached: findCachedMoveFlowBinary,
  install: installMoveFlow,
};

async function resolveExecutablePath(locator: string): Promise<string | null> {
  const candidates =
    path.isAbsolute(locator) || locator.includes(path.sep)
      ? [locator]
      : (process.env.PATH ?? '')
          .split(path.delimiter)
          .filter(Boolean)
          .flatMap((directory) => {
            const exact = path.join(directory, locator);
            if (process.platform !== 'win32' || path.extname(locator)) return [exact];
            const extensions = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';');
            return [
              exact,
              ...extensions.map((extension) => path.join(directory, `${locator}${extension}`)),
            ];
          });
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.R_OK | (process.platform === 'win32' ? 0 : constants.X_OK));
      return await realpath(candidate);
    } catch {
      // Continue through PATH. A resolver mock may intentionally have no file.
    }
  }
  return null;
}

async function hashExecutable(absolutePath: string): Promise<string> {
  // `absolutePath` is the earlier realpath() result. The final path component
  // can still be replaced before createReadStream opens it; this identity is
  // only a cache-invalidation fingerprint (never an authenticity decision),
  // so that TOCTOU can cause at most a conservative rebuild/churn.
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(absolutePath)) digest.update(chunk as Buffer);
  return digest.digest('hex');
}

const localIdentity = async (
  source: 'explicit' | 'path',
  locator: string,
  version: string,
  onLog?: (message: string) => void,
): Promise<MoveCompilerIdentity> => {
  const resolvedPath = await resolveExecutablePath(locator);
  // If the binary changes between the successful version probe and hashing,
  // make this identity unique rather than certifying an unverifiable runtime.
  const binaryDigest = resolvedPath
    ? await hashExecutable(resolvedPath).catch(
        () => `unverifiable:${randomBytes(16).toString('hex')}`,
      )
    : `unverifiable:${randomBytes(16).toString('hex')}`;
  if (binaryDigest.startsWith('unverifiable:')) {
    // The random digest deliberately churns the fingerprint, and a fingerprint
    // change forces a full Move re-index — every run, until the binary is
    // readable again. Say so instead of rebuilding silently.
    onLog?.(
      `move-flow binary at '${resolvedPath ?? locator}' could not be read for ` +
        `fingerprinting; Move facts will be fully rebuilt on every run until it is readable.`,
    );
  }
  return {
    version,
    source,
    fingerprint: createHash('sha256')
      .update(`${source}\0${resolvedPath ?? locator}\0${version}\0${binaryDigest}`)
      .digest('hex'),
  };
};

const verifiedRuntime = (
  binary: VerifiedMoveFlowBinary,
  dependencies: MoveFlowProvisionDependencies,
): ProvisionedMoveFlow | null =>
  isCompatibleMoveFlowVersion(binary.version)
    ? {
        client: dependencies.createClient(binary.binaryPath),
        identity: {
          version: binary.version,
          source: 'release',
          fingerprint: binary.fingerprint,
        },
      }
    : null;

const getInstallAttempt = (
  dependencies: MoveFlowProvisionDependencies,
): Promise<MoveFlowInstallResult> => {
  const active = installAttempts.get(dependencies);
  if (active) return active;

  const created = Promise.resolve().then(dependencies.install);
  installAttempts.set(dependencies, created);
  void created.then(
    (result) => {
      if (result.binary && installAttempts.get(dependencies) === created) {
        installAttempts.delete(dependencies);
      }
    },
    () => {},
  );
  return created;
};

/** Resolve move-flow after the caller has already detected Move code. */
export async function ensureMoveFlowRuntime(
  options: MoveFlowProvisionOptions = {},
  dependencies: MoveFlowProvisionDependencies = defaultDependencies,
): Promise<ProvisionedMoveFlow | null> {
  const explicitPath = process.env.MOVE_FLOW;
  if (explicitPath) {
    const resolved = dependencies.resolveClient(explicitPath);
    if (resolved) {
      return {
        client: resolved.client,
        identity: await localIdentity('explicit', explicitPath, resolved.version, options.onLog),
      };
    }
    options.onLog?.(
      `MOVE_FLOW points to an unavailable binary (${explicitPath}); automatic installation was skipped.`,
    );
    return null;
  }

  const cached = await dependencies.findCached();
  if (cached) {
    const runtime = verifiedRuntime(cached, dependencies);
    if (runtime) return runtime;
  }

  const existing = dependencies.resolveClient();
  if (existing) {
    // The locator must be stable across shells: $PATH itself differs between
    // terminals/CI steps, and a fingerprint churn forces a full re-index.
    return {
      client: existing.client,
      identity: await localIdentity('path', 'move-flow', existing.version, options.onLog),
    };
  }

  if (options.install === false) return null;

  options.onLog?.(
    `Move code detected; ensuring move-flow ${MOVE_FLOW_RELEASE.version} is available.`,
  );
  let result: MoveFlowInstallResult;
  try {
    result = await getInstallAttempt(dependencies);
  } catch (err) {
    options.onLog?.(
      `move-flow installation failed: ${err instanceof Error ? err.message : String(err)}; ` +
        '.move files will not be indexed.',
    );
    return null;
  }

  if (!result.binary) {
    options.onLog?.(
      `move-flow is unavailable${result.message ? `: ${result.message}` : ''}; ` +
        '.move files will not be indexed.',
    );
    return null;
  }
  const runtime = verifiedRuntime(result.binary, dependencies);
  if (!runtime) {
    options.onLog?.(
      `move-flow ${result.binary.version} is protocol-incompatible; .move files will not be indexed.`,
    );
  }
  return runtime;
}
