/**
 * Go cross-file struct-owner reconciliation (#3558).
 *
 * `findEnclosingClassInfo`'s `method_declaration` branch mints the member
 * owner id from the file CONTAINING THE METHOD (`Struct:<methodFile>:<Type>`),
 * while the Struct node itself is keyed by the file DECLARING the struct
 * (`Struct:<declFile>:<Type>`). Same Go package, different file → the
 * HAS_METHOD / HAS_PROPERTY edge points at a node that does not exist and is
 * silently dropped at COPY time.
 *
 * This pass runs after ALL worker chunks are merged into the graph (so every
 * package's structs are visible), and rewrites only edges that would
 * otherwise dangle:
 *
 *   - sourceId looks like `Struct:<file>:<name>` AND no such node exists;
 *   - exactly ONE Struct node shares the same package directory and simple
 *     name. 0 or ≥2 candidates: leave the edge alone — a wrong owner is worse
 *     than a dropped edge.
 *
 * Cheap by default: the whole-node package index is built only when a
 * dangling `Struct:` owner source actually exists. Struct fields never
 * dangle (they live in the struct's own file), so the common case pays two
 * per-type edge scans and nothing else. Idempotent: a second run finds no
 * dangling sources and changes nothing.
 */

import type { KnowledgeGraph } from '../../../graph/types.js';
import type { GraphNode, GraphRelationship } from 'gitnexus-shared';
import { logger } from '../../../logger.js';
import { goPackageDir } from './package-clause.js';

const OWNER_LABEL = 'Struct';

/** `Struct:<file>:<name>` → { filePath, name }, or null for other id shapes. */
const parseStructOwnerId = (
  id: string,
): { readonly filePath: string; readonly name: string } | null => {
  if (!id.startsWith(`${OWNER_LABEL}:`)) return null;
  const rest = id.slice(OWNER_LABEL.length + 1);
  const sep = rest.lastIndexOf(':');
  if (sep === -1 || sep === 0 || sep === rest.length - 1) return null;
  return { filePath: rest.slice(0, sep), name: rest.slice(sep + 1) };
};

/** Rewrites to apply, collected before mutation (the type-index iterator must not be mutated mid-walk). */
interface OwnerRewrite {
  readonly rel: GraphRelationship;
  readonly newSourceId: string;
}

/**
 * Rewrite cross-file Go struct-owner edges in place. Returns the number of
 * edges re-pointed.
 */
export const reconcileGoStructOwnerEdges = (graph: KnowledgeGraph): number => {
  const dangling: GraphRelationship[] = [];
  for (const type of ['HAS_METHOD', 'HAS_PROPERTY'] as const) {
    for (const rel of graph.iterRelationshipsByType(type)) {
      if (graph.getNode(rel.sourceId) === undefined) dangling.push(rel);
    }
  }
  if (dangling.length === 0) return 0;

  // Package-dir + simple-name → candidate Struct nodes. Built from the FULL
  // merged graph, so the declaring file may sit in any already-merged chunk.
  const structByKey = new Map<string, GraphNode[]>();
  for (const node of graph.iterNodes()) {
    if (node.label !== OWNER_LABEL) continue;
    const filePath = node.properties?.filePath;
    const name = node.properties?.name;
    if (typeof filePath !== 'string' || typeof name !== 'string') continue;
    const key = `${goPackageDir(filePath)}\0${name}`;
    const bucket = structByKey.get(key);
    if (bucket) bucket.push(node);
    else structByKey.set(key, [node]);
  }

  let rekeyed = 0;
  for (const rel of dangling) {
    const newSourceId = resolveOwner(graph, structByKey, rel.sourceId);
    if (newSourceId === null || newSourceId === rel.sourceId) continue;
    graph.removeRelationship(rel.id);
    // Edge ids are minted as `<TYPE>:<source>-><target>` by the worker path.
    graph.addRelationship({
      ...rel,
      id: `${rel.type}:${newSourceId}->${rel.targetId}`,
      sourceId: newSourceId,
    });
    rekeyed++;
  }
  if (rekeyed > 0) {
    logger.info(
      `go: re-pointed ${rekeyed} cross-file struct member edge(s) to their declaring file(s)`,
    );
  }
  return rekeyed;
};

/** Unique same-package same-name Struct node for a dangling owner id, else null. */
const resolveOwner = (
  graph: KnowledgeGraph,
  structByKey: Map<string, GraphNode[]>,
  danglingId: string,
): string | null => {
  const parsed = parseStructOwnerId(danglingId);
  if (parsed === null) return null;
  const bucket = structByKey.get(`${goPackageDir(parsed.filePath)}\0${parsed.name}`);
  // No candidate (struct never parsed / outside the repo slice) or an
  // ambiguous same-name pair: keep the old drop behavior rather than guess.
  if (bucket === undefined || bucket.length !== 1) return null;
  const owner = bucket[0]!;
  if (graph.getNode(owner.id) === undefined) return null;
  return owner.id;
};
