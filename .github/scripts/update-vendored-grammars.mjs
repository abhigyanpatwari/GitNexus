#!/usr/bin/env node
/**
 * Vendored tree-sitter grammar update monitor.
 *
 * Checks each vendored grammar against its upstream source-of-origin and, for an
 * available AND ABI-compatible update, re-vendors the grammar source in place so
 * a PR can be opened. The version bump in vendor/<name>/package.json then triggers
 * .github/workflows/build-tree-sitter-prebuilds.yml, which cross-builds + ABI-
 * validates the prebuilds — so even an imperfect re-vendor can never silently
 * ship: its PR's CI goes red.
 *
 * ABI awareness is load-bearing. Every grammar is pinned to tree-sitter@0.21.1
 * (LANGUAGE_VERSION 13–14, the #1922 gate). Most upstream grammar releases target
 * a newer tree-sitter, so a blind "bump to latest" would pull an ABI-incompatible
 * parser and open doomed PRs. This monitor fetches the candidate source, reads its
 * parser.c `#define LANGUAGE_VERSION`, and only re-vendors when it is 13 or 14;
 * incompatible updates are reported (and surfaced as a workflow notice), not
 * applied.
 *
 * Usage:
 *   node update-vendored-grammars.mjs            # detect only → JSON report on stdout
 *   node update-vendored-grammars.mjs --apply X  # re-vendor grammar X in place
 *
 * tree-sitter-c is MONITORED but report-only (`hold`): it is ABI-pinned at 0.21.4
 * (#1242/#858) and must not auto-bump without a tree-sitter runtime upgrade, so an
 * available c update is detected + reported but never auto-applied — even if it is
 * ABI-13/14. A maintainer re-vendors it deliberately.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const VENDOR = path.join(REPO_ROOT, 'gitnexus', 'vendor');

const COMPATIBLE_ABI = new Set([13, 14]); // tree-sitter@0.21.1 LANGUAGE_VERSION range

// Source-of-origin per grammar. npm grammars resolve `latest` via the registry;
// github grammars (no usable npm release) track the default branch HEAD. A `hold`
// reason makes a grammar report-only: updates are detected + surfaced but never
// auto-applied (c is ABI-pinned and must not move without a runtime upgrade).
const GRAMMARS = {
  c: {
    name: 'tree-sitter-c',
    npm: 'tree-sitter-c',
    hold: 'ABI-pinned at 0.21.4 (#1242/#858) — needs a tree-sitter runtime upgrade before bumping',
  },
  swift: { name: 'tree-sitter-swift', npm: 'tree-sitter-swift' },
  kotlin: { name: 'tree-sitter-kotlin', npm: 'tree-sitter-kotlin' },
  dart: { name: 'tree-sitter-dart', github: 'UserNobody14/tree-sitter-dart' },
  proto: { name: 'tree-sitter-proto', github: 'coder3101/tree-sitter-proto' },
};

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();

const clean = (v) =>
  String(v || '')
    .replace(/^[v^~]/, '')
    .trim();

function vendoredVersion(g) {
  const p = path.join(VENDOR, g.name, 'package.json');
  return clean(JSON.parse(fs.readFileSync(p, 'utf8')).version);
}

/** Resolve the upstream candidate: { version, ref, kind }. */
function resolveUpstream(g) {
  if (g.npm) {
    const version = clean(sh('npm', ['view', g.npm, 'version']));
    return { version, ref: version, kind: 'npm' };
  }
  // github: no reliable release tags here, so track the default branch HEAD sha.
  const meta = JSON.parse(sh('gh', ['api', `repos/${g.github}`]));
  const branch = meta.default_branch;
  const sha = JSON.parse(sh('gh', ['api', `repos/${g.github}/commits/${branch}`])).sha;
  // Version key: "<upstreamPkgVersion>-g<sha7>" — safeRef-compatible (no `+`,
  // which the build workflow's ref validator rejects) and changes on every commit.
  let base = '0.0.0';
  try {
    const pkg = JSON.parse(
      Buffer.from(
        JSON.parse(sh('gh', ['api', `repos/${g.github}/contents/package.json?ref=${sha}`])).content,
        'base64',
      ).toString('utf8'),
    );
    if (pkg.version) base = clean(pkg.version);
  } catch {
    /* no upstream package.json — base stays 0.0.0 */
  }
  return { version: `${base}-g${sha.slice(0, 7)}`, ref: sha, kind: 'github' };
}

/** Fetch the candidate source into a temp dir; return the package root. */
function fetchSource(g, ref) {
  const work = fs.mkdtempSync(
    path.join(os.tmpdir(), `revendor-${Object.keys(GRAMMARS).find((k) => GRAMMARS[k] === g)}-`),
  );
  if (g.npm) {
    sh('npm', ['pack', `${g.npm}@${ref}`, '--silent'], { cwd: work });
    const tgz = fs.readdirSync(work).find((f) => f.endsWith('.tgz'));
    sh('tar', ['xzf', tgz], { cwd: work });
    return path.join(work, 'package');
  }
  // github tarball at the resolved sha. Download + extract WITHOUT a shell
  // (no `bash -c`/redirect): `gh api` writes the binary tarball to stdout, which
  // we capture as a Buffer and write to a fixed path, then extract with execFile.
  // Avoids the shell-command-injection surface CodeQL flags when an API-derived
  // ref is interpolated into a `bash -c` string.
  const tgz = path.join(work, 'src.tgz');
  fs.writeFileSync(
    tgz,
    execFileSync('gh', ['api', `repos/${g.github}/tarball/${ref}`], {
      maxBuffer: 512 * 1024 * 1024,
    }),
  );
  sh('tar', ['xzf', tgz], { cwd: work });
  const dir = fs.readdirSync(work).find((f) => fs.statSync(path.join(work, f)).isDirectory());
  return path.join(work, dir);
}

/** Read parser.c's LANGUAGE_VERSION (ABI). Prefer the ABI-14 default parser.c. */
function readAbi(srcRoot) {
  const candidates = ['src/parser.c', 'parser.c'];
  for (const rel of candidates) {
    const p = path.join(srcRoot, rel);
    if (!fs.existsSync(p)) continue;
    // Read only the head — the #define is near the top.
    const head = fs.readFileSync(p, 'utf8').slice(0, 4000);
    const m = head.match(/#define\s+LANGUAGE_VERSION\s+(\d+)/);
    if (m) return Number(m[1]);
  }
  return null; // unknown (e.g. parser.c only generated at build time)
}

function detect() {
  const report = [];
  for (const [key, g] of Object.entries(GRAMMARS)) {
    const have = vendoredVersion(g);
    let up;
    try {
      up = resolveUpstream(g);
    } catch (err) {
      report.push({ grammar: key, error: String(err.message || err) });
      continue;
    }
    const newer = up.kind === 'npm' ? up.version !== have : !have || up.ref.slice(0, 7) !== have;
    let abi = null;
    if (newer) {
      try {
        abi = readAbi(fetchSource(g, up.ref));
      } catch {
        /* fetch/abi best-effort; null = unknown */
      }
    }
    report.push({
      grammar: key,
      vendored: have,
      upstream: up.version,
      ref: up.ref,
      kind: up.kind,
      update: newer,
      abi,
      abiCompatible: abi == null ? null : COMPATIBLE_ABI.has(abi),
      hold: g.hold || null,
      // Auto-appliable only when there's an update, the ABI is known-compatible,
      // AND the grammar is not on a policy hold (c).
      applicable: newer && abi != null && COMPATIBLE_ABI.has(abi) && !g.hold,
    });
  }
  return report;
}

const copyFile = (srcRoot, dest, rel) => {
  const from = path.join(srcRoot, rel);
  if (!fs.existsSync(from)) return false;
  const to = path.join(dest, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  return true;
};

/**
 * Re-vendor one grammar in place from its ABI-compatible upstream candidate.
 * Copies ONLY the generated source-build + runtime files; deliberately KEEPS the
 * GitNexus-hardened binding.gyp (Windows cflags, target_name), README (vendor
 * notice), LICENSE, and prebuilds/ (the build workflow refreshes those). Bumps the
 * stripped vendor package.json version + provenance — never re-introduces
 * scripts/dependencies (#836/#1728). Returns the new version.
 */
function apply(key) {
  const g = GRAMMARS[key];
  if (!g) {
    console.error(`unknown grammar '${key}'`);
    process.exit(2);
  }
  if (g.hold) {
    console.error(
      `${key}: report-only (${g.hold}); not auto-applied. Re-vendor manually if intended.`,
    );
    process.exit(3);
  }
  const have = vendoredVersion(g);
  const up = resolveUpstream(g);
  const newer = up.kind === 'npm' ? up.version !== have : !have || up.version !== have;
  if (!newer) {
    console.error(`${key}: already current (${have}); nothing to apply.`);
    process.exit(0);
  }
  const srcRoot = fetchSource(g, up.ref);
  const abi = readAbi(srcRoot);
  if (abi == null || !COMPATIBLE_ABI.has(abi)) {
    console.error(
      `${key}: candidate ${up.version} is ABI ${abi ?? 'unknown'} — not tree-sitter@0.21.1 ` +
        `compatible (need 13/14); refusing to re-vendor. Handle manually.`,
    );
    process.exit(3);
  }

  const dest = path.join(VENDOR, g.name);
  // The source-build inputs + runtime entrypoints that change between versions.
  // binding.gyp / README / LICENSE / prebuilds are intentionally NOT touched.
  for (const rel of [
    'src/parser.c',
    'src/scanner.c',
    'src/node-types.json',
    'src/tree_sitter/alloc.h',
    'src/tree_sitter/array.h',
    'src/tree_sitter/parser.h',
    'bindings/node/binding.cc',
    'bindings/node/index.js',
    'bindings/node/index.d.ts',
  ]) {
    copyFile(srcRoot, dest, rel);
  }

  const pkgPath = path.join(dest, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.version = up.version;
  pkg._vendoredBy =
    `gitnexus - re-vendored from ${g.npm ? `npm ${g.npm}@${up.version}` : `${g.github}@${up.ref}`} ` +
    `by grammar-update-monitor on ABI ${abi}. Source-build inputs (parser.c/scanner.c/src/) refreshed; ` +
    `the GitNexus-hardened binding.gyp + vendor README + prebuilds are preserved (prebuilds are ` +
    `rebuilt by build-tree-sitter-prebuilds.yml on this version change). No scripts/dependencies here ` +
    `(#836/#1728).`;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

  console.log(`${key}: re-vendored ${g.name} → ${up.version} (ABI ${abi}).`);
  return up.version;
}

// Run the CLI only when invoked directly (not when imported by a test) — detect()
// makes live network calls, so importing must be side-effect-free.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (process.argv[2] === '--apply') {
    apply(process.argv[3]);
  } else {
    process.stdout.write(JSON.stringify(detect(), null, 2) + '\n');
  }
}

export { detect, apply, resolveUpstream, readAbi, vendoredVersion, GRAMMARS, COMPATIBLE_ABI };
