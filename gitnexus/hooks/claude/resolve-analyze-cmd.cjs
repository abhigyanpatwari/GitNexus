/**
 * Single source of truth for how docs, hooks, and warnings invoke gitnexus.
 *
 * Automatically selects a working invocation path:
 * 1. Global `gitnexus` on PATH (best — no install step)
 * 2. npm 11+ with pnpm on PATH → `pnpm --allow-build=… dlx` (avoids the npx
 *    arborist crash *and* pnpm 10+ ignored-build-script failures, #1939)
 * 3. npm < 11 with npm on PATH → `npx` (works; simpler than pnpm dlx)
 * 4. pnpm-only → `pnpm --allow-build=… dlx`
 * 5. Last resort → `npx` (warned on npm 11+ from analyze.ts)
 *
 * The `--allow-build` flags MUST precede the `dlx` token. pnpm < 10.14 keeps
 * `dlx` in its argv escape list, so flags placed *after* `dlx` are parsed as
 * package specs (ERR_PNPM_SPEC_NOT_SUPPORTED). The pre-`dlx` position parses
 * into dlx's allow-build option and has been honored since pnpm 10.2.0 (#1939).
 *
 * This stays self-contained CJS because the Claude/Antigravity hooks run as
 * standalone files copied into the user's hook dir, where no package import is
 * available. The CLI reuses this module from src/cli/resolve-invocation.ts via
 * createRequire rather than re-implementing it. Two committed copies must stay
 * byte-identical (enforced by resolve-invocation.test.ts) — edit both together:
 * gitnexus/hooks/claude/ (the canonical copy the CLI and `gitnexus setup` read)
 * and gitnexus-claude-plugin/hooks/. A THIRD copy is written at runtime to
 * `<repo>/.gitnexus/run.cjs` by `gitnexus analyze` (ai-context.ts) so docs can
 * reference it directly via the `require.main === module` exec tail below; that
 * copy is gitignored and refreshed on every analyze, so it cannot drift for long.
 */

const { execFileSync } = require('child_process');

const NPX_REF = 'gitnexus@latest';

// Native packages whose postinstall must run under pnpm 10+ (blocked by default).
const PNPM_ALLOW_BUILD_BASE = ['@ladybugdb/core', 'gitnexus', 'tree-sitter'];
const PNPM_ALLOW_BUILD_EMBEDDINGS = ['onnxruntime-node'];

// Probe timeout, kept under Claude Code's 10s hook budget. In a linked worktree
// the stale-index hook first runs `git rev-parse --git-common-dir` (~2s) and
// `git rev-parse HEAD` (~3s); the pnpm path then adds up to four 1s probes
// (which gitnexus, npm --version, which pnpm, pnpm --version), so the worst case
// is ~9s — within budget but tight. A healthy `which`/`where`/`--version`
// returns in well under a second, so the realistic cost is far lower.
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

// One spawn of `<command> --version` → { major, minor } (each null when
// unreadable). Version injection happens at the resolver seam (getNpmMajorVersion
// / formatPnpmAllowBuildArgs), so this stays a pure real-process probe.
function probeVersion(command) {
  try {
    const output = execFileSync(command, ['--version'], {
      encoding: 'utf-8',
      timeout: PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      // On Windows, npm/pnpm resolve to `.cmd` shims; execFileSync does no
      // PATHEXT resolution and Node refuses to spawn `.cmd`/`.bat` without a
      // shell (CVE-2024-27980), so a bare `<command> --version` ENOENTs and the
      // probe would wrongly report a present tool as absent. A shell lets the OS
      // resolve the shim. POSIX needs no shell (direct PATH lookup works).
      shell: process.platform === 'win32',
    });
    // Find the first line that starts with a version token (`MAJOR.MINOR`,
    // optional `v` prefix) rather than splitting the whole output — pnpm/npm
    // under Corepack or with an update notice can print a banner line on stdout
    // before the version (stderr is already dropped via the stdio config).
    const versionLine = output
      .split('\n')
      .map((l) => l.trim())
      .find((l) => /^v?\d+\.\d+/.test(l));
    const match = versionLine ? versionLine.match(/^v?(\d+)\.(\d+)/) : null;
    return {
      major: match ? Number(match[1]) : null,
      minor: match ? Number(match[2]) : null,
    };
  } catch {
    return { major: null, minor: null };
  }
}

// `deps` is the single injection seam: an explicitly provided key — including a
// `null` value, detected via `in` — is honored as-is so tests can simulate an
// absent tool without spawning; an absent key falls through to the real probe.
function getNpmMajorVersion(deps = {}) {
  return 'npmMajor' in deps ? deps.npmMajor : probeVersion('npm').major;
}

/**
 * `--allow-build` flags for the pre-`dlx` position. Emitted for pnpm >= 10.2
 * (where the flag exists, and pnpm 10+ blocks build scripts by default). Omitted
 * below 10.2: pnpm < 10 runs build scripts anyway, and pnpm 10.0/10.1 lack the
 * flag (it would be rejected as an unknown option). `alwaysAllowBuild` forces the
 * flags for committed documentation, which cannot probe the reader's pnpm.
 */
function formatPnpmAllowBuildArgs(options = {}, deps = {}) {
  if (!options.alwaysAllowBuild) {
    const { major, minor } =
      'pnpmMajor' in deps
        ? { major: deps.pnpmMajor, minor: 'pnpmMinor' in deps ? deps.pnpmMinor : null }
        : probeVersion('pnpm');
    const lacksAllowBuild =
      major !== null && (major < 10 || (major === 10 && minor !== null && minor < 2));
    if (lacksAllowBuild) return [];
  }
  const pkgs = [...PNPM_ALLOW_BUILD_BASE];
  if (options.embeddings) pkgs.push(...PNPM_ALLOW_BUILD_EMBEDDINGS);
  return pkgs.map((p) => `--allow-build=${p}`);
}

/** Fixed install-free command for committed AGENTS.md / SKILL.md (pnpm >= 10.2). */
function formatDocumentationDlxCommand(gitnexusArgs, options = {}) {
  const flags = formatPnpmAllowBuildArgs({ ...options, alwaysAllowBuild: true }).join(' ');
  const prefix = flags ? `${flags} ` : '';
  return `pnpm ${prefix}dlx ${NPX_REF} ${gitnexusArgs}`;
}

/**
 * Resolve `gitnexus` | `pnpm` | `npx`. `GITNEXUS_INVOCATION` forces a mode
 * (test/escape hatch). `probe` is injectable so the preference order can be
 * unit-tested without spawning; it defaults to the real PATH probe. `deps` can
 * inject `{ npmMajor, pnpmMajor }` for tests.
 */
function resolveInvocationMode(probe = resolveOnPath, deps = {}) {
  const forced = process.env.GITNEXUS_INVOCATION?.trim().toLowerCase();
  if (forced === 'gitnexus' || forced === 'pnpm' || forced === 'npx') {
    return forced;
  }
  if (probe('gitnexus', true)) return 'gitnexus';

  const npmMajor = getNpmMajorVersion(deps);
  // pnpm presence: prefer an explicit `pnpmPresent` flag (set by
  // formatAnalyzeCommand, which falls back to a PATH probe when the version is
  // unreadable) so a present-but-unparseable pnpm — slow probe, Corepack
  // banner — still selects pnpm instead of the npx crash path. Otherwise an
  // injected version (a successful `pnpm --version` proves presence)
  // short-circuits the `which pnpm` probe; failing both, fall back to PATH.
  const hasPnpm =
    'pnpmPresent' in deps
      ? deps.pnpmPresent
      : 'pnpmMajor' in deps
        ? deps.pnpmMajor !== null
        : Boolean(probe('pnpm'));

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
  return `pnpm ${prefix}dlx ${NPX_REF} ${gitnexusArgs}`;
}

function formatAnalyzeCommand(options = {}, deps = {}) {
  const suffix = options.embeddings ? ' --embeddings' : '';
  // Keep the stale-index hook budget tight by querying each tool at most once.
  // A memoized PATH probe is shared with resolveInvocationMode (so `gitnexus`
  // isn't probed twice), and pnpm's version is captured by a single
  // `pnpm --version` that proves both presence (for mode resolution) and
  // version (for the allow-build gate) — replacing the former `which pnpm` +
  // `pnpm --version` double spawn. Injected deps (tests) and forced/global
  // modes skip the pnpm probe.
  const cache = new Map();
  const probe = (command, gitnexusWrapper) => {
    const key = `${command}:${gitnexusWrapper ? 1 : 0}`;
    if (!cache.has(key)) cache.set(key, resolveOnPath(command, gitnexusWrapper));
    return cache.get(key);
  };
  let resolved = deps;
  if (!('pnpmMajor' in deps)) {
    const forced = process.env.GITNEXUS_INVOCATION?.trim().toLowerCase();
    // pnpm is only consulted when no non-pnpm mode is already certain: forced
    // gitnexus/npx never use pnpm, and a present global gitnexus wins outright.
    const mightUsePnpm = forced === 'pnpm' || (forced !== 'gitnexus' && forced !== 'npx');
    if (mightUsePnpm && (forced === 'pnpm' || !probe('gitnexus', true))) {
      const { major, minor } = probeVersion('pnpm');
      // Carry presence separately from version: when the version probe fails
      // (timeout, Corepack banner) but pnpm is on PATH, still treat it as
      // present so mode resolution picks pnpm over the npx crash path. The
      // PATH probe is memoized and only runs when the version is unreadable.
      const pnpmPresent = major !== null || Boolean(probe('pnpm'));
      resolved = { ...deps, pnpmMajor: major, pnpmMinor: minor, pnpmPresent };
    }
  }
  const mode = resolveInvocationMode(probe, resolved);
  if (mode === 'gitnexus') return `gitnexus analyze${suffix}`;
  if (mode === 'pnpm') return `${formatPnpmDlxCommand(`analyze${suffix}`, options, resolved)}`;
  return `npx ${NPX_REF} analyze${suffix}`;
}

/**
 * Resolve `mode` into a concrete { program, args } pair for a set of gitnexus
 * subcommand arguments. Shared by the direct-exec entrypoint below; pure (no
 * spawn) so it is unit-testable. `--embeddings` widens the pnpm allow-build set.
 */
function buildRunnerArgv(mode, gitnexusArgs, deps = {}) {
  // Match both the space form (`--embeddings`) and the equals form
  // (`--embeddings=5000`) Commander accepts, so the pnpm allow-build set still
  // widens to onnxruntime-node when a user hand-types the equals form.
  const embeddings = gitnexusArgs.some(
    (a) => a === '--embeddings' || a.startsWith('--embeddings='),
  );
  if (mode === 'gitnexus') return { program: 'gitnexus', args: [...gitnexusArgs] };
  if (mode === 'pnpm') {
    return {
      program: 'pnpm',
      args: [...formatPnpmAllowBuildArgs({ embeddings }, deps), 'dlx', NPX_REF, ...gitnexusArgs],
    };
  }
  return { program: 'npx', args: [NPX_REF, ...gitnexusArgs] };
}

module.exports = {
  formatAnalyzeCommand,
  formatDocumentationDlxCommand,
  formatPnpmAllowBuildArgs,
  formatPnpmDlxCommand,
  resolveInvocationMode,
  buildRunnerArgv,
  pickPathMatch,
  getNpmMajorVersion,
  NPX_REF,
  PNPM_ALLOW_BUILD_BASE,
};

// Direct-exec entrypoint (#1945): `node run.cjs <gitnexus args…>` resolves the
// best available runner (global `gitnexus` → `pnpm dlx` → `npx`) at call time and
// runs it, inheriting stdio and propagating the child's exit code. This lets the
// committed skills and generated AGENTS.md/CLAUDE.md reference ONE stable,
// CLI-neutral command without baking in a package-manager assumption. `gitnexus
// analyze` drops a copy of this file at `.gitnexus/run.cjs`. Skipped on require()
// (the CLI and tests reuse the exports above), so it runs only when invoked as a
// script.
if (require.main === module) {
  const gitnexusArgs = process.argv.slice(2);
  const { program, args } = buildRunnerArgv(resolveInvocationMode(), gitnexusArgs);
  try {
    execFileSync(program, args, {
      stdio: 'inherit',
      windowsHide: true,
      // On Windows, `npx`/`pnpm`/`gitnexus` resolve to `.cmd`/`.ps1`/`.exe`
      // shims (npm, Volta, Corepack, scoop). execFileSync does not do PATHEXT
      // resolution and Node refuses to spawn `.cmd`/`.bat` without a shell
      // (CVE-2024-27980), so a bare program name ENOENTs. A shell lets the OS
      // resolve the shim; POSIX needs no shell (direct PATH lookup works).
      shell: process.platform === 'win32',
    });
  } catch (err) {
    // Make spawn failures (resolved program absent from PATH) self-explanatory
    // instead of a silent exit 1, then propagate the runner's own exit code.
    if (typeof err.status !== 'number') {
      process.stderr.write(`gitnexus runner: could not launch \`${program}\` — ${err.message}\n`);
    }
    process.exit(typeof err.status === 'number' ? err.status : 1);
  }
}
