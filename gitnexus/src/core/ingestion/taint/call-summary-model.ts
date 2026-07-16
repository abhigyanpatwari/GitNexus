/**
 * Per-callee dependence SUMMARY model (PDG FU-C, U-C2).
 *
 * A {@link CallSummary} is the compact, context-insensitive abstraction of one
 * function's RETURN-VALUE ASCENT: which formal-parameter indices flow to the
 * function's return value. It is the data-dependence twin of the M4
 * {@link FunctionSummary} (taint), but for the *slicing* engine rather than the
 * taint engine — a later consumer phase uses it to ascend a callee's return
 * effect into the caller continuation (the documented no-ascent false negative).
 *
 * ## Scope (first cut — RETURN-VALUE ONLY)
 *
 * WHOLE-PARAMETER granularity. Ports are `param i` → `return`. Out-params /
 * mutated args (need an alias model) and exception ascent (need try/catch CDG)
 * are DEFERRED — the {@link call-summary-codec} reserves wire-format space for
 * them so they can land without a cache-namespace bump.
 *
 * ## Plain-data discipline
 *
 * A summary is a JSON-plain value type (no functions, class instances, Maps, or
 * Symbols) so it survives `RunScopeResolutionStats` → `ScopeResolutionOutput`
 * threading unchanged — the same `Cloneable` constraint the CFG side channel and
 * the taint {@link FunctionSummary} obey.
 */

/** Source-relative parameter index (0-based, declaration order). */
export type ParamIndex = number;

/**
 * The dependence abstraction of one function. The resolved Function/Method/
 * Constructor graph node id this summary describes, plus the set of formal
 * parameters whose value flows to the return.
 */
export interface CallSummary {
  /** The resolved `Function`/`Method`/`Constructor` graph node id. */
  readonly fnId: string;
  /** Repo-relative source path (carried for diagnostics + the anchor join). */
  readonly filePath: string;
  /** 1-based function start line (mirrors `FunctionCfg.functionStartLine`). */
  readonly startLine: number;
  /** Number of declared formal parameters (port arity). */
  readonly paramCount: number;
  /**
   * Sorted, de-duplicated formal-parameter indices that flow to the function's
   * return value (ascending). Empty ⇒ no parameter reaches the return (a sound
   * EMPTY summary — never a false claim).
   */
  readonly returnFlowParams: readonly ParamIndex[];
}
