/**
 * Climbs that ask the same question of many nodes in one tree.
 *
 * node-tree-sitter's `parent` is not a pointer read: it re-descends from the
 * root, so it costs the node's depth (about 150 ns per AST level). A climb
 * from every call or reference to its enclosing function therefore costs
 * O(depth) steps of O(depth) each, and a file of deeply nested closures pays
 * that for every call in it. Two things make such a climb linear in the file:
 *
 *   - `indexedParent` answers from one downward pass over the tree's named
 *     nodes, made the first time a climb on that tree asks;
 *   - `climbAncestors` records its answer for every ancestor it passed, so the
 *     next climb that reaches one of them stops there. The answer at an
 *     ancestor depends only on the ancestor and the ones above it, never on
 *     where the climb started.
 */
import type { SyntaxNode } from './ast-helpers.js';

/** Per tree: node id -> parent (null for the root). */
const parentIndexes = new WeakMap<object, Map<number, SyntaxNode | null>>();

let climbSteps = 0;
let nativeParentReads = 0;

/** Operation counts for the linearity tests (test hook). */
export function getAncestorClimbStats(): { climbSteps: number; nativeParentReads: number } {
  return { climbSteps, nativeParentReads };
}

export function resetAncestorClimbStats(): void {
  climbSteps = 0;
  nativeParentReads = 0;
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
    parentIndexes.set(tree, index);
  }
  return index;
}

/** `node.parent`, from the tree's parent index; a node it lacks reads natively. */
export function indexedParent(node: SyntaxNode): SyntaxNode | null {
  const parent = parentIndex(node).get(node.id);
  if (parent !== undefined) return parent;
  nativeParentReads++;
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
export function climbAncestors<T>(
  start: SyntaxNode,
  memo: Map<number, T>,
  examine: (ancestor: SyntaxNode) => T | undefined,
  absent: T,
): T {
  const passed: number[] = [];
  let found = absent;
  for (let current = indexedParent(start); current !== null; current = indexedParent(current)) {
    climbSteps++;
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
  }
  for (const id of passed) memo.set(id, found);
  return found;
}
