/**
 * Export Command
 *
 * Reads LadybugDB for the current repo and writes its contents to
 * .gitnexus/export/ as Parquet files — one per non-empty node table,
 * one for edges, one for embeddings (optional), and a copy of meta.json.
 */

import fs from 'fs/promises';
import path from 'path';
import { findRepo } from '../storage/repo-manager.js';
import { withLbugDb, executeQuery, loadJsonExtension } from '../core/lbug/lbug-adapter.js';
import {
  NODE_TABLES,
  REL_TABLE_NAME,
  EMBEDDING_TABLE_NAME,
  BACKTICK_NODE_TABLES,
} from '../core/lbug/schema.js';
import { cliError, cliWarn } from './cli-message.js';

const normalizeCopyPath = (p: string): string => p.replace(/\\/g, '/');

const escapeTableName = (table: string): string =>
  BACKTICK_NODE_TABLES.has(table) ? `\`${table}\`` : table;

interface ExportOptions {
  output?: string;
  force?: boolean;
  /** true when --embeddings is passed; omitted by default */
  embeddings?: boolean;
  /** Output format: 'json' (default), 'csv', or 'parquet' */
  format?: string;
}

export const exportCommand = async (pathArg?: string, options: ExportOptions = {}) => {
  const cwd = pathArg ? path.resolve(pathArg) : process.cwd();

  const repo = await findRepo(cwd);
  if (!repo) {
    cliError('No indexed repository found. Run `gitnexus analyze` first.');
    process.exitCode = 1;
    return;
  }

  const exportDir = options.output
    ? path.resolve(options.output)
    : path.join(repo.storagePath, 'export');

  // Mirror clean.ts confirmation-prompt pattern: warn and bail without --force
  if (!options.force) {
    try {
      const existing = await fs.readdir(exportDir);
      if (existing.length > 0) {
        console.log(`Export directory already contains files: ${exportDir}`);
        console.log('Run with --force to overwrite.');
        return;
      }
    } catch {
      // Directory does not exist yet — no prompt needed
    }
  }

  await fs.mkdir(exportDir, { recursive: true });

  const exportedFiles: string[] = [];

  const fmt = (options.format ?? 'json').toLowerCase();
  const ext = fmt === 'parquet' ? 'parquet' : fmt === 'csv' ? 'csv' : 'json';
  // KuzuDB COPY TO infers format from the file extension; no FORMAT clause is needed.
  // CSV output only needs HEADER=true so the first row contains column names.
  const copySuffix = fmt === 'csv' ? ` (HEADER=true)` : '';

  let jsonExtensionFailed = false;

  await withLbugDb(repo.lbugPath, async () => {
    // JSON extension is required for COPY TO '*.json' — delegate to the
    // shared ExtensionManager so install runs out-of-process, policy
    // (GITNEXUS_LBUG_EXTENSION_INSTALL) is respected, and capability is cached.
    if (fmt === 'json') {
      const jsonReady = await loadJsonExtension();
      if (!jsonReady) {
        jsonExtensionFailed = true;
        return;
      }
    }

    // Export node tables — skip empty ones
    for (const table of NODE_TABLES) {
      const escaped = escapeTableName(table);
      const countRows = await executeQuery(`MATCH (n:${escaped}) RETURN count(n) AS cnt`);
      const count = Number(countRows[0]?.cnt ?? 0);
      if (count === 0) continue;

      const outFile = `nodes_${table}.${ext}`;
      const outPath = path.join(exportDir, outFile);
      const copyPath = normalizeCopyPath(outPath);
      await executeQuery(`COPY (MATCH (n:${escaped}) RETURN n.*) TO '${copyPath}'${copySuffix}`);
      exportedFiles.push(outFile);
    }

    // Export edges
    const edgeCountRows = await executeQuery(
      `MATCH ()-[r:${REL_TABLE_NAME}]->() RETURN count(r) AS cnt`,
    );
    const edgeCount = Number(edgeCountRows[0]?.cnt ?? 0);
    if (edgeCount > 0) {
      const outFile = `edges_${REL_TABLE_NAME}.${ext}`;
      const outPath = path.join(exportDir, outFile);
      const copyPath = normalizeCopyPath(outPath);
      await executeQuery(
        `COPY (MATCH ()-[r:${REL_TABLE_NAME}]->() RETURN r.*) TO '${copyPath}'${copySuffix}`,
      );
      exportedFiles.push(outFile);
    }

    // Export embeddings — opt-in via --embeddings; skip if count is 0
    if (options.embeddings === true) {
      const embCountRows = await executeQuery(
        `MATCH (n:${EMBEDDING_TABLE_NAME}) RETURN count(n) AS cnt`,
      );
      const embCount = Number(embCountRows[0]?.cnt ?? 0);
      if (embCount === 0) {
        cliWarn(
          'No embeddings found in the index (embeddings: 0). Skipping embeddings export.\n' +
            'Run `gitnexus analyze --embeddings` to generate them, then re-run export.',
        );
      } else if (embCount > 0) {
        const outFile = `embeddings_${EMBEDDING_TABLE_NAME}.${ext}`;
        const outPath = path.join(exportDir, outFile);
        const copyPath = normalizeCopyPath(outPath);
        await executeQuery(
          `COPY (MATCH (n:${EMBEDDING_TABLE_NAME}) RETURN n.*) TO '${copyPath}'${copySuffix}`,
        );
        exportedFiles.push(outFile);
      }
    }
  });

  if (jsonExtensionFailed) {
    cliError('JSON extension unavailable. Install it manually or use --format parquet.');
    process.exitCode = 1;
    return;
  }

  // Always copy meta.json as-is
  await fs.copyFile(repo.metaPath, path.join(exportDir, 'meta.json'));
  exportedFiles.push('meta.json');

  console.log(`Exported ${exportedFiles.length} file(s) to: ${exportDir}`);
  for (const f of exportedFiles) {
    console.log(`  ${f}`);
  }
};
