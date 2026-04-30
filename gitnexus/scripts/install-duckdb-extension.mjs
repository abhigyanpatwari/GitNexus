#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const EXTENSION_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

// Mirror of LBUG_MAX_DB_SIZE in src/core/lbug/lbug-config.ts. Keep in sync.
// Required since @ladybugdb/core 0.16.0: a 0 / undefined `maxDBSize`
// triggers an 8 TB mmap that fails on most CI runners and laptops.
const LBUG_MAX_DB_SIZE = (() => {
  const raw = process.env.GITNEXUS_LBUG_MAX_DB_SIZE;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return 16 * 1024 * 1024 * 1024;
})();

async function installDuckDbExtension(extensionName) {
  if (!extensionName || !EXTENSION_NAME_PATTERN.test(extensionName)) {
    throw new Error(`Invalid DuckDB extension name: ${extensionName ?? '<missing>'}`);
  }

  const require = createRequire(import.meta.url);
  const lbugModule = require('@ladybugdb/core');
  const lbug = lbugModule.default ?? lbugModule;

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-ext-install-'));
  const dbPath = path.join(tmpDir, 'install.lbug');
  let db;
  let conn;

  try {
    db = new lbug.Database(dbPath, 0, false, false, LBUG_MAX_DB_SIZE);
    conn = new lbug.Connection(db);
    await conn.query(`INSTALL ${extensionName}`);
  } finally {
    if (conn) await conn.close().catch(() => {});
    if (db) await db.close().catch(() => {});
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

installDuckDbExtension(process.argv[2] ?? process.env.GITNEXUS_LBUG_EXTENSION_NAME).catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
