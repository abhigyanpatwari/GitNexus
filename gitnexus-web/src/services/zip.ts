import JSZip from "jszip";
import { shouldIgnorePath } from "../config/ignore-service";

export interface FileEntry {
  path: string;
  content: string;
}

/**
 * Find the common root folder prefix in ZIP files
 * GitHub ZIPs have a root folder like "repo-main/" or "repo-branch/"
 */
const findRootPrefix = (paths: string[]): string => {
  if (paths.length === 0) return "";

  // Get the first path segment of each file
  const firstSegments = paths
    .filter((p) => p.includes("/"))
    .map((p) => p.split("/")[0]);

  if (firstSegments.length === 0) return "";

  // Check if ALL files share the same first segment
  const firstSegment = firstSegments[0];
  const allSameRoot = firstSegments.every((s) => s === firstSegment);

  if (allSameRoot) {
    return firstSegment + "/";
  }

  return "";
};

export const extractZip = async (file: File): Promise<FileEntry[]> => {
  const zip = await JSZip.loadAsync(file);
  const files: FileEntry[] = [];
  const allPaths: string[] = [];

  // First pass: collect all paths to find common root
  zip.forEach((relativePath, entry) => {
    if (!entry.dir) {
      allPaths.push(relativePath);
    }
  });

  // Find and strip root prefix (e.g., "repo-main/")
  const rootPrefix = findRootPrefix(allPaths);

  const promises: Promise<void>[] = [];

  const processEntry = async (
    relativePath: string,
    entry: JSZip.JSZipObject,
  ) => {
    if (entry.dir) return;

    // Strip root prefix if present
    const normalizedPath =
      rootPrefix && relativePath.startsWith(rootPrefix)
        ? relativePath.slice(rootPrefix.length)
        : relativePath;

    if (!normalizedPath) return; // Skip if path becomes empty
    if (shouldIgnorePath(normalizedPath)) return;

    const content = await entry.async("string");

    files.push({
      path: normalizedPath,
      content: content,
    });
  };

  zip.forEach((relativePath, entry) => {
    promises.push(processEntry(relativePath, entry));
  });

  await Promise.all(promises);

  return files;
};
