/** Bounded CLI graph handoff. Live graph consumers run before this is sent. */
import path from 'node:path';
import type { AnalyzeResult } from '../core/run-analyze.js';
import {
  projectPreparedAnalysisHandoff,
  type PreparedAnalysisHandoff,
} from '../core/analysis-phase-supervisor.js';
import { FTS_SKIP_REASONS } from '../core/search/fts-policy.js';

export interface CliPreparedAnalysisMessage {
  type: 'graph-prepared';
  handoff: PreparedAnalysisHandoff;
  result: Pick<
    AnalyzeResult,
    | 'repoPath'
    | 'repoName'
    | 'storagePath'
    | 'stats'
    | 'ftsSkipped'
    | 'ftsSkipReason'
    | 'isPrimaryBranch'
  >;
  startedAt: number;
  /** Snapshot from BEFORE graph/context generation, never recomputed on resume. */
  selfCommitSafety?: { agentsMd: boolean; claudeMd: boolean };
}

export function projectCliPreparedAnalysis(
  result: AnalyzeResult,
  repoPath: string,
  startedAt: number,
  selfCommitSafety?: ReadonlyMap<string, boolean>,
): CliPreparedAnalysisMessage {
  const handoff = projectPreparedAnalysisHandoff(result.preparedGraph);
  if (
    result.graphWriteCollapsed ||
    result.alreadyUpToDate ||
    result.ftsRepairedOnly ||
    result.repoName !== handoff.repoName ||
    path.resolve(result.repoPath) !== path.resolve(repoPath) ||
    path.resolve(result.repoPath) !== path.resolve(handoff.repoPath) ||
    path.resolve(result.storagePath) !== path.resolve(handoff.storagePath)
  )
    throw new Error('Prepared CLI graph does not match the requested analysis');
  if (!Number.isSafeInteger(startedAt) || startedAt < 0)
    throw new Error('Invalid graph phase start time');

  // Never spread stats or the result: either may gain corpus-sized fields.
  const stats: AnalyzeResult['stats'] = {};
  for (const key of [
    'files',
    'nodes',
    'edges',
    'communities',
    'processes',
    'embeddings',
  ] as const) {
    const value = result.stats[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(`Invalid graph phase counter: ${key}`);
    stats[key] = value;
  }
  for (const key of ['ftsSkipped', 'isPrimaryBranch'] as const) {
    if (result[key] !== undefined && typeof result[key] !== 'boolean')
      throw new Error(`Invalid graph phase flag: ${key}`);
  }
  if (result.ftsSkipReason !== undefined && !FTS_SKIP_REASONS.includes(result.ftsSkipReason))
    throw new Error('Invalid graph phase FTS reason');
  return {
    type: 'graph-prepared',
    handoff,
    result: {
      repoPath: handoff.repoPath,
      repoName: handoff.repoName,
      storagePath: handoff.storagePath,
      stats,
      ftsSkipped: result.ftsSkipped,
      ftsSkipReason: result.ftsSkipReason,
      isPrimaryBranch: result.isPrimaryBranch,
    },
    startedAt,
    selfCommitSafety: selfCommitSafety
      ? {
          agentsMd: selfCommitSafety.get('AGENTS.md') === true,
          claudeMd: selfCommitSafety.get('CLAUDE.md') === true,
        }
      : undefined,
  };
}

interface SupervisorChannel {
  connected?: boolean;
  send?: (message: CliPreparedAnalysisMessage, callback: (error: Error | null) => void) => unknown;
}

export function requireCliAnalysisSupervisor(channel: SupervisorChannel = process) {
  if (typeof channel.send !== 'function' || channel.connected !== true)
    throw new Error('Prepared graph requires a connected analysis supervisor');
  return channel.send.bind(channel);
}

/** A successful send is only delivery, never graph publication or process exit. */
export async function sendCliPreparedAnalysis(
  message: CliPreparedAnalysisMessage,
  channel: SupervisorChannel = process,
): Promise<void> {
  const send = requireCliAnalysisSupervisor(channel);
  await new Promise<void>((resolve, reject) => {
    // Await the callback before the caller exits. A false return means channel
    // backpressure, not failure; the callback remains the delivery boundary.
    send(message, (error: Error | null) => (error ? reject(error) : resolve()));
  });
}
