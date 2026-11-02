/**
 * Per-file guard against member edges whose owner node was never emitted.
 *
 * Owner ids are minted from syntax (the binding an object literal is assigned
 * to, the enclosing container), while node labels come from the query captures,
 * so the two can disagree (#3747): `const X = z.object({ k: f(() => 0) }).refine(cb)`
 * is emitted as `Function:<file>:X` but its key's owner is spelled
 * `Const:<file>:X`, and a TS `declare module 'm' {}` owns its members under a
 * `Trait` id no TS capture ever emits. LadybugDB's COPY rejects such an edge and
 * the retry silently drops it.
 *
 * Kept free of worker side effects so it can be unit-tested directly.
 */
import { generateId } from '../../../lib/utils.js';
import type { ParseWorkerResult } from './parse-worker.js';

const isMemberEdge = (type: string): boolean => type === 'HAS_METHOD' || type === 'HAS_PROPERTY';

/**
 * Remove `HAS_METHOD` / `HAS_PROPERTY` edges appended for `filePath` (from
 * `relStart` on) whose owner id names a node in that same file that the file
 * did not emit (from `nodeStart` on). The orphaned member is re-attached to its
 * File with `DEFINES` unless it already has one.
 *
 * Owners in other files are left alone: they are resolved across the whole
 * graph, not per file.
 */
export const dropDanglingInFileOwnerEdges = (
  result: Pick<ParseWorkerResult, 'nodes' | 'relationships'>,
  filePath: string,
  nodeStart: number,
  relStart: number,
): void => {
  const rels = result.relationships;
  const inFilePrefix = `:${filePath}:`;
  let emitted: Set<string> | null = null;
  let dangling: Set<number> | null = null;

  for (let i = relStart; i < rels.length; i++) {
    const rel = rels[i];
    if (!isMemberEdge(rel.type)) continue;
    const labelEnd = rel.sourceId.indexOf(':');
    if (labelEnd < 0 || !rel.sourceId.startsWith(inFilePrefix, labelEnd)) continue;
    if (emitted === null) {
      emitted = new Set<string>();
      for (let n = nodeStart; n < result.nodes.length; n++) emitted.add(result.nodes[n].id);
    }
    if (!emitted.has(rel.sourceId)) (dangling ??= new Set<number>()).add(i);
  }
  if (dangling === null || emitted === null) return;

  const fileId = generateId('File', filePath);
  const defined = new Set<string>();
  for (let i = relStart; i < rels.length; i++) {
    const rel = rels[i];
    if (rel.type === 'DEFINES' && rel.sourceId === fileId) defined.add(rel.targetId);
  }

  let write = relStart;
  for (let i = relStart; i < rels.length; i++) {
    const rel = rels[i];
    if (!dangling.has(i)) {
      rels[write++] = rel;
      continue;
    }
    if (defined.has(rel.targetId) || !emitted.has(rel.targetId)) continue;
    defined.add(rel.targetId);
    rels[write++] = {
      id: generateId('DEFINES', `${fileId}->${rel.targetId}`),
      sourceId: fileId,
      targetId: rel.targetId,
      type: 'DEFINES',
      confidence: 1.0,
      reason: '',
    };
  }
  rels.length = write;
};

/** Tracks the file whose slice of a worker result is still being appended. */
export interface OwnerEdgeGuard {
  /** Settle the previous file, then start tracking what `filePath` appends. */
  open(filePath: string): void;
  /** Settle the tracked file, if any. Safe to call more than once. */
  settle(): void;
}

export const createOwnerEdgeGuard = (
  result: Pick<ParseWorkerResult, 'nodes' | 'relationships'>,
): OwnerEdgeGuard => {
  let current: { path: string; nodeStart: number; relStart: number } | null = null;
  const settle = (): void => {
    if (current === null) return;
    const file = current;
    current = null;
    dropDanglingInFileOwnerEdges(result, file.path, file.nodeStart, file.relStart);
  };
  return {
    open(filePath: string): void {
      settle();
      current = {
        path: filePath,
        nodeStart: result.nodes.length,
        relStart: result.relationships.length,
      };
    },
    settle,
  };
};
