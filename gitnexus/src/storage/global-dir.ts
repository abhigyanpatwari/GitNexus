import os from 'node:os';
import path from 'node:path';

/**
 * The per-user GitNexus directory, ignoring `GITNEXUS_HOME`.
 *
 * `GITNEXUS_HOME` relocates the state a user wants to see and manage — the
 * registry, the repository stores, the uploads. Runtime artifacts that must
 * stay with the account rather than with the relocated state use this path
 * instead, so relocating `GITNEXUS_HOME` never moves them.
 */
export const getUserGitNexusDir = (): string => {
  return path.join(os.homedir(), '.gitnexus');
};

/** Get the path to the global GitNexus directory. */
export const getGlobalDir = (): string => {
  return process.env.GITNEXUS_HOME || getUserGitNexusDir();
};
