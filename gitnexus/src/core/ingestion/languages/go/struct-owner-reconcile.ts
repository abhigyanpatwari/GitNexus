/**
 * Go cross-file struct-owner reconciliation (#3558, #3559).
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
 *   - sourceId looks like `Struct:<file>.go:<name>` AND no such node exists
 *     AND the id names a Go source file — cross-language `Struct:` owner ids
 *     (Rust, Swift, …) never re-point;
 *   - candidate Struct nodes are Go (`properties.language === 'go'`, the
 *     marker the worker stamps on every declared symbol);
 *   - exactly ONE Struct node shares the owner's package directory, declared
 *     package clause, and simple name. The clause matters because one
 *     directory can carry `package pkg` AND external-test `package pkg_test`
 *     files declaring the same type name — the same (dir, package) bucket
 *     `method-owners.ts` uses. 0 or ≥2 candidates: leave the edge alone — a
 *     wrong owner is worse than a dropped edge.
 *
 * Cheap by default: the per-directory index is built only when a dangling Go
 * `Struct:` owner source actually exists, and package clauses are read only
 * from that directory's Go files. Struct fields never dangle (they live in
 * the struct's own file), so the common case pays two per-type edge scans and
 * nothing else. Idempotent: a second run finds no dangling sources and
 * changes nothing.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { GraphNode, GraphRelationship } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { logger } from '../../../logger.js';
import { goPackageDir, inferGoPackageName } from './package-clause.js';

const OWNER_LABEL = 'Struct';
const GO_LANGUAGE = SupportedLanguages.Go as string;

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

const isGoSourcePath = (filePath: string): boolean => filePath.endsWith('.go');

const isGoNode = (node: GraphNode): boolean => node.properties?.language === GO_LANGUAGE;

/** Rewrites to apply, collected before mutation (the type-index iterator must not be mutated mid-walk). */
interface OwnerRewrite {
  readonly rel: GraphRelationship;
  readonly newSourceId: string;
}

/** `package\0name` → candidate Struct nodes in that package. */
type StructOwnerIndex = Map<string, GraphNode[]>;

interface DirIndex {
  readonly byPackageAndName: StructOwnerIndex;
}

/**
 * Package-clause reads for one reconcile call. A file's clause is immutable
 * within a run, and the dangling-owner scan plus the index build both consult
 * it; the cache is call-scoped so concurrent pipelines over different repos
 * never collide on a relative path. Only `.go` files in dangling-owner
 * directories are ever read.
 */
const clauseReader = (repoPath: string): ((filePath: string) => string | null) => {
  const packageClauses = new Map<string, string | null>();
  return (filePath: string): string | null => {
    const hit = packageClauses.get(filePath);
    if (hit !== undefined) return hit;
    let clause: string | null = null;
    try {
      clause = inferGoPackageName(fs.readFileSync(path.join(repoPath, filePath), 'utf-8'));
    } catch {
      clause = null;
    }
    packageClauses.set(filePath, clause);
    return clause;
  };
};

/** Go Struct nodes in `dir`, from the FULL merged graph. */
const goStructsInDir = (graph: KnowledgeGraph, dir: string): GraphNode[] =>
  [...graph.iterNodes()].filter((node) => {
    if (node.label !== OWNER_LABEL || !isGoNode(node)) return false;
    const filePath = node.properties?.filePath;
    return (
      typeof filePath === 'string' &&
      isGoSourcePath(filePath) &&
      goPackageDir(filePath) === dir &&
      typeof node.properties?.name === 'string'
    );
  });

/**
 * `(clause, name)` index for one directory's Go structs, or null when the
 * directory has none. Keyed by the DECLARED clause — `pkg` and `pkg_test`
 * are different packages, and only same-package files can own each other's
 * receivers (same rule `populateGoWorkspaceOwners` buckets by).
 */
const buildDirIndex = (
  graph: KnowledgeGraph,
  readClause: (filePath: string) => string | null,
  dir: string,
): DirIndex | null => {
  const structs = goStructsInDir(graph, dir);
  if (structs.length === 0) return null;

  const byPackageAndName: StructOwnerIndex = new Map();
  for (const node of structs) {
    const filePath = node.properties.filePath as string;
    const declared = readClause(filePath);
    // A struct whose file has no resolvable clause cannot be keyed by
    // package — the same isolation `populateGoWorkspaceOwners` applies.
    if (declared === null) continue;
    const key = `${declared}\0${node.properties.name as string}`;
    const bucket = byPackageAndName.get(key);
    if (bucket) bucket.push(node);
    else byPackageAndName.set(key, [node]);
  }
  return { byPackageAndName };
};

/**
 * Rewrite cross-file Go struct-owner edges in place. Returns the number of
 * edges re-pointed. `repoPath` resolves the repo-relative
 * `properties.filePath` for package-clause reads.
 */
export const reconcileGoStructOwnerEdges = (graph: KnowledgeGraph, repoPath: string): number => {
  const readClause = clauseReader(repoPath);

  const dangling: GraphRelationship[] = [];
  for (const type of ['HAS_METHOD', 'HAS_PROPERTY'] as const) {
    for (const rel of graph.iterRelationshipsByType(type)) {
      if (graph.getNode(rel.sourceId) === undefined) dangling.push(rel);
    }
  }
  if (dangling.length === 0) return 0;

  // Go-owner edges only. A non-Go `Struct:<file>:<name>` owner id — or one
  // whose file is not Go source — never re-points: a cross-language guess is
  // exactly the wrong-owner case this pass refuses.
  const goDangling = dangling.filter((rel) => {
    const parsed = parseStructOwnerId(rel.sourceId);
    return parsed !== null && isGoSourcePath(parsed.filePath);
  });
  if (goDangling.length === 0) return 0;

  // One index per directory that actually has a dangling owner edge. Built
  // from the FULL merged graph, so the declaring file may sit in any
  // already-merged chunk.
  const indexByDir = new Map<string, DirIndex | null>();
  const dirIndex = (dir: string): DirIndex | null => {
    let index = indexByDir.get(dir);
    if (index === undefined) {
      index = buildDirIndex(graph, readClause, dir);
      indexByDir.set(dir, index);
    }
    return index;
  };

  const resolveOwner = (danglingId: string): string | null => {
    const parsed = parseStructOwnerId(danglingId);
    if (parsed === null) return null;
    const dir = goPackageDir(parsed.filePath);
    const index = dirIndex(dir);
    if (index === null) return null;
    const declared = readClause(parsed.filePath);
    // Owner file unreadable or clauseless: refuse, keep the drop behavior.
    if (declared === null) return null;
    const bucket = index.byPackageAndName.get(`${declared}\0${parsed.name}`);
    // No candidate (struct never parsed / outside the repo slice) or an
    // ambiguous same-name pair in the same package: keep the old drop
    // behavior rather than guess.
    if (bucket === undefined || bucket.length !== 1) return null;
    const owner = bucket[0]!;
    if (graph.getNode(owner.id) === undefined) return null;
    return owner.id;
  };

  const rewrites: OwnerRewrite[] = [];
  for (const rel of goDangling) {
    const newSourceId = resolveOwner(rel.sourceId);
    if (newSourceId === null || newSourceId === rel.sourceId) continue;
    rewrites.push({ rel, newSourceId });
  }

  let rekeyed = 0;
  for (const { rel, newSourceId } of rewrites) {
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
