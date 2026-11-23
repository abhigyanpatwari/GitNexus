/** Key-only manifest scans and bounded PK fetches against one immutable graph. */
import lbug from '@ladybugdb/core';
import {
  closeLbugConnection,
  openLbugConnection,
  type LbugConnectionHandle,
} from './lbug-config.js';
import {
  EMBEDDABLE_LABELS,
  LABELS_WITH_EXPORTED,
  LABEL_METHOD,
  type EmbeddableNode,
} from '../embeddings/types.js';
import type {
  EmbeddingManifestSource,
  EmbeddingWorkKey,
} from '../embeddings/embedding-work-manifest.js';

const LABELS = new Set<string>([...EMBEDDABLE_LABELS, 'File']);
// ECMAScript trim's whitespace set, including Unicode separators and BOM.
// RE2's default \\S is ASCII-only and would change the File fallback selection.
const NON_WHITESPACE =
  '[^\\x09-\\x0d\\x20\\x{a0}\\x{1680}\\x{2000}-\\x{200a}\\x{2028}\\x{2029}\\x{202f}\\x{205f}\\x{3000}\\x{feff}]';

function checkedLabel(label: string): string {
  if (!LABELS.has(label)) throw new Error('Unsupported embedding manifest label');
  return `\`${label}\``;
}

function single(result: lbug.QueryResult | lbug.QueryResult[]): lbug.QueryResult {
  if (!Array.isArray(result)) return result;
  if (result.length === 1) return result[0];
  for (const part of result) part.close();
  throw new Error('Unexpected multiple graph query results');
}

function size(value: unknown): number {
  if (typeof value !== 'number' && typeof value !== 'bigint')
    throw new Error('Invalid graph byte count');
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Invalid graph byte count');
  return result;
}

function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid graph text field');
  return value;
}
function optionalString(value: unknown): string | undefined {
  return value == null ? undefined : string(value);
}

export class EmbeddingGraphSource implements EmbeddingManifestSource {
  private active = false;
  private closed = false;
  private closing?: Promise<void>;
  private readonly fetchStatements = new Map<string, lbug.PreparedStatement>();
  private constructor(
    private readonly handle: LbugConnectionHandle,
    private readonly graphPath: string,
  ) {}

  /** graphPath has already passed the publication layer's ownership validation. */
  static async open(
    graphPath: string,
    bufferPoolBytes: number,
    threads: number,
  ): Promise<EmbeddingGraphSource> {
    return new EmbeddingGraphSource(
      await openLbugConnection(lbug, graphPath, { readOnly: true, bufferPoolBytes, threads }),
      graphPath,
    );
  }

  private acquire(): void {
    if (this.closed || this.active)
      throw new Error('Embedding graph source is closed or already in use');
    this.active = true;
  }

  async *scan(label: string): AsyncGenerator<EmbeddingWorkKey> {
    const table = checkedLabel(label);
    this.acquire();
    let result: lbug.QueryResult | undefined;
    try {
      const fields = ['id', 'name', 'filePath'];
      if (label !== 'File') fields.push('description');
      if (label === LABEL_METHOD) fields.push('returnType');
      // JSON escaping costs at most six bytes per source byte. The fixed
      // allowance covers property names, numeric spans, booleans and the label.
      const metadataBytes = fields
        .map((field) => `octet_length(encode(coalesce(n.${field}, '')))`)
        .join(' + ');
      const filter =
        label === 'File'
          ? "WHERE n.filePath IS NOT NULL AND n.filePath <> '' AND n.content <> '[Binary file - content not stored]' AND regexp_matches(coalesce(n.content,''), $nonWhitespace)"
          : '';
      const sql = `MATCH (n:${table}) ${filter} RETURN n.id AS id, octet_length(encode(coalesce(n.content,''))) AS contentBytes, 256 + 6 * (${metadataBytes}) AS metadataBytes ORDER BY n.id`;
      if (label === 'File') {
        const statement = await this.handle.conn.prepare(sql);
        if (!statement.isSuccess()) throw new Error(statement.getErrorMessage());
        result = single(
          await this.handle.conn.execute(statement, { nonWhitespace: NON_WHITESPACE }),
        );
      } else result = single(await this.handle.conn.query(sql));
      while (result.hasNext()) {
        const row = result.getNextSync();
        yield {
          id: string(row.id),
          contentBytes: size(row.contentBytes),
          metadataBytes: size(row.metadataBytes),
        };
      }
    } finally {
      try {
        result?.close();
      } finally {
        this.active = false;
      }
    }
  }

  async fetch(label: string, ids: readonly string[]): Promise<EmbeddableNode[]> {
    const table = checkedLabel(label);
    if (!ids.length || ids.length > 64 || new Set(ids).size !== ids.length)
      throw new Error('Invalid graph fetch unit');
    this.acquire();
    let result: lbug.QueryResult | undefined;
    try {
      let statement = this.fetchStatements.get(label);
      if (!statement) {
        const fields = ['id', 'name', 'filePath', 'content'];
        if (label !== 'File') fields.push('startLine', 'endLine', 'description');
        if (LABELS_WITH_EXPORTED.has(label)) fields.push('isExported');
        if (label === LABEL_METHOD) fields.push('parameterCount', 'returnType');
        statement = await this.handle.conn.prepare(
          `UNWIND $ids AS id MATCH (n:${table} {id:id}) RETURN ${fields.map((field) => `n.${field} AS ${field}`).join(', ')}`,
        );
        if (!statement.isSuccess()) throw new Error(statement.getErrorMessage());
        this.fetchStatements.set(label, statement);
      }
      result = single(await this.handle.conn.execute(statement, { ids: [...ids] }));
      const nodes: EmbeddableNode[] = [];
      while (result.hasNext()) {
        if (nodes.length >= ids.length) throw new Error('Graph fetch exceeded its manifest unit');
        const row = result.getNextSync();
        const content = row.content ?? '';
        if (typeof content !== 'string') throw new Error('Graph content is not text');
        let fileLines = 1;
        if (label === 'File')
          for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) fileLines++;
        if (row.isExported != null && typeof row.isExported !== 'boolean')
          throw new Error('Invalid graph export flag');
        nodes.push({
          id: string(row.id),
          name: string(row.name),
          label,
          filePath: string(row.filePath),
          content,
          startLine: label === 'File' ? 1 : row.startLine == null ? undefined : size(row.startLine),
          endLine:
            label === 'File' ? fileLines : row.endLine == null ? undefined : size(row.endLine),
          ...(label === 'File' ? {} : { description: optionalString(row.description) }),
          ...(LABELS_WITH_EXPORTED.has(label)
            ? { isExported: row.isExported == null ? undefined : (row.isExported as boolean) }
            : {}),
          ...(label === LABEL_METHOD
            ? {
                parameterCount: row.parameterCount == null ? undefined : size(row.parameterCount),
                returnType: optionalString(row.returnType),
              }
            : {}),
        });
      }
      return nodes;
    } finally {
      try {
        result?.close();
      } finally {
        this.active = false;
      }
    }
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.active) throw new Error('Cannot close an active embedding graph read');
    this.closed = true;
    this.fetchStatements.clear();
    this.closing = closeLbugConnection(this.handle, { strict: true, databasePath: this.graphPath });
    try {
      await this.closing;
    } catch (error) {
      this.closing = undefined;
      throw error;
    }
  }
}
