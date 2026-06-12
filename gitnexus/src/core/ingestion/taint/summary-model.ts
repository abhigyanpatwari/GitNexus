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
 * The interprocedural solver matches `(callLine, argIndex)` against the
 * caller's outgoing `CALLS` edges (whose ids embed the call-site line) to find
 * the callee, then applies the callee's summary at port `param argIndex`. This
 * is the TITO ("taint-in-taint-out") propagation edge — a param laundered into
 * a callee, the callee's behaviour deciding what happens next.
 *
 * `callLine` is the 1-based statement line as harvested (`StatementFacts.line`);
 * the solver normalises it against the `CALLS` edge line base when matching.
 * `calleeName` is the site's dotted-callee tail (best-effort) — a secondary
 * disambiguator when several calls share a line; absent when the callee chain
 * was not statically resolvable.
 */
export interface ParamToCallArg {
  readonly param: ParamIndex;
  readonly callLine: number;
  readonly argIndex: number;
  readonly calleeName?: string;
}

/** `param i` flows to the function's return value (a `return <expr>` use). */
export interface ParamToReturn {
  readonly param: ParamIndex;
  /** Sink kinds neutralised on EVERY path param→return (intersection); the
   *  solver subtracts these when this return feeds a downstream sink. */
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
 * `TaintSource[...]` return model.
 */
export interface SourceToReturn {
  readonly sourceKind: SourceKind;
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
  readonly callLine: number;
  readonly argIndex: number;
  readonly calleeName?: string;
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
  /**
   * Content version stamp — `hash(own-facts ∪ sorted callee versions)`. The
   * incremental cache key (Infer's content-keyed summary): equal across two
   * runs iff the function's own taint facts AND every callee summary it depends
   * on are unchanged. Set by the fixpoint once callee versions are known; the
   * harvester emits the own-facts portion via {@link ownFactsDigest}.
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
      .map((c) => `c:${c.param}:${c.callLine}:${c.argIndex}:${c.calleeName ?? ''}`)
      .sort(),
  );
  parts.push(...s.paramToSink.map((k) => `k:${k.param}:${k.sinkKind}`).sort());
  parts.push(...s.sourceToReturn.map((g) => `g:${g.sourceKind}`).sort());
  parts.push(
    ...s.sourceToCallArg
      .map((g) => `s:${g.sourceKind}:${g.callLine}:${g.argIndex}:${g.calleeName ?? ''}`)
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
