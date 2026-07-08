/**
 * In-phase taint emission (#2083 M3 U4, plan KTD1/KTD6).
 *
 * Per-file driver for the M3 taint pass: gate → match → solve → propagate →
 * persist sparse `TAINTED` + `SANITIZES` edges. Invoked from the pdg window in
 * scope-resolution (`pipeline/run.ts`), immediately after `emitFileReachingDefs`
 * inside the SAME per-file try — per-file isolation for free (KTD1). Mirrors
 * `emitFileReachingDefs` (cfg/emit.ts) for the budget/dedup/warn discipline and
 * the telemetry-result shape.
 *
 * ## Per-function pipeline (ordering is load-bearing)
 *
 * 1. `hasTaintSafeSites` — a corrupted-store site annotation degrades to
 *    SKIP-TAINT-KEEP-RD for this function (counted + warned), never a crash
 *    (KTD2; the matcher/propagator dereference indices unvalidated).
 * 2. `matchFunctionSites` against the language spec (the import index is
 *    built ONCE per file — imports are a file-level fact).
 * 3. ZERO-MATCH FAST PATH: the solver runs only when the function has at
 *    least one matched source AND one matched sink. In a typical repo almost
 *    no function has both; an unconditional second `computeReachingDefs` per
 *    function would ship a near-2× solve cost to every `--pdg` user.
 * 4. `computeReachingDefs` with the taint `maxFacts` — by DEFAULT the M2
 *    derived `DEFAULT_PDG_MAX_REACHING_DEF_FACTS_PER_FUNCTION` (deliberate
 *    reuse, not a new constant: the fact-materialization envelope is a
 *    memory question, O(defs×uses), orthogonal to the findings cap, and M2
 *    already validated exactly this envelope on the same solver in the same
 *    window). The run.ts caller derives `limits.maxFacts` from the SAME
 *    RD-edge-cap formula `emitFileReachingDefs` uses, so taint coverage and
 *    RD coverage truncate together — a function is never `truncated` for one
 *    layer and `computed` for the other.
 * 5. `computeTaintFlows` — a non-`computed` status is a per-function
 *    COVERAGE GAP (R4: counted by `gapReason`, function skipped entirely,
 *    never partially analyzed).
 * 6. Emit one `TAINTED` edge per finding and one `SANITIZES` edge per kill.
 *    Kills are emitted even when findings are zero — a fully-sanitized
 *    function's kills are exactly its evidence of safety.
 *
 * ## Identity, dedup, budget (KTD6)
 *
 * Findings carry STATEMENT-LEVEL identity — function anchor + sink kind +
 * source occurrence (point/site/object-binding/property) + sink occurrence
 * (point/site/arg/binding) — NOT the REACHING_DEF block-level key (block-pair
 * conflation would drop `exec(req.body, req.query)`'s second finding). The
 * propagation engine dedups by this exact key BEFORE its deterministic cap
 * (`maxFindingsPerFunction`) and counts the overflow; this module templates
 * the same coordinates into the edge id (binding identity via the shared
 * `bindingKey`; the free-text `property` rides LAST so it can never collide
 * into another component) and warns with the drop count on truncation.
 *
 * `reason` carries the versioned hop encoding (`taint/path-codec.ts` — U6's
 * `explain` decodes the same module) for `TAINTED`, and the killed binding's
 * plain name for `SANITIZES` (M0/S1 queryability verdict, like REACHING_DEF).
 *
 * ## Warn split (R4 vs noise)
 *
 * Unsafe-site skips and cap drops warn PER FUNCTION here (rare, actionable —
 * mirrors `emitFileReachingDefs`' malformed/cap warns). Solver coverage gaps
 * (`truncated`/`overflow`) do NOT re-warn per function: the RD layer already
 * warned for the same function with the same solver status (same `maxFacts`
 * derivation — see step 4), and a duplicate `[taint]` line per mega-function
 * would be pure spam. They are counted (+ exampled) in the result and the
 * run.ts caller aggregates them into ONE unconditional `logger.warn` per
 * language (R4) — never dropped on the floor (the M2 lesson).
 */

import type { ParsedImport } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../graph/types.js';
import { generateId } from '../../../lib/utils.js';
import {
  basicBlockId,
  bindingKey,
  DEFAULT_PDG_MAX_REACHING_DEF_FACTS_PER_FUNCTION,
} from '../cfg/emit.js';
import {
  computeReachingDefs,
  pointKey,
  type ProgramPoint,
  type ReachingDefsSolver,
} from '../cfg/reaching-defs.js';
import type { BindingEntry, FunctionCfg } from '../cfg/types.js';
import { hasTaintSafeSites } from './site-safety.js';
import { buildTaintImportIndex, matchFunctionSites } from './match.js';
import {
  computeTaintFlows,
  DEFAULT_PDG_MAX_TAINT_FINDINGS_PER_FUNCTION,
  DEFAULT_PDG_MAX_TAINT_HOPS,
} from './propagate.js';

// Re-exported so the pipeline (run.ts) sources the taint default caps through
// this orchestration module rather than reaching into propagate.ts directly.
export {
  DEFAULT_PDG_MAX_TAINT_FINDINGS_PER_FUNCTION,
  DEFAULT_PDG_MAX_TAINT_HOPS,
} from './propagate.js';
import { encodeTaintPath } from './path-codec.js';
import type { SourceSinkSanitizerSpec } from './source-sink-config.js';

/** Cap on example anchors carried per result (aggregate-warn material, R4). */
const MAX_EXAMPLES = 5;

export interface TaintEmitLimits {
  /** Per-function findings cap (post-dedup). `undefined` ⇒
   *  {@link DEFAULT_PDG_MAX_TAINT_FINDINGS_PER_FUNCTION}; `0` ⇒ unlimited. */
  readonly maxFindingsPerFunction?: number;
  /** Per-finding hop cap (source-side prefix kept). `undefined` ⇒
   *  {@link DEFAULT_PDG_MAX_TAINT_HOPS}; `0` ⇒ unlimited. */
  readonly maxHops?: number;
  /**
   * Solver fact-materialization cap for the taint-side `computeReachingDefs`
   * call. `undefined` ⇒ {@link DEFAULT_PDG_MAX_REACHING_DEF_FACTS_PER_FUNCTION}
   * (the M2 derived default — see the module doc for why it is REUSED rather
   * than derived from the findings cap); `0` ⇒ unlimited.
   */
  readonly maxFacts?: number;
}

/**
 * Full taint-emit telemetry for one file. EVERY counter is surfaced by the
 * run.ts aggregate (the M2 emit result had two fields dropped on the floor —
 * the plan names that mistake; don't repeat it).
 */
export interface TaintEmitResult {
  /** Functions fully propagated (`computeTaintFlows` returned `computed`). */
  functionsAnalyzed: number;
  /** Functions skipped by the zero-match fast path (no solver call). */
  functionsSkippedNoMatch: number;
  /** Functions whose `sites` failed {@link hasTaintSafeSites} (skip-taint-keep-RD). */
  functionsSkippedUnsafeSites: number;
  /** Source+sink functions skipped on a non-`computed` solver status (R4). */
  functionsCoverageGap: { truncated: number; overflow: number; 'no-facts': number };
  /** TAINTED edges persisted. */
  findingsEmitted: number;
  /** SANITIZES edges persisted (emitted even when findings are zero). */
  killsEmitted: number;
  /** Findings dropped by the per-function cap (post-dedup), summed. */
  findingsDropped: number;
  /** Findings whose persisted hop path is a truncated prefix (hop/byte cap). */
  hopsTruncatedFindings: number;
  /** ≤{@link MAX_EXAMPLES} `file:line` anchors of gap/unsafe-site functions. */
  coverageGapExamples: string[];
  /** ≤{@link MAX_EXAMPLES} `file:line` anchors of cap-dropped functions. */
  droppedExamples: string[];
}

const pushExample = (list: string[], anchor: string): void => {
  if (list.length < MAX_EXAMPLES) list.push(anchor);
};

/**
 * Run the taint pass over one file's emit-safe CFGs and persist TAINTED +
 * SANITIZES edges. `cfgs` MUST already be `isEmitSafeCfg`-filtered (the same
 * `wellFormed` array the caller fed `emitFileCfgs`/`emitFileReachingDefs`) —
 * block/edge anchors are trusted here; only the M3 `sites` layer is
 * re-validated (`hasTaintSafeSites`). Never throws on well-formed input;
 * the caller's per-file try isolates the rest.
 */
export function emitFileTaint(
  graph: KnowledgeGraph,
  cfgs: readonly FunctionCfg[],
  parsedImports: readonly ParsedImport[],
  spec: SourceSinkSanitizerSpec,
  limits?: TaintEmitLimits,
  onWarn?: (message: string) => void,
  // U12: shared per-file memoized solver (harvest/taint bucket — no maxBlockVisits).
  // The zero-match fast path below still skips the solve entirely; only MATCHED
  // functions request it, hitting the cache the call-summary harvest warmed.
  solve: ReachingDefsSolver = computeReachingDefs,
): TaintEmitResult {
  const result: TaintEmitResult = {
    functionsAnalyzed: 0,
    functionsSkippedNoMatch: 0,
    functionsSkippedUnsafeSites: 0,
    functionsCoverageGap: { truncated: 0, overflow: 0, 'no-facts': 0 },
    findingsEmitted: 0,
    killsEmitted: 0,
    findingsDropped: 0,
    hopsTruncatedFindings: 0,
    coverageGapExamples: [],
    droppedExamples: [],
  };

  // Imports are a FILE-level fact — build the index once, not per function.
  const importIndex = buildTaintImportIndex(parsedImports);
  const maxFindingsPerFunction =
    limits?.maxFindingsPerFunction ?? DEFAULT_PDG_MAX_TAINT_FINDINGS_PER_FUNCTION;
  const maxHops = limits?.maxHops ?? DEFAULT_PDG_MAX_TAINT_HOPS;
  const maxFacts = limits?.maxFacts ?? DEFAULT_PDG_MAX_REACHING_DEF_FACTS_PER_FUNCTION;

  // Defensive cross-CFG id guard: finding identity is unique WITHIN a
  // function by construction (the propagation engine dedups), so a repeat can
  // only mean two CFGs sharing an anchor — skip, never double-insert.
  const seenEdgeIds = new Set<string>();

  for (const cfg of cfgs) {
    const { filePath, functionStartLine, functionStartColumn } = cfg;
    const anchor = `${filePath}:${functionStartLine}`;

    if (!hasTaintSafeSites(cfg)) {
      result.functionsSkippedUnsafeSites++;
      pushExample(result.coverageGapExamples, anchor);
      onWarn?.(
        `[taint] ${anchor}: malformed site annotations (out-of-range binding/site ` +
          `indices) — taint skipped for this function; its CFG and REACHING_DEF ` +
          `layers are unaffected`,
      );
      continue;
    }

    const matches = matchFunctionSites(cfg, spec, importIndex);
    if (!matches.hasSource || !matches.hasSink) {
      // Zero-match fast path: no solver call (see module doc step 3).
      result.functionsSkippedNoMatch++;
      continue;
    }

    const defUse = solve(cfg, { maxFacts });
    const flows = computeTaintFlows(cfg, defUse, matches, { maxFindingsPerFunction, maxHops });
    if (flows.status === 'coverage-gap') {
      // R4: skipped entirely, counted by reason; aggregate-warned by the
      // caller (the RD layer already per-function-warned this solver status).
      result.functionsCoverageGap[flows.gapReason ?? 'no-facts']++;
      pushExample(result.coverageGapExamples, anchor);
      continue;
    }
    result.functionsAnalyzed++;

    const bindings: readonly BindingEntry[] = cfg.bindings ?? [];
    const fnAnchor = `${filePath}:${functionStartLine}:${functionStartColumn}`;
    const blockId = (p: ProgramPoint): string =>
      basicBlockId(filePath, functionStartLine, functionStartColumn, p.blockIndex);
    const bKey = (idx: number): string => {
      const b = bindings[idx];
      return b === undefined ? `#${idx}` : bindingKey(b);
    };
    // SANITIZES — one edge per kill, REGARDLESS of findings (kills can and do
    // exist with zero findings: a fully-sanitized flow IS the kill evidence).
    for (const kill of flows.kills) {
      const id = generateId(
        'SANITIZES',
        `${fnAnchor}:${pointKey(kill.sanitizer)}->${pointKey(kill.killedDef)}:` +
          bKey(kill.bindingIdx),
      );
      if (seenEdgeIds.has(id)) continue;
      seenEdgeIds.add(id);
      graph.addRelationship({
        id,
        type: 'SANITIZES',
        sourceId: blockId(kill.sanitizer),
        targetId: blockId(kill.killedDef),
        confidence: 1.0,
        reason: bindings[kill.bindingIdx]?.name ?? `#${kill.bindingIdx}`,
      });
      result.killsEmitted++;
    }

    // TAINTED — one edge per finding (already deduped + capped upstream).
    for (const finding of flows.findings) {
      const { source, sink } = finding;
      // KTD6 statement-level identity: function anchor + kind + source
      // occurrence + sink occurrence + binding keys. The rule-(b) occurrence
      // coordinates (site index / arg index) distinguish
      // `exec(req.body, req.query)`'s two findings; `property` is free-text
      // (string-literal subscripts) and rides LAST so it cannot collide into
      // another component.
      const id =
        source.type === 'member-read'
          ? generateId(
              'TAINTED',
              `${fnAnchor}:${finding.sinkKind}:` +
                `${pointKey(source.point)}.${source.siteIndex}:${bKey(source.objectBindingIdx)}:` +
                `${pointKey(sink.point)}.${sink.siteIndex}.${sink.argIndex}:${bKey(
                  sink.bindingIdx,
                )}:` +
                `${sink.entryName}:${source.property}`,
            )
          : generateId(
              'TAINTED',
              `${fnAnchor}:${finding.sinkKind}:` +
                `${pointKey(source.point)}.${source.siteIndex}:call-result:` +
                `${bKey(source.resultBindingIdx)}:${source.calleeName}:` +
                `${pointKey(sink.point)}.${sink.siteIndex}.${sink.argIndex}:${bKey(
                  sink.bindingIdx,
                )}:` +
                `${sink.entryName}`,
            );
      if (seenEdgeIds.has(id)) continue;
      seenEdgeIds.add(id);
      // `kind` rides the reason's `;<kind>` header — the only persisted
      // channel for the finding's category (the edge id embedding it is not a
      // stored column; `step` is INT32). U6's `explain` decodes it back.
      const encoded = encodeTaintPath(
        finding.hops.map((h) => ({ name: h.name, line: h.point.line, viaCall: h.viaCall })),
        { truncated: finding.hopsTruncated === true, kind: finding.sinkKind },
      );
      if (encoded.truncated) result.hopsTruncatedFindings++;
      graph.addRelationship({
        id,
        type: 'TAINTED',
        sourceId: blockId(source.point),
        targetId: blockId(sink.point),
        confidence: 1.0,
        reason: encoded.reason,
      });
      result.findingsEmitted++;
    }

    if (flows.droppedFindings > 0) {
      result.findingsDropped += flows.droppedFindings;
      pushExample(result.droppedExamples, anchor);
      onWarn?.(
        `[taint] ${anchor}: per-function taint findings cap ` +
          `(${maxFindingsPerFunction}) reached — dropped ${flows.droppedFindings} of ` +
          `${flows.findings.length + flows.droppedFindings} deduped findings`,
      );
    }
  }

  return result;
}
