/**
 * Filesystem-only staged embedding provenance. Keep this independent of native
 * and model imports: every index-lock caller needs the retention decision.
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';
import type { EmbeddingRecoveryReference } from './repo-meta.js';
import { INDEX_METADATA_FILE, LEGACY_METADATA_FILE } from './storage-constants.js';

const STAGING_FILENAME =
  /^lbug\.staging\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const FAMILY_SUFFIXES = [
  '',
  '.wal',
  '.shadow',
  '.wal.checkpoint',
  '.lock',
  '.checkpoint.intent.lock',
  '.checkpoint.apply.lock',
] as const;

export interface ResolvedEmbeddingRecovery extends EmbeddingRecoveryReference {
  dbPath: string;
  /** Exact basenames, never a prefix match that can preserve another generation. */
  familyFiles: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonemptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;
const isNodeIds = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isNonemptyString);
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * Resolve only an explicit interrupted-generation receipt in this canonical
 * slot. This validates provenance, not native contents or current identity;
 * those checks must pass separately before any rows can be reused.
 */
export const resolveEmbeddingRecovery = (
  lockDir: string,
  checkpoint: unknown,
): ResolvedEmbeddingRecovery | undefined => {
  if (!isRecord(checkpoint) || !isRecord(checkpoint.recovery)) return undefined;
  if (checkpoint.kind !== undefined && checkpoint.kind !== 'interrupted') return undefined;
  if (
    !isNonemptyString(checkpoint.at) ||
    !Number.isFinite(Date.parse(checkpoint.at)) ||
    !isCount(checkpoint.nodesProcessed) ||
    !isCount(checkpoint.totalNodes) ||
    checkpoint.nodesProcessed > checkpoint.totalNodes ||
    !isCount(checkpoint.chunksProcessed) ||
    !isNonemptyString(checkpoint.model) ||
    !isCount(checkpoint.dimensions) ||
    checkpoint.dimensions === 0 ||
    !isNonemptyString(checkpoint.provider) ||
    (checkpoint.pendingNodeIds !== undefined && !isNodeIds(checkpoint.pendingNodeIds))
  ) {
    return undefined;
  }
  const recovery = checkpoint.recovery;
  if (
    !isNonemptyString(recovery.stagingFile) ||
    !STAGING_FILENAME.test(recovery.stagingFile) ||
    !isNonemptyString(recovery.schemaFingerprint) ||
    !isNodeIds(recovery.unsafeNodeIds)
  ) {
    return undefined;
  }
  const unsafeNodeIds = new Set(recovery.unsafeNodeIds);
  if (
    isNodeIds(checkpoint.pendingNodeIds) &&
    checkpoint.pendingNodeIds.some((nodeId) => !unsafeNodeIds.has(nodeId))
  ) {
    return undefined;
  }

  try {
    const canonicalDir = realpathSync(lockDir);
    if (!lstatSync(canonicalDir).isDirectory()) return undefined;
    const familyFiles = FAMILY_SUFFIXES.map((suffix) => recovery.stagingFile + suffix);
    for (const [index, filename] of familyFiles.entries()) {
      try {
        // lstat refuses both live and dangling symlinks, without following one
        // to a database outside the slot. The base file must exist.
        if (!lstatSync(path.join(canonicalDir, filename)).isFile()) return undefined;
      } catch (error) {
        if (index > 0 && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        return undefined;
      }
    }
    return {
      dbPath: path.join(canonicalDir, recovery.stagingFile),
      stagingFile: recovery.stagingFile,
      schemaFingerprint: recovery.schemaFingerprint,
      unsafeNodeIds: [...unsafeNodeIds],
      familyFiles,
    };
  } catch {
    return undefined;
  }
};

/** Synchronous mirror of loadMeta's primary-first, absent-only fallback rule. */
export const readEmbeddingRecovery = (lockDir: string): ResolvedEmbeddingRecovery | undefined => {
  let metadataPath = path.join(lockDir, INDEX_METADATA_FILE);
  let descriptor: number | undefined;
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const flags = constants.O_RDONLY | noFollow | (constants.O_NONBLOCK ?? 0);
  try {
    try {
      descriptor = openSync(metadataPath, flags);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return undefined;
      // Windows cannot open with O_NOFOLLOW: an open of a dangling symlink
      // reports ENOENT, but that existing primary entry must prevent fallback.
      try {
        lstatSync(metadataPath);
        return undefined;
      } catch (statError) {
        const statCode = (statError as NodeJS.ErrnoException).code;
        if (statCode !== 'ENOENT' && statCode !== 'ENOTDIR') return undefined;
      }
      metadataPath = path.join(lockDir, LEGACY_METADATA_FILE);
      descriptor = openSync(metadataPath, flags);
    }
    const opened = fstatSync(descriptor, { bigint: true });
    const entry = lstatSync(metadataPath, { bigint: true });
    // Check the opened file itself and match the current non-symlink entry.
    // This also refuses replacement on platforms without O_NOFOLLOW.
    if (
      !opened.isFile() ||
      !entry.isFile() ||
      (noFollow === 0 && opened.ino === 0n) ||
      opened.dev !== entry.dev ||
      opened.ino !== entry.ino
    ) {
      return undefined;
    }
    const meta: unknown = JSON.parse(readFileSync(descriptor, 'utf8'));
    if (!isRecord(meta)) return undefined;
    // storagePath describes the flat/cache root, including in branch-slot
    // metadata. The current locked directory is the generation boundary.
    return resolveEmbeddingRecovery(lockDir, meta.embeddingCheckpoint);
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        /* best-effort */
      }
    }
  }
};
