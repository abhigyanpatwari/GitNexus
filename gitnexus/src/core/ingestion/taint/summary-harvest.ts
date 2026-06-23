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
 *
 * ## Known limitation — destructured / rest params (documented FN)
 *
 * Param indices are assigned by ORDINAL over the flattened param-binding list,
 * which equals the FORMAL parameter position only when every param is a simple
 * identifier. A destructured or rest param contributes several bindings (or
 * shifts the count), so a simple param positioned AFTER one
 * (`function f([a, b], x) { sink(x) }`) gets a summary port index that does not
 * match the formal argument position the interprocedural solver joins against
 * — a cross-function false negative for that function. The precise fix needs a
 * formal-param index threaded from the worker harvest (`BindingEntry`), a
 * cache-namespace-affecting change deferred with the other documented FN
 * classes (closures, fields — see the taint skill). Functions with all-simple
 * params (the common case) are unaffected.
 */

import type { FunctionCfg, SiteRecord } from '../cfg/types.js';
import { pointKey, type FunctionDefUse, type ProgramPoint } from '../cfg/reaching-defs.js';
import type { FunctionSiteMatches } from './match.js';
import { sinkKindRank, sortSinkKinds, type SinkKind } from './source-sink-config.js';
import type {
  CallResult,
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
  readonly callResults: readonly CallResult[];
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
  callResults: [],
};

/** Last segment of a dotted callee path (`child_process.exec` ⇒ `exec`). */
const calleeTail = (callee: string | undefined): string | undefined =>
  callee === undefined ? undefined : (callee.split('.').pop() ?? callee);

/** A tainted binding flowing forward, tagged with the seed it came from. */
interface SeedTaint {
  readonly bindingIdx: number;
  readonly point: ProgramPoint;
  /** Param index (≥0), or -1 for a source seed, or -2 for a call-result seed. */
  readonly seedId: number;
  /** Sink kinds neutralised on the path to here (monotone over the floor). */
  readonly exclusions: ReadonlySet<SinkKind>;
  /** For a call-result seed (#2084 review P1-1): the user function whose RESULT
   *  this taint flows from. When set, reaches record {@link CallResult} edges. */
  readonly originCallee?: string;
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
  // Matched sink/sanitizer sites (`stmtKey:siteIndex`) — EXCLUDED from the
  // call-result seed (#2084 review P1-1): their result semantics are already
  // modelled (a sanitizer's result rides U2 exclusions; a sink returns void).
  const modeledSites = new Set<string>();
  for (const sm of matches.statements) {
    const stmtKey = `${sm.blockIndex}:${sm.statementIndex}`;
    for (const s of sm.sinks) modeledSites.add(`${stmtKey}:${s.siteIndex}`);
    for (const s of sm.sanitizers) modeledSites.add(`${stmtKey}:${s.siteIndex}`);
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
  // Intersection-over-paths of the neutralized kinds reaching each call-arg
  // edge (#2084 review P1-2, deepening correction a). MUST intersect, not
  // first-write-wins: a second, un-sanitized occurrence path to the same edge
  // (`relay(x){ exec(x); exec(escape(x)); }`) shrinks the set to ∅ — mirror
  // `recordReturn`. `*Seen` tracks first-write so the initial set is a copy.
  const paramCallArgKinds = new Map<string, Set<SinkKind>>();
  const sourceCallArgKinds = new Map<string, Set<SinkKind>>();
  const intersectKinds = (
    store: Map<string, Set<SinkKind>>,
    key: string,
    incoming: ReadonlySet<SinkKind>,
  ): void => {
    const cur = store.get(key);
    if (cur === undefined) store.set(key, new Set(incoming));
    else for (const k of [...cur]) if (!incoming.has(k)) cur.delete(k);
  };
  const paramSink = new Set<string>();
  const paramSinkOut: ParamToSink[] = [];
  const sourceReturn = new Set<SinkKind | 'remote-input'>();
  // Caller-side call-result flows (#2084 review P1-1), deduped by a structural key.
  const callResults = new Map<string, CallResult>();
  const recordCallResult = (cr: CallResult): void => {
    const d = cr.dest;
    const destKey =
      d.to === 'sink'
        ? `sink:${d.sinkKind}`
        : d.to === 'return'
          ? 'return'
          : `arg:${d.toCallee ?? ''}:${d.argIndex}`;
    const key = `${cr.calleeName}|${destKey}`;
    if (!callResults.has(key)) callResults.set(key, cr);
  };

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
    // originCallee discriminates call-result seeds (all share seedId -2) so two
    // distinct callees' results on the same binding are not collapsed.
    const key = `${t.seedId}:${t.originCallee ?? ''}:${t.bindingIdx}:${pointKey(t.point)}:${[...t.exclusions].sort().join(',')}`;
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
    const memberSources = sm.sources.filter((src) => src.type === 'member-read');
    if (returnUseStmtKeys.has(stmtKey)) {
      for (const src of memberSources) sourceReturn.add(src.entry.kind);
    }
    if (memberSources.length > 0) {
      for (const d of [...facts.defs, ...(facts.mayDefs ?? [])]) {
        enqueue({ bindingIdx: d, point, seedId: -1, exclusions: new Set() });
      }
    }
    for (const src of sm.sources) {
      if (src.type !== 'call-result') continue;
      for (const d of src.resultDefs) {
        enqueue({ bindingIdx: d, point, seedId: -1, exclusions: new Set() });
      }
    }
    // DIRECT source-in-call-arg (`runIt(req.body)`): no intermediate binding is
    // defined, so the floor seed above records nothing. Climb the source
    // member-read's `parent` chain — each enclosing call/new site is a
    // `sourceToCallArg` (the cross-function fixpoint seed). A sink ancestor is
    // M3's intra-procedural concern and harmless to also record here.
    for (const src of memberSources) {
      let cur: SiteRecord | undefined = facts.sites?.[src.siteIndex];
      const guard = new Set<number>([src.siteIndex]);
      while (cur?.parent) {
        const [siteIdx, argPos] = cur.parent;
        if (guard.has(siteIdx)) break;
        guard.add(siteIdx);
        const ancestor = facts.sites?.[siteIdx];
        if (!ancestor) break;
        if (ancestor.kind === 'call' || ancestor.kind === 'new') {
          const tail = calleeTail(ancestor.callee);
          const scKey = `${facts.line}:${argPos}:${tail ?? ''}`;
          if (!sourceCallArg.has(scKey)) {
            sourceCallArg.set(scKey, {
              sourceKind: src.entry.kind,
              callLine: facts.line,
              argIndex: argPos,
              ...(tail ? { calleeName: tail } : {}),
            });
          }
        }
        cur = ancestor;
      }
    }
  }

  // Call-result seeds (#2084 review P1-1): a call to a (potentially generative)
  // USER function is a NEW taint origin — `matchFunctionSites` only sources
  // member-reads, so the result of `getInput()` is invisible today. Seed every
  // call/new site that is NOT a matched sink/sanitizer and carries a resolvable
  // callee name; the worklist then records a CallResult edge when the result
  // reaches a sink / return / another call arg. The fixpoint composes it with
  // the callee's `sourceToReturn` (the floor cannot — the source is in the
  // callee, so the caller passes no tainted input).
  //
  // Documented limitation: a result passed DIRECTLY into a modelled sink with
  // no binding (`exec(getInput())`) is not recorded as `dest:sink` — the sink
  // is occurrence-gated by `matchFunctionSites` and a bare call result is not a
  // binding occurrence, so `exec` reads as a plain call (recorded `dest:callArg`
  // to a callee with no summary → uncomposed). The binding form
  // (`const t = getInput(); exec(t)`) is the supported path.
  for (const block of cfg.blocks) {
    block.statements?.forEach((facts, stmtIdx) => {
      const stmtKey = `${block.index}:${stmtIdx}`;
      const point: ProgramPoint = { blockIndex: block.index, stmtIndex: stmtIdx, line: facts.line };
      facts.sites?.forEach((site, siteIndex) => {
        if (site.kind !== 'call' && site.kind !== 'new') return;
        if (modeledSites.has(`${stmtKey}:${siteIndex}`)) return; // sink/sanitizer — modelled
        const tail = calleeTail(site.callee);
        if (tail === undefined) return; // unresolvable callee — cannot compose
        // Binding case (`const t = getInput(); …`): seed the result bindings.
        for (const d of site.resultDefs ?? []) {
          enqueue({ bindingIdx: d, point, seedId: -2, exclusions: new Set(), originCallee: tail });
        }
        // Direct case (`exec(getInput())` / `return getInput()`): no result
        // binding — climb the call's parent chain (or detect a bare return).
        if ((site.resultDefs?.length ?? 0) === 0) {
          if (site.parent === undefined && returnUseStmtKeys.has(stmtKey)) {
            recordCallResult({ calleeName: tail, dest: { to: 'return' } });
          }
          let cur: SiteRecord | undefined = site;
          const guard = new Set<number>([siteIndex]);
          while (cur?.parent) {
            const [ancIdx, argPos] = cur.parent;
            if (guard.has(ancIdx)) break;
            guard.add(ancIdx);
            const ancestor = facts.sites?.[ancIdx];
            if (!ancestor) break;
            const ancKey = `${stmtKey}:${ancIdx}`;
            const sinkPositions = sinkPosBySite.get(stmtKey)?.get(ancIdx);
            if (sinkPositions?.has(argPos)) {
              for (const kind of sinkKindByEntry.get(stmtKey)?.get(ancIdx) ?? []) {
                recordCallResult({ calleeName: tail, dest: { to: 'sink', sinkKind: kind } });
              }
            } else if (
              !modeledSites.has(ancKey) &&
              (ancestor.kind === 'call' || ancestor.kind === 'new')
            ) {
              recordCallResult({
                calleeName: tail,
                dest: {
                  to: 'callArg',
                  ...(calleeTail(ancestor.callee) ? { toCallee: calleeTail(ancestor.callee) } : {}),
                  argIndex: argPos,
                },
              });
            }
            cur = ancestor;
          }
        }
      });
    });
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
        if (t.originCallee !== undefined) {
          recordCallResult({ calleeName: t.originCallee, dest: { to: 'return' } });
        } else if (t.seedId >= 0) recordReturn(t.seedId, t.exclusions);
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
          if (t.originCallee !== undefined) {
            // Call-result seed (#2084 review P1-1): the result of a call to
            // `originCallee` flows into THIS call's arg `argPos`.
            recordCallResult({
              calleeName: t.originCallee,
              dest: { to: 'callArg', ...(tail ? { toCallee: tail } : {}), argIndex: argPos },
            });
          } else if (t.seedId >= 0) {
            const caKey = `${t.seedId}:${callLine}:${argPos}:${tail ?? ''}`;
            if (!paramCallArg.has(caKey)) {
              paramCallArg.set(caKey, {
                param: t.seedId,
                callLine,
                argIndex: argPos,
                ...(tail ? { calleeName: tail } : {}),
              });
            }
            // Carry the sanitizer exclusions on the path INTO this call arg,
            // intersected over occurrence paths (P1-2).
            intersectKinds(paramCallArgKinds, caKey, t.exclusions);
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
            intersectKinds(sourceCallArgKinds, scKey, t.exclusions);
          }
          // matched sink at this position?
          const sinkPositions = sinkBySite?.get(siteIndex);
          if (sinkPositions?.has(argPos)) {
            for (const kind of kindBySite?.get(siteIndex) ?? []) {
              if (t.exclusions.has(kind)) continue;
              if (t.originCallee !== undefined) {
                // A generated source returned by `originCallee` reaches a sink.
                recordCallResult({
                  calleeName: t.originCallee,
                  dest: { to: 'sink', sinkKind: kind },
                });
              } else if (t.seedId >= 0) {
                const sKey = `${t.seedId}:${kind}`;
                if (!paramSink.has(sKey)) {
                  paramSink.add(sKey);
                  paramSinkOut.push({ param: t.seedId, sinkKind: kind });
                }
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
          ...(t.originCallee !== undefined ? { originCallee: t.originCallee } : {}),
        });
      }
    }
  }

  // ── deterministic assembly ────────────────────────────────────────────────
  const paramToReturn: ParamToReturn[] = [...paramReturn.entries()]
    .map(([param, kinds]) => ({
      param,
      ...(kinds.size > 0 ? { neutralized: sortSinkKinds(kinds) } : {}),
    }))
    .sort((a, b) => a.param - b.param);

  const paramToCallArg = [...paramCallArg.entries()]
    .map(([key, edge]) => {
      const kinds = paramCallArgKinds.get(key);
      return kinds && kinds.size > 0 ? { ...edge, neutralized: sortSinkKinds(kinds) } : edge;
    })
    .sort(
      (a, b) =>
        a.param - b.param ||
        a.callLine - b.callLine ||
        a.argIndex - b.argIndex ||
        (a.calleeName ?? '').localeCompare(b.calleeName ?? ''),
    );

  const paramToSink = paramSinkOut.sort(
    (a, b) => a.param - b.param || sinkKindRank(a.sinkKind) - sinkKindRank(b.sinkKind),
  );

  const sourceToReturn: SourceToReturn[] =
    sourceReturn.size > 0 ? [{ sourceKind: 'remote-input' }] : [];

  const sourceToCallArg = [...sourceCallArg.entries()]
    .map(([key, edge]) => {
      const kinds = sourceCallArgKinds.get(key);
      return kinds && kinds.size > 0 ? { ...edge, neutralized: sortSinkKinds(kinds) } : edge;
    })
    .sort(
      (a, b) =>
        a.callLine - b.callLine ||
        a.argIndex - b.argIndex ||
        (a.calleeName ?? '').localeCompare(b.calleeName ?? ''),
    );

  const callResultsOut = [...callResults.values()].sort((a, b) => {
    const ord = (cr: CallResult): string => {
      const d = cr.dest;
      const dest =
        d.to === 'sink'
          ? `1sink:${d.sinkKind}`
          : d.to === 'return'
            ? '2return'
            : `0arg:${d.toCallee ?? ''}:${d.argIndex}`;
      return `${cr.calleeName}|${dest}`;
    };
    return ord(a).localeCompare(ord(b));
  });

  return {
    status: 'computed',
    facts: {
      paramCount,
      paramToReturn,
      paramToCallArg,
      paramToSink,
      sourceToReturn,
      sourceToCallArg,
      callResults: callResultsOut,
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
