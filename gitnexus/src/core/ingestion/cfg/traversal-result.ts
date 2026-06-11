/**
 * TraversalResult (issue #2081, M1).
 *
 * Visiting a statement (or a statement sequence) returns the block its control
 * flow ENTERS through, plus the set of blocks whose **normal** control flows
 * out the bottom (the "dangling exits") — to be wired to the entry of whatever
 * comes next. Abnormal exits (return/break/continue/throw) are wired directly
 * to their targets during the walk and are NOT part of `exits`.
 *
 * A statement that cannot fall through (e.g. ends in `return`/`throw`, or both
 * branches of an `if` return) yields an empty `exits` array.
 */
export interface TraversalResult {
  /** Block index control enters this statement/sequence through. */
  readonly entry: number;
  /** Block indices whose normal control falls out the bottom (may be empty). */
  readonly exits: readonly number[];
}

/** A sequence of statements that produced no blocks (e.g. an empty body). */
export const emptyTraversal = (entry: number): TraversalResult => ({ entry, exits: [entry] });
