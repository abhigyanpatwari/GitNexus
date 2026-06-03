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
  formatDocumentationDlxCommand: (
    gitnexusArgs: string,
    options?: { embeddings?: boolean },
  ) => string;
  NPX_REF: string;
}

const { resolveInvocationMode, formatDocumentationDlxCommand, NPX_REF } = createRequire(
  import.meta.url,
  // `require()` returns `any`; go through `unknown` so the cast reads as an
  // explicit narrowing to the subset this module uses, not a claim that the
  // cjs's full export shape is known here. The drift guard below verifies it.
)('../../hooks/claude/resolve-analyze-cmd.cjs') as unknown as InvocationResolver;

// Fail loud at module load if the canonical cjs export shape drifts (e.g. a
// renamed export), rather than as a late TypeError inside warnIfNpm11NpxRisk.
if (
  typeof resolveInvocationMode !== 'function' ||
  typeof formatDocumentationDlxCommand !== 'function' ||
  typeof NPX_REF !== 'string'
) {
  throw new Error(
    'resolve-analyze-cmd.cjs must export resolveInvocationMode (function), formatDocumentationDlxCommand (function), and NPX_REF (string)',
  );
}

export { NPX_REF };

// Re-implemented here (rather than reusing the cjs export) so vitest's
// `vi.mock('node:child_process')` intercepts it — the cjs uses bare
// `require('child_process')`, which the mock cannot reach. Timeout matches the
// cjs PROBE_TIMEOUT_MS (1s) so this CLI probe shares the same hook-budget cap;
// `npm --version` is a sub-second local call.
export function getNpmMajorVersion(): number | null {
  try {
    const output = execFileSync('npm', ['--version'], {
      encoding: 'utf-8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      // Windows `npm` is a `.cmd` shim; without a shell execFileSync ENOENTs
      // (CVE-2024-27980) and the npm-11 npx-crash warning below would never
      // fire on Windows. Mirrors probeVersion in resolve-analyze-cmd.cjs.
      shell: process.platform === 'win32',
    });
    // Read the first version-shaped line so a Corepack/update banner on stdout
    // doesn't defeat the parse (mirrors the cjs probeVersion hardening).
    const major = output
      .split('\n')
      .map((l) => l.trim())
      .find((l) => /^v?\d+\./.test(l))
      ?.match(/^v?(\d+)\./);
    return major ? Number(major[1]) : null;
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
      `(npm/arborist "node.target is null"). Prefer: ${formatDocumentationDlxCommand('analyze')} ` +
      `or npm install -g ${NPX_REF}. See https://github.com/abhigyanpatwari/GitNexus/issues/1939\n`,
  );
}
