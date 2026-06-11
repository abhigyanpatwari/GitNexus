/**
 * Client-side pre-filter for a webkitdirectory folder upload.
 *
 * Drops VCS metadata, dependency/build directories, and oversized files before
 * upload — `.git` alone is often larger than the working tree — so payloads
 * stay small and the upload matches what the analyzer actually needs. Produces
 * an order-aligned `manifest` of webkitRelativePaths (the server keys on this,
 * not the multipart filename, which browsers rewrite).
 */

/** Directory names excluded anywhere in a file's path. */
export const EXCLUDED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'vendor',
  '.venv',
  '__pycache__',
  'target',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.cache',
  'coverage',
  '.idea',
  '.gitnexus',
]);

/** Per-file size cap; matches the server's per-file limit. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export interface FilterResult {
  files: File[];
  manifest: string[];
  droppedCount: number;
  totalBytes: number;
}

type FileLike = Pick<File, 'name' | 'size'> & { webkitRelativePath?: string };

/**
 * Filter a webkitdirectory `FileList` (or array) into the files to upload plus
 * their relative-path manifest.
 */
export function filterRepoFiles(input: ArrayLike<FileLike>): FilterResult {
  const files: File[] = [];
  const manifest: string[] = [];
  let droppedCount = 0;
  let totalBytes = 0;

  for (let i = 0; i < input.length; i++) {
    const f = input[i];
    const rel =
      f.webkitRelativePath && f.webkitRelativePath.length > 0 ? f.webkitRelativePath : f.name;
    const segments = rel.split('/');
    if (segments.some((s) => EXCLUDED_DIRS.has(s))) {
      droppedCount++;
      continue;
    }
    if (f.size > MAX_FILE_BYTES) {
      droppedCount++;
      continue;
    }
    files.push(f as File);
    manifest.push(rel);
    totalBytes += f.size;
  }

  return { files, manifest, droppedCount, totalBytes };
}
