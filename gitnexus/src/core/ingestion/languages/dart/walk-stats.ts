/**
 * Operation counters for the Dart capture walk's linearity tests (test hook).
 *
 * node-tree-sitter's `parent` and sibling reads re-descend from the root, so
 * each costs the node's depth. The capture walk carries what those reads would
 * find; these count the reads that still happen, so a test can pin them at
 * zero for every node the walk visited.
 */

let ownerParentSteps = 0;
let siblingReads = 0;

/** A `parent` step of the callable-flow owner climb. */
export function recordOwnerParentStep(): void {
  ownerParentSteps++;
}

/** A sibling read that a call-callee or closure-static lookup fell back to. */
export function recordSiblingRead(): void {
  siblingReads++;
}

export function getDartCaptureWalkStats(): { ownerParentSteps: number; siblingReads: number } {
  return { ownerParentSteps, siblingReads };
}

export function resetDartCaptureWalkStats(): void {
  ownerParentSteps = 0;
  siblingReads = 0;
}
