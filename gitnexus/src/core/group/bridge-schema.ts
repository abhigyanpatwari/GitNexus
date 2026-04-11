/**
 * Bridge LadybugDB schema for cross-repo Contract Registry.
 * Separate from per-repo schema in lbug/schema.ts.
 */

/**
 * Version of the bridge.lbug schema below. `openBridgeDbReadOnly` compares
 * this against `meta.json`'s version field and returns `null` on mismatch,
 * which trips the caller into either the JSON fallback path or a fresh
 * `group sync` that rebuilds `bridge.lbug` from scratch.
 *
 * Migration contract for contributors bumping this constant:
 *   1. Bump the number (e.g. `1` → `2`).
 *   2. Update the DDL below to match the new schema.
 *   3. DO NOT attempt an online migration in this file — the version gate
 *      is intentionally a "discard and re-sync" strategy for V1. An old
 *      bridge.lbug whose version doesn't match is treated as opaque and
 *      rebuilt by the next `group sync`.
 *   4. If online migration becomes necessary (e.g. when groups accumulate
 *      large amounts of embedding data), add a migration path as a
 *      separate `bridge-migrations.ts` module rather than bloating this
 *      file — keep schema and migration concerns separate.
 */
export const BRIDGE_SCHEMA_VERSION = 1;

export const CONTRACT_SCHEMA = `
CREATE NODE TABLE Contract (
  id STRING,
  contractId STRING,
  type STRING,
  role STRING,
  repo STRING,
  service STRING DEFAULT '',
  symbolUid STRING DEFAULT '',
  filePath STRING DEFAULT '',
  symbolName STRING DEFAULT '',
  confidence DOUBLE DEFAULT 0.0,
  meta STRING DEFAULT '{}',
  PRIMARY KEY (id)
)`;

export const REPO_SNAPSHOT_SCHEMA = `
CREATE NODE TABLE RepoSnapshot (
  id STRING,
  indexedAt STRING DEFAULT '',
  lastCommit STRING DEFAULT '',
  PRIMARY KEY (id)
)`;

export const CONTRACT_LINK_SCHEMA = `
CREATE REL TABLE ContractLink (
  FROM Contract TO Contract,
  matchType STRING,
  confidence DOUBLE,
  contractId STRING,
  fromRepo STRING,
  toRepo STRING
)`;

export const BRIDGE_SCHEMA_QUERIES = [CONTRACT_SCHEMA, REPO_SNAPSHOT_SCHEMA, CONTRACT_LINK_SCHEMA];
