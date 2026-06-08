/**
 * Source/sink/sanitizer config model (issue #2080, taint/PDG substrate M0).
 *
 * The per-language taint configuration *shape*. M0 ships only the type and an
 * (empty) registry seam — no analysis consumes it yet. M3 (#2083, intra-proc
 * taint) populates per-language specs and reads them when emitting TAINTED /
 * SANITIZES edges.
 *
 * Kept deliberately minimal: enough for M3 to express "callable X is a
 * source / sink / sanitizer, optionally for argument position N" without M0
 * committing to matcher semantics it cannot yet validate. The shape is
 * expected to grow (e.g. sanitizer escape conditions, return-position taint)
 * when M3 makes contact with real flows; that is a forward-declared-interface
 * design choice, not a finished contract.
 */

/**
 * Identifies a callable that participates in taint flow. `name` is matched
 * against a resolved callable (simple or qualified name — exact matching
 * semantics are M3's call). `args` optionally narrows to specific 0-based
 * argument positions that carry taint (for a source/sink) or clear it (for a
 * sanitizer); omit to mean "unspecified / all".
 */
export interface TaintCallableMatcher {
  readonly name: string;
  readonly args?: readonly number[];
}

/**
 * The taint configuration for a single language: which callables introduce
 * taint (sources), which are dangerous to reach with tainted input (sinks),
 * and which clear taint (sanitizers).
 */
export interface SourceSinkSanitizerSpec {
  readonly sources: readonly TaintCallableMatcher[];
  readonly sinks: readonly TaintCallableMatcher[];
  readonly sanitizers: readonly TaintCallableMatcher[];
}
