/**
 * Single source of truth for how docs, hooks, and warnings invoke gitnexus.
 *
 * Automatically selects a working invocation path:
 * 1. Global `gitnexus` on PATH (best — no install step)
 * 2. npm 11+ with pnpm on PATH → `pnpm dlx --allow-build=…` (avoids the npx
 *    arborist crash *and* pnpm 10+ ignored-build-script failures, #1939)
 * 3. npm < 11 with npm on PATH → `npx` (works; simpler than pnpm dlx)
 * 4. pnpm-only → `pnpm dlx --allow-build=…`
 * 5. Last resort → `npx` (warned on npm 11+ from analyze.ts)
 *
 * This stays self-contained CJS because the Claude/Antigravity hooks run as
 * standalone files copied into the user's hook dir, where no package import is
 * available. The CLI reuses this module from src/cli/resolve-invocation.ts via
 * createRequire rather than re-implementing it. Shipped in two packages —
 * gitnexus/hooks/claude/ (the canonical copy the CLI and `gitnexus setup` read)
 * and gitnexus-claude-plugin/hooks/ — kept byte-identical by
 * resolve-invocation.test.ts. Edit both together.
 */

const { execFileSync } = require('child_process');

const NPX_REF = 'gitnexus@latest';

// Native packages whose postinstall must run under pnpm 10+ (blocked by default).
const PNPM_ALLOW_BUILD_BASE = ['@ladybugdb/core', 'gitnexus', 'tree-sitter'];
const PNPM_ALLOW_BUILD_EMBEDDINGS = ['onnxruntime-node'];

// PATH-probe timeout, kept well under Claude Code's 10s hook budget. In a
// linked worktree the stale-index hook runs `git rev-parse --git-common-dir`
// (~2s) and `git rev-parse HEAD` (~3s) before up to two probes (gitnexus, then
// pnpm), so a 1s cap holds the worst case near ~7s with comfortable headroom; a
// healthy `which`/`where` returns in well under a second.
const PROBE_TIMEOUT_MS = 1000;

/**
 * Pick the best match from `where`/`which` output. A global `gitnexus` may be a
 * `.cmd`/`.bat` (npm), a `.exe`, or an extensionless shim (Volta, scoop), so on
 * Windows we prefer a recognized executable extension but accept any hit — the
 * emitted hint is `gitnexus analyze` regardless of which shim resolves it. Pure
 * and exported so the shim-matching can be unit-tested without spawning.
 */
function pickPathMatch(output, { isWin, gitnexusWrapper } = {}) {
  const lines = output
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (isWin && gitnexusWrapper) {
    return lines.find((l) => /\.(cmd|bat|exe)$/i.test(l)) || lines[0] || null;
  }
  return lines[0] || null;
}

/** Absolute path to `command` on PATH, or null. `gitnexusWrapper` enables the Windows shim match. */
function resolveOnPath(command, gitnexusWrapper = false) {
  const isWin = process.platform === 'win32';
  try {
    const output = execFileSync(isWin ? 'where' : 'which', [command], {
      encoding: 'utf-8',
      timeout: PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return pickPathMatch(output, { isWin, gitnexusWrapper });
  } catch {
    return null;
  }
}

function parseMajorVersion(command, deps = {}) {
  if (deps[command] !== undefined) return deps[command];
  try {
    const output = execFileSync(command, ['--version'], {
      encoding: 'utf-8',
      timeout: PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const major = parseInt(output.trim().split('.')[0] ?? '', 10);
    return Number.isFinite(major) ? major : null;
  } catch {
    return null;
  }
}

function getNpmMajorVersion(deps = {}) {
  return parseMajorVersion('npm', deps);
}

function getPnpmMajorVersion(deps = {}) {
  return parseMajorVersion('pnpm', deps);
}

/**
 * `--allow-build` flags for pnpm 10+ (ignored for pnpm < 10 where scripts run
 * by default). `alwaysAllowBuild` forces flags for committed documentation.
 */
function formatPnpmAllowBuildArgs(options = {}, deps = {}) {
  const pnpmMajor = deps.pnpmMajor ?? getPnpmMajorVersion(deps);
  if (!options.alwaysAllowBuild && pnpmMajor !== null && pnpmMajor < 10) {
    return [];
  }
  const pkgs = [...PNPM_ALLOW_BUILD_BASE];
  if (options.embeddings) pkgs.push(...PNPM_ALLOW_BUILD_EMBEDDINGS);
  return pkgs.map((p) => `--allow-build=${p}`);
}

/** Fixed install-free command for committed AGENTS.md / SKILL.md (pnpm 10+ safe). */
function formatDocumentationDlxCommand(gitnexusArgs, options = {}) {
  const flags = formatPnpmAllowBuildArgs({ ...options, alwaysAllowBuild: true }).join(' ');
  const prefix = flags ? `${flags} ` : '';
  return `pnpm dlx ${prefix}${NPX_REF} ${gitnexusArgs}`;
}

/**
 * Resolve `gitnexus` | `pnpm` | `npx`. `GITNEXUS_INVOCATION` forces a mode
 * (test/escape hatch). `probe` is injectable so the preference order can be
 * unit-tested without spawning; it defaults to the real PATH probe. `deps` can
 * inject `{ npmMajor, pnpmMajor }` for tests.
 */
function resolveInvocationMode(probe = resolveOnPath, deps = {}) {
  const pathProbe = probe ?? resolveOnPath;
  const forced = process.env.GITNEXUS_INVOCATION?.trim().toLowerCase();
  if (forced === 'gitnexus' || forced === 'pnpm' || forced === 'npx') {
    return forced;
  }
  if (pathProbe('gitnexus', true)) return 'gitnexus';

  const npmMajor = deps.npmMajor ?? getNpmMajorVersion(deps);
  const hasPnpm = Boolean(pathProbe('pnpm'));

  // npm 11+ npx install crash (#1939) — prefer pnpm dlx when available.
  if (hasPnpm && npmMajor !== null && npmMajor >= 11) return 'pnpm';
  // npm 10 and earlier: npx works; prefer it over pnpm dlx when npm is present.
  if (npmMajor !== null && npmMajor < 11) return 'npx';
  // npm absent or unreadable — use pnpm if present (with allow-build flags).
  if (hasPnpm) return 'pnpm';

  return 'npx';
}

function formatPnpmDlxCommand(gitnexusArgs, options = {}, deps = {}) {
  const flags = formatPnpmAllowBuildArgs(options, deps).join(' ');
  const prefix = flags ? `${flags} ` : '';
  return `pnpm dlx ${prefix}${NPX_REF} ${gitnexusArgs}`;
}

function formatAnalyzeCommand(options = {}, deps = {}) {
  const suffix = options.embeddings ? ' --embeddings' : '';
  const mode = resolveInvocationMode(undefined, deps);
  if (mode === 'gitnexus') return `gitnexus analyze${suffix}`;
  if (mode === 'pnpm') return `${formatPnpmDlxCommand(`analyze${suffix}`, options, deps)}`;
  return `npx ${NPX_REF} analyze${suffix}`;
}

module.exports = {
  formatAnalyzeCommand,
  formatDocumentationDlxCommand,
  formatPnpmAllowBuildArgs,
  formatPnpmDlxCommand,
  resolveInvocationMode,
  pickPathMatch,
  getNpmMajorVersion,
  getPnpmMajorVersion,
  NPX_REF,
  PNPM_ALLOW_BUILD_BASE,
};
