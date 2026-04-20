/**
 * Build a `(filePath, name) → graphNodeId` lookup over the graph's
 * Function/Method/Class/Constructor nodes. Two keys per node:
 *
 *   - simple name (`User` / `save`) — legacy fallback
 *   - qualified name when derivable from the node id (`User.save`)
 *
 * The qualified key is the authoritative one when two classes in the
 * same file define a method with the same simple name
 * (`class User: def save` + `class Document: def save`). Without it,
 * the simple-name key collides and every `document.save()` CALLS edge
 * would silently target `User.save`. Method node ids encode the
 * qualifier (`Method:file.py:User.save#1`), so we parse it back out.
 *
 * Language-agnostic seam. Any language provider migrating to the
 * registry-primary path can consume this to translate scope-resolution
 * `SymbolDefinition.nodeId` values into the legacy graph-node ID
 * format that downstream consumers (queries, edges, MCP) expect.
 */

import type { NodeLabel } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';

export type GraphNodeLookup = ReadonlyMap<string, string>;

/**
 * Parse a qualified name out of a Function/Method node id.
 *
 * Node id format: `${label}:${filePath}:${qualifiedName}${arityTag}`,
 * where `arityTag` is `#<n>` (or empty). Strips the known-length
 * label + filePath prefix so colons inside `filePath` (Windows
 * `C:\...`) don't break the parse. Returns `undefined` when the id
 * doesn't match the expected shape.
 */
function parseQualifiedFromId(id: string, label: NodeLabel, filePath: string): string | undefined {
  const prefix = `${label}:${filePath}:`;
  if (!id.startsWith(prefix)) return undefined;
  const suffix = id.slice(prefix.length);
  if (suffix.length === 0) return undefined;
  const hash = suffix.indexOf('#');
  return hash === -1 ? suffix : suffix.slice(0, hash);
}

export function buildGraphNodeLookup(graph: KnowledgeGraph): GraphNodeLookup {
  const lookup = new Map<string, string>();
  for (const node of graph.iterNodes()) {
    const props = node.properties as {
      filePath?: string;
      name?: string;
      qualifiedName?: string;
    };
    if (props.filePath === undefined || props.name === undefined) continue;
    if (!isLinkableLabel(node.label)) continue;

    // Primary key: fully-qualified name when available. Class nodes
    // carry `qualifiedName` in their properties (set by the parsing
    // processor). Method/Function nodes do not, so derive the
    // qualifier from the node id — that's where the parse-phase
    // encoded it.
    const qualified =
      props.qualifiedName ?? parseQualifiedFromId(node.id, node.label, props.filePath);
    if (qualified !== undefined && qualified.length > 0) {
      const qKey = `${props.filePath}::${qualified}`;
      if (!lookup.has(qKey)) lookup.set(qKey, node.id);
    }

    // Fallback key: simple name. First-wins within a file — used when
    // the caller doesn't know the qualifier (unqualified free-call
    // fallback, cross-file resolution where MethodRegistry already
    // disambiguated the owner).
    const simpleKey = `${props.filePath}::${props.name}`;
    if (!lookup.has(simpleKey)) lookup.set(simpleKey, node.id);
  }
  return lookup;
}

export function isLinkableLabel(label: NodeLabel): boolean {
  return (
    label === 'Function' ||
    label === 'Method' ||
    label === 'Constructor' ||
    label === 'Class' ||
    label === 'Interface' ||
    label === 'Struct' ||
    label === 'Enum' ||
    // Variable / Property are linkable too — receiver-bound write/read
    // ACCESSES edges target field nodes (e.g. `user.name = "x"` →
    // ACCESSES edge to User's `name` Variable/Property node).
    label === 'Variable' ||
    label === 'Property'
  );
}
