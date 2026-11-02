import type { ParseCacheIdentity } from '../../src/core/parse-cache-identity.js';

/** Opaque deterministic identities for store tests; artifact derivation is tested separately. */
export const TEST_PARSE_IDENTITY: ParseCacheIdentity = Object.freeze({
  base: 'a'.repeat(64),
  pdg: 'b'.repeat(64),
});
