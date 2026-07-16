import type { PipelinePhase } from './types.js';

/**
 * Shared output contract for compiler-backed or otherwise standalone ingesters.
 * Claimed files are excluded from the generic parser to prevent duplicate nodes.
 */
export interface StandaloneIngestOutput {
  readonly ingestedFiles: ReadonlySet<string>;
}

/** Default no-op used when the caller does not supply a standalone ingester. */
export const emptyStandaloneIngestPhase: PipelinePhase<StandaloneIngestOutput> = {
  name: 'standaloneIngest',
  deps: ['structure'],
  execute: () => Promise.resolve({ ingestedFiles: new Set<string>() }),
};
