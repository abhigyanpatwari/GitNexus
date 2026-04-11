/**
 * Bridge LadybugDB schema for cross-repo Contract Registry.
 * Separate from per-repo schema in lbug/schema.ts.
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
