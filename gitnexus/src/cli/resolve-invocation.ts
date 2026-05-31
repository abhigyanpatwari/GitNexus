/**
 * Resolve how to invoke gitnexus from docs, hooks, and warnings.
 *
 * Prefers a global `gitnexus` binary, then `pnpm dlx` (avoids npm 11.x npx
 * arborist crashes — #1939), then pinned `npx`.
 */

import { execFileSync } from 'node:child_process';

// Invocation hints standardize on `gitnexus@latest`: the safety this delivers
// is the *method* steered to (global / `pnpm dlx`), not a pinned version, and
// the in-repo CJS mirror already degrades to `latest` once copied outside the
// package. The version-pinned MCP-registration ref lives separately in setup.ts.
export const NPX_REF = 'gitnexus@latest';

export type InvocationMode = 'gitnexus' | 'pnpm' | 'npx';

let npm11Warned = false;

function resolveOnPath(command: string, winGitnexusWrapper = false): string | null {
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

/** Absolute path to a spawnable global `gitnexus` binary, or null. */
export function resolveGitnexusBin(): string | null {
  return resolveOnPath('gitnexus', true);
}

export function isPnpmOnPath(): boolean {
  return resolveOnPath('pnpm') !== null;
}

export function getNpmMajorVersion(): number | null {
  try {
    const output = execFileSync('npm', ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const major = parseInt(output.trim().split('.')[0] ?? '', 10);
    return Number.isFinite(major) ? major : null;
  } catch {
    return null;
  }
}

/** Test hook: force `gitnexus` | `pnpm` | `npx` invocation hints. */
export function resolveInvocationMode(): InvocationMode {
  const forced = process.env.GITNEXUS_INVOCATION?.trim().toLowerCase();
  if (forced === 'gitnexus' || forced === 'pnpm' || forced === 'npx') {
    return forced;
  }
  if (resolveGitnexusBin()) return 'gitnexus';
  if (isPnpmOnPath()) return 'pnpm';
  return 'npx';
}

export function formatAnalyzeCommand(options?: { embeddings?: boolean }): string {
  const suffix = options?.embeddings ? ' --embeddings' : '';
  const mode = resolveInvocationMode();
  if (mode === 'gitnexus') return `gitnexus analyze${suffix}`;
  if (mode === 'pnpm') return `pnpm dlx ${NPX_REF} analyze${suffix}`;
  return `npx ${NPX_REF} analyze${suffix}`;
}

/** One-line stderr warning when npm 11+ users are on the npx install path (#1939). */
export function warnIfNpm11NpxRisk(): void {
  if (npm11Warned) return;
  if (resolveInvocationMode() !== 'npx') return;
  const major = getNpmMajorVersion();
  if (major === null || major < 11) return;
  npm11Warned = true;
  process.stderr.write(
    `Warning: npm ${major}.x can crash while installing gitnexus via npx ` +
      `(npm/arborist "node.target is null"). Prefer: pnpm dlx ${NPX_REF} analyze ` +
      `or npm install -g ${NPX_REF}. See https://github.com/abhigyanpatwari/GitNexus/issues/1939\n`,
  );
}
