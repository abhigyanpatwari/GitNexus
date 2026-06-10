/**
 * Vitest globalSetup — runs once in the MAIN process before any forks.
 *
 * Creates a single shared LadybugDB with full schema so that forked test
 * files only need to clear + reseed data instead of recreating the
 * entire schema each time (~29 DDL queries per file eliminated).
 *
 * The dbPath is shared with test files via vitest's provide/inject API.
 */
import path from 'path';
import lbug from '@ladybugdb/core';
import type { GlobalSetupContext } from 'vitest/node';
import { createTempDir } from './helpers/test-db.js';
import {
  NODE_SCHEMA_QUERIES,
  REL_SCHEMA_QUERIES,
  EMBEDDING_SCHEMA,
} from '../src/core/lbug/schema.js';

export default async function setup({ provide }: GlobalSetupContext) {
  const tmpHandle = await createTempDir('gitnexus-shared-');
  const dbPath = path.join(tmpHandle.dbPath, 'lbug');

  // Create DB with full schema
  const db = new lbug.Database(dbPath);
  const conn = new lbug.Connection(db);

  for (const q of NODE_SCHEMA_QUERIES) {
    await conn.query(q);
  }
  for (const q of REL_SCHEMA_QUERIES) {
    await conn.query(q);
  }
  await conn.query(EMBEDDING_SCHEMA);

  // Pre-install FTS extension so forks don't need to download it
  try {
    await conn.query('INSTALL fts');
    await conn.query('LOAD EXTENSION fts');
  } catch {
    // FTS may already be installed system-wide — not fatal
  }

  await conn.close();
  await db.close();

  // Share the dbPath with all test files via inject('lbugDbPath')
  provide('lbugDbPath', dbPath);

  // Fork-safe fallback. On vitest 4.x, `provide()` does not reliably reach
  // `inject()` in the `lbug-db` sub-project's forks during a full-suite run
  // (projects + globalSetup + inject interaction bug). globalSetup runs in
  // the MAIN process before any fork is spawned, so an env var set here is
  // inherited by every fork — a robust channel independent of provide/inject.
  // See test/helpers/test-indexed-db.ts for the consuming fallback.
  process.env.LBUG_DB_PATH = dbPath;

  // Teardown: remove temp directory after all tests complete
  return async () => {
    await tmpHandle.cleanup();
  };
}
