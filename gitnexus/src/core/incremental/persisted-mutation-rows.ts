import { executePrepared } from '../lbug/lbug-adapter.js';
import { NODE_TABLES } from '../lbug/schema.js';

const FILE_LABELS = NODE_TABLES.filter((table) => table !== 'Community' && table !== 'Process')
  .map((table) => `\`${table}\``)
  .join('|');

/**
 * Bound the deleting half of a replacement before DML. Fresh graph counts
 * cannot see symbols/edges removed from a still-present file. Internal edges
 * can be counted at both ends, conservatively selecting compaction sooner.
 * Read failures propagate; missing evidence must not certify a small mutation.
 */
export async function persistedMutationRows(
  files: readonly string[],
  limit: number,
): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid mutation row limit');
  if (limit === 0 || files.length === 0) return 0;
  const paths = [...new Set(files)];
  let rows = 0;
  for (let offset = 0; offset < paths.length; offset += 200) {
    const batch = paths.slice(offset, offset + 200);
    const match = `MATCH (n:${FILE_LABELS}) WHERE n.filePath IN $paths `;
    for (const [suffix, variable] of [
      ['', 'n'],
      ['MATCH (n)-[r:CodeRelation]->() ', 'r'],
      ['MATCH (n)<-[r:CodeRelation]-() ', 'r'],
    ]) {
      const remaining = limit - rows;
      const result = await executePrepared(
        `${match}${suffix}WITH ${variable} LIMIT $limit RETURN count(*) AS rowCount`,
        { paths: batch, limit: remaining },
      );
      const count = result[0]?.rowCount;
      if (
        result.length !== 1 ||
        !(
          (typeof count === 'number' &&
            Number.isSafeInteger(count) &&
            count >= 0 &&
            count <= remaining) ||
          (typeof count === 'bigint' && count >= 0n && count <= BigInt(remaining))
        )
      ) {
        throw new Error('Could not measure persisted mutation rows');
      }
      rows += Number(count);
      if (rows >= limit) return limit;
    }
  }
  return rows;
}
