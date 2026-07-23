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
    | 'empty-package-facts'
    /** Package skipped: move-flow could not build it (skip-and-warn, #2624). */
    | 'package-build-failed'
    /** Package skipped pre-flight: Move.toml [addresses] has `_` placeholders
     *  move-flow cannot resolve (it has no dev-mode build). */
    | 'unresolved-named-address'
    /** Package ingested, but its build carries compiler errors - move-flow
     *  silently omits inferred facts (acquires) from such builds. */
    | 'degraded-package-facts';
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

/** First non-empty line of a compiler diagnostic blob (for one-line summaries). */
function firstDiagnosticLine(diagnostics: string | undefined): string {
  if (!diagnostics) return '';
  for (const line of diagnostics.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

/**
 * A package skipped because move-flow could not build it (skip-and-warn).
 * Warning, not error: the analyze continues and the skip is surfaced in the
 * CLI summary; GITNEXUS_MOVE_STRICT=1 restores the historical fatal behavior.
 */
export function buildFailedIssue(pkg: {
  pkgRoot: string;
  moveFileCount: number;
  diagnostics: string;
}): MoveConsistencyIssue {
  const firstLine = firstDiagnosticLine(pkg.diagnostics);
  return {
    code: 'package-build-failed',
    severity: 'warning',
    message:
      `Move package skipped — move-flow could not build it` +
      (firstLine ? ` (${firstLine})` : '') +
      `: ${pkg.pkgRoot}. Fix the package or exclude its directory via .gitnexusignore; ` +
      `set GITNEXUS_MOVE_STRICT=1 to make build failures fatal.`,
    details: {
      packageRoot: pkg.pkgRoot,
      moveFileCount: pkg.moveFileCount,
      diagnostics: pkg.diagnostics,
    },
  };
}

/**
 * A package skipped pre-flight: its Move.toml `[addresses]` contains `_`
 * placeholders. move-flow's `move_package_query` has no dev-mode, so the build
 * would always fail with "Unresolved addresses" - skip with the remedy instead.
 */
export function unresolvedAddressIssue(pkg: {
  pkgRoot: string;
  moveFileCount: number;
  placeholders: string[];
}): MoveConsistencyIssue {
  return {
    code: 'unresolved-named-address',
    severity: 'warning',
    message:
      `Move package skipped — named address(es) ${pkg.placeholders.join(', ')} are "_" ` +
      `placeholders in Move.toml (move-flow cannot build dev-mode): ${pkg.pkgRoot}. ` +
      `Set concrete addresses in [addresses] or exclude the directory via .gitnexusignore.`,
    details: {
      packageRoot: pkg.pkgRoot,
      moveFileCount: pkg.moveFileCount,
      placeholders: pkg.placeholders,
    },
  };
}

/**
 * A package that WAS ingested but whose build carries compiler errors.
 * move-flow still serves structurally complete facts for such builds but
 * silently drops inference-stage output (`acquiresInferred`), so the graph is
 * missing ACQUIRES edges/properties — surface it instead of implying full
 * fidelity. (Commonly: a framework dependency newer than move-flow's pinned
 * compiler, e.g. spec pragmas it does not recognize.)
 */
export function degradedFactsIssue(pkg: {
  pkgRoot: string;
  diagnostics: string;
}): MoveConsistencyIssue {
  const firstLine = firstDiagnosticLine(pkg.diagnostics);
  return {
    code: 'degraded-package-facts',
    severity: 'warning',
    message:
      `Move package compiled with errors — compiler-inferred facts (acquires) may be ` +
      `incomplete` +
      (firstLine ? ` (${firstLine})` : '') +
      `: ${pkg.pkgRoot}`,
    details: { packageRoot: pkg.pkgRoot, diagnostics: pkg.diagnostics },
  };
}

/**
 * The persistent CLI-summary warnings for a run's Move issues: the three
 * skip/degrade codes are operator-actionable and must survive past the
 * scrolling progress bar (same rationale as the FTS warning, #1161).
 */
export function cliWarningsFromIssues(issues: readonly MoveConsistencyIssue[]): string[] {
  const surfaced: MoveConsistencyIssue['code'][] = [
    'package-build-failed',
    'unresolved-named-address',
    'degraded-package-facts',
  ];
  return issues.filter((i) => surfaced.includes(i.code)).map((i) => i.message);
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
