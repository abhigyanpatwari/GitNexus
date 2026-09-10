import os from 'node:os';
import path from 'node:path';

/** Get the path to the global GitNexus directory. */
export const getGlobalDir = (): string => {
  return process.env.GITNEXUS_HOME || path.join(os.homedir(), '.gitnexus');
};
