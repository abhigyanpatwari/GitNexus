import type { ScannedFile } from '../ingestion/filesystem-walker.js';
import type { RepoFileManifest } from '../../storage/repo-manager.js';

export interface FileManifestDiff {
  added: string[];
  modified: string[];
  deleted: string[];
  unchanged: number;
}

const stableSort = (paths: string[]): string[] => [...paths].sort((a, b) => a.localeCompare(b));

export const createFileManifest = (
  scannedFiles: ScannedFile[],
  generatedAt = new Date().toISOString(),
): RepoFileManifest => {
  const files: RepoFileManifest['files'] = {};
  const byPath = new Map(scannedFiles.map((file) => [file.path, file]));

  for (const filePath of stableSort([...byPath.keys()])) {
    const scanned = byPath.get(filePath);
    if (!scanned) continue;
    files[filePath] = {
      size: scanned.size,
      mtimeMs: Math.trunc(scanned.mtimeMs ?? 0),
    };
  }

  return { version: 1, generatedAt, files };
};

export const diffFileManifests = (
  previous: RepoFileManifest | null | undefined,
  next: RepoFileManifest,
): FileManifestDiff => {
  if (!previous) {
    return {
      added: stableSort(Object.keys(next.files)),
      modified: [],
      deleted: [],
      unchanged: 0,
    };
  }

  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  let unchanged = 0;

  for (const [filePath, current] of Object.entries(next.files)) {
    const prior = previous.files[filePath];
    if (!prior) {
      added.push(filePath);
    } else if (
      prior.size !== current.size ||
      Math.trunc(prior.mtimeMs) !== Math.trunc(current.mtimeMs)
    ) {
      modified.push(filePath);
    } else {
      unchanged++;
    }
  }

  for (const filePath of Object.keys(previous.files)) {
    if (!next.files[filePath]) {
      deleted.push(filePath);
    }
  }

  return {
    added: stableSort(added),
    modified: stableSort(modified),
    deleted: stableSort(deleted),
    unchanged,
  };
};

export const hasFileManifestChanges = (diff: FileManifestDiff): boolean =>
  diff.added.length > 0 || diff.modified.length > 0 || diff.deleted.length > 0;

export const formatFileManifestDiffSummary = (diff: FileManifestDiff): string => {
  const parts = [
    `${diff.added.length} added`,
    `${diff.modified.length} modified`,
    `${diff.deleted.length} deleted`,
  ];
  return parts.join(', ');
};
