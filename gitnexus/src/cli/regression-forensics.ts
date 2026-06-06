import { readFileSync, writeSync } from 'node:fs';
import {
  buildRegressionForensicsReport,
  renderRegressionForensicsMarkdown,
  type RegressionForensicsFailureInput,
  type RegressionForensicsInput,
} from '../core/regression-forensics/report.js';
import type { PrImpactReport } from '../core/pr-impact/report.js';

export interface RegressionForensicsCommandOptions {
  failureJson?: string;
  prImpactJson?: string;
  format?: string;
}

type FailureJsonInput = RegressionForensicsFailureInput & {
  knownGoodRef?: string;
  knownBadRef?: string;
};

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

export async function regressionForensicsCommand(
  options?: RegressionForensicsCommandOptions,
): Promise<void> {
  if (!options?.failureJson || !options?.prImpactJson) {
    throw new Error('Both --failure-json and --pr-impact-json are required.');
  }

  const failure = readJsonFile<FailureJsonInput>(options.failureJson);
  const prImpactReport = readJsonFile<PrImpactReport>(options.prImpactJson);

  const input: RegressionForensicsInput = {
    failure: {
      failureCommand: failure.failureCommand,
      exitCode: failure.exitCode,
      failingTests: failure.failingTests,
      failureExcerpt: failure.failureExcerpt,
      environment: failure.environment,
    },
    refs: {
      knownGoodRef: failure.knownGoodRef,
      knownBadRef: failure.knownBadRef,
    },
    prImpactReport,
  };

  const report = buildRegressionForensicsReport(input);
  if ((options.format || 'markdown').toLowerCase() === 'json') {
    output(JSON.stringify(report, null, 2));
    return;
  }

  output(renderRegressionForensicsMarkdown(report));
}
