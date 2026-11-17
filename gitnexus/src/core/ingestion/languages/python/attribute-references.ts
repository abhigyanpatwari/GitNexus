import Parser from 'tree-sitter';
import Python from 'tree-sitter-python';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import { PYTHON_QUERY_MAX_START_DEPTH } from './query.js';

type AccessKinds = readonly ('read' | 'write')[];

const TARGET_WRAPPERS = new Set([
  'parenthesized_expression',
  'pattern_list',
  'tuple_pattern',
  'list_pattern',
  'list_splat_pattern',
  'as_pattern_target',
  'expression_list',
  'tuple',
  'list',
]);

const READ: AccessKinds = ['read'];
/** A node inside a `type`. Its own array: identity tells it from "no access". */
const ANNOTATED: AccessKinds = [];
/** The target of an annotation-only assignment (`obj.x: T`): neither read nor
 * written. It wins over the `write` capture of the same target. */
const NOT_ASSIGNED: AccessKinds = [];
/** Capture name -> access kinds of a target in that position. */
const TARGET_KINDS = new Map<string, AccessKinds>([
  ['none', []],
  ['write', ['write']],
  ['annotated', NOT_ASSIGNED],
  ['readwrite', ['read', 'write']],
]);

/** Python Language Reference §§6.3.1, 7.2 and 7.5: a target is not a read,
 * except for augmented assignment. Reading the receiver of a target still is. */
const CONTEXTS = `
(type) @type
; The member-call capture owns the callee.
(call function: (_) @none)
(decorator (_) @none)
(delete_statement (_) @write)
(as_pattern alias: (_) @write)
; Single-step patterns: \`left: (_) @write right: (_)\` would hold its capture
; open across the target, and every capture inside it would wait behind it.
(assignment left: (_) @write)
; \`obj.x: T\` evaluates obj but neither reads nor assigns x.
(assignment left: (_) @annotated !right)
(augmented_assignment left: (_) @readwrite)
(for_statement left: (_) @write)
(for_in_clause left: (_) @write)
`;

let contextQuery: Parser.Query | undefined;
/** Per parse tree, by node id: ANNOTATED for every identifier and attribute
 * inside a `type` node, otherwise the access kinds of every attribute that is
 * not a plain read. */
const accessMemo = new WeakMap<Parser.Tree, Map<number, AccessKinds>>();

/**
 * tree-sitter nodes have no parent pointer: each `.parent` walks down from the
 * root, so asking a node for its context costs its depth, and a chain of n
 * member accesses cost O(n^2). One query pass per tree finds every context
 * from above instead, and each check is one hash lookup. The pass is linear
 * only while every pattern in CONTEXTS ends at its capture: `captures()`
 * returns captures in document order, so captures inside an open match wait
 * in a buffer that is rescanned on every step.
 */
function accessKindsFor(tree: Parser.Tree): Map<number, AccessKinds> {
  let kinds = accessMemo.get(tree);
  if (kinds !== undefined) return kinds;
  contextQuery ??= new Parser.Query(Python as Parameters<Parser['setLanguage']>[0], CONTEXTS);
  kinds = new Map();
  let annotationEnd = -1;
  // The same start-depth limit as the scope query (see query.ts): past depth
  // 65,535 tree-sitter wraps a match's start depth and keeps it open.
  for (const { name, node } of contextQuery.captures(tree.rootNode, {
    maxStartDepth: PYTHON_QUERY_MAX_START_DEPTH,
  })) {
    const targetKinds = TARGET_KINDS.get(name);
    if (targetKinds === undefined) {
      // `@type`. Captures arrive in document order. A `type` inside an
      // annotation already collected adds nothing, and skipping it keeps
      // nested generics linear.
      if (node.endIndex <= annotationEnd) continue;
      annotationEnd = node.endIndex;
      for (const inner of node.descendantsOfType(['identifier', 'attribute']))
        kinds.set(inner.id, ANNOTATED);
      continue;
    }
    // The captured node is the target, or wraps the targets.
    const pending = [node];
    for (let target = pending.pop(); target !== undefined; target = pending.pop()) {
      const type = target.type;
      if (type === 'attribute') {
        // An annotation names a type; it does not read that instance's field.
        // Both assignment patterns capture the target of `obj.x: T`; the
        // annotation-only one wins whatever the order.
        const previous = kinds.get(target.id);
        if (previous !== ANNOTATED && previous !== NOT_ASSIGNED) kinds.set(target.id, targetKinds);
      } else if (TARGET_WRAPPERS.has(type)) {
        for (const child of target.namedChildren) pending.push(child);
      }
    }
  }
  accessMemo.set(tree, kinds);
  return kinds;
}

/** True when `node` (an identifier or attribute) sits inside a `type` annotation. */
export function isPythonTypeAnnotation(node: SyntaxNode): boolean {
  return accessKindsFor(node.tree).get(node.id) === ANNOTATED;
}

/** How an `attribute` node accesses its field: nothing, a read, a write or both. */
export function pythonAttributeAccessKinds(node: SyntaxNode): AccessKinds {
  return accessKindsFor(node.tree).get(node.id) ?? READ;
}
