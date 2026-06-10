#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const EXTENSION_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

function parseLbugMaxDbSize(raw) {
  const parsed = raw ? Number(raw) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid LadybugDB max DB size for extension installer: ${raw ?? '<missing>'}`);
  }
  return Math.floor(parsed);
}

async function installDuckDbExtension(extensionName, verifyOnly = false) {
  if (!extensionName || !EXTENSION_NAME_PATTERN.test(extensionName)) {
    throw new Error(`Invalid DuckDB extension name: ${extensionName ?? '<missing>'}`);
  }

  const require = createRequire(import.meta.url);
  const lbugModule = require('@ladybugdb/core');
  const lbug = lbugModule.default ?? lbugModule;
  // argv[3] is the optional positional size; ignore it when it is actually a
  // flag token (e.g. `--verify-only`) and fall back to the env default.
  const sizeArg =
    process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : undefined;
  const lbugMaxDbSize = parseLbugMaxDbSize(sizeArg ?? process.env.GITNEXUS_LBUG_MAX_DB_SIZE);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-ext-install-'));
  const dbPath = path.join(tmpDir, 'install.lbug');
  let db;
  let conn;

  try {
    db = new lbug.Database(dbPath, 0, false, false, lbugMaxDbSize);
    conn = new lbug.Connection(db);
    if (verifyOnly) {
      // Prove a previously-baked extension is resolvable by a FRESH process
      // under the current HOME (the runtime `LOAD EXTENSION` path) — no INSTALL,
      // no network. Used as a Docker build-time gate so a HOME/extension-dir
      // mismatch fails the build instead of silently degrading search at runtime.
      await conn.query(`LOAD EXTENSION ${extensionName}`);
      console.log(
        `[install-ext] LOAD-only verify OK for '${extensionName}' (HOME=${process.env.HOME})`,
      );
    } else {
      await conn.query(`INSTALL ${extensionName}`);
    }
  } finally {
    if (conn) await conn.close().catch(() => {});
    if (db) await db.close().catch(() => {});
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

installDuckDbExtension(
  process.argv[2] ?? process.env.GITNEXUS_LBUG_EXTENSION_NAME,
  process.argv.includes('--verify-only'),
).catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
