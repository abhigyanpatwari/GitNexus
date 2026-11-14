/**
 * Climbs that ask the same question of many nodes in one tree.
 *
 * node-tree-sitter's `parent` is not a pointer read: it re-descends from the
 * root, so it costs the node's depth (about 150 ns per AST level). A climb
 * from every call or reference to its enclosing function therefore costs
 * O(depth) steps of O(depth) each, and a file of deeply nested closures pays
 * that for every call in it. Two things make such a climb linear in the file:
 *
 *   - short climbs use native parents; one climb past 32 ancestors, or every
 *     256th native read of a tree landing on a node at least that deep, builds
 *     one parent index for subsequent reads. A flat file of shallow climbs
 *     never pays for an index of nodes it does not climb through;
 *   - `climbAncestors` records its answer for every ancestor it passed, so the
 *     next climb that reaches one of them stops there. The answer at an
 *     ancestor depends only on the ancestor and the ones above it, never on
 *     where the climb started.
 */
import type { SyntaxNode } from './ast-helpers.js';

/** Per tree: node id -> parent (null for the root). */
const parentIndexes = new WeakMap<object, Map<number, SyntaxNode | null>>();
const nativeReadsByTree = new WeakMap<object, number>();
const NATIVE_CLIMB_LIMIT = 32;
const NATIVE_PARENT_LIMIT = 256;

let counting = false;
let climbSteps = 0;
let nativeParentReads = 0;
let indexedNodes = 0;

/** Operation counts for the linearity tests (test hook). */
export function getAncestorClimbStats(): {
  climbSteps: number;
  nativeParentReads: number;
  indexedNodes: number;
} {
  return { climbSteps, nativeParentReads, indexedNodes };
}

/** Clear counters; tests opt in with `true` and disable again afterwards. */
export function resetAncestorClimbStats(enabled = false): void {
  counting = enabled;
  climbSteps = 0;
  nativeParentReads = 0;
  indexedNodes = 0;
}

function parentIndex(node: SyntaxNode): Map<number, SyntaxNode | null> {
  const tree = node.tree;
  let index = parentIndexes.get(tree);
  if (index === undefined) {
    index = new Map();
    const root = tree.rootNode;
    index.set(root.id, null);
    const stack: SyntaxNode[] = [root];
    for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
      for (const child of current.namedChildren) {
        index.set(child.id, current);
        stack.push(child);
      }
    }
    if (counting) indexedNodes += index.size;
    parentIndexes.set(tree, index);
  }
  return index;
}

/** Whether `node` has at least NATIVE_CLIMB_LIMIT ancestors: a native read there is costly. */
function isDeep(node: SyntaxNode): boolean {
  let ancestor = node.parent;
  for (let i = 1; ancestor !== null && i < NATIVE_CLIMB_LIMIT; i++) ancestor = ancestor.parent;
  return ancestor !== null;
}

/** Read an existing parent index, falling back to native parents for short climbs. */
function indexedParent(node: SyntaxNode): SyntaxNode | null {
  const tree = node.tree;
  const reads = nativeReadsByTree.get(tree) ?? 0;
  const index =
    parentIndexes.get(tree) ??
    (reads > 0 && reads % NATIVE_PARENT_LIMIT === 0 && isDeep(node)
      ? parentIndex(node)
      : undefined);
  const parent = index?.get(node.id);
  if (parent !== undefined) return parent;
  if (counting) nativeParentReads++;
  nativeReadsByTree.set(tree, reads + 1);
  return node.parent;
}

/**
 * The first answer `examine` gives on the way up from `start` (its parent
 * first, `start` itself never), or `absent` at the root. `memo` (node id ->
 * answer, one map per question per file) is read before `examine` and filled
 * for every ancestor the climb examined, the one that answered included.
 * `examine` returns undefined to keep climbing; an answer must not be
 * undefined.
 */
export function climbAncestors<T extends NonNullable<unknown> | null>(
  start: SyntaxNode,
  memo: Map<number, T>,
  examine: (ancestor: SyntaxNode) => T | undefined,
  absent: T,
): T {
  const passed: number[] = [];
  let found = absent;
  for (let current = indexedParent(start); current !== null; current = indexedParent(current)) {
    if (counting) climbSteps++;
    const known = memo.get(current.id);
    if (known !== undefined) {
      found = known;
      break;
    }
    passed.push(current.id);
    const answer = examine(current);
    if (answer !== undefined) {
      found = answer;
      break;
    }
    // A single short lookup must not wrap an unrelated large literal or body.
    // Once a climb is deep, cap native parent work for the rest of this tree.
    if (passed.length === NATIVE_CLIMB_LIMIT) parentIndex(current);
  }
  for (const id of passed) memo.set(id, found);
  return found;
}
