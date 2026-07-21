import { createHash } from 'node:crypto';
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

const localIdentity = (
  source: 'explicit' | 'path',
  locator: string,
  version: string,
): MoveCompilerIdentity => ({
  version,
  source,
  fingerprint: createHash('sha256').update(`${source}\0${locator}\0${version}`).digest('hex'),
});

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
  const clear = (): void => {
    if (installAttempts.get(dependencies) === created) installAttempts.delete(dependencies);
  };
  void created.then(clear, clear);
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
        identity: localIdentity('explicit', explicitPath, resolved.version),
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
      identity: localIdentity('path', 'move-flow', existing.version),
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
