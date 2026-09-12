// Imports exactly ONE of the two definitions. The read below cannot plausibly
// mean the other — the reader cannot see it — so direct-import evidence picks
// the candidate that workspace uniqueness alone had to abandon.
import { alphaCfg } from './narrow-alpha.js';

export function readsNarrowed(cfg) {
  return cfg.narrowedTimeoutMs;
}

export function readsViaBinding() {
  return alphaCfg.narrowedTimeoutMs;
}
