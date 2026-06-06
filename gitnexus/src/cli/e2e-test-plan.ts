import { readFileSync, writeSync } from 'node:fs';
import {
  buildE2ETestPlanReport,
  renderE2ETestPlanMarkdown,
  type E2EExistingScenario,
  type E2ERouteEvidence,
  type E2ETestPlanInput,
  type E2ETestTargetContract,
} from '../core/e2e-test-generation/report.js';
import type { PrImpactReport } from '../core/pr-impact/report.js';
import type { RegressionForensicsReport } from '../core/regression-forensics/report.js';

export interface E2ETestPlanCommandOptions {
  targetJson?: string;
  prImpactJson?: string;
  existingScenariosJson?: string;
  routeEvidenceJson?: string;
  regressionForensicsJson?: string;
  format?: string;
}

function output(data: string): void {
  try {
    writeSync(1, data + '\n');
  } catch (err: any) {
    if (err?.code === 'EPIPE') process.exit(0);
    process.stderr.write(data + '\n');
  }
}

const readJsonFile = <T>(filePath: string): T =>
  JSON.parse(readFileSync(filePath, 'utf-8')) as T;

export async function e2eTestPlanCommand(
  options?: E2ETestPlanCommandOptions,
): Promise<void> {
  if (
    !options?.targetJson ||
    !options?.prImpactJson ||
    !options?.existingScenariosJson ||
    !options?.routeEvidenceJson
  ) {
    throw new Error(
      'Required options: --target-json, --pr-impact-json, --existing-scenarios-json, and --route-evidence-json.',
    );
  }

  const target = readJsonFile<E2ETestTargetContract>(options.targetJson);
  const prImpactReport = readJsonFile<PrImpactReport>(options.prImpactJson);
  const existingScenarios = readJsonFile<E2EExistingScenario[]>(
    options.existingScenariosJson,
  );
  const routeEvidence = readJsonFile<E2ERouteEvidence[]>(options.routeEvidenceJson);
  const regressionForensicsReport = options.regressionForensicsJson
    ? readJsonFile<RegressionForensicsReport>(options.regressionForensicsJson)
    : undefined;

  const input: E2ETestPlanInput = {
    target,
    prImpactReport,
    regressionForensicsReport,
    existingScenarios,
    routeEvidence,
  };

  const report = buildE2ETestPlanReport(input);
  if ((options.format || 'markdown').toLowerCase() === 'json') {
    output(JSON.stringify(report, null, 2));
    return;
  }

  output(renderE2ETestPlanMarkdown(report));
}
