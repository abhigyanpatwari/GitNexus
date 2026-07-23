import type { KnowledgeGraph } from '../graph/types.js';
import type { MovePackageStatus } from './mcp-client.js';
import type { MoveIngestOutput } from './move-ingest.js';
import type { DroppedRef, PendingRefKind } from './refs.js';
import { moveModuleQualifiedName, parseMoveModuleQualifiedName } from './symbol-id.js';

export type MoveConsistencySeverity = 'warning' | 'error';

export interface MoveConsistencyIssue {
  code:
    | 'missing-owned-caller'
    | 'missing-owned-callee'
    | 'malformed-source-evidence'
    | 'unresolved-resource-target'
    | 'unresolved-type-target'
    | 'unresolved-friend-target'
    | 'unresolved-lambda-host'
    | 'function-usage-query-failed'
    /** Non-empty call graph in which no caller resolves to a mapped function -
     *  a systematic qualified-name mismatch between `call_graph` and `facts`. */
    | 'call-graph-unlinked'
    /** Externally-materialized module shares an address with repo-local
     *  modules - possibly local code the compiler elided from `facts`. */
    | 'external-module-address-overlap'
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

export interface MoveConsistencySummaryIssue {
  code: MoveConsistencyIssue['code'];
  severity: MoveConsistencySeverity;
  message: string;
  /** Bounded JSON preview of the original structured details. */
  details?: string;
}

/** Compact, persistable digest of a run's Move consistency issues. */
export interface MoveConsistencySummary {
  errorCount: number;
  warningCount: number;
  /** Errors-first sample, capped so meta.json stays small. */
  issues: MoveConsistencySummaryIssue[];
}

const MAX_SUMMARY_MESSAGE_CHARS = 500;
const MAX_SUMMARY_DETAILS_CHARS = 2_000;

function truncateSummaryText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 3)}...`;
}

/** `undefined` when there is nothing to record (the common clean run). */
export function summarizeMoveConsistency(
  issues: readonly MoveConsistencyIssue[],
  sampleLimit = 20,
): MoveConsistencySummary | undefined {
  if (issues.length === 0) return undefined;
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  return {
    errorCount: errors.length,
    warningCount: warnings.length,
    issues: [...errors, ...warnings].slice(0, sampleLimit).map((issue) => ({
      code: issue.code,
      severity: issue.severity,
      message: truncateSummaryText(issue.message, MAX_SUMMARY_MESSAGE_CHARS),
      details:
        issue.details === undefined
          ? undefined
          : truncateSummaryText(JSON.stringify(issue.details), MAX_SUMMARY_DETAILS_CHARS),
    })),
  };
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

  validateCallGraphLinkage(moveIngest, issues);
  validateExternalAddressOverlap(graph, moveIngest, issues);

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

  pushGroupedDrops(issues, moveIngest.droppedRefs);
  pushDroppedIssue(
    issues,
    moveIngest.functionUsageFailures,
    'function-usage-query-failed',
    'supplemental function-usage query(s) failed',
  );

  return issues;
}

const DROP_ISSUE: Record<PendingRefKind, { code: MoveConsistencyIssue['code']; label: string }> = {
  resource: {
    code: 'unresolved-resource-target',
    label: 'resource read/write/acquires target(s) could not be resolved',
  },
  type: {
    code: 'unresolved-type-target',
    label: 'signature/type reference target(s) could not be resolved',
  },
  friend: {
    code: 'unresolved-friend-target',
    label: 'friend declaration target(s) have no Module node',
  },
  'lambda-host': {
    code: 'unresolved-lambda-host',
    label: 'lambda function(s) have no resolvable host function',
  },
};

function pushGroupedDrops(issues: MoveConsistencyIssue[], drops: readonly DroppedRef[]): void {
  const byKind = new Map<PendingRefKind, DroppedRef[]>();
  for (const d of drops) {
    const list = byKind.get(d.kind);
    if (list) list.push(d);
    else byKind.set(d.kind, [d]);
  }
  for (const [kind, list] of byKind) {
    const { code, label } = DROP_ISSUE[kind];
    issues.push({
      code,
      severity: 'warning',
      message: `${list.length} ${label}.`,
      details: { count: list.length, sample: list.slice(0, 5) },
    });
  }
}

/** One warning per non-empty dropped-reference list: full count, 5-item sample. */
function pushDroppedIssue(
  issues: MoveConsistencyIssue[],
  dropped: readonly unknown[],
  code: MoveConsistencyIssue['code'],
  label: string,
): void {
  if (dropped.length === 0) return;
  issues.push({
    code,
    severity: 'warning',
    message: `${dropped.length} ${label}.`,
    details: { count: dropped.length, sample: dropped.slice(0, 5) },
  });
}

/**
 * A non-empty call graph in which NO caller resolves to a mapped function OR
 * mapped module is a systematic qualified-name mismatch between `call_graph`
 * and `facts` (e.g. address-normalization drift across move-flow versions):
 * every CALLS edge drops, and the per-caller ownership checks are also blind
 * because modulePackageMap is keyed from the same facts names. The module
 * condition keeps call graphs that merely include facts-elided functions
 * (e.g. tests) out of scope — their caller MODULES still resolve, and the
 * per-caller missing-owned-caller check already covers them. The callee
 * condition covers callers living entirely in facts-elided modules (a
 * test-only module exercising a mapped library): their CALLEES still join
 * facts names, which real normalization drift would break on both sides.
 * Scoped to packages that DID map functions, so a structs-only package
 * cannot false-positive.
 */
function validateCallGraphLinkage(
  moveIngest: MoveIngestOutput,
  issues: MoveConsistencyIssue[],
): void {
  const mappedFnPackages = new Set<string>();
  for (const fnQualified of moveIngest.functionNodeMap.keys()) {
    const pkg = moveIngest.modulePackageMap.get(moveModuleQualifiedName(fnQualified));
    if (pkg) mappedFnPackages.add(pkg);
  }
  for (const [packageRoot, callGraph] of moveIngest.callGraphByPackage) {
    const callers = Object.keys(callGraph);
    if (callers.length === 0 || !mappedFnPackages.has(packageRoot)) continue;
    if (callers.some((caller) => moveIngest.functionNodeMap.has(caller))) continue;
    if (
      callers.some((caller) => moveIngest.modulePackageMap.has(moveModuleQualifiedName(caller)))
    ) {
      continue;
    }
    const callees = Object.values(callGraph).flat();
    if (callees.some((callee) => moveIngest.functionNodeMap.has(callee))) continue;
    issues.push({
      code: 'call-graph-unlinked',
      severity: 'error',
      message:
        `Move call graph for ${packageRoot} resolved zero of ${callers.length} caller(s) to ` +
        `mapped functions - qualified-name mismatch between call_graph and facts?`,
      details: { packageRoot, callerCount: callers.length, sample: callers.slice(0, 5) },
    });
  }
}

/**
 * The linker materializes unresolved cross-module targets as external
 * dependency nodes (`locationFidelity: 'external'`). An external module whose
 * ADDRESS also hosts repo-local modules is suspicious: it may be local code
 * that `facts` elided while `call_graph`/type refs still name it, which would
 * otherwise mislabel the user's own symbols as foreign with no trace.
 */
function validateExternalAddressOverlap(
  graph: KnowledgeGraph,
  moveIngest: MoveIngestOutput,
  issues: MoveConsistencyIssue[],
): void {
  const localAddresses = new Set<string>();
  for (const moduleQualified of moveIngest.moduleFileMap.keys()) {
    const { address } = parseMoveModuleQualifiedName(moduleQualified);
    if (address) localAddresses.add(address);
  }
  if (localAddresses.size === 0) return;

  const overlapping: string[] = [];
  for (const node of graph.iterNodes()) {
    if (node.label !== 'Module' || node.properties.locationFidelity !== 'external') continue;
    const qualifiedName = node.properties.qualifiedName;
    if (typeof qualifiedName !== 'string') continue;
    const { address } = parseMoveModuleQualifiedName(qualifiedName);
    if (address && localAddresses.has(address)) overlapping.push(qualifiedName);
  }
  if (overlapping.length === 0) return;
  issues.push({
    code: 'external-module-address-overlap',
    severity: 'warning',
    message:
      `${overlapping.length} external-dependency module(s) share an address with repo-local ` +
      `modules - local code may have been materialized as external (facts/call_graph drift).`,
    details: { count: overlapping.length, sample: overlapping.slice(0, 5) },
  });
}
