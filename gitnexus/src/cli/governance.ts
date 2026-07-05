import path from 'node:path';
import { detectGovernance } from '../core/governance/detector.js';

export interface GovernanceOptions {
  json?: boolean;
  maxFiles?: string;
}

export async function governanceCommand(
  targetPath = '.',
  options: GovernanceOptions = {},
): Promise<void> {
  const root = path.resolve(targetPath);
  const maxFiles = options.maxFiles ? Number.parseInt(options.maxFiles, 10) : undefined;
  const report = detectGovernance(root, {
    maxFiles: Number.isFinite(maxFiles) ? maxFiles : undefined,
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(report.contextMarkdown);
}
