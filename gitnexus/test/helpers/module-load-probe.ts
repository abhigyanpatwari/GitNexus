/**
 * Shared child-process module-load probe for the `dist/` import-closure tests.
 *
 * Extracted at its THIRD consumer (`mini-repo.ts` set the precedent at its
 * second). `test/integration/mcp/import-closure.test.ts`,
 * `test/integration/optional-grammars/registry-import-closure.test.ts` and
 * `test/integration/mcp/startup-language-closure.test.ts` had each grown their
 * own copy of the same machinery: the `REPO_ROOT` derivation, the probe source,
 * the "dist missing — run `npm run build`" guard, the spawn with `NODE_OPTIONS`
 * cleared, the status-vs-signal error rendering, and the JSON payload parse.
 *
 * The copies were not equal, which is what made the duplication actively
 * harmful rather than merely verbose. Two of the three diffed `require.cache`
 * only — structurally BLIND to the first-party ESM `dist/**` graph they walk
 * (`dist/` is `"type": "module"`), so they could not see most of what they
 * traversed — and one of those had no non-vacuity guard at all, meaning a
 * severed entry passed it green. The next author had 2-in-3 odds of copying a
 * broken probe.
 *
 * So the HARNESS is shared and the POLICY is not: which modules are forbidden,
 * and what the remedy is, stays in each test, because that advice is specific
 * to the regression that test exists to prevent.
 *
 * Two load channels, unioned:
 *  - `module.registerHooks({ load })` sees every module the ESM loader
 *    resolves, including the first-party `dist/**` graph. (Added in Node
 *    22.15; the package `engines` floor is `^22.18.0 || >=24.11.0`.)
 *  - a `require.cache` diff catches CJS/native modules, which is how a
 *    tree-sitter grammar binding or a `.node` addon surfaces.
 *
 * Non-vacuity is STRUCTURAL here, not a convention a caller can forget: every
 * request MUST declare an `anchor` module and a `minModules` floor, and the
 * probe throws unless both hold. "The probe loaded nothing" is the one failure
 * mode that turns every one of these tests green while asserting nothing, so it
 * is not left to the test author to remember.
 *
 * An anchor is PER-POLICY, not per-entry. One probe is routinely asserted over
 * by several INDEPENDENT policies ("loads no language provider" AND "loads no
 * group extractor"), and each policy is only non-vacuous while the chain IT
 * polices is still walked. A single anchor on one of those chains, plus the
 * module-count floor, both stay green when a DIFFERENT chain is severed — and
 * the policy that rode on it silently stops being able to fail. So `anchor`
 * takes a list: name one module per policy, e.g.
 * `anchor: ['dist/mcp/resources.js', 'dist/core/group/service.js']`. A bare
 * string is the single-policy shorthand.
 *
 * Lazy `await import(...)` inside a function body remains the sanctioned escape
 * hatch throughout: it does not run at module evaluation, so the probe does not
 * see it. A TOP-LEVEL `await import(...)` does run, and the probe reports it —
 * which is the point.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** `test/helpers/module-load-probe.ts` → the gitnexus package root is two levels up. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Payload delimiters. The child writes its JSON between them so a stray
 * `console.log` from an imported module cannot corrupt the payload — several of
 * the entries probed here print banners on load.
 */
const BEGIN = '<<<GITNEXUS_PROBE>>>';
const END = '<<<END_GITNEXUS_PROBE>>>';

/**
 * Hard bound on one child. Generous: the heaviest entry probed today (the
 * scope-resolution registry, which eagerly loads ~40 tree-sitter bindings)
 * takes ~9 s, and CI machines are slower. This is a wedge-breaker, not a
 * performance assertion — nothing here asserts on elapsed time.
 */
const PROBE_TIMEOUT_MS = 60_000;

const PROBE_SOURCE = `
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

/**
 * `path.relative(from, to)` rendered with POSIX separators, so paths compare
 * and print identically on Windows. Inline copies of this three-step dance had
 * accumulated across the test tree; new ones should call this.
 */
export function relativePosix(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join('/');
}

/**
 * Render one probe entry — a `file:` URL from the ESM hook, or an absolute path
 * from `require.cache` — as a repo-relative POSIX path.
 *
 * Anything that is not an absolute path inside the repo (a `node:` builtin, a
 * globally-linked dependency) is returned VERBATIM, so failure output still
 * names it recognizably and so the rendering never depends on `process.cwd()`.
 */
export function toRepoRelativePosix(entry: string): string {
  const asPath = entry.startsWith('file:') ? fileURLToPath(entry) : entry;
  if (!path.isAbsolute(asPath)) return entry;
  const relative = relativePosix(REPO_ROOT, asPath);
  return relative.startsWith('..') || relative === '' ? entry : relative;
}

/** What to probe, and what proves the probe actually reached the target's graph. */
export interface ModuleLoadRequest {
  /**
   * Path under `dist/`, POSIX separators: `'mcp/local/local-backend.js'`.
   * Also the probe's label in every message it emits.
   */
  readonly entry: string;
  /**
   * Module(s) the entry genuinely loads, as `toRepoRelativePosix` renders them
   * (e.g. `'dist/mcp/resources.js'`). Every one must be present or the probe
   * throws.
   *
   * Non-vacuity guard, and REQUIRED: if a refactor severs the entry from its
   * real graph, the probe fails loudly instead of letting "none of the
   * forbidden modules loaded" pass green over a graph nothing walked. Each
   * anchor must sit on the same edge a policy asserted over this probe
   * polices — one whose disappearance would make that policy's assertion
   * meaningless. ONE PER POLICY: a file running two independent policies over
   * one probe needs two anchors (see the module doc), because an anchor on
   * policy A's chain says nothing about whether policy B's chain is still
   * walked.
   */
  readonly anchor: string | readonly string[];
  /**
   * Floor on the number of distinct modules loaded — a coarser second
   * non-vacuity guard, and REQUIRED. Set it well below the observed count so
   * ordinary dependency churn does not trip it.
   */
  readonly minModules: number;
  /**
   * Extra child environment, merged last. Use it to neutralise env that would
   * change what the child loads (the caller's own env is inherited, with
   * `NODE_OPTIONS` already cleared).
   */
  readonly env?: Readonly<Record<string, string>>;
}

/** What one entry actually loaded. */
export interface ModuleLoadProbe {
  /** `dist/mcp/server.js` — the entry, as it appears in failure messages. */
  readonly label: string;
  /**
   * Every distinct module the child loaded, in load order, rendered by
   * `toRepoRelativePosix`. Includes the ESM `dist/**` graph and the CJS/native
   * modules under it.
   */
  readonly modules: readonly string[];
  /** The loaded modules matching `pattern` — the offender list for a policy assertion. */
  matching(pattern: RegExp): readonly string[];
}

/** The probes recorded by one concurrent `probeModuleLoads` call. */
export interface ModuleLoadProbes {
  /** The probe for `entry`. Throws when it was never requested — never returns empty. */
  get(entry: string): ModuleLoadProbe;
}

interface ProbeProcessResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** A settled probe: the outcome, or the failure that stopped it — always labelled. */
type SettledProbe =
  | { readonly label: string; readonly probe: ModuleLoadProbe }
  | { readonly label: string; readonly error: Error };

/** The label a request is reported and looked up under. */
function labelOf(entry: string): string {
  return `dist/${entry}`;
}

/**
 * Normalise {@link ModuleLoadRequest.anchor} to a list. Exported so a test can
 * derive "which entries does policy X apply to?" from the anchors themselves
 * rather than from a hand-maintained second list that can drift out of step
 * with them.
 */
export function anchorsOf(anchor: string | readonly string[]): readonly string[] {
  return typeof anchor === 'string' ? [anchor] : anchor;
}

/**
 * Run the probe against `targetUrl` in a fresh child process.
 *
 * Async `spawn` rather than `spawnSync` so several entries can be probed
 * CONCURRENTLY: `spawnSync` blocks the event loop, and vitest runs a file's
 * tests sequentially, so a per-test sync probe serialises N full Node starts
 * that share nothing.
 */
function spawnProbe(targetUrl: string, extraEnv: Readonly<Record<string, string>>) {
  return new Promise<ProbeProcessResult>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', PROBE_SOURCE], {
      cwd: REPO_ROOT,
      // NODE_OPTIONS is cleared so a session-pinned --max-old-space-size (or a
      // loader flag) can't perturb which modules the child evaluates.
      //
      // PROBE_TARGET is spread AFTER `extraEnv` deliberately: the harness's own
      // target must always win. A request whose `env` set PROBE_TARGET would
      // otherwise redirect the probe at a different module while `anchor` and
      // `minModules` stayed keyed on `entry` — the exact vacuity this file
      // exists to make impossible.
      env: { ...process.env, NODE_OPTIONS: '', ...extraEnv, PROBE_TARGET: targetUrl },
      timeout: PROBE_TIMEOUT_MS,
      // SIGKILL rather than the default SIGTERM, which is catchable and
      // ignorable — a child wedged in synchronous native code (the failure this
      // guards) would survive it. Same reasoning as `lbug-config.ts`'s spawn.
      // Node's own `timeout` delivers this, so no second timer to keep in step.
      killSignal: 'SIGKILL',
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
    child.on('error', (error) => {
      reject(error);
    });
    child.on('close', (status, signal) => {
      resolve({ status, signal, stdout, stderr });
    });
  });
}

function runProbe(request: ModuleLoadRequest, label: string): Promise<ModuleLoadProbe> {
  const target = path.join(REPO_ROOT, 'dist', ...request.entry.split('/'));
  if (!fs.existsSync(target)) {
    return Promise.reject(
      new Error(
        `${target} missing — run \`npm run build\` first (or \`npm run test:integration\`, ` +
          `which builds via pretest:integration).`,
      ),
    );
  }

  return spawnProbe(pathToFileURL(target).href, request.env ?? {}).then((result) => {
    if (result.status !== 0) {
      // `status` is null when the child died to a signal (e.g. a native addon
      // SIGSEGV) — report the signal so that reads differently from a plain
      // non-zero exit.
      const exit =
        result.status !== null ? `status ${result.status}` : `signal ${result.signal ?? 'unknown'}`;
      throw new Error(
        `probing ${label} failed (${exit}):\n` +
          `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`,
      );
    }

    const begin = result.stdout.indexOf(BEGIN);
    const end = result.stdout.indexOf(END);
    if (begin < 0 || end < begin) {
      throw new Error(
        `probe output for ${label} had no payload markers.\n` +
          `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
    }

    const raw = parsePayload(result.stdout.slice(begin + BEGIN.length, end), label);
    // Deduplicate AFTER rendering: a CJS module imported from ESM is reported
    // once per channel (a `file:` URL and an absolute path) and would otherwise
    // appear twice in every offender list. Load order is preserved — it is the
    // most useful thing in a failure dump.
    const modules = [...new Set(raw.map(toRepoRelativePosix))];

    assertNonVacuous(request, label, modules);

    return {
      label,
      modules,
      matching: (pattern: RegExp): readonly string[] => modules.filter((m) => pattern.test(m)),
    };
  });
}

/**
 * Parse the child's payload back into a module list.
 *
 * Validated rather than cast: this crosses a process boundary, so the shape is
 * an assumption about another process's output, not a fact the type system
 * knows. A malformed payload must read as a HARNESS failure with the raw text
 * attached, never as `undefined` flowing into the offender lists.
 */
function parsePayload(payload: string, label: string): readonly string[] {
  const parsed: unknown = JSON.parse(payload);
  if (!isModuleList(parsed)) {
    throw new Error(
      `probe payload for ${label} was not an array of module strings — the child's ` +
        `protocol changed, or a module wrote between the payload markers. Payload:\n${payload}`,
    );
  }
  return parsed;
}

function isModuleList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry: unknown) => typeof entry === 'string');
}

/**
 * Fail unless the probe demonstrably walked the entry's real graph. Thrown, not
 * asserted, because a vacuous probe is a harness failure: every policy
 * assertion built on it is meaningless, so no test should get the chance to
 * evaluate one.
 *
 * EVERY anchor must be present, not merely one: they are one-per-policy, so a
 * surviving anchor cannot vouch for a severed sibling's chain.
 */
function assertNonVacuous(
  request: ModuleLoadRequest,
  label: string,
  modules: readonly string[],
): void {
  const missing = anchorsOf(request.anchor).filter((anchor) => !modules.includes(anchor));
  if (missing.length > 0) {
    throw new Error(
      `${label} did not load its anchor(s) ${missing.join(', ')}. If that edge moved, repoint ` +
        `the anchor — otherwise this probe is reporting over an unexercised graph and every ` +
        `assertion on it is vacuous. Loaded (${modules.length}):\n${modules.join('\n')}`,
    );
  }
  if (modules.length < request.minModules) {
    throw new Error(
      `${label} loaded ${modules.length} modules, below its floor of ${request.minModules} — ` +
        `the probe did not reach the entry's real graph. Loaded:\n${modules.join('\n')}`,
    );
  }
}

/**
 * Probe every request CONCURRENTLY and return the results by entry.
 *
 * Each request is an independent child process paying a full Node start, so
 * running them in parallel is worth roughly a 60% wall-clock cut on a
 * three-entry file. Call this once from `beforeAll` and keep the `it` bodies
 * pure assertions over what it recorded.
 *
 * Every failure is reported WITH its entry — a shared hook must not collapse N
 * distinct probes into one anonymous "beforeAll failed". Rejections are caught
 * per request rather than raced, which also guarantees every child is reaped
 * before this resolves.
 */
export async function probeModuleLoads(
  requests: readonly ModuleLoadRequest[],
): Promise<ModuleLoadProbes> {
  const settled = await Promise.all(
    requests.map((request): Promise<SettledProbe> => {
      const label = labelOf(request.entry);
      return runProbe(request, label).then(
        (probe) => ({ label, probe }),
        (error: unknown) => ({
          label,
          error: error instanceof Error ? error : new Error(String(error)),
        }),
      );
    }),
  );

  const failures = settled.flatMap((r) => ('error' in r ? [`${r.label}: ${r.error.message}`] : []));
  if (failures.length > 0) {
    throw new Error(
      `${failures.length} of ${requests.length} module-load probes failed:\n\n` +
        failures.join('\n\n'),
    );
  }

  const byLabel = new Map(
    settled.flatMap((r) => ('probe' in r ? ([[r.label, r.probe]] as const) : [])),
  );

  return {
    get(entry: string): ModuleLoadProbe {
      const label = labelOf(entry);
      const probe = byLabel.get(label);
      if (probe === undefined) {
        throw new Error(
          `no module-load probe recorded for ${label} — probed: ` +
            `${[...byLabel.keys()].join(', ')}. (A typo here would otherwise read as a pass.)`,
        );
      }
      return probe;
    },
  };
}

/** Probe a single entry. Same guarantees as {@link probeModuleLoads}. */
export async function probeModuleLoad(request: ModuleLoadRequest): Promise<ModuleLoadProbe> {
  return (await probeModuleLoads([request])).get(request.entry);
}
