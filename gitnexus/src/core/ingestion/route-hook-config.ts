import type { RouteFrameworkAlias } from './language-provider.js';

/**
 * Stable metadata value for the declared route configuration. Sorting makes
 * equivalent lists independent of declaration order; no config is `[[],[]]`.
 */
export function routeHookConfigKey(
  aliases: readonly RouteFrameworkAlias[] = [],
  wrappers: readonly string[] = [],
): string {
  const aliasKeys = aliases
    .map((alias) => [alias.importPath, alias.type, alias.framework])
    .sort((a, b) => a.join('\u0000').localeCompare(b.join('\u0000')));
  return JSON.stringify([aliasKeys, [...new Set(wrappers)].sort()]);
}
