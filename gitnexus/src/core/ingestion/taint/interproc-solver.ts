/**
 * Interprocedural taint fixpoint (#2084 M4 U3).
 *
 * Composes per-function {@link FunctionSummary} objects over the resolved
 * `CALLS` graph to find source→sink flows that cross function and file
 * boundaries. PURE AND DETERMINISTIC (no graph, no I/O, no logger) — the phase
 * builds the inputs from `ctx.graph` and persists the outputs.
 *
 * ## The model — whole-parameter taint reachability
 *
 * The unit of taint is `(function, parameter)`. The fixpoint computes the set
 * of parameters that can hold source-derived data, then fires a finding
 * whenever a tainted parameter feeds a modelled sink (`paramToSink`).
 *
 * - **Seeds** — every `sourceToCallArg` edge: a function generates a source and
 *   passes it into argument `argIndex` of a call at `callLine`. Resolving that
 *   call site against the caller's outgoing `CALLS` edges yields the callee;
 *   the callee's parameter `argIndex` becomes tainted, with the generating
 *   function recorded as the flow's source.
 * - **Propagation** — every `paramToCallArg` edge of a function whose parameter
 *   is ALREADY tainted: `param i → arg j of callee` taints the callee's
 *   parameter `j` (TITO composition). Iterated to a fixpoint.
 * - **Findings** — whenever a parameter becomes tainted and the owning
 *   function's `paramToSink` contains that parameter, a cross-function finding
 *   is emitted (source function → sink function, with the kind).
 *
 * ## Cycle safety (recursion)
 *
 * The tainted-parameter set is monotone over a FINITE lattice (`Σ functions ×
 * params`), so the worklist fixpoint converges: a recursive or mutually
 * recursive call merely re-proposes an already-tainted parameter, which the
 * visited-set absorbs — no infinite descent. This is the functional/summary
 * method's standard termination argument (Sharir-Pnueli; Pysa, Mariana Trench,
 * and Infer all rely on it). SCC condensation would only refine the PROCESSING
 * ORDER; correctness and termination do not require it.
 *
 * ## Context-insensitivity & the name-join over-approximation
 *
 * One summary per function, applied at every call site — return/param merging
 * is accepted (the security-conservative direction). The call-arg→callee join
 * is by callee NAME (not line), so when one caller invokes two DISTINCT
 * same-named callees (`x.handler(src)` and `y.handler(clean)`), a source that
 * flowed into ONE of them taints BOTH callees' parameter — an extra finding on
 * the callee the source did not reach. This is sound (over-attribution, never a
 * missed flow — the conservative direction for a security tool) and is the
 * documented price of dropping the fragile line-based join; the `explain` tool
 * surfaces it ("may over-attribute among same-named callees"). Other known
 * precision losses (call-site conflation, shared dispatch, callbacks) are the
 * documented M4 trade-offs; refinements are deferred (plan KTD).
 */

import type { SinkKind } from './source-sink-config.js';
import type { FunctionSummary } from './summary-model.js';

/**
 * One resolved call edge from the `CALLS` graph. The join to a summary's
 * call-arg edge is by CALLEE NAME (the callee node's declared name), NOT by
 * call-site line — line-base parity between the CFG harvest (1-based) and the
 * reference site is fragile, while the callee identity is exact and the
 * context-insensitive model tatints the callee's parameter the same way at
 * every call site to it.
 */
export interface InterprocCallEdge {
  readonly callerId: string;
  readonly calleeId: string;
  /** The callee node's declared name (`helper`, `process`) — the join key. */
  readonly calleeName: string;
}

/** One hop of a cross-function flow: the function entered, and how. */
export interface InterprocHop {
  readonly fnId: string;
  /** The call-site line in the PREVIOUS function that entered this one. */
  readonly callLine?: number;
  /** Argument position the taint entered through (undefined for the source fn). */
  readonly argIndex?: number;
}

export interface InterprocFinding {
  readonly sourceFnId: string;
  readonly sinkFnId: string;
  readonly sinkKind: SinkKind;
  /** Ordered source→sink hop chain (functions). A prefix when `truncated`. */
  readonly hops: readonly InterprocHop[];
  readonly hopsTruncated: boolean;
}

export interface InterprocLimits {
  /** Max functions in a single flow's hop chain. `undefined`/0 ⇒ default 32. */
  readonly maxHops?: number;
  /** Max findings overall (post-dedup). `undefined`/0 ⇒ unlimited. */
  readonly maxFindings?: number;
}

export interface InterprocResult {
  readonly findings: readonly InterprocFinding[];
  /** Findings dropped by `maxFindings` (post-dedup). */
  readonly droppedFindings: number;
  /** Call edges whose call-site line matched no summary edge (diagnostics). */
  readonly unmatchedCallSites: number;
}

export const DEFAULT_MAX_INTERPROC_HOPS = 32;

/**
 * Default per-run cap on cross-function findings (#2084 review P1-3). Like the
 * other pdg caps it is resolved into `RepoMeta.pdg` so `pdgModeMismatch`
 * stamps it; `0` ⇒ unlimited. 2000 is generous for a real repo — more deduped
 * `(source, sink, kind)` findings than that is a fixture or a runaway fan-in,
 * and the overflow is deterministic + counted (`droppedFindings`).
 */
export const DEFAULT_PDG_MAX_INTERPROC_FINDINGS = 2000;

/** A tainted parameter, with the flow that first tainted it (for path reconstruction). */
interface TaintedParam {
  readonly fnId: string;
  readonly paramIndex: number;
  readonly sourceFnId: string;
  /** Hop chain from source to this `(fnId, paramIndex)` entry. */
  readonly hops: readonly InterprocHop[];
  readonly truncated: boolean;
  /**
   * Sink kinds neutralised on the composed path to here (#2084 review P1-2) —
   * UNION along the hop chain (a sanitizer at any upstream call-arg stays
   * neutralised downstream). A `paramToSink` of a kind in this set does NOT
   * fire (the cross-function sanitizer). Mutable in spirit: on revisit by a
   * less-neutralised path the stored set INTERSECTS (mirrors `propagate.ts`).
   */
  readonly neutralized: ReadonlySet<SinkKind>;
}

/**
 * Taint-state key — `(function, parameter, SOURCE)`. The source discriminator
 * is load-bearing: without it, a parameter tainted by source A is marked
 * visited and a later flow from source B to the SAME parameter is dropped
 * before it can fire that function's sink, silently losing B→sink (the
 * multi-source collapse — the recurring M3 bug class). Including the source
 * keeps each origin's flow independent; the lattice stays finite (`fn × param ×
 * source`), so the monotone worklist still terminates and is cycle-safe.
 */
const pkey = (fnId: string, param: number, sourceFnId: string): string =>
  `${fnId}#${param}#${sourceFnId}`;

/**
 * Run the interprocedural taint fixpoint. `summaries` is keyed by function node
 * id; `callEdges` is the resolved `CALLS` graph (caller→callee with call-site
 * lines). Deterministic: inputs in, sorted findings out.
 */
export function solveInterprocTaint(
  summaries: ReadonlyMap<string, FunctionSummary>,
  callEdges: readonly InterprocCallEdge[],
  limits?: InterprocLimits,
): InterprocResult {
  const maxHops =
    limits?.maxHops && limits.maxHops > 0 ? limits.maxHops : DEFAULT_MAX_INTERPROC_HOPS;

  // Adjacency: callerId → outgoing call edges. The summary's call-arg edges
  // resolve against this by callee NAME.
  const callsByCaller = new Map<string, InterprocCallEdge[]>();
  for (const e of callEdges) {
    const list = callsByCaller.get(e.callerId);
    if (list) list.push(e);
    else callsByCaller.set(e.callerId, [e]);
  }
  let unmatchedCallSites = 0;

  // Resolve a caller's call-arg edge (by callee name) to concrete callee edges.
  // An unknown callee name (chain not statically resolvable) conservatively
  // matches EVERY outgoing call — sound over-approximation (may over-taint).
  const resolveCallees = (
    callerId: string,
    calleeName: string | undefined,
  ): InterprocCallEdge[] => {
    const candidates = callsByCaller.get(callerId);
    if (!candidates || candidates.length === 0) {
      unmatchedCallSites++;
      return [];
    }
    if (calleeName === undefined) return candidates;
    const named = candidates.filter((c) => c.calleeName === calleeName);
    if (named.length === 0) {
      unmatchedCallSites++;
      return [];
    }
    return named;
  };

  // ── findings + worklist ───────────────────────────────────────────────────
  const findingsByKey = new Map<string, InterprocFinding>();
  const tainted = new Map<string, TaintedParam>();
  const queue: TaintedParam[] = [];

  const recordFinding = (
    sourceFnId: string,
    sinkFnId: string,
    sinkKind: SinkKind,
    hops: readonly InterprocHop[],
    truncated: boolean,
  ): void => {
    const key = `${sourceFnId}|${sinkFnId}|${sinkKind}`;
    if (findingsByKey.has(key)) return;
    findingsByKey.set(key, { sourceFnId, sinkFnId, sinkKind, hops, hopsTruncated: truncated });
  };

  /** Fire every `paramToSink` of `tp`'s param, except kinds it neutralised. */
  const fireSinks = (tp: TaintedParam): void => {
    const summary = summaries.get(tp.fnId);
    if (!summary) return;
    for (const ps of summary.paramToSink) {
      if (ps.param !== tp.paramIndex) continue;
      if (tp.neutralized.has(ps.sinkKind)) continue; // sanitised across the boundary (P1-2)
      // `tp.hops` already terminates at this (tainted) function — it IS the
      // source→sink chain, no extra hop to append.
      recordFinding(tp.sourceFnId, tp.fnId, ps.sinkKind, tp.hops, tp.truncated);
    }
  };

  /**
   * Mark (fnId, paramIndex, source) tainted; enqueue. On a fresh key, taint +
   * fire sinks. On revisit, INTERSECT the neutralised set (a kind stays
   * neutralised only if EVERY path neutralises it — the sound direction); if it
   * shrank, re-enqueue + re-fire so a less-neutralised path's sinks surface
   * (the shrink-reprocess guard, mirroring `propagate.ts:deriveTaint`). Without
   * it, a first more-neutralised path would freeze out a real finding (FN).
   */
  const taint = (tp: TaintedParam): void => {
    const key = pkey(tp.fnId, tp.paramIndex, tp.sourceFnId);
    const existing = tainted.get(key);
    if (existing) {
      const inter = new Set<SinkKind>();
      for (const k of existing.neutralized) if (tp.neutralized.has(k)) inter.add(k);
      if (inter.size >= existing.neutralized.size) return; // no shrink — cycle-safe
      const merged: TaintedParam = { ...existing, neutralized: inter };
      tainted.set(key, merged);
      queue.push(merged);
      fireSinks(merged);
      return;
    }
    tainted.set(key, tp);
    queue.push(tp);
    fireSinks(tp);
  };

  // ── seeds: every source→callee-arg, resolved against CALLS ────────────────
  for (const [callerId, summary] of summaries) {
    for (const sc of summary.sourceToCallArg) {
      for (const edge of resolveCallees(callerId, sc.calleeName)) {
        const callee = summaries.get(edge.calleeId);
        if (!callee) continue;
        if (sc.argIndex >= callee.paramCount) continue; // arity guard
        const hops: InterprocHop[] = [
          { fnId: callerId },
          { fnId: edge.calleeId, callLine: sc.callLine, argIndex: sc.argIndex },
        ];
        taint({
          fnId: edge.calleeId,
          paramIndex: sc.argIndex,
          sourceFnId: callerId,
          hops,
          truncated: hops.length > maxHops,
          neutralized: new Set(sc.neutralized ?? []),
        });
      }
    }
  }

  // ── propagation worklist ──────────────────────────────────────────────────
  let head = 0;
  while (head < queue.length) {
    const tp = queue[head++];
    const summary = summaries.get(tp.fnId);
    if (!summary) continue;
    // This function's tainted param flows into callee args via paramToCallArg.
    for (const pc of summary.paramToCallArg) {
      if (pc.param !== tp.paramIndex) continue;
      for (const edge of resolveCallees(tp.fnId, pc.calleeName)) {
        const callee = summaries.get(edge.calleeId);
        if (!callee) continue;
        if (pc.argIndex >= callee.paramCount) continue;
        const next = appendHop(
          tp.hops,
          { fnId: edge.calleeId, callLine: pc.callLine, argIndex: pc.argIndex },
          maxHops,
        );
        // Union the edge's neutralised kinds onto the composed path (a
        // sanitizer between this param and the callee arg stays neutralised).
        const neutralized =
          pc.neutralized && pc.neutralized.length > 0
            ? new Set<SinkKind>([...tp.neutralized, ...pc.neutralized])
            : tp.neutralized;
        taint({
          fnId: edge.calleeId,
          paramIndex: pc.argIndex,
          sourceFnId: tp.sourceFnId,
          hops: next.hops,
          truncated: tp.truncated || next.truncated,
          neutralized,
        });
      }
    }
  }

  // ── deterministic assembly ────────────────────────────────────────────────
  const all = [...findingsByKey.values()].sort(
    (a, b) =>
      a.sourceFnId.localeCompare(b.sourceFnId) ||
      a.sinkFnId.localeCompare(b.sinkFnId) ||
      a.sinkKind.localeCompare(b.sinkKind),
  );
  const maxFindings = limits?.maxFindings && limits.maxFindings > 0 ? limits.maxFindings : Infinity;
  const findings = all.length > maxFindings ? all.slice(0, maxFindings) : all;

  return {
    findings,
    droppedFindings: all.length - findings.length,
    unmatchedCallSites,
  };
}

/** Append a hop, respecting the hop cap (keeps the source-side prefix). */
function appendHop(
  hops: readonly InterprocHop[],
  hop: InterprocHop,
  maxHops: number,
): { hops: readonly InterprocHop[]; truncated: boolean } {
  if (hops.length >= maxHops) return { hops, truncated: true };
  return { hops: [...hops, hop], truncated: hops.length + 1 > maxHops };
}
