import { resolveParseCacheIdentity } from '../../src/core/parse-cache-identity.js';

/** Use the same source parent / compiled worker artifacts as real analysis. */
export async function runtimeParseIdentity() {
  const result = await resolveParseCacheIdentity(
    new URL('../../src/core/run-analyze.ts', import.meta.url).href,
  );
  if (result.ok === false) throw new Error(`Cannot verify test parser artifacts: ${result.reason}`);
  return result.identity;
}
