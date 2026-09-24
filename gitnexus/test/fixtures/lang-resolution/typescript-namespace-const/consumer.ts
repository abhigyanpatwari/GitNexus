import { Limits } from './config.js';

export function readsNamespacedConst(): number {
  return Limits.NAMESPACED_MAX;
}
