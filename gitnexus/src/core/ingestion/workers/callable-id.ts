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
 * Zero-based start position that keys the graph-to-scope join for a bound
 * callable (#2735/#3041).
 *
 * Graph-node queries may anchor on an outer binding wrapper while the scope
 * channel anchors on the inner callable. A bound graph node therefore follows
 * the semantic definition's line and column rather than the outer wrapper.
 *
 * `ParsedFile.localDefs` is the language-agnostic source of that position.
 * Matching uses only the canonical label, name, and source range; shared worker
 * code does not need to know grammar node types or initializer field names.
 *
 * Node ids stay on the binding wrapper via `localIdentity(definitionNode)`.
 * Missing or ambiguous semantic matches retain the wrapper row, preserving the
 * existing fail-closed behavior.
 */
export function boundCallableStartPosition(
  definitionNode: SyntaxNode,
  nodeName: string,
  nodeLabel: NodeLabel,
  localDefs: readonly SymbolDefinition[] | undefined,
  nameNode?: SyntaxNode | null,
): { readonly row: number; readonly column: number } {
  if (localDefs === undefined) return definitionNode.startPosition;

  const origin = nameNode?.startPosition ?? definitionNode.startPosition;
  let best: { row: number; column: number; distance: number } | undefined;
  let tied = false;

  for (const def of localDefs) {
    if (
      def.type !== nodeLabel ||
      (simpleDefinitionName(def) !== nodeName && def.qualifiedName !== nodeName)
    ) {
      continue;
    }
    const position = definitionIdPosition(def.nodeId, def.filePath);
    if (position === undefined) continue;

    const row = position.line - 1;
    if (!containsPosition(definitionNode, row, position.column)) continue;

    const distance =
      Math.abs(row - origin.row) * 1_000_000 + Math.abs(position.column - origin.column);
    if (best === undefined || distance < best.distance) {
      best = { row, column: position.column, distance };
      tied = false;
    } else if (
      distance === best.distance &&
      (row !== best.row || position.column !== best.column)
    ) {
      tied = true;
    }
  }

  return best !== undefined && !tied
    ? { row: best.row, column: best.column }
    : definitionNode.startPosition;
}

export function boundCallableStartRow(
  definitionNode: SyntaxNode,
  nodeName: string,
  nodeLabel: NodeLabel,
  localDefs: readonly SymbolDefinition[] | undefined,
  nameNode?: SyntaxNode | null,
): number {
  return boundCallableStartPosition(definitionNode, nodeName, nodeLabel, localDefs, nameNode).row;
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
export const positionQualifiedCallableName = (
  name: string,
  position: { readonly row: number; readonly column: number },
): string => `${name}@${position.row}:${position.column}`;

export const localIdentity = (node: SyntaxNode, name: string): string =>
  positionQualifiedCallableName(name, node.startPosition);

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
