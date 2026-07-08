#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const EXTENSION_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

// Positive on-disk-corruption signatures. `FORCE INSTALL` re-downloads even when
// a file is already present; we only want that when the LOAD error proves the
// existing file is bad (truncated/wrong-platform, #2374). For everything else —
// a missing file (plain INSTALL downloads it), or a permanent non-file failure a
// re-download can never fix (missing runtime dep: "cannot open shared object") —
// plain INSTALL avoids re-downloading ~2 MB on every analyze run forever.
// Exported so a parity test keeps this byte-identical to the copy in
// src/core/lbug/extension-load-error.ts (this `.mjs` cannot import that `.ts`), #2383 F5b.
export const FILE_CORRUPTION_SIGNATURES = [
  /invalid elf/i,
  /file too short/i,
  /not a valid/i,
  /bad magic/i,
  /wrong architecture/i,
  /mach-o/i,
  /truncat/i,
];

/**
 * Decide the install verb from the LOAD error that triggered this install.
 * `FORCE INSTALL` only when the error positively indicates file-level breakage;
 * otherwise plain `INSTALL` (missing file, missing-dependency dlopen failure,
 * or unknown/absent error).
 */
export function chooseInstallVerb(loadError) {
  if (loadError && FILE_CORRUPTION_SIGNATURES.some((re) => re.test(loadError))) {
    return 'FORCE INSTALL';
  }
  return 'INSTALL';
}

function parseLbugMaxDbSize(raw) {
  const parsed = raw ? Number(raw) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid LadybugDB max DB size for extension installer: ${raw ?? '<missing>'}`);
  }
  return Math.floor(parsed);
}

function resolveMaxDbSize() {
  // argv[3] is the optional positional size; ignore it when it is actually a
  // flag token (e.g. `--verify-only`) and fall back to the env default.
  const sizeArg =
    process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : undefined;
  return parseLbugMaxDbSize(sizeArg ?? process.env.GITNEXUS_LBUG_MAX_DB_SIZE);
}

/** Open a scratch LadybugDB and return its connection plus a disposer. */
async function defaultConnect(lbugMaxDbSize) {
  const require = createRequire(import.meta.url);
  const lbugModule = require('@ladybugdb/core');
  const lbug = lbugModule.default ?? lbugModule;

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-ext-install-'));
  const dbPath = path.join(tmpDir, 'install.lbug');
  const db = new lbug.Database(dbPath, 0, false, false, lbugMaxDbSize);
  const conn = new lbug.Connection(db);
  return {
    conn,
    dispose: async () => {
      await conn.close().catch(() => {});
      await db.close().catch(() => {});
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/**
 * Install (or verify) an optional LadybugDB extension in this short-lived process.
 *
 * @param {string} extensionName
 * @param {object} [options]
 * @param {boolean} [options.verifyOnly] LOAD-only Docker build gate — no install.
 * @param {string} [options.loadError] The parent's LOAD failure; selects the verb.
 * @param {(size: number) => Promise<{conn: {query: (sql: string) => Promise<unknown>}, dispose: () => Promise<void>}>} [options.connect]
 *        Connection factory; injectable for offline unit tests.
 */
export async function installDuckDbExtension(extensionName, options = {}) {
  const { verifyOnly = false, loadError, connect } = options;
  if (!extensionName || !EXTENSION_NAME_PATTERN.test(extensionName)) {
    throw new Error(`Invalid DuckDB extension name: ${extensionName ?? '<missing>'}`);
  }

  const makeConnection = connect ?? (() => defaultConnect(resolveMaxDbSize()));
  const { conn, dispose } = await makeConnection();

  try {
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
      // Plain INSTALL is a no-op when the file already exists; escalate to FORCE
      // only when the LOAD error proves the on-disk file is broken (#2374).
      await conn.query(`${chooseInstallVerb(loadError)} ${extensionName}`);
    }
  } finally {
    await dispose();
  }
}

// Only run when executed directly — imported (e.g. by unit tests) it stays inert.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  installDuckDbExtension(process.argv[2] ?? process.env.GITNEXUS_LBUG_EXTENSION_NAME, {
    verifyOnly: process.argv.includes('--verify-only'),
    loadError: process.env.GITNEXUS_LBUG_EXTENSION_LOAD_ERROR,
  }).catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  });
}
