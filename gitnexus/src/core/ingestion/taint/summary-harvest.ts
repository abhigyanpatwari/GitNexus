/**
 * Per-function taint SUMMARY harvest (#2084 M4 U1).
 *
 * Pure, deterministic derivation of one function's {@link FunctionSummary}
 * facts from the SAME substrate the M3 intra-procedural pass consumes — the M2
 * reaching-definition facts (`computeReachingDefs`) and the matched taint sites
 * (`matchFunctionSites`). No graph, no I/O, no logger; mirrors the
 * `computeReachingDefs` / `computeTaintFlows` contract (insertion-ordered
 * worklist, explicitly sorted outputs) so snapshot tests and the version stamp
 * stay stable. Runs IN-PHASE inside the scope-resolution pdg window where the
 * CFG side channel is live (plan KTD1); the cross-function fixpoint that
 * COMPOSES these summaries runs afterward over the complete call graph.
 *
 * ## What a summary captures (whole-parameter granularity)
 *
 * Seeding each formal parameter as taint and running forward reachability over
 * the def→use facts yields four edge categories:
 *
 * - **param→return** — a param's value reaches a `return <expr>`. Return
 *   statements are identified structurally: the SOURCE block of every CFG edge
 *   of kind `return` terminates in the return jump (the M2 edge-kind
 *   invariant), so its last statement's `uses` are the returned bindings.
 * - **param→callee-arg** — a param occurrence lands in argument position
 *   `argIndex` of a call at `callLine`. The fixpoint resolves `callLine` to a
 *   callee via the caller's `CALLS` edges and applies the callee's summary
 *   (TITO composition).
 * - **param→sink** — a param reaches a modelled sink position (the partial
 *   flow that a cross-function source completes).
 * - **source→return** — a modelled source read (`req.body`) reaches the return
 *   (a generative summary: calling the function yields tainted data).
 *
 * ## Soundness model (context-insensitive first cut)
 *
 * Onward propagation uses the M3 STATEMENT-LEVEL precision floor: a statement
 * that uses a tainted binding taints all of its defs (and `mayDefs`). This is
 * the same sound over-approximation M3 documents — it may over-taint
 * (multi-declarator conflation) but never drops a real flow. Sanitizer
 * `resultDefs` narrow the EXCLUSION set (a def produced by a matched sanitizer
 * carries that sanitizer's neutralised `SinkKind`s), so a sanitised value does
 * not trigger a downstream sink of the neutralised kind — the kind-set
 * exclusion model, simplified to the result-def channel (occurrence
 * interposition, field paths, and callbacks are deferred — plan KTD).
 *
 * The summary edges themselves (return / call-arg / sink) are recorded from
 * ACTUAL binding occurrences (a tainted binding present in a return's uses, a
 * call's arg list, or a matched sink position), never the floor — the floor
 * governs only onward def-tainting, keeping the recorded edges precise.
 */

import type { FunctionCfg, SiteRecord } from '../cfg/types.js';
import { pointKey, type FunctionDefUse, type ProgramPoint } from '../cfg/reaching-defs.js';
import type { FunctionSiteMatches } from './match.js';
import type { SinkKind } from './source-sink-config.js';
import type {
  ParamToCallArg,
  ParamToReturn,
  ParamToSink,
  SourceToCallArg,
  SourceToReturn,
} from './summary-model.js';

/** The own-facts portion of a summary (fnId/version are added by the caller). */
export interface HarvestedSummaryFacts {
  readonly paramCount: number;
  readonly paramToReturn: readonly ParamToReturn[];
  readonly paramToCallArg: readonly ParamToCallArg[];
  readonly paramToSink: readonly ParamToSink[];
  readonly sourceToReturn: readonly SourceToReturn[];
  readonly sourceToCallArg: readonly SourceToCallArg[];
}

export interface HarvestResult {
  /** `computed` — facts derived; `coverage-gap` — the RD solver was not
   *  `computed`, so no summary is produced (consistent with M3 R4). */
  readonly status: 'computed' | 'coverage-gap';
  readonly gapReason?: FunctionDefUse['status'];
  readonly facts: HarvestedSummaryFacts;
}

const EMPTY_FACTS: HarvestedSummaryFacts = {
  paramCount: 0,
  paramToReturn: [],
  paramToCallArg: [],
  paramToSink: [],
  sourceToReturn: [],
  sourceToCallArg: [],
};

const KIND_ORDER: readonly SinkKind[] = [
  'code-injection',
  'command-injection',
  'path-traversal',
  'sql-injection',
  'xss',
];
const kindRank = new Map<SinkKind, number>(KIND_ORDER.map((k, i) => [k, i]));
const sortKinds = (kinds: Iterable<SinkKind>): SinkKind[] =>
  [...new Set(kinds)].sort((a, b) => (kindRank.get(a) ?? 99) - (kindRank.get(b) ?? 99));

/** Last segment of a dotted callee path (`child_process.exec` ⇒ `exec`). */
const calleeTail = (callee: string | undefined): string | undefined =>
  callee === undefined ? undefined : (callee.split('.').pop() ?? callee);

/** A tainted binding flowing forward, tagged with the seed it came from. */
interface SeedTaint {
  readonly bindingIdx: number;
  readonly point: ProgramPoint;
  /** Index into `seeds` — the param index, or -1 for a source seed. */
  readonly seedId: number;
  /** Sink kinds neutralised on the path to here (monotone over the floor). */
  readonly exclusions: ReadonlySet<SinkKind>;
}

/**
 * Harvest the summary facts for one function. PRECONDITION: `cfg` is
 * `isEmitSafeCfg`-filtered and `defUse` was computed from it; sites are assumed
 * `hasTaintSafeSites`-valid (the caller gates exactly as the M3 emit path does).
 */
export function harvestFunctionSummary(
  cfg: FunctionCfg,
  defUse: FunctionDefUse,
  matches: FunctionSiteMatches,
): HarvestResult {
  if (defUse.status !== 'computed') {
    return { status: 'coverage-gap', gapReason: defUse.status, facts: EMPTY_FACTS };
  }
  const bindings = defUse.bindings;

  // ── param bindings → param index (declaration order) ──────────────────────
  // `kind:'param'` bindings, ordered by declaration site (declLine/declColumn).
  const paramBindings = bindings
    .map((b, idx) => ({ b, idx }))
    .filter((e) => e.b.kind === 'param')
    .sort((a, b) => a.b.declLine - b.b.declLine || a.b.declColumn - b.b.declColumn);
  const paramIndexOf = new Map<number, number>();
  paramBindings.forEach((e, paramIdx) => paramIndexOf.set(e.idx, paramIdx));
  const paramCount = paramBindings.length;

  // ── return points: source block of every `return` CFG edge ────────────────
  // The M2 edge-kind invariant: a `return` edge's SOURCE block terminates in
  // the return jump, so its LAST statement is the `return <expr>` — its `uses`
  // are the returned bindings. (`return;` with no value has empty uses.)
  const returnUseStmtKeys = new Set<string>();
  for (const e of cfg.edges) {
    if (e.kind !== 'return') continue;
    const block = cfg.blocks[e.from];
    const stmts = block?.statements;
    if (!stmts || stmts.length === 0) continue;
    returnUseStmtKeys.add(`${e.from}:${stmts.length - 1}`);
  }

  // ── per-statement match context (sink/source/sanitizer by site) ───────────
  const sinkPosBySite = new Map<string, Map<number, Set<number>>>(); // stmtKey → site → argPositions
  const sinkKindByEntry = new Map<string, Map<number, SinkKind[]>>(); // stmtKey → site → kinds at any pos
  const sanitizerResultDefKinds = new Map<string, Map<number, SinkKind[]>>(); // stmtKey → resultDef binding → kinds
  for (const sm of matches.statements) {
    const stmtKey = `${sm.blockIndex}:${sm.statementIndex}`;
    if (sm.sinks.length > 0) {
      const bySite = new Map<number, Set<number>>();
      const kindBySite = new Map<number, SinkKind[]>();
      for (const sink of sm.sinks) {
        const pos = bySite.get(sink.siteIndex) ?? new Set<number>();
        for (const p of sink.argPositions) pos.add(p);
        bySite.set(sink.siteIndex, pos);
        const ks = kindBySite.get(sink.siteIndex) ?? [];
        ks.push(sink.entry.kind);
        kindBySite.set(sink.siteIndex, ks);
      }
      sinkPosBySite.set(stmtKey, bySite);
      sinkKindByEntry.set(stmtKey, kindBySite);
    }
    if (sm.sanitizers.length > 0) {
      const byDef = new Map<number, SinkKind[]>();
      for (const san of sm.sanitizers) {
        for (const d of san.resultDefs) {
          const ks = byDef.get(d) ?? [];
          ks.push(...san.entry.neutralizes);
          byDef.set(d, ks);
        }
      }
      sanitizerResultDefKinds.set(stmtKey, byDef);
    }
  }

  const stmtAt = (p: ProgramPoint) => cfg.blocks[p.blockIndex]?.statements?.[p.stmtIndex];

  // ── def→use index ─────────────────────────────────────────────────────────
  const factsByDef = new Map<string, { bindingIdx: number; use: ProgramPoint }[]>();
  for (const f of defUse.facts) {
    const key = `${f.bindingIdx}:${pointKey(f.def)}`;
    const list = factsByDef.get(key);
    const entry = { bindingIdx: f.bindingIdx, use: f.use };
    if (list) list.push(entry);
    else factsByDef.set(key, [entry]);
  }

  // ── accumulators (deduped by string identity) ─────────────────────────────
  const paramReturn = new Map<number, Set<SinkKind>>(); // param → neutralized intersection
  const paramReturnSeen = new Set<number>();
  const paramCallArg = new Map<string, ParamToCallArg>();
  const sourceCallArg = new Map<string, SourceToCallArg>();
  const paramSink = new Set<string>();
  const paramSinkOut: ParamToSink[] = [];
  const sourceReturn = new Set<SinkKind | 'remote-input'>();

  /** Record param→return, intersecting neutralized kinds across paths. */
  const recordReturn = (param: number, exclusions: ReadonlySet<SinkKind>): void => {
    if (!paramReturnSeen.has(param)) {
      paramReturnSeen.add(param);
      paramReturn.set(param, new Set(exclusions));
    } else {
      const cur = paramReturn.get(param) as Set<SinkKind>;
      for (const k of [...cur]) if (!exclusions.has(k)) cur.delete(k);
    }
  };

  // ── seeds: each param at its entry def point + each source statement ───────
  // seedId 0..paramCount-1 = params; -1 = source.
  const queue: SeedTaint[] = [];
  const visited = new Set<string>();
  const enqueue = (t: SeedTaint): void => {
    const key = `${t.seedId}:${t.bindingIdx}:${pointKey(t.point)}:${[...t.exclusions].sort().join(',')}`;
    if (visited.has(key)) return;
    visited.add(key);
    queue.push(t);
  };

  // Param seeds: find each param's def point(s) in the def→use facts (params are
  // defined at ENTRY; any fact whose def-binding is the param and whose def
  // sits in the entry block is a param-origin edge).
  for (const { idx } of paramBindings) {
    const paramIdx = paramIndexOf.get(idx) as number;
    // Seed at every def point of this param binding in the entry block.
    for (const f of defUse.facts) {
      if (f.bindingIdx === idx && f.def.blockIndex === cfg.entryIndex) {
        enqueue({ bindingIdx: idx, point: f.def, seedId: paramIdx, exclusions: new Set() });
      }
    }
  }

  // Source seeds: a statement with a matched source taints its own defs; a bare
  // `return <source>` is a direct source→return. The source's value rides the
  // statement's defs (resultDefs of the assignment) under the floor.
  for (const sm of matches.statements) {
    if (sm.sources.length === 0) continue;
    const stmtKey = `${sm.blockIndex}:${sm.statementIndex}`;
    const facts = cfg.blocks[sm.blockIndex]?.statements?.[sm.statementIndex];
    if (!facts) continue;
    const point: ProgramPoint = {
      blockIndex: sm.blockIndex,
      stmtIndex: sm.statementIndex,
      line: facts.line,
    };
    if (returnUseStmtKeys.has(stmtKey)) {
      for (const src of sm.sources) sourceReturn.add(src.entry.kind);
    }
    for (const d of [...facts.defs, ...(facts.mayDefs ?? [])]) {
      enqueue({ bindingIdx: d, point, seedId: -1, exclusions: new Set() });
    }
  }

  // ── forward reachability ──────────────────────────────────────────────────
  let head = 0;
  while (head < queue.length) {
    const t = queue[head++];
    const b = t.bindingIdx;
    for (const fact of factsByDef.get(`${b}:${pointKey(t.point)}`) ?? []) {
      const useStmt = stmtAt(fact.use);
      if (!useStmt) continue;
      const useKey = `${fact.use.blockIndex}:${fact.use.stmtIndex}`;

      // (1) return reach
      if (returnUseStmtKeys.has(useKey) && useStmt.uses.includes(b)) {
        if (t.seedId >= 0) recordReturn(t.seedId, t.exclusions);
        else sourceReturn.add('remote-input');
      }

      // (2) call-arg + sink reach: occurrences of b in this statement's sites.
      const sinkBySite = sinkPosBySite.get(useKey);
      const kindBySite = sinkKindByEntry.get(useKey);
      useStmt.sites?.forEach((site, siteIndex) => {
        const argHits = occurrencesInArgs(site, b);
        for (const argPos of argHits) {
          const callLine = useStmt.line;
          const tail = calleeTail(site.callee);
          if (t.seedId >= 0) {
            const caKey = `${t.seedId}:${callLine}:${argPos}:${tail ?? ''}`;
            if (!paramCallArg.has(caKey)) {
              paramCallArg.set(caKey, {
                param: t.seedId,
                callLine,
                argIndex: argPos,
                ...(tail ? { calleeName: tail } : {}),
              });
            }
          } else {
            // Source-seeded: a generated source flowing into a call argument is
            // a fixpoint SEED (it taints the callee's param). One source kind
            // today ('remote-input'); when more exist the seed must carry it.
            const scKey = `${callLine}:${argPos}:${tail ?? ''}`;
            if (!sourceCallArg.has(scKey)) {
              sourceCallArg.set(scKey, {
                sourceKind: 'remote-input',
                callLine,
                argIndex: argPos,
                ...(tail ? { calleeName: tail } : {}),
              });
            }
          }
          // matched sink at this position?
          const sinkPositions = sinkBySite?.get(siteIndex);
          if (sinkPositions?.has(argPos) && t.seedId >= 0) {
            for (const kind of kindBySite?.get(siteIndex) ?? []) {
              if (t.exclusions.has(kind)) continue;
              const sKey = `${t.seedId}:${kind}`;
              if (!paramSink.has(sKey)) {
                paramSink.add(sKey);
                paramSinkOut.push({ param: t.seedId, sinkKind: kind });
              }
            }
          }
        }
      });

      // (3) onward floor: this statement's defs become tainted, with sanitizer
      //     result-def exclusions accumulated.
      const sanByDef = sanitizerResultDefKinds.get(useKey);
      for (const d of [...useStmt.defs, ...(useStmt.mayDefs ?? [])]) {
        const added = sanByDef?.get(d);
        const exclusions =
          added && added.length > 0 ? new Set([...t.exclusions, ...added]) : t.exclusions;
        enqueue({
          bindingIdx: d,
          point: {
            blockIndex: fact.use.blockIndex,
            stmtIndex: fact.use.stmtIndex,
            line: useStmt.line,
          },
          seedId: t.seedId,
          exclusions,
        });
      }
    }
  }

  // ── deterministic assembly ────────────────────────────────────────────────
  const paramToReturn: ParamToReturn[] = [...paramReturn.entries()]
    .map(([param, kinds]) => ({
      param,
      ...(kinds.size > 0 ? { neutralized: sortKinds(kinds) } : {}),
    }))
    .sort((a, b) => a.param - b.param);

  const paramToCallArg = [...paramCallArg.values()].sort(
    (a, b) =>
      a.param - b.param ||
      a.callLine - b.callLine ||
      a.argIndex - b.argIndex ||
      (a.calleeName ?? '').localeCompare(b.calleeName ?? ''),
  );

  const paramToSink = paramSinkOut.sort(
    (a, b) =>
      a.param - b.param || (kindRank.get(a.sinkKind) ?? 99) - (kindRank.get(b.sinkKind) ?? 99),
  );

  const sourceToReturn: SourceToReturn[] =
    sourceReturn.size > 0 ? [{ sourceKind: 'remote-input' }] : [];

  const sourceToCallArg = [...sourceCallArg.values()].sort(
    (a, b) =>
      a.callLine - b.callLine ||
      a.argIndex - b.argIndex ||
      (a.calleeName ?? '').localeCompare(b.calleeName ?? ''),
  );

  return {
    status: 'computed',
    facts: {
      paramCount,
      paramToReturn,
      paramToCallArg,
      paramToSink,
      sourceToReturn,
      sourceToCallArg,
    },
  };
}

/** Argument positions where binding `b` occurs (direct or via a nested site). */
function occurrencesInArgs(site: SiteRecord, b: number): number[] {
  const hits: number[] = [];
  site.args?.forEach((entries, argPos) => {
    for (const e of entries) {
      if (typeof e === 'number') {
        if (e === b) hits.push(argPos);
      } else if (e[0] === b) {
        hits.push(argPos);
      }
    }
  });
  return hits;
}
