/**
 * Server Mapping Configuration
 *
 * Reads getGlobalDir()/server-mapping.json to map repo names to service names.
 * Used in embedding text to enrich metadata with microservice context.
 */

import fs from 'fs/promises';
import path from 'path';
import { getGlobalDir } from '../../storage/repo-manager.js';

// Sourced from getGlobalDir() so it honors GITNEXUS_HOME (the Docker image sets
// GITNEXUS_HOME=/data/gitnexus); falls back to ~/.gitnexus when unset. Wrapped in
// path.resolve() for parity with the clone/upload roots (git-clone.ts CLONE_ROOT,
// upload-paths.ts UPLOAD_ROOT) so a relative GITNEXUS_HOME still yields an absolute path.
const MAPPING_FILE = path.resolve(path.join(getGlobalDir(), 'server-mapping.json'));

let cachedMapping: Record<string, string> | null = null;

/**
 * Read the server mapping file and return the serverName for a given repoName.
 * Returns undefined if no mapping exists.
 */
export const readServerMapping = async (repoName: string): Promise<string | undefined> => {
  try {
    if (!cachedMapping) {
      const raw = await fs.readFile(MAPPING_FILE, 'utf-8');
      cachedMapping = JSON.parse(raw);
    }
    return cachedMapping[repoName];
  } catch {
    return undefined;
  }
};

/**
 * Clear the cached mapping (useful for testing or after file changes)
 */
export const clearServerMappingCache = (): void => {
  cachedMapping = null;
};
