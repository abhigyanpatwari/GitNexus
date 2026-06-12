/**
 * Per-function taint SUMMARY model (#2084 M4 U2).
 *
 * A {@link FunctionSummary} is the compact, context-insensitive abstraction of
 * one function's taint behaviour — the input to the interprocedural fixpoint
 * (`interproc-solver.ts`). It is the GitNexus analogue of Pysa's `.pysa`
 * models, Mariana Trench's "propagations", and CodeQL Models-as-Data summary
 * rows: a function is reduced to how taint enters (params / generated sources),
 * how it moves through (param→return, param→callee-arg), and where it lands
 * (param→sink). The fixpoint composes these across resolved `CALLS` edges so a
 * source in one function reaches a sink in another.
 *
 * ## Why summaries (not whole-program IFDS)
 *
 * The functional/summary method (Sharir-Pnueli 1981) analyses each function
 * ONCE and propagates the result over the call graph — the same shape Pysa,
 * Mariana Trench, and Infer use in production. GitNexus already resolves the
 * call graph (`CALLS` edges carry final node ids), so the summary IS the only
 * new artifact; propagation is graph reachability over a finite lattice.
 *
 * ## Granularity (first cut)
 *
 * WHOLE-PARAMETER. Ports are `param i`, `return`, and `receiver` — no field
 * access paths (`arg0.field.sub`). Field sensitivity, callback-parameter ports
 * (`Argument[0].Parameter[0]`), and context sensitivity are deferred (plan
 * KTD; the largest JS/TS FN class — closures — stays a documented gap).
 *
 * ## Plain-data discipline
 *
 * A summary is a JSON-plain value type (no functions, class instances, Maps, or
 * Symbols) so it survives `RunScopeResolutionStats` → `ScopeResolutionOutput`
 * threading and any future worker/cache boundary unchanged — the same
 * `Cloneable` constraint the CFG side channel obeys.
 */

import type { SinkKind, SourceKind } from './source-sink-config.js';

/**
 * Source-relative parameter index (0-based, in declaration order). A
 * function's first parameter is `0`. Destructured / rest params map each bound
 * name to the index of the formal parameter that introduced it (so
 * `function f([a, b]) {}` binds both `a` and `b` to param `0`).
 */
export type ParamIndex = number;

/**
 * `param i` flows into argument `argIndex` of a call at source line `callLine`.
 * The interprocedural solver joins this to the caller's outgoing `CALLS` edges
 * by CALLEE NAME (`calleeName`) — NOT by `callLine` — because line-base parity
 * between the CFG harvest (1-based) and the resolved reference site is fragile,
 * while the callee identity is exact. It then applies the callee's summary at
 * port `param argIndex`. This is the TITO ("taint-in-taint-out") propagation
 * edge — a param laundered into a callee, the callee's behaviour deciding what
 * happens next.
 *
 * `calleeName` is the site's dotted-callee tail (best-effort); absent when the
 * callee chain was not statically resolvable, in which case the solver
 * conservatively matches every outgoing call (sound over-approximation).
 * `callLine` is the 1-based statement line as harvested (`StatementFacts.line`)
 * — carried for hop display and as a TIE-BREAKER among several same-named
 * callees of one caller, never as the primary join key.
 */
export interface ParamToCallArg {
  readonly param: ParamIndex;
  readonly callLine: number;
  readonly argIndex: number;
  readonly calleeName?: string;
  /**
   * Sink kinds neutralised on EVERY harvested path from the param to this call
   * argument (intersection-over-paths, #2084 review P1-2). A sanitizer between
   * the param and the callee arg (`relay(x){ const y=escape(x); sinkFn(y); }`)
   * must carry across the boundary so the callee's `paramToSink` of a
   * neutralised kind does not fire (the cross-function false positive). Absent
   * means none neutralised.
   */
  readonly neutralized?: readonly SinkKind[];
}

/**
 * `param i` flows to the function's return value (a `return <expr>` use).
 *
 * RESERVED — not yet consumed by the fixpoint (#2084 review P1-1). The M3
 * statement-level floor already treats every call as propagate-through, so it
 * taints a callee's RESULT whenever the caller passes tainted input; param→
 * return recall is therefore already covered, and consuming `paramToReturn`
 * would only add PRECISION (avoiding the floor's over-approximation for
 * functions that don't actually return their param) — a larger refactor
 * deferred. Harvested + version-stamped so the precision pass can land without
 * a cache-namespace bump.
 */
export interface ParamToReturn {
  readonly param: ParamIndex;
  /** Sink kinds neutralised on EVERY path param→return (intersection). */
  readonly neutralized?: readonly SinkKind[];
}

/** `param i` reaches a modelled sink of kind `sinkKind` inside this function. */
export interface ParamToSink {
  readonly param: ParamIndex;
  readonly sinkKind: SinkKind;
}

/**
 * The function itself GENERATES a source (a modelled source read, e.g.
 * `req.body`) that reaches its return value — calling it yields tainted data
 * with no tainted input required. The generative analogue of Pysa's
 * `TaintSource[...]` return model. CONSUMED by the fixpoint via the caller's
 * {@link CallResult} edges (#2084 review P1-1): a caller that uses such a
 * function's result composes this into a finding/propagation. This is the
 * genuinely-additive recall the floor cannot cover (the source is inside the
 * callee — the caller passes no tainted input for the floor to propagate).
 */
export interface SourceToReturn {
  readonly sourceKind: SourceKind;
}

/**
 * What a user-function call's RESULT flows into, in the CALLER (#2084 review
 * P1-1). Recorded when a call to a (potentially generative) user function has
 * its return value used by the caller. The fixpoint composes it with the
 * callee's {@link SourceToReturn}: if the callee returns a generated source,
 * the caller's downstream use of the result is tainted.
 */
export type CallResultDest =
  | { readonly to: 'sink'; readonly sinkKind: SinkKind }
  | { readonly to: 'return' }
  | { readonly to: 'callArg'; readonly toCallee?: string; readonly argIndex: ParamIndex };

/** The result of a call to `calleeName` flows to `dest` in this function. */
export interface CallResult {
  readonly calleeName: string;
  readonly dest: CallResultDest;
}

/**
 * A modelled source generated in this function flows into argument `argIndex`
 * of a call at `callLine`. This SEEDS the interprocedural fixpoint: the source
 * taints the callee's parameter, which the callee's summary then carries to a
 * sink (one or more hops away). The cross-function analogue of an intra-
 * procedural `source → sink` partial flow whose sink lives in the callee.
 */
export interface SourceToCallArg {
  readonly sourceKind: SourceKind;
  /** Carried for hop display + same-name tie-break; NOT the join key (see
   *  {@link ParamToCallArg} — the solver joins by `calleeName`). */
  readonly callLine: number;
  readonly argIndex: number;
  readonly calleeName?: string;
  /** Sink kinds neutralised on EVERY path from the generated source to this
   *  call argument (intersection; #2084 review P1-2 — see {@link ParamToCallArg}). */
  readonly neutralized?: readonly SinkKind[];
}

/**
 * The compact taint abstraction of one function. All arrays are deterministically
 * sorted by the harvester and deduped, so two structurally-equal summaries
 * serialise identically (the {@link summaryVersion} contract).
 */
export interface FunctionSummary {
  /** The resolved `Function`/`Method` graph node id this summary describes. */
  readonly fnId: string;
  /** Repo-relative source path (carried for diagnostics + the join debug). */
  readonly filePath: string;
  /** 1-based function start line (mirrors `FunctionCfg.functionStartLine`). */
  readonly startLine: number;
  /** Number of declared formal parameters (port arity). */
  readonly paramCount: number;
  /** param→return TITO edges. */
  readonly paramToReturn: readonly ParamToReturn[];
  /** param→callee-arg TITO edges (composed across `CALLS` in the fixpoint). */
  readonly paramToCallArg: readonly ParamToCallArg[];
  /** param→sink partial flows (a source reaching this param triggers a finding). */
  readonly paramToSink: readonly ParamToSink[];
  /** Generative source→return models. */
  readonly sourceToReturn: readonly SourceToReturn[];
  /** Generative source→callee-arg seeds (fixpoint entry points). */
  readonly sourceToCallArg: readonly SourceToCallArg[];
  /** Caller-side call-result flows — compose with callee `sourceToReturn`. */
  readonly callResults: readonly CallResult[];
  /**
   * Content version stamp — `hash(own-facts ∪ sorted callee versions)`. The
   * incremental cache key (Infer's content-keyed summary): equal across two
   * runs iff the function's own taint facts AND every callee summary it depends
   * on are unchanged. NOTE (#2084 review P1-1): callee-version composition is
   * RESERVED — the harvester stamps the own-facts portion only
   * ({@link ownFactsDigest}); the fixpoint does not yet recompose it.
   */
  readonly version: string;
}

/** Stable FNV-1a 32-bit hash → 8-char hex. Pure, deterministic, no deps. */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts (avoids BigInt; stays in int32 land).
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Deterministic digest of a summary's OWN taint facts (everything except
 * `version`, which is derived). Order-independent within each edge category —
 * the harvester already sorts, but the digest re-canonicalises so a reordering
 * never changes the stamp. Used as the leaf of {@link summaryVersion}.
 */
export function ownFactsDigest(
  s: Pick<
    FunctionSummary,
    | 'paramCount'
    | 'paramToReturn'
    | 'paramToCallArg'
    | 'paramToSink'
    | 'sourceToReturn'
    | 'sourceToCallArg'
    | 'callResults'
  >,
): string {
  const parts: string[] = [`p${s.paramCount}`];
  parts.push(
    ...s.paramToReturn
      .map((r) => `r:${r.param}:${[...(r.neutralized ?? [])].sort().join(',')}`)
      .sort(),
  );
  parts.push(
    ...s.paramToCallArg
      .map(
        (c) =>
          `c:${c.param}:${c.callLine}:${c.argIndex}:${c.calleeName ?? ''}:${[...(c.neutralized ?? [])].sort().join(',')}`,
      )
      .sort(),
  );
  parts.push(...s.paramToSink.map((k) => `k:${k.param}:${k.sinkKind}`).sort());
  parts.push(...s.sourceToReturn.map((g) => `g:${g.sourceKind}`).sort());
  parts.push(
    ...s.sourceToCallArg
      .map(
        (g) =>
          `s:${g.sourceKind}:${g.callLine}:${g.argIndex}:${g.calleeName ?? ''}:${[...(g.neutralized ?? [])].sort().join(',')}`,
      )
      .sort(),
  );
  parts.push(
    ...s.callResults
      .map((cr) => {
        const d = cr.dest;
        const dest =
          d.to === 'sink'
            ? `sink:${d.sinkKind}`
            : d.to === 'return'
              ? 'return'
              : `arg:${d.toCallee ?? ''}:${d.argIndex}`;
        return `cr:${cr.calleeName}:${dest}`;
      })
      .sort(),
  );
  return fnv1a(parts.join('|'));
}

/**
 * Content version stamp for a summary: `hash(ownFactsDigest ∪ sorted callee
 * versions)`. Order-independent over callee versions (sorted). Equal iff the
 * function's own facts AND every callee dependency are unchanged — this is the
 * incremental invalidation primitive (a changed callee changes its version,
 * which changes every transitive caller's version).
 */
export function summaryVersion(ownDigest: string, calleeVersions: readonly string[]): string {
  return fnv1a(`${ownDigest}#${[...calleeVersions].sort().join(',')}`);
}
