/**
 * Shared analyze-command hint for Claude/Antigravity hooks (CJS).
 *
 * Duplicated byte-for-byte in gitnexus/hooks/claude/ and
 * gitnexus-claude-plugin/hooks/, and mirrors src/cli/resolve-invocation.ts.
 * resolve-invocation.test.ts enforces both: the two CJS copies stay
 * byte-identical, and NPX_REF + the emitted command per mode + the Windows
 * shim regex match the TS source. Edit all three copies together.
 */

const { execFileSync } = require('child_process');

const NPX_REF = 'gitnexus@latest';

function resolveOnPath(command, winGitnexusWrapper = false) {
  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'where' : 'which';
  try {
    const output = execFileSync(cmd, [command], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const lines = output
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (isWin && winGitnexusWrapper) {
      // A global gitnexus may be a .cmd/.bat (npm), a .exe, or an extensionless
      // shim (Volta, scoop). Any non-empty `where` hit means it is on PATH; the
      // emitted hint is `gitnexus analyze` regardless of which shim resolves it.
      return lines.find((l) => /\.(cmd|bat|exe)$/i.test(l)) || lines[0] || null;
    }
    return lines[0] || null;
  } catch {
    return null;
  }
}

function resolveInvocationMode() {
  const forced = process.env.GITNEXUS_INVOCATION?.trim().toLowerCase();
  if (forced === 'gitnexus' || forced === 'pnpm' || forced === 'npx') {
    return forced;
  }
  if (resolveOnPath('gitnexus', true)) return 'gitnexus';
  if (resolveOnPath('pnpm')) return 'pnpm';
  return 'npx';
}

function formatAnalyzeCommand(options = {}) {
  const suffix = options.embeddings ? ' --embeddings' : '';
  const mode = resolveInvocationMode();
  if (mode === 'gitnexus') return `gitnexus analyze${suffix}`;
  if (mode === 'pnpm') return `pnpm dlx ${NPX_REF} analyze${suffix}`;
  return `npx ${NPX_REF} analyze${suffix}`;
}

module.exports = { formatAnalyzeCommand, resolveInvocationMode, NPX_REF };
