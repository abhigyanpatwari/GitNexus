import { MoveFlowMcpClient, tryCreateMoveFlowClient } from './mcp-client.js';
import { findCachedMoveFlow, installMoveFlow, type MoveFlowInstallResult } from './install.js';
import { MOVE_FLOW_RELEASE } from './release.js';

// One install attempt per dependency set per process: concurrent callers share
// the in-flight promise, and a settled failure is not retried until restart
// (an explicit MOVE_FLOW or a PATH/cache binary is still re-probed every call).
const installAttempts = new WeakMap<
  MoveFlowProvisionDependencies,
  Promise<MoveFlowInstallResult>
>();

export interface MoveFlowProvisionOptions {
  onLog?: (message: string) => void;
}

export interface MoveFlowProvisionDependencies {
  resolveClient: (binaryPath?: string) => MoveFlowMcpClient | null;
  findCached: () => Promise<string | null>;
  install: () => Promise<MoveFlowInstallResult>;
}

const defaultDependencies: MoveFlowProvisionDependencies = {
  resolveClient: tryCreateMoveFlowClient,
  findCached: findCachedMoveFlow,
  install: installMoveFlow,
};

/**
 * Resolve move-flow, provisioning the pinned release only when a caller has
 * already detected Move code. Explicit MOVE_FLOW overrides remain authoritative:
 * an invalid override is reported instead of silently replaced.
 */
export async function ensureMoveFlowClient(
  options: MoveFlowProvisionOptions = {},
  dependencies: MoveFlowProvisionDependencies = defaultDependencies,
): Promise<MoveFlowMcpClient | null> {
  if (process.env.MOVE_FLOW) {
    const explicit = dependencies.resolveClient(process.env.MOVE_FLOW);
    if (explicit) return explicit;
    options.onLog?.(
      `MOVE_FLOW points to an unavailable binary (${process.env.MOVE_FLOW}); automatic installation was skipped.`,
    );
    return null;
  }

  const cachedPath = await dependencies.findCached();
  if (cachedPath) {
    const cached = dependencies.resolveClient(cachedPath);
    if (cached) return cached;
  }

  const existing = dependencies.resolveClient();
  if (existing) return existing;

  let attempt = installAttempts.get(dependencies);
  if (!attempt) {
    options.onLog?.(
      `Move code detected; ensuring move-flow ${MOVE_FLOW_RELEASE.version} is available.`,
    );
    attempt = dependencies.install();
    installAttempts.set(dependencies, attempt);
  }

  let result: MoveFlowInstallResult;
  try {
    result = await attempt;
  } catch (err) {
    options.onLog?.(
      `move-flow installation failed: ${err instanceof Error ? err.message : String(err)}; ` +
        '.move files will not be indexed (not retried in this process).',
    );
    return null;
  }

  if (!result.binaryPath) {
    options.onLog?.(
      `move-flow is unavailable${result.message ? `: ${result.message}` : ''}; .move files will not be indexed.`,
    );
    return null;
  }

  const installed = dependencies.resolveClient(result.binaryPath);
  if (installed) return installed;

  options.onLog?.(`Installed move-flow failed its runtime probe at ${result.binaryPath}.`);
  return null;
}
