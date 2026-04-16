/**
 * Import resolver factory — creates a composable import resolver from
 * an ordered list of strategies.
 *
 * Mirrors the method-extractors/generic.ts and call-extractors/generic.ts
 * pattern: declare a config per language, produce a runtime resolver via factory.
 *
 * Each strategy is tried in order. The first non-null result wins.
 * A result with an empty `files` array is treated as "handled but unresolved"
 * (stops the chain without producing import edges).
 */

import type { ImportResolverFn, ImportResolutionConfig } from './types.js';

/**
 * Create an ImportResolverFn from a declarative config.
 *
 * Chains strategies in declaration order — first non-null result wins.
 * Returns null only if every strategy returns null.
 *
 * Error behaviour: if a strategy throws, the error propagates immediately
 * and remaining strategies are not tried.  Strategies are expected to be
 * pure data transforms that never throw; any unexpected exception indicates
 * a bug in the strategy implementation.
 */
export function createImportResolver(config: ImportResolutionConfig): ImportResolverFn {
  const { strategies } = config;
  return (rawImportPath, filePath, ctx) => {
    for (const strategy of strategies) {
      const result = strategy(rawImportPath, filePath, ctx);
      if (result) return result;
    }
    return null;
  };
}
