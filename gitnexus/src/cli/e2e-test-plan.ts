import { dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import {
  buildE2ETestPlanReport,
  renderE2ETestPlanMarkdown,
  type E2EExistingScenario,
  type E2ERouteEvidence,
  type E2ETestPlanInput,
  type E2ETestTargetContract,
} from '../core/e2e-test-generation/report.js';
import { renderE2EGeneratedSpecs } from '../core/e2e-test-generation/spec-renderer.js';
import type { PrImpactReport } from '../core/pr-impact/report.js';
import type { RegressionForensicsReport } from '../core/regression-forensics/report.js';

export interface E2ETestPlanCommandOptions {
  targetJson?: string;
  prImpactJson?: string;
  existingScenariosJson?: string;
  routeEvidenceJson?: string;
  regressionForensicsJson?: string;
  format?: string;
  writeSpecs?: boolean;
  specOutputDir?: string;
  force?: boolean;
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

const renderSpecsWithExistingFilePolicy = (
  report: ReturnType<typeof buildE2ETestPlanReport>,
  options: E2ETestPlanCommandOptions,
) => {
  const firstPass = renderE2EGeneratedSpecs(report, {
    outputDir: options.specOutputDir,
  });
  const existingSpecs = firstPass.specs
    .filter((spec) => existsSync(spec.path))
    .map((spec) => ({
      path: spec.path,
      generated: readFileSync(spec.path, 'utf-8').includes('Generated E2E plan:'),
    }));

  return renderE2EGeneratedSpecs(report, {
    outputDir: options.specOutputDir,
    existingSpecs,
    force: options.force,
  });
};

const writeGeneratedSpecs = (
  report: ReturnType<typeof buildE2ETestPlanReport>,
  options: E2ETestPlanCommandOptions,
): void => {
  const rendered = renderSpecsWithExistingFilePolicy(report, options);
  for (const spec of rendered.specs) {
    mkdirSync(dirname(spec.path), { recursive: true });
    writeFileSync(spec.path, spec.text, 'utf-8');
  }

  if ((options.format || 'markdown').toLowerCase() === 'json') {
    output(
      JSON.stringify(
        {
          report,
          generated_specs: rendered.specs.map((spec) => spec.path),
          blocked: rendered.blocked,
        },
        null,
        2,
      ),
    );
    return;
  }

  output(
    [
      `Generated specs written: ${rendered.specs.length}`,
      `Blocked proposals: ${rendered.blocked.length}`,
      ...rendered.specs.map((spec) => `- ${spec.path}`),
      ...rendered.blocked.map((blocked) => `- ${blocked.proposalId}: ${blocked.reason}`),
    ].join('\n'),
  );
};

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
  if (options.writeSpecs) {
    writeGeneratedSpecs(report, options);
    return;
  }

  if ((options.format || 'markdown').toLowerCase() === 'json') {
    output(JSON.stringify(report, null, 2));
    return;
  }

  output(renderE2ETestPlanMarkdown(report));
}
