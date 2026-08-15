#!/usr/bin/env node

/**
 * heal-stale-wal.mjs — Clear stale LadybugDB WAL files that prevent graph loads.
 *
 * PROBLEM
 * -------
 * Aborting a graph stream mid-flight (navigating away, reloading the page, or
 * closing the tab before the stream finishes) leaves a small `lbug.wal` file in
 * the index's storage directory. Every subsequent attempt to open the database
 * then fails because LadybugDB tries to recover through `lbug.shadow`, which
 * was never written:
 *
 *   {"type":"error","error":"IO exception: Cannot open file.
 *    path: .../.gitnexus/lbug.shadow - Error 2: The system cannot find the file
 *    specified."}
 *
 * The web UI receives this as its first stream frame, so the progress bar sits
 * at "0.0 MB downloaded" and falls back to "Graph not loaded". It is not a size
 * problem and not a browser problem: the index stays bricked until the WAL is
 * removed.
 *
 * USAGE
 *   node gitnexus/scripts/heal-stale-wal.mjs           # heal every registered index
 *   node gitnexus/scripts/heal-stale-wal.mjs --check    # report only, change nothing
 *
 * SAFETY
 * ------
 * A WAL is only junk when nothing is writing. `gitnexus analyze` writes, so this
 * script refuses to run while an analyze is in flight. It also copies each WAL to
 * a backup directory before unlinking, and only targets WAL files at or below a
 * header-only size threshold (4 KB) to avoid touching legitimate transactions.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, unlinkSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const REGISTRY_PATH = join(homedir(), '.gitnexus', 'registry.json');
const BACKUP_DIR = join(homedir(), '.gitnexus', 'wal-backups');
const HEADER_ONLY_BYTES = 4096;

function isAnalyzeRunning() {
  try {
    const output = execSync(
      process.platform === 'win32'
        ? 'tasklist /FO CSV /NH'
        : 'ps aux',
      { encoding: 'utf-8', timeout: 5000 },
    );
    return output.includes('gitnexus') && output.includes('analyze');
  } catch {
    return false;
  }
}

function getStoragePaths() {
  if (!existsSync(REGISTRY_PATH)) return [];
  let entries;
  try {
    entries = JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8'));
  } catch {
    return [];
  }
  if (!Array.isArray(entries)) return [];
  const out = [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const raw = entry.storagePath || entry.path;
    if (raw) out.push({ name: entry.name || '?', storagePath: resolve(String(raw)) });
  }
  return out;
}

function formatTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function heal({ checkOnly = false } = {}) {
  if (isAnalyzeRunning()) {
    console.log('gitnexus analyze is running; refusing to touch any WAL.');
    return 0;
  }

  const indexes = getStoragePaths();
  if (indexes.length === 0) {
    console.log('No indexes found in registry.');
    return 0;
  }

  let cleared = 0;

  for (const { name, storagePath } of indexes) {
    const walPath = join(storagePath, 'lbug.wal');

    if (!existsSync(walPath)) {
      console.log(`  ${name}: clean`);
      continue;
    }

    let size;
    try {
      size = statSync(walPath).size;
    } catch {
      console.log(`  ${name}: could not stat WAL`);
      continue;
    }

    if (size > HEADER_ONLY_BYTES) {
      console.log(
        `  ${name}: WAL is ${size.toLocaleString()} bytes — too large to assume it is ` +
        `an aborted read. Left alone; re-run \`gitnexus analyze\` instead.`,
      );
      continue;
    }

    if (checkOnly) {
      console.log(`  ${name}: STALE WAL (${size} bytes) — would clear`);
      cleared++;
      continue;
    }

    try {
      mkdirSync(BACKUP_DIR, { recursive: true });
      const backupName = `${name}-${formatTimestamp()}.wal`;
      copyFileSync(walPath, join(BACKUP_DIR, backupName));
      unlinkSync(walPath);
      console.log(`  ${name}: cleared stale WAL (${size} bytes)`);
      cleared++;
    } catch (err) {
      console.log(`  ${name}: could not clear WAL (${err.message}). Is the server holding it?`);
    }
  }

  return cleared;
}

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');

if (!existsSync(REGISTRY_PATH)) {
  console.log('No GitNexus registry found at ~/.gitnexus/registry.json');
  process.exit(0);
}

const count = heal({ checkOnly });

if (count > 0 && !checkOnly) {
  console.log(`\n${count} index(es) healed. Reload the GitNexus tab.`);
} else if (count === 0) {
  console.log('\nNothing to heal.');
}
