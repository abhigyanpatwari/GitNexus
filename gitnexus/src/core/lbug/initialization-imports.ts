import {
  BLADE_VIEW_REFERENCE_REASON,
  DEFERRED_IMPORT_REASON_SUFFIX,
  DOCUMENTATION_LINK_REASON,
  TYPE_ONLY_IMPORT_REASON_SUFFIX,
} from '../graph/edge-reasons.js';
import { providerNonInitializingImportReasons } from '../ingestion/languages/query-providers.js';
import { executeParameterized } from './pool-adapter.js';

const nonInitializingReasons = [
  DOCUMENTATION_LINK_REASON,
  BLADE_VIEW_REFERENCE_REASON,
  ...providerNonInitializingImportReasons,
];

/** Read only file dependencies that can constrain module initialization order. */
export function readInitializationImports(repoId: string, limit: number) {
  // determinism: probe — the caller rejects a full result before reporting cycles.
  return executeParameterized(
    repoId,
    `
    MATCH (source:File)-[r:CodeRelation]->(target:File)
    WHERE r.type = 'IMPORTS'
      AND (r.reason IS NULL OR (
        NOT list_contains($nonInitializingReasons, r.reason)
        AND NOT r.reason ENDS WITH $deferred
        AND NOT r.reason ENDS WITH $erased
      ))
    RETURN source.filePath AS source, target.filePath AS target
    LIMIT $limit`,
    {
      nonInitializingReasons,
      deferred: DEFERRED_IMPORT_REASON_SUFFIX,
      erased: TYPE_ONLY_IMPORT_REASON_SUFFIX,
      limit,
    },
  );
}
