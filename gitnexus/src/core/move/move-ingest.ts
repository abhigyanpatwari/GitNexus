/**
 * Phase: moveIngest
 *
 * Compiler-first Move ingestion via the move-flow MCP server. **No raw Move
 * source is ever read.** The `facts` query is the ONLY ingestion path: if the
 * move-flow build doesn't expose it, the phase fails fast with a clear upgrade
 * error before touching any package. Call edges come from the `call_graph`
 * query.
 *
 * Note: move-flow's `facts` query elides all `#[test]` and `#[test_only]`
 * symbols (functions, structs, constants). The graph therefore contains only
 * production symbols; queries to find test functions or exclude tests from
 * impact do not need a symbol-level test filter.
 *
 * @deps    structure
 * @reads   scannedFiles (from structure phase)
 * @writes  graph (Module/Function/Struct/Enum/EnumVariant/Const nodes +
 *          CALLS/DEFINES/CONTAINS/FRIEND_OF/READS_RESOURCE/WRITES_RESOURCE/
 *          ACQUIRES/USES_TYPE/ENTRY_POINT_OF/IMPORTS edges)
 */

import * as path from 'node:path';
import { readFile } from 'node:fs/promises';
import type {
  PipelinePhase,
  PipelineContext,
  PhaseResult,
} from '../ingestion/pipeline-phases/types.js';
import { getPhaseOutput } from '../ingestion/pipeline-phases/types.js';
import type { StructureOutput } from '../ingestion/pipeline-phases/structure.js';
import type { StandaloneIngestOutput } from '../ingestion/pipeline-phases/standalone-ingest.js';
import { moveRepoRelativePath } from './constants.js';
import {
  MoveFlowTimeoutError,
  MoveFlowToolCallError,
  type MoveFlowClient,
  type MovePackageStatus,
} from './mcp-client.js';
import { mapFactsToGraph, type MoveFactsMapResult } from './facts-mapper.js';
import type { CallGraphMap, MoveFactsMap } from './compiler-facts.js';
import { collectClosureCaptureCalls, type FunctionUsageFailure } from './function-usage.js';
import { linkMoveIngestGraph, type MoveLinkView } from './move-linker.js';
import type { DroppedRef, PendingRef } from './refs.js';
import {
  buildFailedIssue,
  cliWarningsFromIssues,
  degradedFactsIssue,
  emptyFactsIssue,
  unresolvedAddressIssue,
  validateMoveIngestOutput,
  type EmptyFactsPackage,
  type MoveConsistencyIssue,
} from './consistency.js';
import { createMoveEntryPointEdges } from './entry-points.js';

function resolveMoveConcurrency(): number {
  const n = Number(process.env.GITNEXUS_MOVE_FLOW_CONCURRENCY);
  return Number.isSafeInteger(n) && n > 0 ? n : 4;
}

// ── Phase output ───────────────────────────────────────────────────────────

export interface MoveIngestOutput extends StandaloneIngestOutput {
  /** Move package roots (absolute directories containing Move.toml). */
  packageRoots: string[];
  /** Module qualified names → source file path (repo-relative or package-root). */
  moduleFileMap: ReadonlyMap<string, string>;
  /** Function qualified names → graph node IDs. */
  functionNodeMap: ReadonlyMap<string, string>;
  /** Struct/enum qualified names → graph node IDs. */
  structNodeMap: ReadonlyMap<string, string>;
  /** Module qualified names → absolute package root. */
  modulePackageMap: ReadonlyMap<string, string>;
  /** Repo-relative file paths → absolute package root. */
  filePackageMap: ReadonlyMap<string, string>;
  /** Absolute package root → compiler call graph for that package. */
  callGraphByPackage: ReadonlyMap<string, CallGraphMap>;
  /** All refs dropped during global resolution (resource, type, friend, lambda-host). */
  droppedRefs: DroppedRef[];
  /** Supplemental function-usage queries that could not be completed. */
  functionUsageFailures: FunctionUsageFailure[];
  /** Non-fatal consistency issues found after Move ingestion. */
  consistencyIssues: MoveConsistencyIssue[];
  /** Operator-actionable warnings for the persistent CLI summary (skipped or
   *  degraded packages). Part of the neutral StandaloneIngestOutput contract. */
  ingestWarnings?: readonly string[];
}

/** Mutable accumulator shared while ingesting every package. */
class MoveIngestAccumulator implements MoveLinkView {
  readonly moduleFileMap = new Map<string, string>();
  readonly functionNodeMap = new Map<string, string>();
  readonly structNodeMap = new Map<string, string>();
  readonly modulePackageMap = new Map<string, string>();
  readonly filePackageMap = new Map<string, string>();
  readonly callGraphByPackage = new Map<string, CallGraphMap>();
  readonly closureCallsByPackage = new Map<string, CallGraphMap>();
  readonly pendingRefs: PendingRef[] = [];
  readonly droppedRefs: DroppedRef[] = [];
  readonly ingestedFiles = new Set<string>();
  readonly functionUsageFailures: FunctionUsageFailure[] = [];

  mergePackage(mapped: MoveFactsMapResult, pkgRoot: string): void {
    for (const [qn, file] of mapped.moduleFileMap) {
      this.moduleFileMap.set(qn, file);
      this.modulePackageMap.set(qn, pkgRoot);
      this.filePackageMap.set(file, pkgRoot);
    }
    for (const [qn, id] of mapped.functionNodeMap) this.functionNodeMap.set(qn, id);
    for (const [qn, id] of mapped.structNodeMap) this.structNodeMap.set(qn, id);
    this.pendingRefs.push(...mapped.pendingRefs);
  }

  toOutput(
    packageRoots: string[],
    consistencyIssues: MoveConsistencyIssue[] = [],
  ): MoveIngestOutput {
    return {
      ingestedFiles: this.ingestedFiles,
      // A package only enters callGraphByPackage after all required queries
      // and the empty-facts gate succeed. Any missing root means this run is a
      // partial snapshot and incremental persistence must retain the prior
      // external dependency nodes/edges for the skipped package.
      externalNodeSnapshotComplete: packageRoots.every((root) => this.callGraphByPackage.has(root)),
      packageRoots,
      moduleFileMap: this.moduleFileMap,
      functionNodeMap: this.functionNodeMap,
      structNodeMap: this.structNodeMap,
      modulePackageMap: this.modulePackageMap,
      filePackageMap: this.filePackageMap,
      callGraphByPackage: this.callGraphByPackage,
      droppedRefs: this.droppedRefs,
      functionUsageFailures: this.functionUsageFailures,
      consistencyIssues,
      ingestWarnings: cliWarningsFromIssues(consistencyIssues),
    };
  }
}

/** GITNEXUS_MOVE_STRICT=1|true restores the historical fatal-on-build-failure
 *  behavior instead of skip-and-warn. */
function isStrictMove(): boolean {
  const v = process.env.GITNEXUS_MOVE_STRICT?.trim().toLowerCase();
  return v === '1' || v === 'true';
}

/**
 * Named addresses assigned the `_` placeholder in a package's Move.toml
 * `[addresses]` section. Deliberately a line-oriented scan, not a TOML parser:
 * the two token shapes involved (`[section]`, `name = "_"`) are stable across
 * every Move manifest and a full parser dependency buys nothing here.
 * Unreadable/absent manifest → `[]` (the build itself will surface that).
 */
async function findPlaceholderAddresses(pkgRoot: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(path.join(pkgRoot, 'Move.toml'), 'utf8');
  } catch {
    return [];
  }
  const placeholders: string[] = [];
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    if (section !== 'addresses') continue;
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*["']_["']$/);
    if (kv) placeholders.push(kv[1]);
  }
  return placeholders;
}

export function createMoveIngestPhase(
  client: MoveFlowClient | null,
): PipelinePhase<MoveIngestOutput> {
  return {
    name: 'standaloneIngest',
    deps: ['structure'],

    async execute(
      ctx: PipelineContext,
      deps: ReadonlyMap<string, PhaseResult<unknown>>,
    ): Promise<MoveIngestOutput> {
      const { scannedFiles, totalFiles } = getPhaseOutput<StructureOutput>(deps, 'structure');

      const packageRoots = [
        ...new Set(
          scannedFiles
            .map((f) => f.path)
            .filter((p) => p.endsWith('Move.toml'))
            .map((p) => path.dirname(path.resolve(ctx.repoPath, p))),
        ),
      ].sort();
      if (!client || packageRoots.length === 0) {
        return new MoveIngestAccumulator().toOutput(packageRoots);
      }

      const { hasFactsQuery, hasFunctionUsageQuery, hasStatusTool } = await client.capabilities();
      if (!hasFactsQuery) {
        // userActionable: rendered as a one-liner without a stack — the fix is
        // an operator action (upgrade move-flow), not a code bug.
        throw Object.assign(
          new Error(
            'move-flow is too old — upgrade to a build that exposes `move_package_query { query: "facts" }`.',
          ),
          { userActionable: true },
        );
      }
      const acc = new MoveIngestAccumulator();

      // Group scanned .move files by their (innermost) owning package. Files
      // are marked as ingested per package only AFTER its facts arrive, so a
      // package whose facts come back empty is left un-ingested rather than
      // silently absent from the graph (the generic parse phase still sees it).
      const moveFilesByPackage = new Map<string, string[]>();
      for (const f of scannedFiles) {
        if (!f.path.endsWith('.move')) continue;
        const abs = path.resolve(ctx.repoPath, f.path);
        // Boundary-safe: bare startsWith would let a sibling directory sharing
        // a name prefix (pkg_ab vs root pkg_a) claim the file.
        const owners = packageRoots.filter((root) => {
          const prefix = root.endsWith(path.sep) ? root : root + path.sep;
          return abs.startsWith(prefix);
        });
        if (owners.length === 0) continue;
        const owner = owners.reduce((a, b) => (b.length > a.length ? b : a));
        const files = moveFilesByPackage.get(owner) ?? [];
        files.push(moveRepoRelativePath(abs, ctx.repoPath));
        moveFilesByPackage.set(owner, files);
      }

      // Pass 1: per-package nodes/edges (all packages first, so cross-package
      // CALLS in Pass 2 can resolve callees in later packages).
      const emptyFactsPackages: EmptyFactsPackage[] = [];
      const packageIssues: MoveConsistencyIssue[] = [];
      const strictMove = isStrictMove();
      for (const pkgRoot of packageRoots) {
        ctx.onProgress({
          phase: 'moveIngest',
          percent: 18,
          message: `Ingesting Move package: ${path.basename(pkgRoot)}`,
          stats: { filesProcessed: 0, totalFiles, nodesCreated: ctx.graph.nodeCount },
        });

        const pkgMoveFiles = moveFilesByPackage.get(pkgRoot) ?? [];

        // Pre-flight: `_` placeholder addresses always fail the build (move-flow
        // has no dev-mode), so skip before spending a compile on the known outcome.
        const placeholders = await findPlaceholderAddresses(pkgRoot);
        if (placeholders.length > 0) {
          packageIssues.push(
            unresolvedAddressIssue({ pkgRoot, moveFileCount: pkgMoveFiles.length, placeholders }),
          );
          continue;
        }

        let callGraphData: CallGraphMap;
        let factsMap: MoveFactsMap;
        try {
          // The pinned move-flow server processes one stdin request at a time
          // on Linux. Keep the two package queries serialized so a single
          // client never has concurrent protocol requests in flight.
          callGraphData = await client.callGraph(pkgRoot);
          factsMap = await client.facts(pkgRoot);
        } catch (err) {
          // A Move package that does not build (bad manifest, missing
          // dependency, unresolved address) is an operator problem, not a code
          // bug. Default: skip the package (its files stay un-ingested, like the
          // empty-facts path) and surface a persistent warning — one broken
          // auxiliary package must not abort the whole analyze.
          if (err instanceof MoveFlowToolCallError && !strictMove) {
            packageIssues.push(
              buildFailedIssue({
                pkgRoot,
                moveFileCount: pkgMoveFiles.length,
                diagnostics: err.message,
              }),
            );
            ctx.onProgress({
              phase: 'moveIngest',
              percent: 18,
              message: `Skipping Move package (build failed): ${path.basename(pkgRoot)}`,
              stats: { filesProcessed: 0, totalFiles, nodesCreated: ctx.graph.nodeCount },
            });
            continue;
          }
          // Strict-mode build failure, timeout (wedged build), or a transport
          // fault that already used its retry: render as the operator one-liner
          // (build/timeout) or propagate as the crash it is.
          throw toPackageQueryError(err, pkgRoot);
        }

        if (Object.keys(factsMap).length === 0 && pkgMoveFiles.length > 0) {
          // Facts `{}` is ambiguous: syntax-broken packages return it as a
          // SUCCESS (the compiler diagnostic only surfaces via
          // `move_package_status`), but so do valid packages whose every item
          // is `#[test]`/`#[test_only]` (elided from facts - see file header).
          // Cross-check the build status to tell them apart; either way skip
          // the package (its files stay un-ingested) and record an issue.
          emptyFactsPackages.push({
            pkgRoot,
            moveFileCount: pkgMoveFiles.length,
            status: await probePackageStatus(client, pkgRoot, hasStatusTool),
          });
          continue;
        }
        // Only past the gate: a skipped package must have zero footprint in
        // Pass 2 linking and consistency validation.
        acc.callGraphByPackage.set(pkgRoot, callGraphData);
        if (hasFunctionUsageQuery) {
          const closureCapture = await collectClosureCaptureCalls(
            client,
            pkgRoot,
            factsMap,
            callGraphData,
            resolveMoveConcurrency(),
          );
          acc.closureCallsByPackage.set(pkgRoot, closureCapture.calls);
          acc.functionUsageFailures.push(...closureCapture.failures);
        }
        for (const rel of pkgMoveFiles) acc.ingestedFiles.add(rel);
        const mapped = mapFactsToGraph(factsMap, pkgRoot, ctx.repoPath);
        for (const node of mapped.nodes) ctx.graph.addNode(node);
        for (const rel of mapped.edges) ctx.graph.addRelationship(rel);
        acc.mergePackage(mapped, pkgRoot);

        // Facts arrived, but move-flow serves structurally complete facts even
        // for builds with compiler errors — and such builds silently lose the
        // inference stage (`acquiresInferred`, hence ACQUIRES edges). Probe the
        // build status so the degraded fidelity is surfaced, not implied away.
        const status = await probePackageStatus(client, pkgRoot, hasStatusTool);
        if (status && !status.ok) {
          packageIssues.push(degradedFactsIssue({ pkgRoot, diagnostics: status.diagnostics }));
        }
      }

      // Pass 2+: link edges that need the full cross-package node index.
      linkMoveIngestGraph(ctx.graph, acc);

      const output = acc.toOutput(packageRoots);
      createMoveEntryPointEdges(ctx.graph, output);

      const consistencyIssues: MoveConsistencyIssue[] = [
        ...packageIssues,
        ...emptyFactsPackages.map(emptyFactsIssue),
      ];
      consistencyIssues.push(...validateMoveIngestOutput(ctx.graph, output));
      reportConsistencyIssues(ctx, consistencyIssues);
      return {
        ...output,
        consistencyIssues,
        ingestWarnings: cliWarningsFromIssues(consistencyIssues),
      };
    },
  };
}

/**
 * Map a package-query failure to its user-facing form. Build/input errors and
 * timeouts are operator problems rendered as one-liners; transport faults
 * have already used up the client's single retry, so anything else propagates
 * as the crash it is.
 */
function toPackageQueryError(err: unknown, pkgRoot: string): Error {
  if (err instanceof MoveFlowToolCallError) {
    // userActionable: rendered as a one-liner without a stack - a Move
    // package that does not build (bad manifest, missing dependency,
    // nonexistent path) is an operator problem, not a code bug.
    return Object.assign(
      new Error(`move-flow could not build Move package ${pkgRoot}: ${err.message}`),
      { userActionable: true },
    );
  }
  if (err instanceof MoveFlowTimeoutError) {
    // Fresh copy: the client owns this instance (it is reused across the
    // transport retry), so stamping the original would mutate state we do
    // not own. The message already names the fix (raise
    // GITNEXUS_MOVE_FLOW_TIMEOUT_MS).
    return Object.assign(new Error(err.message), { userActionable: true });
  }
  return err instanceof Error ? err : new Error(String(err));
}

// --- Empty-facts discrimination ---

/** Cross-check the build status of a sources-but-empty-facts package.
 *  `null` = status unavailable (no status tool, or the probe itself failed). */
async function probePackageStatus(
  client: MoveFlowClient,
  pkgRoot: string,
  hasStatusTool: boolean,
): Promise<MovePackageStatus | null> {
  if (!hasStatusTool) return null;
  try {
    return await client.packageStatus(pkgRoot);
  } catch {
    // Probe failure -> cannot discriminate; fall back to the pessimistic issue.
    return null;
  }
}

/** Surface consistency errors so they reach a human/log (not just the output). */
function reportConsistencyIssues(ctx: PipelineContext, issues: MoveConsistencyIssue[]): void {
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length === 0) return;
  ctx.onProgress({
    phase: 'moveIngest',
    percent: 22,
    message: `Move ingest: ${errors.length} consistency error(s) (e.g. ${errors[0].message})`,
    stats: { filesProcessed: 0, totalFiles: 0, nodesCreated: ctx.graph.nodeCount },
  });
}
