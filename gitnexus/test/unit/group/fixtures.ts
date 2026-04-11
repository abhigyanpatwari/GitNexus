/**
 * Shared test fixtures for `test/unit/group/*` test files. Keep this small
 * and purpose-built — it's NOT a general-purpose factory. If a builder here
 * grows complex enough to need its own module, move it next to the code
 * under test (e.g. `bridge-db.fixtures.ts`) instead of ballooning this file.
 */

import type { StoredContract } from '../../../src/core/group/types.js';

/**
 * Canonical baseline contract used by bridge-db and related tests. Every
 * field is populated so callers get a valid `StoredContract` with zero args,
 * and any field can be overridden via the partial — e.g.
 * `makeContract({ role: 'consumer', repo: 'frontend' })`.
 *
 * Prefer passing a `Partial<StoredContract>` override for the specific
 * field you care about rather than mutating the returned object in place.
 */
export function makeContract(overrides: Partial<StoredContract> = {}): StoredContract {
  return {
    contractId: 'http::GET::/api/users',
    type: 'http',
    role: 'provider',
    symbolUid: 'uid-1',
    symbolRef: { filePath: 'src/routes.ts', name: 'getUsers' },
    symbolName: 'getUsers',
    confidence: 0.85,
    meta: {},
    repo: 'backend',
    ...overrides,
  };
}
