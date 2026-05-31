/**
 * npm 11.x npx-install-crash nudge for the `analyze` command (#1939).
 *
 * The gitnexus/pnpm/npx selection itself lives in the canonical hook helper
 * (hooks/claude/resolve-analyze-cmd.cjs) — self-contained CJS because the copied
 * hook runtime cannot import from the package. We reuse it here via createRequire
 * instead of re-implementing it, so there is one source of truth for the
 * invocation decision. This module adds only the npm-version probe and the
 * warning, which are CLI-only. The relative path resolves identically from
 * src/cli/ (tsx, vitest) and dist/cli/ (shipped), since both sit one level under
 * the package root and `hooks/` is published.
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

type InvocationMode = 'gitnexus' | 'pnpm' | 'npx';

interface InvocationResolver {
  // `probe` is injectable in the cjs (defaults to the real PATH probe) so the
  // preference order is unit-testable without spawning; the CLI calls it with
  // no argument.
  resolveInvocationMode: (
    probe?: (command: string, gitnexusWrapper?: boolean) => string | null,
  ) => InvocationMode;
  NPX_REF: string;
}

const { resolveInvocationMode, NPX_REF } = createRequire(import.meta.url)(
  '../../hooks/claude/resolve-analyze-cmd.cjs',
) as InvocationResolver;

// Fail loud at module load if the canonical cjs export shape drifts (e.g. a
// renamed export), rather than as a late TypeError inside warnIfNpm11NpxRisk.
if (typeof resolveInvocationMode !== 'function' || typeof NPX_REF !== 'string') {
  throw new Error(
    'resolve-analyze-cmd.cjs must export resolveInvocationMode (function) and NPX_REF (string)',
  );
}

export { NPX_REF };

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

/**
 * One-line stderr nudge when an npm 11+ user is on the npx install path (#1939).
 * Skipped when a global `gitnexus` or `pnpm` is already preferred, so it never
 * nags users who are not exposed to the npx/arborist crash.
 */
export function warnIfNpm11NpxRisk(): void {
  if (resolveInvocationMode() !== 'npx') return;
  const major = getNpmMajorVersion();
  if (major === null || major < 11) return;
  process.stderr.write(
    `Warning: npm ${major}.x can crash while installing gitnexus via npx ` +
      `(npm/arborist "node.target is null"). Prefer: pnpm dlx ${NPX_REF} analyze ` +
      `or npm install -g ${NPX_REF}. See https://github.com/abhigyanpatwari/GitNexus/issues/1939\n`,
  );
}
