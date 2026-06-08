import { readFileSync, writeSync } from 'node:fs';
import {
  buildRegressionForensicsReport,
  renderRegressionForensicsMarkdown,
  type RegressionForensicsFailureInput,
  type RegressionForensicsInput,
} from '../core/regression-forensics/report.js';
import type { ImpactForRangesReport } from '../core/pr-impact/impact-for-ranges-report.js';
import type { PrImpactReport } from '../core/pr-impact/report.js';

export interface RegressionForensicsCommandOptions {
  failureJson?: string;
  prImpactJson?: string;
  impactForRangesJson?: string;
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
  const hasPrImpact = Boolean(options?.prImpactJson);
  const hasImpactForRanges = Boolean(options?.impactForRangesJson);
  if (!options?.failureJson || hasPrImpact === hasImpactForRanges) {
    throw new Error(
      'Required options: --failure-json plus exactly one of --pr-impact-json or --impact-for-ranges-json.',
    );
  }

  const failure = readJsonFile<FailureJsonInput>(options.failureJson);

  const baseInput = {
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
  };
  const input: RegressionForensicsInput = hasPrImpact
    ? {
        ...baseInput,
        prImpactReport: readJsonFile<PrImpactReport>(options!.prImpactJson!),
      }
    : {
        ...baseInput,
        impactForRangesReport: readJsonFile<ImpactForRangesReport>(options!.impactForRangesJson!),
      };

  const report = buildRegressionForensicsReport(input);
  if ((options.format || 'markdown').toLowerCase() === 'json') {
    output(JSON.stringify(report, null, 2));
    return;
  }

  output(renderRegressionForensicsMarkdown(report));
}
