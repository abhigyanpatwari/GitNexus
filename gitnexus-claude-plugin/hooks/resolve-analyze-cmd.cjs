/**
 * Single source of truth for how docs, hooks, and warnings invoke gitnexus.
 *
 * Selection order: a global `gitnexus` binary, then `pnpm dlx` (avoids the
 * npm 11.x npx/arborist "node.target is null" install crash, #1939), then a
 * pinned `npx`.
 *
 * This stays self-contained CJS because the Claude/Antigravity hooks run as
 * standalone files copied into the user's hook dir, where no package import is
 * available. The CLI reuses this module from src/cli/resolve-invocation.ts via
 * createRequire rather than re-implementing it, so the gitnexus/pnpm/npx
 * decision lives in exactly one place. Shipped in two packages —
 * gitnexus/hooks/claude/ (the canonical copy the CLI and `gitnexus setup` read)
 * and gitnexus-claude-plugin/hooks/ — kept byte-identical by
 * resolve-invocation.test.ts. Edit both together.
 */

const { execFileSync } = require('child_process');

const NPX_REF = 'gitnexus@latest';

// PATH-probe timeout, kept well under Claude Code's 10s hook budget. The
// stale-index hook may run `git rev-parse` (~3s) plus up to two probes
// (gitnexus, then pnpm), so a low cap bounds the worst case while a healthy
// `which`/`where` returns in well under a second.
const PROBE_TIMEOUT_MS = 2000;

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

/**
 * Resolve `gitnexus` | `pnpm` | `npx`. `GITNEXUS_INVOCATION` forces a mode
 * (test/escape hatch). `probe` is injectable so the preference order can be
 * unit-tested without spawning; it defaults to the real PATH probe.
 */
function resolveInvocationMode(probe = resolveOnPath) {
  const forced = process.env.GITNEXUS_INVOCATION?.trim().toLowerCase();
  if (forced === 'gitnexus' || forced === 'pnpm' || forced === 'npx') {
    return forced;
  }
  if (probe('gitnexus', true)) return 'gitnexus';
  if (probe('pnpm')) return 'pnpm';
  return 'npx';
}

function formatAnalyzeCommand(options = {}) {
  const suffix = options.embeddings ? ' --embeddings' : '';
  const mode = resolveInvocationMode();
  if (mode === 'gitnexus') return `gitnexus analyze${suffix}`;
  if (mode === 'pnpm') return `pnpm dlx ${NPX_REF} analyze${suffix}`;
  return `npx ${NPX_REF} analyze${suffix}`;
}

module.exports = {
  formatAnalyzeCommand,
  resolveInvocationMode,
  pickPathMatch,
  NPX_REF,
};
