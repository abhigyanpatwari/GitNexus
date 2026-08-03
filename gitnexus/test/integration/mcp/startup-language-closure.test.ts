/**
 * MCP startup must not load the analyze-only language provider registry (#2802).
 *
 * `mcp/local/pdg-impact.ts` once imported `core/ingestion/languages/index.ts`
 * for a single extension→language lookup. That edge pulled all 16 providers,
 * their extractors, and the tree-sitter native binding into every MCP server
 * start: ~226 extra modules and ~130 ms, for a server that never analyzes
 * anything. The finding was discovered and lost once already (during #2793)
 * before #2802 re-derived it, so it gets a guard rather than a comment.
 *
 * The guard is a REAL MODULE-LOAD PROBE, not a source-level import walk. A
 * previous regex-based version of this test (`test/unit/mcp-startup-import-
 * closure.test.ts`) was defeated four separate ways: it walked from
 * `local-backend.ts` instead of the actual server entry, it was structurally
 * blind to eager top-level `await import(...)`, its type-only-import stripper
 * lazily matched across a 16 kB window of `pdg-impact.ts` (the terminating
 * `from "…"` lived inside a string literal), and its comment stripper treated
 * `/*` inside a string literal as a comment opener.
 *
 * This version spawns a child Node process, imports a built `dist/` entry, and
 * reports every module the loader actually pulled in — the same evidence-based
 * shape as `test/integration/mcp/import-closure.test.ts` and
 * `test/integration/optional-grammars/registry-import-closure.test.ts`. It
 * cannot be fooled by import syntax, a stale entry point, or regex drift:
 * whatever Node evaluates, the probe sees.
 *
 * Coverage note: `dist/mcp/server.js` is the entry that must be protected — it
 * is what `mcpCommand` dynamically imports and what actually serves MCP.
 * `dist/cli/mcp.js` is asserted too (it is the process entry, and its
 * deliberately leaf-only static closure is pinned separately by
 * `import-closure.test.ts`), as is `dist/mcp/local/local-backend.js` — the
 * module whose import graph #2802 actually changed.
 *
 * Lazy `await import(...)` inside a function body remains the sanctioned escape
 * hatch: it does not run at startup, so the probe does not see it. A top-level
 * `await import(...)` DOES run at module evaluation, and the probe reports it —
 * which is the point.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const BEGIN = '<<<GITNEXUS_PROBE>>>';
const END = '<<<END_GITNEXUS_PROBE>>>';

/**
 * Record every module the loader pulls in while evaluating the target.
 *
 * Two channels, unioned, because `dist/` is ESM (`"type": "module"`) while the
 * native/CJS dependencies below it are not:
 *  - `registerHooks({ load })` sees every module the ESM loader resolves,
 *    including the first-party `dist/**` graph this test is about. A
 *    `require.cache` diff alone would miss all of it.
 *  - the `require.cache` diff catches CJS/native modules, which is how a
 *    tree-sitter grammar binding surfaces.
 *
 * Output is marker-delimited so a stray `console.log` from an imported module
 * cannot corrupt the payload.
 */
const PROBE = `
  import { createRequire, registerHooks } from 'node:module';

  const req = createRequire(import.meta.url);

  const loaded = new Set();
  registerHooks({
    load(url, context, nextLoad) {
      loaded.add(url);
      return nextLoad(url, context);
    },
  });

  const beforeCjs = new Set(Object.keys(req.cache));
  await import(process.env.PROBE_TARGET);
  for (const key of Object.keys(req.cache)) {
    if (!beforeCjs.has(key)) loaded.add(key);
  }

  process.stdout.write('${BEGIN}' + JSON.stringify([...loaded]) + '${END}');
`;

/** Modules under this directory are the analyze-only provider registry. */
const FORBIDDEN_RE = /(^|\/)core\/ingestion\/languages\//;

/**
 * Render a probe entry (a `file:` URL, or an absolute path from `require.cache`)
 * as a repo-relative POSIX path. Anything outside the repo — `node:` builtins,
 * a globally-linked dependency — is returned unchanged so failure output still
 * names it recognizably.
 */
function toRepoRelative(entry: string): string {
  const asPath = entry.startsWith('file:') ? fileURLToPath(entry) : entry;
  const relative = path.relative(REPO_ROOT, asPath).split(path.sep).join('/');
  return relative.startsWith('..') || relative === '' ? entry : relative;
}

interface ProbeOutcome {
  /** Every loaded module, as a repo-relative POSIX path where possible. */
  readonly modules: readonly string[];
  /** Loaded modules that live under `core/ingestion/languages/`. */
  readonly offenders: readonly string[];
}

interface ProbeProcessResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run the probe against `targetUrl` in a fresh child process.
 *
 * Async `spawn` rather than `spawnSync` so the three entries below can probe
 * CONCURRENTLY: `spawnSync` blocks the event loop, and vitest runs a file's tests
 * sequentially, so a per-test sync probe serialises three ~3 s Node starts that
 * share nothing.
 */
function spawnProbe(targetUrl: string): Promise<ProbeProcessResult> {
  return new Promise<ProbeProcessResult>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', PROBE], {
      cwd: REPO_ROOT,
      // NODE_OPTIONS is cleared so a session-pinned --max-old-space-size (or a
      // loader flag) can't perturb which modules the child evaluates.
      env: { ...process.env, PROBE_TARGET: targetUrl, NODE_OPTIONS: '' },
      timeout: 60_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status, signal) => {
      resolve({ status, signal, stdout, stderr });
    });
  });
}

/** Import `distRelative` in a fresh child process and report what it loaded. */
async function probeStartupClosure(distRelative: readonly string[]): Promise<ProbeOutcome> {
  const target = path.join(REPO_ROOT, 'dist', ...distRelative);
  if (!fs.existsSync(target)) {
    throw new Error(
      `${target} missing — run \`npm run build\` first (or \`npm run test:integration\`, ` +
        `which builds via pretest:integration).`,
    );
  }

  const result = await spawnProbe(pathToFileURL(target).href);

  if (result.status !== 0) {
    // `status` is null when the child died to a signal (e.g. a native addon
    // SIGSEGV) — report the signal so that reads differently from a plain
    // non-zero exit.
    const exit =
      result.status !== null ? `status ${result.status}` : `signal ${result.signal ?? 'unknown'}`;
    throw new Error(
      `probing dist/${distRelative.join('/')} failed (${exit}):\n` +
        `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`,
    );
  }

  const begin = result.stdout.indexOf(BEGIN);
  const end = result.stdout.indexOf(END);
  if (begin < 0 || end < begin) {
    throw new Error(
      `probe output for dist/${distRelative.join('/')} had no payload markers.\n` +
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }

  const payload = result.stdout.slice(begin + BEGIN.length, end);
  const modules = (JSON.parse(payload) as string[]).map(toRepoRelative);
  return { modules, offenders: modules.filter((m) => FORBIDDEN_RE.test(m)) };
}

interface StartupEntry {
  /** Path segments under `dist/`. */
  readonly dist: readonly string[];
  /**
   * A first-party module the entry genuinely loads. Non-vacuity guard: if a
   * refactor severs the entry from its real graph, this fails loudly instead of
   * letting "no language modules loaded" pass green on an unexercised path.
   */
  readonly anchor: string;
  /** Floor on total loaded modules — a second, coarser non-vacuity guard. */
  readonly minModules: number;
}

// Observed on Node 22.18 against a clean build: server.js loads 631 modules,
// local-backend.js 337, cli/mcp.js 4. The floors sit well below those so normal
// dependency churn doesn't trip them, while a probe that silently loaded
// nothing still fails.
const ENTRIES: ReadonlyArray<readonly [string, StartupEntry]> = [
  [
    'dist/mcp/server.js',
    { dist: ['mcp', 'server.js'], anchor: 'dist/mcp/resources.js', minModules: 100 },
  ],
  [
    'dist/cli/mcp.js',
    { dist: ['cli', 'mcp.js'], anchor: 'dist/mcp/stdio-context.js', minModules: 3 },
  ],
  [
    'dist/mcp/local/local-backend.js',
    {
      dist: ['mcp', 'local', 'local-backend.js'],
      anchor: 'dist/mcp/local/pdg-impact.js',
      minModules: 50,
    },
  ],
];

/** A settled probe: the outcome, or the failure that stopped it, always labelled. */
type ProbeResult =
  | { readonly label: string; readonly outcome: ProbeOutcome }
  | { readonly label: string; readonly error: Error };

const outcomes = new Map<string, ProbeOutcome>();

/**
 * The probe of `label`, as recorded by `beforeAll`. Missing means the hook did
 * not populate it — which it cannot do silently, since it throws on any failed
 * probe — so this reads as a harness error rather than a vacuous pass.
 */
function outcomeOf(label: string): ProbeOutcome {
  const outcome = outcomes.get(label);
  if (outcome === undefined) throw new Error(`no probe outcome recorded for ${label}`);
  return outcome;
}

describe('MCP startup module-load closure (#2802)', () => {
  // All three entries are probed CONCURRENTLY here, not one per test: the probes
  // are independent child processes and each pays a full Node start, so running
  // them in parallel cuts this file's wall clock by roughly 60%. The `it` bodies
  // below are then pure assertions over what the hook recorded.
  beforeAll(async () => {
    const results = await Promise.all(
      ENTRIES.map(
        ([label, entry]): Promise<ProbeResult> =>
          probeStartupClosure(entry.dist).then(
            (outcome) => ({ label, outcome }),
            (error: unknown) => ({
              label,
              error: error instanceof Error ? error : new Error(String(error)),
            }),
          ),
      ),
    );

    // Every failure is named with its entry — a shared hook must not turn three
    // distinct probes into one anonymous "beforeAll failed". `Promise.all` over
    // already-caught results (rather than raw rejections) also guarantees all
    // three children are reaped before the hook returns.
    const failures = results.flatMap((r) =>
      'error' in r ? [`${r.label}: ${r.error.message}`] : [],
    );
    if (failures.length > 0) {
      throw new Error(
        `${failures.length} of ${ENTRIES.length} startup probes failed:\n\n${failures.join('\n\n')}`,
      );
    }

    for (const r of results) {
      if ('outcome' in r) outcomes.set(r.label, r.outcome);
    }
  }, 90_000);

  it.each(ENTRIES)('importing %s loads no language provider module', (label, entry) => {
    const { modules, offenders } = outcomeOf(label);

    // Non-vacuity: the probe reached the entry's real graph.
    expect(
      modules,
      `Expected ${label} to load ${entry.anchor}. If that edge moved, repoint the ` +
        `anchor — otherwise this guard is asserting over an unexercised graph. ` +
        `Loaded (${modules.length}):\n${modules.join('\n')}`,
    ).toContain(entry.anchor);
    expect(
      modules.length,
      `Probe of ${label} loaded suspiciously few modules:\n${modules.join('\n')}`,
    ).toBeGreaterThanOrEqual(entry.minModules);

    // Headline assertion: named chains, not a bare boolean, so whoever
    // reintroduces the edge sees exactly which modules did it.
    expect(
      offenders,
      `${label} eagerly loads the analyze-only language provider registry. ` +
        `MCP startup never analyzes anything — route the lookup through a lazy ` +
        `\`await import(...)\` inside the function that needs it (see #2802). ` +
        `Offending modules:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
