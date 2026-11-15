import { assertValidGraphNodeId } from '../graph/node-identity.js';

/** Integrity failures must stop preservation before graph writeback. */
export class EmbeddingIntegrityError extends Error {}

export function assertValidEmbeddingKey(nodeId: string, chunkIndex: number, context: string): void {
  try {
    assertValidGraphNodeId(nodeId, context);
  } catch (cause) {
    throw new EmbeddingIntegrityError((cause as Error).message, { cause });
  }
  // CodeEmbedding.chunkIndex is INT32, not a JavaScript safe integer.
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > 2147483647) {
    throw new EmbeddingIntegrityError(
      `${context}: invalid chunk index; expected a non-negative INT32.`,
    );
  }
}

export function assertUniqueEmbeddingKeys(
  rows: Iterable<{ nodeId: string; chunkIndex: number }>,
  context: string,
): void {
  const keys = new Set<string>();
  for (const row of rows) {
    assertValidEmbeddingKey(row.nodeId, row.chunkIndex, context);
    const key = `${row.nodeId}:${row.chunkIndex}`;
    if (keys.has(key)) {
      throw new EmbeddingIntegrityError(
        `${context}: duplicate pending key ${JSON.stringify(key.slice(0, 160))}.`,
      );
    }
    keys.add(key);
  }
}
