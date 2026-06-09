import { select } from '@inquirer/prompts';
import type { CiSetupOptions, CiSystem, DeployTarget, AuthMode, BranchStrategy, DetectResult } from './types.js';

export async function resolveOptions(
  detect: DetectResult,
  partial: Partial<CiSetupOptions>,
): Promise<CiSetupOptions> {
  // In non-interactive (CI) environments, fill in defaults for unset options
  // rather than hanging on stdin. The user can override with explicit flags.
  const isTTY = process.stdin.isTTY === true;

  const ci = partial.ci ?? (isTTY ? await promptCi(detect) : 'github-actions');
  const deploy = partial.deploy ?? (isTTY ? await promptDeploy() : 'docker');
  const auth = partial.auth ?? (isTTY ? await promptAuth() : 'token');
  const branchStrategy =
    partial.branchStrategy ?? (isTTY ? await promptBranchStrategy() : 'pr-scoped');

  return {
    ci,
    deploy,
    auth,
    branchStrategy,
    port: partial.port ?? 4747,
    dryRun: partial.dryRun ?? false,
    apply: partial.apply ?? false,
    yes: partial.yes ?? false,
    outputDir: partial.outputDir ?? (detect.gitRoot ?? process.cwd()),
  };
}

async function promptCi(detect: DetectResult): Promise<CiSystem> {
  const detected = detect.detectedCi;
  return select<CiSystem>({
    message: 'CI/CD system',
    choices: [
      {
        name: `GitHub Actions${detected === 'github-actions' ? ' (detected)' : ''}`,
        value: 'github-actions',
      },
      {
        name: `Azure DevOps${detected === 'azure-devops' ? ' (detected)' : ''}`,
        value: 'azure-devops',
      },
      { name: 'Both', value: 'both' },
    ],
    default: detected ?? 'github-actions',
  });
}

async function promptDeploy(): Promise<DeployTarget> {
  return select<DeployTarget>({
    message: 'Deployment target for gitnexus serve',
    choices: [
      { name: 'Docker (local / self-hosted)', value: 'docker' },
      { name: 'Azure Container App', value: 'azure-container-app' },
      { name: 'Both', value: 'both' },
    ],
    default: 'docker',
  });
}

async function promptAuth(): Promise<AuthMode> {
  return select<AuthMode>({
    message: 'Auth for the shared MCP server',
    choices: [
      {
        name: 'Shared token (Caddy reverse proxy enforces GITNEXUS_TOKEN)',
        value: 'token',
      },
      {
        name: 'No auth (trusted internal network only)',
        value: 'none',
      },
    ],
    default: 'token',
  });
}

async function promptBranchStrategy(): Promise<BranchStrategy> {
  return select<BranchStrategy>({
    message: 'Branch index strategy',
    choices: [
      { name: 'Main + PR-scoped (recommended)', value: 'pr-scoped' },
      { name: 'Main branch only', value: 'main-only' },
    ],
    default: 'pr-scoped',
  });
}
