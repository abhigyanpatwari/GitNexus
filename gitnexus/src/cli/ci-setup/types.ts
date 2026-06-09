export type CiSystem = 'github-actions' | 'azure-devops' | 'both';
export type DeployTarget = 'docker' | 'azure-container-app' | 'both';
export type AuthMode = 'token' | 'none';
export type BranchStrategy = 'pr-scoped' | 'main-only';

export interface CiSetupOptions {
  ci: CiSystem;
  deploy: DeployTarget;
  port: number;
  auth: AuthMode;
  branchStrategy: BranchStrategy;
  dryRun: boolean;
  apply: boolean;
  yes: boolean;
  outputDir: string;
}

export interface DetectResult {
  gitRoot: string | null;
  detectedCi: CiSystem | null;
  hasDocker: boolean;
  portAvailable: boolean;
  primaryLanguage: string;
}

export interface GeneratedFile {
  relativePath: string;
  content: string;
}

export interface CiSetupResult {
  generated: string[];
  skipped: string[];
  errors: string[];
}
