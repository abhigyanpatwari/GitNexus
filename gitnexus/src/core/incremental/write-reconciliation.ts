import type { GraphNode } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../graph/types.js';
import { NODE_TABLES, type NodeTableName } from '../lbug/schema.js';
import { sanitizeUTF8 } from '../lbug/csv-generator.js';

// These layers need a different oracle: folders can outlive their last file,
// derived nodes may be preserved without recomputation, and PDG can be streamed.
const EXCLUDED = new Set<NodeTableName>(['Folder', 'Community', 'Process', 'BasicBlock']);
const WITHOUT_RANGE = new Set<NodeTableName>(['File', 'Route', 'Tool']);

interface IdentityRow {
  id: string;
  name: string | null;
  filePath: string | null;
  startLine?: number | null;
  endLine?: number | null;
}

const storedString = (value: string | undefined): string => sanitizeUTF8(value || '');

const storedIdentityField = (node: GraphNode, field: string): unknown => {
  const value = node.properties[field];
  if (field === 'name' || field === 'filePath') {
    return storedString(value as string | undefined);
  }
  if (node.label === 'Destination') {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }
  return value ?? -1;
};

/**
 * Certify the identity fields used by context/impact/detect_changes, including
 * retained rows. A write-set-only probe misses corruption of an unchanged row.
 * Scan one label at a time, without path/range predicates: a corrupt field must
 * not be able to hide its own row. No multi-label scans (#3139), N+1 ID lookups,
 * source-content copies, or whole-graph row materialization.
 *
 * This certifies node identity, not relationships or native storage internals.
 * Call after COPY/checkpoint and after FTS/embedding/checkpoint, before metadata.
 */
export async function reconcileGraphNodeIdentities(
  graph: KnowledgeGraph,
  query: (cypher: string) => Promise<IdentityRow[]>,
  phase: string,
): Promise<{ nodes: number; tables: number }> {
  const expected = new Map<NodeTableName, Map<string, GraphNode>>();
  for (const table of NODE_TABLES) {
    if (!EXCLUDED.has(table)) expected.set(table, new Map());
  }
  for (const node of graph.iterNodes()) {
    const table = expected.get(node.label as NodeTableName);
    if (!table) continue;
    const id = storedString(node.id);
    if (!id || table.has(id)) {
      throw new Error(`Graph identity reconciliation (${phase}): invalid or duplicate ID ${id}`);
    }
    table.set(id, node);
  }

  let nodes = 0;
  for (const [table, remaining] of expected) {
    const fields = WITHOUT_RANGE.has(table)
      ? ['id', 'name', 'filePath']
      : ['id', 'name', 'filePath', 'startLine', 'endLine'];
    const identityFields = fields.slice(1);
    const fail: (detail: string, cause?: unknown) => never = (detail, cause) => {
      throw new Error(
        `Graph identity reconciliation failed (${phase}, ${table}): ${detail}. ` +
          'Freshness was not advanced; run `gitnexus analyze --force` to rebuild the graph.',
        { cause },
      );
    };
    let rows: IdentityRow[];
    try {
      rows = await query(
        `MATCH (n:\`${table}\`) RETURN ${fields.map((f) => `n.${f} AS ${f}`).join(', ')}`,
      );
    } catch (error) {
      fail(
        `could not read identity fields: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
    for (const row of rows) {
      const node = remaining.get(row.id);
      if (!node) fail(`unexpected or duplicate ID ${JSON.stringify(row.id)}`);
      for (const field of identityFields) {
        const wanted = storedIdentityField(node, field);
        const actual = field === 'name' || field === 'filePath' ? (row[field] ?? '') : row[field];
        if (actual !== wanted) {
          fail(
            `${row.id}.${field}: expected ${JSON.stringify(wanted)}, read ${JSON.stringify(actual)}`,
          );
        }
      }
      remaining.delete(row.id);
      nodes++;
    }
    if (remaining.size) {
      fail(
        `${remaining.size} missing ID(s), including ${JSON.stringify(remaining.keys().next().value)}`,
      );
    }
  }
  return { nodes, tables: expected.size };
}
