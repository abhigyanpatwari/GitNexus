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
// The web UI is a SEPARATE package with its own ~650-package dependency
// tree (React, Vite, LangChain, Mermaid). It is only needed inside the
// published tarball (`files: [... "web"]`), so it is built by `prepack`,
// not by `prepare`. Building it from `prepare` made every plain
// `npm ci` in gitnexus/ install and Vite-build a second product — on CI
// that ran uncached inside an execSync timeout and SIGTERM'd healthy
// installs mid-flight (#1048 introduced it; the node-floor-compat job
// died on it). `gitnexus serve` degrades to the built-in landing page
// when web/ is absent, so the default build staying CLI-only is safe.
const WEB_ROOT = path.resolve(ROOT, '..', 'gitnexus-web');
const WEB_DEST = path.join(DIST, '..', 'web');
const buildWeb = process.argv.includes('--web') || process.env.GITNEXUS_BUILD_WEB === '1';

if (!buildWeb) {
  console.log('[build] skipping web UI (pass --web or set GITNEXUS_BUILD_WEB=1 to include it)');
} else if (!fs.existsSync(path.join(WEB_ROOT, 'package.json'))) {
  console.log('[build] skipping web UI (gitnexus-web not found)');
} else {
  console.log('[build] building gitnexus-web…');
  if (!fs.existsSync(path.join(WEB_ROOT, 'node_modules'))) {
    // Deliberately untimed: this is a full second install, and killing it
    // partway through leaves a broken tree and a misleading ETIMEDOUT.
    // CI should install gitnexus-web itself (cached, its own step) so this
    // fallback only fires for a local `npm pack` / `npm publish`.
    console.log('[build] installing gitnexus-web dependencies (no local node_modules)…');
    execSync('npm ci', { cwd: WEB_ROOT, stdio: 'inherit' });
  }
  execSync('npm run build', { cwd: WEB_ROOT, stdio: 'inherit', timeout: BUILD_TIMEOUT_MS });

  // Copy dist → gitnexus/web/ (shipped in the npm package)
  fs.rmSync(WEB_DEST, { recursive: true, force: true });
  fs.cpSync(path.join(WEB_ROOT, 'dist'), WEB_DEST, { recursive: true });
  console.log('[build] copied web UI → gitnexus/web/');
}

console.log(`[build] done — rewrote ${rewritten} files.`);
