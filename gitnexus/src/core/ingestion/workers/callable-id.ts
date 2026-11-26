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

/** Zero-based (row, column) parsed from a definition id. */
interface DefinitionPosition {
  readonly row: number;
  readonly column: number;
}

/**
 * Same label+name definitions. `positions` is materialized on the first lookup
 * of the bucket: each def's id is parsed once, defs without a parseable
 * position are dropped (every lookup skipped them anyway), and the rest are
 * sorted by (row, column) so a node range selects a contiguous slice.
 */
interface DefinitionBucket {
  readonly defs: SymbolDefinition[];
  positions: readonly DefinitionPosition[] | undefined;
}

// Parsed-file definitions are finalized before worker graph extraction. Index
// once per immutable array; weak keys release the index with its parse result.
const definitionsByName = new WeakMap<readonly SymbolDefinition[], Map<string, DefinitionBucket>>();

function compareDefinitionPositions(a: DefinitionPosition, b: DefinitionPosition): number {
  return a.row - b.row || a.column - b.column;
}

function bucketPositions(bucket: DefinitionBucket): readonly DefinitionPosition[] {
  if (bucket.positions !== undefined) return bucket.positions;
  const positions: DefinitionPosition[] = [];
  for (const def of bucket.defs) {
    const position = definitionIdPosition(def.nodeId, def.filePath);
    if (position === undefined) continue;
    positions.push({ row: position.line - 1, column: position.column });
  }
  positions.sort(compareDefinitionPositions);
  bucket.positions = positions;
  return positions;
}

/** First index whose position is >= (row, column), or `positions.length`. */
function lowerBoundPosition(
  positions: readonly DefinitionPosition[],
  row: number,
  column: number,
): number {
  let lo = 0;
  let hi = positions.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const candidate = positions[mid];
    if (candidate.row < row || (candidate.row === row && candidate.column < column)) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function simpleDefinitionName(def: SymbolDefinition): string | undefined {
  const qualifiedName = def.qualifiedName;
  if (qualifiedName === undefined) return undefined;
  const dot = qualifiedName.lastIndexOf('.');
  const tail = dot === -1 ? qualifiedName : qualifiedName.slice(dot + 1);
  return tail.replace(LOCAL_IDENTITY_SUFFIX, '');
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

  let index = definitionsByName.get(localDefs);
  if (index === undefined) {
    index = new Map();
    for (const def of localDefs) {
      for (const name of new Set([simpleDefinitionName(def), def.qualifiedName])) {
        if (name === undefined) continue;
        const key = `${def.type}\0${name}`;
        const bucket = index.get(key);
        if (bucket === undefined) index.set(key, { defs: [def], positions: undefined });
        else bucket.defs.push(def);
      }
    }
    definitionsByName.set(localDefs, index);
  }

  const start = definitionNode.startPosition;
  const bucket = index.get(`${nodeLabel}\0${nodeName}`);
  if (bucket === undefined) return start;

  const end = definitionNode.endPosition;
  const origin = nameNode?.startPosition ?? start;
  const positions = bucketPositions(bucket);
  let best: { row: number; column: number; distance: number } | undefined;
  let tied = false;

  // Positions inside [start, end] (both bounds inclusive) are a contiguous run
  // of the (row, column)-sorted bucket: begin at the first one >= start and stop
  // at the first one past end.
  for (let i = lowerBoundPosition(positions, start.row, start.column); i < positions.length; i++) {
    const { row, column } = positions[i];
    if (row > end.row || (row === end.row && column > end.column)) break;

    const distance = Math.abs(row - origin.row) * 1_000_000 + Math.abs(column - origin.column);
    if (best === undefined || distance < best.distance) {
      best = { row, column, distance };
      tied = false;
    } else if (distance === best.distance && (row !== best.row || column !== best.column)) {
      tied = true;
    }
  }

  return best !== undefined && !tied ? { row: best.row, column: best.column } : start;
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
 * The owner prefix of a class member's id (`<prefix>.<member>`) — THE single
 * definition of that rule, shared by every id-building phase (#2874).
 *
 * Default: the immediate owner name, which is what every language has always
 * keyed on. A language that opts into `qualifiedMemberIds` (C++, Ruby) keys on
 * the owner's fully-qualified path instead, so `N::Box<T>::save` and a global
 * `Box<T>::save` stay two nodes. The qualified path is only present when the
 * owner is actually nested (see `EnclosingClassInfo.qualifiedClassName`), so a
 * top-level owner keeps its id unchanged.
 *
 * An anonymous namespace contributes `@anon<startByte>` to the owner's NODE id
 * (#1995). The member id drops the byte offset: it would rename every member in
 * the namespace whenever unrelated code above it is edited. The cost is that
 * same-named members of same-named types in two anonymous namespaces of one
 * file still share an id, exactly as they did before this rule.
 */
export const memberOwnerPrefix = (
  owner: { readonly className: string; readonly qualifiedClassName?: string },
  qualifiedMemberIds: boolean,
): string =>
  qualifiedMemberIds && owner.qualifiedClassName !== undefined
    ? owner.qualifiedClassName.replace(/@anon\d+/g, '@anon')
    : owner.className;

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
