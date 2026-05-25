import { parseTruthyEnv } from './env.js';

export const isVerboseIngestionEnabled = (): boolean =>
  parseTruthyEnv(process.env.GITNEXUS_VERBOSE);
