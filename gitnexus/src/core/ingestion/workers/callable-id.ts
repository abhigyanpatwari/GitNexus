/**
 * The id rules for a callable nested inside another callable (#2699).
 *
 * Extracted from `parse-worker.ts` for one reason: **three** phases there
 * build these ids independently — the definition phase
 * (`callableOwnQualifiedName`), the caller-attribution phase
 * (`findEnclosingFunctionId`), and the worker-path node-id derivation in
 * `processFileGroup`. An id they compute differently is not a test failure;
 * the caller attaches to a node that does not exist, so the edge is dropped
 * rather than reported. "Zero dangling edges" is what that looks like from
 * outside, which is why the divergence #2714 fixed went unnoticed.
 *
 * These functions are pure and free of module-scope side effects, unlike
 * `parse-worker.ts`, which posts a `ready` message to `parentPort` at import
 * and therefore cannot be value-imported by a unit test at all. That is what
 * makes the rule testable rather than merely commented.
 *
 * See `parse-worker.ts`'s `enclosingCallablePrefix` for how the prefix passed
 * in here is derived, and why only genuinely nested callables get one.
 */

import type { NodeLabel, SymbolDefinition } from 'gitnexus-shared';
import type { SyntaxNode } from '../utils/ast-helpers.js';
import { definitionIdPosition } from '../scope-resolution/utils/definition-id.js';

const LOCAL_IDENTITY_SUFFIX = /@\d+:\d+$/;

function simpleDefinitionName(def: SymbolDefinition): string | undefined {
  const qualifiedName = def.qualifiedName;
  if (qualifiedName === undefined) return undefined;
  const dot = qualifiedName.lastIndexOf('.');
  const tail = dot === -1 ? qualifiedName : qualifiedName.slice(dot + 1);
  return tail.replace(LOCAL_IDENTITY_SUFFIX, '');
}

function containsPosition(node: SyntaxNode, row: number, column: number): boolean {
  const start = node.startPosition;
  const end = node.endPosition;
  if (row < start.row || row > end.row) return false;
  if (row === start.row && column < start.column) return false;
  if (row === end.row && column > end.column) return false;
  return true;
}

/**
 * Zero-based start row that keys the graph-to-scope position join for a bound
 * callable (#2735).
 *
 * Graph-node queries may anchor on an outer binding wrapper while the scope
 * channel anchors on the inner callable. The join is line-only, so a multi-line
 * binding needs the graph node's `startLine` to follow the semantic definition.
 *
 * `ParsedFile.localDefs` is the language-agnostic source of that position.
 * Matching uses only the canonical label, name, and source range; shared worker
 * code does not need to know grammar node types or initializer field names.
 *
 * Node ids stay on the binding wrapper via `localIdentity(definitionNode)`.
 * Missing or ambiguous semantic matches retain the wrapper row, preserving the
 * existing fail-closed behavior.
 */
export function boundCallableStartRow(
  definitionNode: SyntaxNode,
  nodeName: string,
  nodeLabel: NodeLabel,
  localDefs: readonly SymbolDefinition[] | undefined,
  nameNode?: SyntaxNode | null,
): number {
  if (localDefs === undefined) return definitionNode.startPosition.row;

  const origin = nameNode?.startPosition ?? definitionNode.startPosition;
  let best: { row: number; distance: number } | undefined;
  let tied = false;

  for (const def of localDefs) {
    if (def.type !== nodeLabel || simpleDefinitionName(def) !== nodeName) continue;
    const position = definitionIdPosition(def.nodeId, def.filePath);
    if (position === undefined) continue;

    const row = position.line - 1;
    if (!containsPosition(definitionNode, row, position.column)) continue;

    const distance =
      Math.abs(row - origin.row) * 1_000_000 + Math.abs(position.column - origin.column);
    if (best === undefined || distance < best.distance) {
      best = { row, distance };
      tied = false;
    } else if (distance === best.distance && row !== best.row) {
      tied = true;
    }
  }

  return best !== undefined && !tied ? best.row : definitionNode.startPosition.row;
}
/**
 * A function-local callable's own name segment: its name plus its declaration
 * position.
 *
 * The name chain alone is not enough, and the gap is the language's, not the
 * grammar's: ECMAScript creates an environment record per function AND per
 * block, so sibling blocks in one function hold genuinely different bindings —
 *
 *     function outer(a) {
 *       if (a) { const pick = …; return pick(1); }   // one binding
 *       else   { const pick = …; return pick(2); }   // a DIFFERENT binding
 *     }
 *
 * — and both are `outer.pick` by name. Putting a block token in the qualifier
 * would tag every local inside any `if`, the common case, and buy nothing over
 * putting the position on the declaration itself: a declaration's own position
 * is unique across every environment record it could belong to, without the
 * qualifier having to enumerate them. One rule, no conditionals, O(1).
 *
 * Applied ONLY to locals. Top-level functions and class methods keep their
 * bare/class-qualified ids, which is what keeps this off the symbols other
 * files, saved queries and stored references actually address.
 */
export const localIdentity = (node: SyntaxNode, name: string): string =>
  `${name}@${node.startPosition.row}:${node.startPosition.column}`;

/**
 * The qualified name of a callable nested inside another callable — THE single
 * definition of that rule, shared by all three id-building phases.
 *
 * A comment asking three call sites to stay in step is exactly the invariant
 * that rots; routing them through one function makes divergence require
 * deleting a call rather than editing a duplicated expression.
 */
export const nestedCallableQualifiedName = (
  prefix: string,
  node: SyntaxNode,
  name: string,
): string => `${prefix}.${localIdentity(node, name)}`;
