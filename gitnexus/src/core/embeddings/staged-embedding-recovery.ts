/** Recover paid embedding rows without opening an interrupted native DB in analyze. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  abortCachedEmbeddingsBuilder,
  createCachedEmbeddingsBuilder,
  EmbeddingSpillReader,
  emptyCachedEmbeddingsSnapshot,
  finalizeCachedEmbeddingsSnapshot,
  ingestCachedEmbeddingRow,
  materializeCachedEmbeddings,
  type CachedEmbeddingMeta,
  type CachedEmbeddingsSnapshot,
} from './embedding-restore-spill.js';

export interface StagedEmbeddingRecoveryOptions {
  dimensions: number;
  /** Active checkpoint window and any incomplete inherited restore groups. */
  excludedNodeIds?: Iterable<string>;
  timeoutMs?: number;
}

export interface StagedEmbeddingExport {
  version: 1;
  dimensions: number;
  rows: CachedEmbeddingMeta[];
  rejectedNodeIds: string[];
}

const RESTORE_BATCH_SIZE = 200;
const DEFAULT_EXTRACTION_TIMEOUT_MS = 120_000;

/** A contiguous prefix is safe only when its node is outside every unsafe window. */
export function validateRecoveredNodeGroups(
  rows: readonly CachedEmbeddingMeta[],
  excludedNodeIds: ReadonlySet<string> = new Set(),
): Set<string> {
  const groups = new Map<string, { hash: string; ordinals: Set<number>; invalid: boolean }>();
  for (const row of rows) {
    let group = groups.get(row.nodeId);
    if (!group) {
      group = { hash: row.contentHash, ordinals: new Set(), invalid: false };
      groups.set(row.nodeId, group);
    }
    if (
      typeof row.nodeId !== 'string' ||
      !row.nodeId ||
      typeof row.contentHash !== 'string' ||
      !row.contentHash ||
      row.contentHash !== group.hash ||
      !Number.isInteger(row.chunkIndex) ||
      row.chunkIndex < 0 ||
      group.ordinals.has(row.chunkIndex) ||
      !Number.isInteger(row.startLine) ||
      row.startLine < 0 ||
      !Number.isInteger(row.endLine) ||
      row.endLine < row.startLine
    )
      group.invalid = true;
    group.ordinals.add(row.chunkIndex);
  }
  const accepted = new Set<string>();
  for (const [nodeId, group] of groups) {
    if (group.invalid || excludedNodeIds.has(nodeId)) continue;
    // Unique ordinals with max n-1 and zero present have no holes.
    if (!group.ordinals.has(0)) continue;
    if ([...group.ordinals].some((ordinal) => ordinal >= group.ordinals.size)) continue;
    accepted.add(nodeId);
  }
  return accepted;
}

/** Whole recovered nodes replace whole published groups; vectors stay in bounded batches. */
export function mergeRecoveredEmbeddings(
  live: CachedEmbeddingsSnapshot,
  recovered: CachedEmbeddingsSnapshot,
): CachedEmbeddingsSnapshot {
  const builder = createCachedEmbeddingsBuilder({ inMemoryRowLimit: 0 });
  try {
    appendSnapshotRows(
      live,
      live.rows.filter((row) => !recovered.embeddingNodeIds.has(row.nodeId)),
      builder,
    );
    appendSnapshotRows(recovered, recovered.rows, builder);
    return finalizeCachedEmbeddingsSnapshot(builder);
  } catch (err) {
    abortCachedEmbeddingsBuilder(builder);
    throw err;
  }
}

function appendSnapshotRows(
  snapshot: CachedEmbeddingsSnapshot,
  rows: readonly CachedEmbeddingMeta[],
  builder: ReturnType<typeof createCachedEmbeddingsBuilder>,
): void {
  const reader = snapshot.spill ? new EmbeddingSpillReader(snapshot.spill) : undefined;
  try {
    for (let i = 0; i < rows.length; i += RESTORE_BATCH_SIZE) {
      const batch = materializeCachedEmbeddings(
        snapshot,
        rows.slice(i, i + RESTORE_BATCH_SIZE),
        reader,
      );
      for (const row of batch)
        ingestCachedEmbeddingRow(builder, row as unknown as Record<string, unknown>, true);
    }
  } finally {
    reader?.close();
  }
}

/**
 * Caller must validate checkpoint identity, schema, exact generation, and hold the
 * index lock. A subprocess contains native WAL replay/query/destructor failures.
 * A failed strict open is never retried with WAL removed or validation disabled.
 */
export async function recoverStagedEmbeddings(
  dbPath: string,
  options: StagedEmbeddingRecoveryOptions,
): Promise<CachedEmbeddingsSnapshot> {
  if (!Number.isInteger(options.dimensions) || options.dimensions <= 0) {
    throw new Error('invalid staged embedding dimensions');
  }
  const dbStat = fs.lstatSync(dbPath);
  if (!dbStat.isFile() || dbStat.isSymbolicLink())
    throw new Error('staged embedding DB is not a regular file');
  const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-stage-export-'));
  try {
    await runExtractionChild(dbPath, exportDir, options);
    const manifestPath = path.join(exportDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as StagedEmbeddingExport;
    if (
      manifest.version !== 1 ||
      manifest.dimensions !== options.dimensions ||
      !Array.isArray(manifest.rows) ||
      !Array.isArray(manifest.rejectedNodeIds) ||
      manifest.rejectedNodeIds.some((id) => typeof id !== 'string') ||
      manifest.rows.some((row, i) => !row || row.vectorIndex !== i)
    )
      throw new Error('invalid staged embedding export manifest');
    if (manifest.rows.length === 0) return emptyCachedEmbeddingsSnapshot();
    const spill = {
      path: path.join(exportDir, 'vectors.bin'),
      dims: options.dimensions,
      rowCount: manifest.rows.length,
    };
    const vectorStat = fs.lstatSync(spill.path);
    if (
      !vectorStat.isFile() ||
      vectorStat.isSymbolicLink() ||
      vectorStat.size !== 12 + spill.rowCount * spill.dims * 4
    ) {
      throw new Error('invalid staged embedding export size');
    }
    const excluded = new Set(options.excludedNodeIds ?? []);
    for (const nodeId of manifest.rejectedNodeIds) excluded.add(nodeId);
    const accepted = validateRecoveredNodeGroups(manifest.rows, excluded);
    const exported: CachedEmbeddingsSnapshot = {
      rows: manifest.rows,
      embeddings: [],
      embeddingNodeIds: accepted,
      spill,
    };
    const builder = createCachedEmbeddingsBuilder({ inMemoryRowLimit: 0 });
    const reader = new EmbeddingSpillReader(spill);
    try {
      const rows = manifest.rows.filter((row) => accepted.has(row.nodeId));
      for (let i = 0; i < rows.length; i += RESTORE_BATCH_SIZE) {
        for (const row of materializeCachedEmbeddings(
          exported,
          rows.slice(i, i + RESTORE_BATCH_SIZE),
          reader,
        )) {
          if (
            row.embedding.length !== options.dimensions ||
            row.embedding.some((value) => !Number.isFinite(value))
          ) {
            throw new Error('invalid staged embedding vector');
          }
          ingestCachedEmbeddingRow(builder, row as unknown as Record<string, unknown>, true);
        }
      }
      return finalizeCachedEmbeddingsSnapshot(builder);
    } catch (err) {
      abortCachedEmbeddingsBuilder(builder);
      throw err;
    } finally {
      reader.close();
    }
  } finally {
    fs.rmSync(exportDir, { recursive: true, force: true });
  }
}

function runExtractionChild(
  dbPath: string,
  exportDir: string,
  options: StagedEmbeddingRecoveryOptions,
): Promise<void> {
  const compiledPath = fileURLToPath(
    new URL('./staged-embedding-recovery-child.js', import.meta.url),
  );
  const sourcePath = compiledPath.replace(/\.js$/, '.ts');
  const childPath = fs.existsSync(compiledPath) ? compiledPath : sourcePath;
  const args = childPath.endsWith('.ts')
    ? ['--import', import.meta.resolve('tsx'), childPath]
    : [childPath];
  args.push(dbPath, exportDir, String(options.dimensions));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    let timedOut = false;
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString().slice(0, 4096 - stderr.length);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      // A process boundary is safe to kill even while native code is executing.
      child.kill('SIGKILL');
    }, options.timeoutMs ?? DEFAULT_EXTRACTION_TIMEOUT_MS);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && !signal && !timedOut) resolve();
      else
        reject(
          new Error(
            `staged embedding extraction failed${timedOut ? ' (timeout)' : ` (${signal ?? code})`}${stderr ? `: ${stderr.trim()}` : ''}`,
          ),
        );
    });
  });
}
