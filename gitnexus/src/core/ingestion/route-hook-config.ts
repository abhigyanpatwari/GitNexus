import { compareCodeUnits } from '../../lib/utils.js';
import type { RouteHookConfig } from './language-provider.js';

/**
 * Stable metadata value for the declared route configuration. Sorting makes
 * equivalent lists independent of declaration order; no config is `[[],[]]`.
 */
export function routeHookConfigKey(config?: RouteHookConfig): string {
  const aliasKeys = (config?.routeFrameworkAliases ?? [])
    .map((alias) => [alias.importPath, alias.type, alias.framework])
    .sort((a, b) => compareCodeUnits(a.join('\u0000'), b.join('\u0000')));
  return JSON.stringify([
    aliasKeys,
    [...new Set(config?.routeHandlerWrappers)].sort(compareCodeUnits),
  ]);
}
