import type { AnalysisFeatureDescriptor } from '../../../analysis-features.js';
import {
  OBJECTIVE_C_GRAMMAR_PACKAGE,
  OBJECTIVE_C_GRAMMAR_VERSION,
  OBJECTIVE_C_PROVIDER_VERSION,
} from './facts.js';

function isObjectiveCProviderCandidatePath(filePath: string): boolean {
  const normalized = filePath.replaceAll('\\', '/').toLowerCase();
  return normalized.endsWith('.m') || normalized.endsWith('.mm') || normalized.endsWith('.h');
}

/**
 * Durable metadata stamp for Objective-C semantic indexing. The feature id
 * carries provider and grammar versions verbatim so a semantic identity/edge
 * change records the exact producer in index metadata and forces a full rebuild.
 *
 * `.h` is included only as a path-level rebuild predicate; content classification
 * still decides whether a header is actually parsed as Objective-C.
 */
export const OBJECTIVE_C_PROVIDER_FEATURE: AnalysisFeatureDescriptor = {
  id:
    `objective-c.provider-${OBJECTIVE_C_PROVIDER_VERSION}.` +
    `${OBJECTIVE_C_GRAMMAR_PACKAGE}-${OBJECTIVE_C_GRAMMAR_VERSION}`,
  version: 1,
  appliesTo: (filePaths) => filePaths.some(isObjectiveCProviderCandidatePath),
};
