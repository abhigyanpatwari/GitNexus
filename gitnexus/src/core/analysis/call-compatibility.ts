import type {
  BrokenKeywordCall,
  CallCompatibilityFile,
  CallCompatibilityProvider,
  CallCompatibilityTarget,
} from '../ingestion/call-compatibility.js';
import { executeParameterized } from '../lbug/pool-adapter.js';
import { LBUG_ID_PROBE_BATCH_SIZE } from '../lbug/query-batch.js';
import { chunk, compareCodeUnits, mapConcurrent } from '../../lib/utils.js';

export interface CallCompatibilityReport {
  findings: BrokenKeywordCall[];
  complete: boolean;
  skipped: { filePath?: string; reason: string }[];
}

export async function checkCallCompatibility(
  graph: string,
  image: {
    directory: string;
    scope: string;
    base?: string;
    files: readonly CallCompatibilityFile[];
  },
  groups: ReadonlyMap<CallCompatibilityProvider, CallCompatibilityTarget[]>,
  onError: (context: string, error: unknown) => void,
  callerSourceUnavailable?: string,
): Promise<CallCompatibilityReport> {
  const report: CallCompatibilityReport = { findings: [], complete: true, skipped: [] };
  const unavailable = new Error('Caller source unavailable');
  for (const [checker, targets] of groups) {
    try {
      const result = await checker.check(
        image.directory,
        image.scope,
        image.base,
        targets,
        async (targetIds) => {
          // A declaration-only comparison uses the selected diff images. Enforce
          // retention before a changed signature can trigger any caller reads.
          if (callerSourceUnavailable) throw unavailable;
          const batches = await mapConcurrent(
            chunk(targetIds, LBUG_ID_PROBE_BATCH_SIZE),
            (ids) =>
              executeParameterized(
                graph,
                `
              MATCH (caller)-[r:CodeRelation]->(target)
              WHERE target.id IN $ids AND r.type IN $relationTypes
              RETURN DISTINCT target.id AS target, caller.filePath AS filePath, r.type AS relationType
            `,
                { ids, relationTypes: checker.relationTypes },
              ),
            { onError: (error) => onError('detect-changes:callers', error) },
          );
          if (batches.includes(undefined)) {
            report.complete = false;
            report.skipped.push({ reason: 'caller-query-failed' });
          }
          return batches.flatMap((rows) => rows ?? []);
        },
        image.files,
        callerSourceUnavailable,
      );
      for (const call of result.findings) report.findings.push(call);
      for (const entry of result.skipped) report.skipped.push(entry);
      if (!result.complete) report.complete = false;
    } catch (error) {
      if (error === unavailable && callerSourceUnavailable) {
        report.complete = false;
        report.skipped.push({ reason: callerSourceUnavailable });
        continue;
      }
      onError('detect-changes:call-compatibility', error);
      report.complete = false;
      report.skipped.push({ reason: 'signature-check-failed' });
    }
  }
  if (groups.size > 1)
    report.findings.sort(
      (a, b) =>
        compareCodeUnits(a.filePath, b.filePath) ||
        a.line - b.line ||
        compareCodeUnits(a.target, b.target),
    );
  return report;
}
