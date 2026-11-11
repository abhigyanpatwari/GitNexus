/**
 * Per-file digests of the graph rows an incremental write owns.
 *
 * A resolution group says "any member's edges may change when one member
 * changes". Rewriting every member is always correct and, for a group as wide
 * as a whole language, always a full database write. The pipeline has already
 * built the complete new graph, so the question "did this unchanged file's rows
 * change?" has an exact answer: compare a digest of its new rows with the
 * digest recorded when its rows were last written.
 *
 * A file's rows are its nodes plus the file-to-file relationships that leave
 * them. Graph-wide nodes and relationships are excluded: their owning phases
 * delete and re-extract them on every run, whatever the write set is.
 */

import { createHash } from 'node:crypto';
import type { GraphNode, GraphRelationship } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../graph/types.js';
import { isGraphWideNode, isGraphWideRelationship } from './subgraph-extract.js';

const WORDS = 4;

/** Order-independent: rows are hashed one by one and summed, so emission order
 * and graph storage layout cannot change a digest. The row count is part of it. */
export function computeFileRowDigests(graph: KnowledgeGraph): Map<string, string> {
  const sums = new Map<string, Uint32Array>();
  const fileOf = new Map<string, string>();
  const add = (file: string, row: string): void => {
    const hash = createHash('sha1').update(row).digest();
    let sum = sums.get(file);
    if (sum === undefined) {
      sum = new Uint32Array(WORDS + 1);
      sums.set(file, sum);
    }
    for (let word = 0; word < WORDS; word++) sum[word] += hash.readUInt32LE(word * 4);
    sum[WORDS]++;
  };
  graph.forEachNode((node: GraphNode) => {
    const file = node.properties?.filePath as string | undefined;
    if (!file || isGraphWideNode(node)) return;
    fileOf.set(node.id, file);
    add(file, `${node.label}\n${node.id}\n${JSON.stringify(node.properties)}`);
  });
  graph.forEachRelationship((relationship: GraphRelationship) => {
    if (isGraphWideRelationship(relationship)) return;
    const file = fileOf.get(relationship.sourceId);
    if (file === undefined || !fileOf.has(relationship.targetId)) return;
    add(
      file,
      `${relationship.type}\n${relationship.sourceId}\n${relationship.targetId}\n` +
        `${relationship.confidence}\n${relationship.reason}`,
    );
  });
  const digests = new Map<string, string>();
  for (const [file, sum] of sums) {
    digests.set(
      file,
      Buffer.from(sum.buffer, sum.byteOffset, sum.byteLength).toString('base64url'),
    );
  }
  return digests;
}

/**
 * The digests to record after a run. A recorded digest must describe the rows
 * the database holds for that file, so a file takes its new digest only when
 * this run wrote its rows. A file that was not written keeps the digest it had;
 * a file with no trustworthy record gets none, and the next comparison treats
 * it as changed.
 */
export function nextFileRowDigests(
  previous: Readonly<Record<string, string>> | undefined,
  current: ReadonlyMap<string, string>,
  written: ReadonlySet<string> | 'all',
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [file, digest] of current) {
    if (written === 'all' || written.has(file)) next[file] = digest;
    else if (previous?.[file] !== undefined) next[file] = previous[file];
  }
  return next;
}
