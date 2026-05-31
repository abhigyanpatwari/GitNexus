/**
 * Shared analyze-command hint for Claude/Antigravity hooks (CJS).
 *
 * Duplicated byte-for-byte in gitnexus/hooks/claude/ and
 * gitnexus-claude-plugin/hooks/; resolve-invocation.test.ts enforces parity.
 * Mirrors src/cli/resolve-invocation.ts — edit all copies together.
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
      return lines.find((l) => /\.(cmd|bat)$/i.test(l)) || null;
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
