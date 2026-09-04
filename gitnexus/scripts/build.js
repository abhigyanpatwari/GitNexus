#!/usr/bin/env node
/**
 * Build script that compiles gitnexus and inlines gitnexus-shared into the dist.
 *
 * Steps:
 *  1. Build gitnexus-shared (tsc)
 *  2. Build gitnexus (tsc)
 *  3. Copy gitnexus-shared/dist → dist/_shared
 *  4. Rewrite bare 'gitnexus-shared' specifiers → relative paths
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWebBuild } from './build-web.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SHARED_ROOT = path.resolve(ROOT, '..', 'gitnexus-shared');
const DIST = path.join(ROOT, 'dist');
const SHARED_DEST = path.join(DIST, '_shared');
const DEFAULT_BUILD_TIMEOUT_MS = 600_000;

function getBuildTimeoutMs() {
  const raw = process.env.GITNEXUS_BUILD_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_BUILD_TIMEOUT_MS;

  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;

  console.warn(
    `[build] ignoring invalid GITNEXUS_BUILD_TIMEOUT_MS=${JSON.stringify(raw)}; using ${DEFAULT_BUILD_TIMEOUT_MS}ms`,
  );
  return DEFAULT_BUILD_TIMEOUT_MS;
}

const BUILD_TIMEOUT_MS = getBuildTimeoutMs();

// Published-package guard: when installed from the npm registry the
// monorepo sibling `gitnexus-shared` does not exist and `dist/` is
// already pre-built. Skip the build to avoid a misleading ENOENT
// crash (#1795).
if (!fs.existsSync(SHARED_ROOT)) {
  if (fs.existsSync(DIST)) {
    console.log('[build] skipping — dist/ already present (published package).');
    process.exit(0);
  }
  console.error(
    `[build] gitnexus-shared not found at ${SHARED_ROOT} and no dist/ exists.\n` +
      'Are you running from the monorepo checkout? Run `npm install` from the repo root first.',
  );
  process.exit(1);
}

// ── 1. Build gitnexus-shared ───────────────────────────────────────
console.log('[build] compiling gitnexus-shared…');
const tscCmd =
  process.platform === 'win32'
    ? path.join('node_modules', '.bin', 'tsc.cmd')
    : path.join('node_modules', '.bin', 'tsc');
execSync(tscCmd, { cwd: SHARED_ROOT, stdio: 'inherit', timeout: BUILD_TIMEOUT_MS });

// ── 2. Build gitnexus ──────────────────────────────────────────────
console.log('[build] compiling gitnexus…');
execSync(tscCmd, { cwd: ROOT, stdio: 'inherit', timeout: BUILD_TIMEOUT_MS });

// ── 3. Copy shared dist ────────────────────────────────────────────
console.log('[build] copying shared module into dist/_shared…');
fs.cpSync(path.join(SHARED_ROOT, 'dist'), SHARED_DEST, { recursive: true });

// ── 4. Rewrite imports ─────────────────────────────────────────────
console.log('[build] rewriting gitnexus-shared imports…');
let rewritten = 0;

function rewriteFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  if (!content.includes('gitnexus-shared')) return;

  const relDir = path.relative(path.dirname(filePath), SHARED_DEST);
  // Always use posix separators and point to the package index
  const relImport = relDir.split(path.sep).join('/') + '/index.js';

  const updated = content
    .replace(/from\s+['"]gitnexus-shared['"]/g, `from '${relImport}'`)
    .replace(/import\(\s*['"]gitnexus-shared['"]\s*\)/g, `import('${relImport}')`);

  if (updated !== content) {
    fs.writeFileSync(filePath, updated);
    rewritten++;
  }
}

function walk(dir, extensions, cb) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, extensions, cb);
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      cb(full);
    }
  }
}

walk(DIST, ['.js', '.d.ts'], rewriteFile);

// ── 5. Make CLI entry executable ────────────────────────────────────
const cliEntry = path.join(DIST, 'cli', 'index.js');
if (fs.existsSync(cliEntry)) fs.chmodSync(cliEntry, 0o755);

// ── 6. Build & copy web UI (opt-in) ─────────────────────────────────
// Web UI is a separate package and is only required in the published
// tarball, so it is built by `prepack --web`, not by `prepare`. Serve
// falls back to the landing page when web/ is absent. CLI-only builds
// delete stale web/ except during npm pack/publish prepare, which must
// keep the prepack output.
runWebBuild({ root: ROOT, dist: DIST, timeoutMs: BUILD_TIMEOUT_MS });

console.log(`[build] done — rewrote ${rewritten} files.`);
