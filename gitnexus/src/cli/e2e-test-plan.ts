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
import { renderE2EGeneratedApiSmokeSpecs } from '../core/e2e-test-generation/api-smoke-renderer.js';
import { renderE2EGeneratedSpecs } from '../core/e2e-test-generation/spec-renderer.js';
import type { ImpactForRangesReport } from '../core/pr-impact/impact-for-ranges-report.js';
import type { PrImpactReport } from '../core/pr-impact/report.js';
import type { RegressionForensicsReport } from '../core/regression-forensics/report.js';

export interface E2ETestPlanCommandOptions {
  targetJson?: string;
  prImpactJson?: string;
  impactForRangesJson?: string;
  existingScenariosJson?: string;
  routeEvidenceJson?: string;
  regressionForensicsJson?: string;
  format?: string;
  writeSpecs?: boolean;
  writeApiSmokeSpecs?: boolean;
  specOutputDir?: string;
  apiSmokeOutputDir?: string;
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
): { paths: string[]; blocked: { proposalId: string; reason: string }[]; lines: string[] } => {
  const rendered = renderSpecsWithExistingFilePolicy(report, options);
  for (const spec of rendered.specs) {
    mkdirSync(dirname(spec.path), { recursive: true });
    writeFileSync(spec.path, spec.text, 'utf-8');
  }

  return {
    paths: rendered.specs.map((spec) => spec.path),
    blocked: rendered.blocked,
    lines: [
      `Generated specs written: ${rendered.specs.length}`,
      `Blocked proposals: ${rendered.blocked.length}`,
      ...rendered.specs.map((spec) => `- ${spec.path}`),
      ...rendered.blocked.map((blocked) => `- ${blocked.proposalId}: ${blocked.reason}`),
    ],
  };
};

const renderApiSmokeSpecsWithExistingFilePolicy = (
  report: ReturnType<typeof buildE2ETestPlanReport>,
  options: E2ETestPlanCommandOptions,
) => {
  const firstPass = renderE2EGeneratedApiSmokeSpecs(report, {
    outputDir: options.apiSmokeOutputDir,
  });
  const existingSpecs = firstPass.specs
    .filter((spec) => existsSync(spec.path))
    .map((spec) => ({
      path: spec.path,
      generated: readFileSync(spec.path, 'utf-8').includes('Generated GitNexus API smoke plan:'),
    }));

  return renderE2EGeneratedApiSmokeSpecs(report, {
    outputDir: options.apiSmokeOutputDir,
    existingSpecs,
    force: options.force,
  });
};

const writeGeneratedApiSmokeSpecs = (
  report: ReturnType<typeof buildE2ETestPlanReport>,
  options: E2ETestPlanCommandOptions,
): { paths: string[]; blocked: { proposalId: string; reason: string }[]; lines: string[] } => {
  const rendered = renderApiSmokeSpecsWithExistingFilePolicy(report, options);
  for (const spec of rendered.specs) {
    mkdirSync(dirname(spec.path), { recursive: true });
    writeFileSync(spec.path, spec.text, 'utf-8');
  }

  return {
    paths: rendered.specs.map((spec) => spec.path),
    blocked: rendered.blocked,
    lines: [
      `Generated API-smoke specs written: ${rendered.specs.length}`,
      `Blocked API-smoke proposals: ${rendered.blocked.length}`,
      ...rendered.specs.map((spec) => `- ${spec.path}`),
      ...rendered.blocked.map((blocked) => `- ${blocked.proposalId}: ${blocked.reason}`),
    ],
  };
};

export async function e2eTestPlanCommand(
  options?: E2ETestPlanCommandOptions,
): Promise<void> {
  const hasPrImpact = Boolean(options?.prImpactJson);
  const hasImpactForRanges = Boolean(options?.impactForRangesJson);
  if (
    !options?.targetJson ||
    hasPrImpact === hasImpactForRanges ||
    !options?.existingScenariosJson ||
    !options?.routeEvidenceJson
  ) {
    throw new Error(
      'Required options: --target-json, --existing-scenarios-json, --route-evidence-json, and exactly one of --pr-impact-json or --impact-for-ranges-json.',
    );
  }

  const target = readJsonFile<E2ETestTargetContract>(options.targetJson);
  const existingScenarios = readJsonFile<E2EExistingScenario[]>(
    options.existingScenariosJson,
  );
  const routeEvidence = readJsonFile<E2ERouteEvidence[]>(options.routeEvidenceJson);
  const regressionForensicsReport = options.regressionForensicsJson
    ? readJsonFile<RegressionForensicsReport>(options.regressionForensicsJson)
    : undefined;

  const input: E2ETestPlanInput = hasPrImpact
    ? {
        target,
        prImpactReport: readJsonFile<PrImpactReport>(options.prImpactJson!),
        regressionForensicsReport,
        existingScenarios,
        routeEvidence,
      }
    : {
        target,
        impactForRangesReport: readJsonFile<ImpactForRangesReport>(options.impactForRangesJson!),
        regressionForensicsReport,
        existingScenarios,
        routeEvidence,
      };

  const report = buildE2ETestPlanReport(input);
  if (options.writeSpecs || options.writeApiSmokeSpecs) {
    const generatedSpecs = options.writeSpecs
      ? writeGeneratedSpecs(report, options)
      : undefined;
    const generatedApiSmokeSpecs = options.writeApiSmokeSpecs
      ? writeGeneratedApiSmokeSpecs(report, options)
      : undefined;

    if ((options.format || 'markdown').toLowerCase() === 'json') {
      output(
        JSON.stringify(
          {
            report,
            ...(generatedSpecs
              ? {
                  generated_specs: generatedSpecs.paths,
                  blocked: generatedSpecs.blocked,
                }
              : {}),
            ...(generatedApiSmokeSpecs
              ? {
                  generated_api_smoke_specs: generatedApiSmokeSpecs.paths,
                  blocked_api_smoke: generatedApiSmokeSpecs.blocked,
                }
              : {}),
          },
          null,
          2,
        ),
      );
      return;
    }

    output(
      [
        ...(generatedSpecs?.lines ?? []),
        ...(generatedSpecs && generatedApiSmokeSpecs ? [''] : []),
        ...(generatedApiSmokeSpecs?.lines ?? []),
      ].join('\n'),
    );
    return;
  }

  if ((options.format || 'markdown').toLowerCase() === 'json') {
    output(JSON.stringify(report, null, 2));
    return;
  }

  output(renderE2ETestPlanMarkdown(report));
}
