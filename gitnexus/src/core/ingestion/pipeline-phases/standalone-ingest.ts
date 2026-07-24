import type { PipelinePhase } from './types.js';

/**
 * Shared output contract for compiler-backed or otherwise standalone ingesters.
 * Claimed files are excluded from the generic parser to prevent duplicate nodes.
 */
export interface StandaloneIngestOutput {
  readonly ingestedFiles: ReadonlySet<string>;
  /**
   * Operator-actionable warnings the ingester wants surfaced in the persistent
   * CLI summary (e.g. a package it had to skip or ingest at degraded fidelity).
   * Language-neutral: the pipeline passes these through without interpreting.
   */
  readonly ingestWarnings?: readonly string[];
}

/** Default no-op used when the caller does not supply a standalone ingester. */
export const emptyStandaloneIngestPhase: PipelinePhase<StandaloneIngestOutput> = {
  name: 'standaloneIngest',
  deps: ['structure'],
  execute: () => Promise.resolve({ ingestedFiles: new Set<string>() }),
};
