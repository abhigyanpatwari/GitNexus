/** Disk-backed migration of the legacy vector table, without copying its graph. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import lbug from '@ladybugdb/core';
import { openLbugConnection, closeLbugConnection, toNativeSafePath } from './lbug-config.js';
import { escapeCypherString } from './cypher-escape.js';
import { assertLbugPublicationReady } from './publication.js';
import { embeddingJobDirectory, syncEmbeddingJobDirectory } from '../../storage/embedding-job.js';
import {
  recordLegacyEmbeddingSource,
  type LegacyEmbeddingSourceRecord,
} from '../../storage/legacy-embedding-source.js';

export interface LegacyVectorExportOptions {
  metadataDirectory: string;
  /** The caller owns the slot lock and a stable source connection. Only catalog,
   * count and native COPY results cross this callback, never vector payloads. */
  query: (cypher: string) => Promise<unknown[]>;
  provenance: Pick<
    LegacyEmbeddingSourceRecord,
    'schemaFingerprint' | 'recordedIdentity' | 'recordedInputIdentity'
  >;
  excluded: Iterable<string> | AsyncIterable<string>;
  /** Additional native pool, admitted alongside the source's pool. */
  bufferPoolBytes: number;
  threads: number;
  signal?: AbortSignal;
}

const fields = ['id', 'nodeId', 'chunkIndex', 'startLine', 'endLine', 'embedding', 'contentHash'];
const countQuery = 'MATCH (e:CodeEmbedding) RETURN count(e) AS count';

/** Preserve the old physical width before writable schema initialization can
 * replace its table. The caller publishes the returned receipt under its lock. */
export async function exportLegacyVectorsFromFile(
  sourcePath: string,
  options: Omit<LegacyVectorExportOptions, 'query'> & { sourcePoolBytes: number },
): Promise<string | undefined> {
  options.signal?.throwIfAborted();
  const stat = await fs.lstat(sourcePath);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error('Legacy vector source must be an owned regular file');
  const handle = await openLbugConnection(lbug, sourcePath, {
    readOnly: true,
    bufferPoolBytes: options.sourcePoolBytes,
    threads: options.threads,
  });
  try {
    return await exportLegacyVectors({
      ...options,
      query: async (sql) => {
        const result = await handle.conn.query(sql);
        const cursors = Array.isArray(result) ? result : [result];
        try {
          if (cursors.length !== 1) throw new Error('Unexpected legacy vector export result');
          return await cursors[0].getAll();
        } finally {
          for (const cursor of cursors) cursor.close();
        }
      },
    });
  } finally {
    await closeLbugConnection(handle, { strict: true, databasePath: sourcePath });
  }
}

function count(rows: unknown[]): number {
  const value = (rows[0] as { count?: unknown } | undefined)?.count;
  if (rows.length !== 1 || (typeof value !== 'number' && typeof value !== 'bigint'))
    throw new Error('Legacy vector export count is unverified');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Legacy vector export count is invalid');
  return n;
}

/** The returned receipt pins an independent, immutable table-only database.
 * Group completeness/input compatibility is still checked by LegacyVectorSource;
 * copying a row does not certify its historical provider or text configuration.
 * The source and its metadata are never changed here. Publish the returned
 * reference under the slot lock before any source mutation or cleanup. */
export async function exportLegacyVectors(
  options: LegacyVectorExportOptions,
): Promise<string | undefined> {
  options.signal?.throwIfAborted();
  if (
    !Number.isSafeInteger(options.bufferPoolBytes) ||
    options.bufferPoolBytes < 8 * 1024 * 1024 ||
    !Number.isSafeInteger(options.threads) ||
    options.threads < 1
  )
    throw new Error('Legacy vector export requires an admitted native pool');
  const root = await embeddingJobDirectory(options.metadataDirectory);
  const expected = count(await options.query(countQuery));
  if (expected === 0) return undefined;
  const catalog = (await options.query("CALL table_info('CodeEmbedding') RETURN *")) as {
    name?: unknown;
    type?: unknown;
    'primary key'?: unknown;
  }[];
  const vectorType = catalog.find((column) => column.name === 'embedding')?.type;
  const match = typeof vectorType === 'string' && /^FLOAT\[([1-9]\d*)\]$/.exec(vectorType);
  const dimensions = match ? Number(match[1]) : NaN;
  const types = ['STRING', 'STRING', 'INT32', 'INT64', 'INT64', vectorType, 'STRING'];
  if (
    !Number.isSafeInteger(dimensions) ||
    dimensions < 1 ||
    fields.some((name, i) => !catalog.some((c) => c.name === name && c.type === types[i])) ||
    !catalog.some((c) => c.name === 'id' && c['primary key'] === true) ||
    (options.provenance.recordedIdentity?.dimensions !== undefined &&
      options.provenance.recordedIdentity.dimensions !== dimensions)
  )
    throw new Error('Legacy vector schema differs from its recorded provenance; source retained');

  const id = randomUUID();
  const staging = path.join(root, `lbug.staging.${id}`);
  const csv = staging + '.csv';
  const sourceFile = `lbug.generation.${id.replaceAll('-', '')}`;
  const destination = path.join(root, sourceFile);
  const csvLiteral = `'${escapeCypherString(toNativeSafePath(csv).replace(/\\/g, '/'))}'`;
  let stagingReleased = true;
  try {
    options.signal?.throwIfAborted();
    await options.query(
      `COPY (MATCH (e:CodeEmbedding) RETURN ${fields.map((f) => `e.${f} AS ${f}`).join(', ')}) TO ${csvLiteral} (HEADER=true)`,
    );
    options.signal?.throwIfAborted();
    stagingReleased = false;
    const handle = await openLbugConnection(lbug, staging, {
      bufferPoolBytes: options.bufferPoolBytes,
      threads: options.threads,
    });
    const query = async (sql: string): Promise<unknown[]> => {
      const result = await handle.conn.query(sql);
      const results = Array.isArray(result) ? result : [result];
      try {
        if (results.length !== 1) throw new Error('Unexpected legacy vector export result');
        return await results[0].getAll();
      } finally {
        for (const cursor of results) cursor.close();
      }
    };
    try {
      await query(
        `CREATE NODE TABLE CodeEmbedding (${fields.map((name, i) => `${name} ${types[i]}`).join(', ')}, PRIMARY KEY(id))`,
      );
      await query(`COPY CodeEmbedding FROM ${csvLiteral} (HEADER=true, auto_detect=false)`);
      if (
        count(await query(countQuery)) !== expected ||
        count(await options.query(countQuery)) !== expected
      )
        throw new Error('Legacy vector export lost rows or its source changed; source retained');
      options.signal?.throwIfAborted();
      await query('CHECKPOINT');
    } finally {
      // A failed physical release remains charged by the native reservation
      // manager. Never rename or certify that still-open export.
      await closeLbugConnection(handle, { strict: true, databasePath: staging });
      stagingReleased = true;
    }
    options.signal?.throwIfAborted();
    await assertLbugPublicationReady(staging);
    await fs.rename(staging, destination);
    const file = await fs.open(destination, 'r+');
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    await syncEmbeddingJobDirectory(root);
    return await recordLegacyEmbeddingSource(
      root,
      { sourceFile, ...options.provenance },
      options.excluded,
      options.signal,
    );
  } finally {
    await fs.rm(csv, { force: true });
    // The original source remains untouched. A failed close must retain its
    // live file; renamed generations are reclaimed by the ownership sweep,
    // since a receipt write can succeed before reporting a durability failure.
    if (stagingReleased)
      for (const suffix of ['', '.wal', '.shadow']) await fs.rm(staging + suffix, { force: true });
  }
}
