// CONTROL: imports BOTH candidates, so direct-import evidence does not
// disambiguate and the read must stay refused. Narrowing is meant to use
// scope evidence, not to lower the bar for guessing.
import { alphaCfg } from './narrow-alpha.js';
import { betaCfg } from './narrow-beta.js';

export function readsBothVisible(cfg) {
  return cfg.narrowedTimeoutMs;
}

export const bothSeen = [alphaCfg, betaCfg];
