import type { KnowledgeGraph } from '../graph/types.js';
import type { MovePackageStatus } from './mcp-client.js';
import type { MoveIngestOutput } from './move-ingest.js';
import { moveModuleQualifiedName } from './symbol-id.js';

export type MoveConsistencySeverity = 'warning' | 'error';

export interface MoveConsistencyIssue {
  code:
    | 'missing-owned-caller'
    | 'missing-owned-callee'
    | 'malformed-source-evidence'
    | 'unresolved-resource-target'
    /** Package with .move sources returned facts `{}` - severity policy in
     *  `emptyFactsIssue` below. */
    | 'empty-package-facts';
  severity: MoveConsistencySeverity;
  message: string;
  details?: Record<string, unknown>;
}

/** A sources-but-empty-facts package plus what `move_package_status` said
 *  (`null` = build status unavailable: older move-flow, or probe failure). */
export interface EmptyFactsPackage {
  pkgRoot: string;
  moveFileCount: number;
  status: MovePackageStatus | null;
}

/**
 * Severity policy for a package whose facts came back `{}` despite .move
 * sources: compiling -> warning (likely test-only, elided from facts), failing
 * -> error carrying the compiler diagnostics, status unavailable -> pessimistic
 * error. Pure mapping - probing the status (client I/O) stays in the phase.
 */
export function emptyFactsIssue(pkg: EmptyFactsPackage): MoveConsistencyIssue {
  const { pkgRoot, moveFileCount, status } = pkg;
  if (status === null) {
    return {
      code: 'empty-package-facts',
      severity: 'error',
      message:
        `Move package produced no facts despite containing .move sources ` +
        `(does it compile? check \`move_package_status\`): ${pkgRoot}`,
      details: { packageRoot: pkgRoot, moveFileCount },
    };
  }
  if (status.ok) {
    return {
      code: 'empty-package-facts',
      severity: 'warning',
      message:
        `Move package compiles but produced no facts - likely test-only ` +
        `(#[test]/#[test_only] items are elided); its .move files stay un-ingested: ${pkgRoot}`,
      details: { packageRoot: pkgRoot, moveFileCount },
    };
  }
  const firstLine = status.diagnostics.split('\n', 1)[0]?.trim();
  return {
    code: 'empty-package-facts',
    severity: 'error',
    message:
      `Move package produced no facts because it does not compile` +
      (firstLine ? ` (${firstLine})` : '') +
      `: ${pkgRoot}`,
    details: { packageRoot: pkgRoot, moveFileCount, diagnostics: status.diagnostics },
  };
}

export function validateMoveIngestOutput(
  graph: KnowledgeGraph,
  moveIngest: MoveIngestOutput,
): MoveConsistencyIssue[] {
  const issues: MoveConsistencyIssue[] = [];

  for (const [moduleQualified, filePath] of moveIngest.moduleFileMap) {
    if (!filePath.endsWith('.move')) {
      issues.push({
        code: 'malformed-source-evidence',
        severity: 'warning',
        message: `Move module ${moduleQualified} has non-Move source evidence: ${filePath}`,
        details: { moduleQualified, filePath },
      });
      continue;
    }
    const fileNode = graph.getNode(`File:${filePath}`);
    const knownSource = moveIngest.ingestedFiles.has(filePath) || !!fileNode;
    if (!knownSource) {
      issues.push({
        code: 'malformed-source-evidence',
        severity: 'warning',
        message: `Move module ${moduleQualified} points at a source file not seen by ingestion: ${filePath}`,
        details: { moduleQualified, filePath },
      });
    }
  }

  for (const [packageRoot, callGraph] of moveIngest.callGraphByPackage) {
    for (const [callerQualified, callees] of Object.entries(callGraph)) {
      const callerModule = moveModuleQualifiedName(callerQualified);
      if (
        moveIngest.modulePackageMap.has(callerModule) &&
        !moveIngest.functionNodeMap.has(callerQualified)
      ) {
        issues.push({
          code: 'missing-owned-caller',
          severity: 'warning',
          message: `Move call graph caller has package ownership but no function node: ${callerQualified}`,
          details: { packageRoot, callerQualified },
        });
      }

      for (const calleeQualified of callees) {
        const calleeModule = moveModuleQualifiedName(calleeQualified);
        if (!moveIngest.modulePackageMap.has(calleeModule)) continue;
        if (moveIngest.functionNodeMap.has(calleeQualified)) continue;
        issues.push({
          code: 'missing-owned-callee',
          severity: 'warning',
          message: `Move call graph callee belongs to this repo but has no function node: ${calleeQualified}`,
          details: { packageRoot, callerQualified, calleeQualified },
        });
      }
    }
  }

  const dropped = moveIngest.droppedResourceRefs;
  if (dropped && dropped.length > 0) {
    issues.push({
      code: 'unresolved-resource-target',
      severity: 'warning',
      message: `${dropped.length} resource read/write/acquires target(s) could not be resolved.`,
      details: { count: dropped.length, sample: dropped.slice(0, 5) },
    });
  }

  return issues;
}
