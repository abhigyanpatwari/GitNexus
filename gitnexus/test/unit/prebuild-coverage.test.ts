import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';

/**
 * Regression guard: every tree-sitter grammar GitNexus ships must provide a
 * loadable native binding for EVERY platform-arch we support, on the ABI we
 * support — so a toolchain-less install never silently loses a language.
 *
 * "The ABI we support":
 *   - Node native ABI: engines.node >= 22 → all grammars are N-API
 *     (node-addon-api), i.e. one ABI-stable `.node` per platform-arch loads
 *     across Node majors. We assert each prebuilt binary exports the N-API
 *     entry symbol `napi_register_module_v1` (a node-ABI-pinned binary would
 *     not) — this works cross-platform because the symbol name is an ASCII
 *     string in the binary on linux/macOS/Windows alike.
 *   - tree-sitter language ABI: pinned `tree-sitter@0.21.1` (#1922) — verified
 *     by the load+parse smoke in parser-loader-abi.test.ts.
 *
 * Two cohorts:
 *   1. VENDORED grammars (gitnexus/vendor/tree-sitter-*) — GitNexus owns these
 *      prebuilds (cross-built by .github/workflows/build-tree-sitter-prebuilds.yml;
 *      Swift's were originally upstream-shipped, now rebuilt the same way). Each
 *      one that does NOT also vendor its build source MUST cover all 6 tuples.
 *   2. npm-dependency grammars — upstream owns their prebuilds. We assert 6/6
 *      too, with documented exceptions (see KNOWN_NPM_GAPS).
 */

const TUPLES = [
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
  'win32-x64',
  'win32-arm64',
];
const NAPI_SYMBOL = 'napi_register_module_v1';

const GITNEXUS_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const VENDOR_DIR = path.join(GITNEXUS_ROOT, 'vendor');
const NODE_MODULES = path.join(GITNEXUS_ROOT, 'node_modules');

/**
 * Known, tracked upstream coverage gaps for npm-dependency grammars. Each entry
 * is the EXACT set of tuples the upstream package omits — the test fails if a
 * grammar drops MORE than its allow-listed gap (a new silent regression) OR if
 * an allow-listed gap is closed upstream (prompting allow-list removal).
 *
 * (tree-sitter-c@0.21.4 ships only 4/6 — no linux-arm64/win32-arm64, #2116 — but
 * it is now VENDORED with GitNexus-built prebuilds for all 6, so it falls under
 * the vendored cohort below, not here.)
 */
const KNOWN_NPM_GAPS: Record<string, string[]> = {};

/**
 * Vendored grammars declared "fully prebuilt": GitNexus has committed 6/6
 * prebuilds for them, so they MUST keep all six even though they also vendor
 * source (binding.gyp). Without this list the strict 6/6 assertion is dormant for
 * every grammar that carries source — a dropped prebuild would pass CI silently.
 * Grammars graduate into this set as the build-tree-sitter-prebuilds workflow
 * lands their binaries (today only Swift ships 6/6; c/dart/proto/kotlin are
 * source-build-only until the workflow runs).
 */
const FULLY_PREBUILT = new Set<string>(['tree-sitter-swift']);

function isNapiBinary(file: string): boolean {
  return readFileSync(file).includes(NAPI_SYMBOL);
}

function prebuiltTuples(grammarDir: string): { covered: Set<string>; nonNapi: string[] } {
  const pdir = path.join(grammarDir, 'prebuilds');
  const covered = new Set<string>();
  const nonNapi: string[] = [];
  if (!existsSync(pdir)) return { covered, nonNapi };
  for (const tuple of TUPLES) {
    const td = path.join(pdir, tuple);
    if (!existsSync(td) || !statSync(td).isDirectory()) continue;
    const nodes = readdirSync(td).filter((f) => f.endsWith('.node'));
    if (nodes.length === 0) continue;
    covered.add(tuple);
    for (const n of nodes) if (!isNapiBinary(path.join(td, n))) nonNapi.push(`${tuple}/${n}`);
  }
  return { covered, nonNapi };
}

const vendoredGrammars = existsSync(VENDOR_DIR)
  ? readdirSync(VENDOR_DIR).filter((d) => /^tree-sitter-/.test(d))
  : [];

describe('vendored grammar prebuild coverage (toolchain-free on every supported platform)', () => {
  it('discovers the vendored grammars', () => {
    // Sanity: if vendor/ ever empties, the per-grammar assertions would vacuously
    // pass — fail loudly instead.
    expect(vendoredGrammars.length).toBeGreaterThan(0);
  });

  for (const grammar of vendoredGrammars) {
    const grammarDir = path.join(VENDOR_DIR, grammar);
    const { covered, nonNapi } = prebuiltTuples(grammarDir);
    const missing = TUPLES.filter((t) => !covered.has(t));
    // A grammar that vendors its build sources (binding.gyp) can source-build the
    // gaps on any toolchain host (e.g. CI), so an incomplete prebuild set is
    // tolerated for it — the build-tree-sitter-prebuilds workflow fills the
    // prebuilds to make it toolchain-free. Every grammar GitNexus currently
    // vendors carries its source (incl. swift, unified with the rest), so the
    // strict branch below is defensive: a hypothetical prebuild-only grammar (no
    // binding.gyp) MUST ship all six, or it is dead on the missing platform.
    const hasSourceFallback = existsSync(path.join(grammarDir, 'binding.gyp'));
    // A declared-fully-prebuilt grammar must ship all six EVEN THOUGH it has a
    // source fallback — otherwise the strict 6/6 assertion is dormant for every
    // source-carrying grammar and a dropped prebuild slips through CI.
    const mustBeFullyPrebuilt = FULLY_PREBUILT.has(grammar);

    it(
      mustBeFullyPrebuilt
        ? `${grammar}: ships an N-API prebuild for ALL 6 tuples (declared fully-prebuilt)`
        : hasSourceFallback
          ? `${grammar}: present prebuilds are N-API (source-build fallback covers any gaps)`
          : `${grammar}: ships an N-API prebuild for all 6 platform-arch tuples`,
      () => {
        // Any prebuild that IS present must be a loadable N-API binary — always.
        expect(nonNapi, `${grammar} has non-N-API prebuilds: ${nonNapi.join(', ')}`).toEqual([]);
        if (mustBeFullyPrebuilt || !hasSourceFallback) {
          // Either declared fully-prebuilt, or prebuild-only (no source fallback):
          // all six are required. Run the build-tree-sitter-prebuilds workflow to
          // (re)generate any that are missing.
          expect(
            missing,
            `${grammar} is missing prebuilds for: ${missing.join(', ') || 'none'} ` +
              (mustBeFullyPrebuilt
                ? `(declared fully-prebuilt in FULLY_PREBUILT — its 6/6 set must stay complete)`
                : `(prebuild-only — run the build-tree-sitter-prebuilds workflow)`),
          ).toEqual([]);
        }
      },
    );
  }
});

describe('npm-dependency grammar prebuild coverage', () => {
  const pkg = JSON.parse(readFileSync(path.join(GITNEXUS_ROOT, 'package.json'), 'utf8'));
  const npmGrammars = Object.keys(pkg.dependencies ?? {})
    .filter((d) => /^tree-sitter-/.test(d))
    .sort();

  it('discovers the npm grammar dependencies', () => {
    expect(npmGrammars.length).toBeGreaterThan(0);
  });

  for (const grammar of npmGrammars) {
    const grammarDir = path.join(NODE_MODULES, grammar);

    it(`${grammar}: upstream ships N-API prebuilds for all 6 tuples (minus tracked gaps)`, () => {
      if (!existsSync(grammarDir)) {
        // node_modules must be installed for this check (CI coverage job / local).
        throw new Error(`${grammar} not installed at ${grammarDir} — run npm install`);
      }
      const { covered, nonNapi } = prebuiltTuples(grammarDir);
      const allowedGap = new Set(KNOWN_NPM_GAPS[grammar] ?? []);
      const unexpectedMissing = TUPLES.filter((t) => !covered.has(t) && !allowedGap.has(t));
      const unexpectedlyClosed = [...allowedGap].filter((t) => covered.has(t));

      expect(
        unexpectedMissing,
        `${grammar} is missing prebuilds for: ${unexpectedMissing.join(', ')} ` +
          `(new gap — upstream dropped a platform, or pin a version that ships it)`,
      ).toEqual([]);
      expect(
        unexpectedlyClosed,
        `${grammar} now ships prebuilds for ${unexpectedlyClosed.join(', ')} — ` +
          `remove it from KNOWN_NPM_GAPS (and close the tracking issue)`,
      ).toEqual([]);
      expect(nonNapi, `${grammar} has non-N-API prebuilds: ${nonNapi.join(', ')}`).toEqual([]);
    });
  }
});

describe('prebuild workflow validate snippets cover every REGISTRY grammar', () => {
  // The "Validate the .node loads and parses" step looks up snippets[GRAMMAR].
  // A missing key yields undefined, and tree-sitter's parse() throws
  // "Input must be a function" — the six zig jobs on #3180.
  const workflow = readFileSync(
    path.join(GITNEXUS_ROOT, '..', '.github/workflows/build-tree-sitter-prebuilds.yml'),
    'utf8',
  );
  const registry = [...workflow.matchAll(/^\s{12}(\w+):\s+\{\s+name:\s+'tree-sitter-/gm)].map(
    (m) => m[1],
  );
  const snippets = [...workflow.matchAll(/^\s{14}(\w+):\s+"/gm)].map((m) => m[1]);

  it('REGISTRY and snippets are both non-empty (the regex still matches the workflow)', () => {
    expect(registry.length).toBeGreaterThan(0);
    expect(snippets.length).toBeGreaterThan(0);
  });

  it('every REGISTRY grammar has a parse snippet', () => {
    expect(snippets.sort(), 'add a snippets.<grammar> entry when extending REGISTRY').toEqual(
      [...registry].sort(),
    );
  });
});

describe('prebuild workflow rebuild loop guard', () => {
  const workflow = load(
    readFileSync(
      path.join(GITNEXUS_ROOT, '..', '.github/workflows/build-tree-sitter-prebuilds.yml'),
      'utf8',
    ),
  ) as {
    jobs: { guard: { steps: { id?: string; run?: string; env?: Record<string, string> }[] } };
  };
  const decide = workflow.jobs.guard.steps.find((step) => step.id === 'decide');
  if (!decide?.run) throw new Error('Missing prebuild workflow Decide script');
  // Execute the actual workflow script against real commits, including the
  // cumulative PR diff that remains after generated binaries are committed.
  const script = decide.run.match(/node --input-type=module - <<'NODE'\n([\s\S]*?)\nNODE/)?.[1];
  if (!script) throw new Error('Missing prebuild workflow Decide Node heredoc');
  let root: string;
  let base: string;
  let source: string;
  const vendor = 'gitnexus/vendor/tree-sitter-zig';

  function git(...args: string[]): string {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  }

  function write(rel: string, contents: string): void {
    const dest = path.join(root, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, contents);
  }

  function commit(message: string): string {
    git('add', 'gitnexus');
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  }

  function runGuard(env: Record<string, string> = {}) {
    const runnerTemp = mkdtempSync(path.join(root, 'runner-'));
    const output = path.join(runnerTemp, 'output');
    const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
      cwd: root,
      input: script,
      encoding: 'utf8',
      env: {
        ...process.env,
        EVENT: 'pull_request',
        ACTION: 'synchronize',
        BASE_SHA: base,
        BEFORE_SHA: source,
        HEAD_SHA: git('rev-parse', 'HEAD'),
        INPUT_GRAMMARS: '',
        INPUT_REF: '',
        FORCE: 'false',
        RUNNER_TEMP: runnerTemp,
        GITHUB_OUTPUT: output,
        ...env,
      },
    });
    return { ...result, output: existsSync(output) ? readFileSync(output, 'utf8') : '' };
  }

  function expectBuild(env: Record<string, string> = {}): void {
    const result = runGuard(env);
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toContain('any=true\n');
    const matrix = JSON.parse(result.output.split('matrix=')[1]);
    expect(matrix.include).toHaveLength(6);
    expect(matrix.include.every((entry: { grammar: string }) => entry.grammar === 'zig')).toBe(
      true,
    );
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'gitnexus-prebuild-guard-'));
    git('init', '-q');
    git('config', 'user.name', 'Prebuild test');
    git('config', 'user.email', 'prebuild-test@example.invalid');
    mkdirSync(path.join(root, 'hooks'));
    git('config', 'core.hooksPath', path.join(root, 'hooks'));
    write('gitnexus/package.json', '{}');
    base = commit('base without vendored zig');
    write(`${vendor}/package.json`, '{"version":"1.1.2"}');
    write(`${vendor}/src/parser.c`, 'original source');
    source = commit('vendor zig source');
    write(`${vendor}/prebuilds/win32-x64/tree-sitter-zig.node`, 'binary build 1');
    write(`${vendor}/prebuilds/SHA256SUMS`, 'checksum 1');
    commit('generated prebuilds');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('wires the event action and exact push endpoints into the guard', () => {
    expect(decide.env).toMatchObject({
      ACTION: '${{ github.event.action }}',
      BEFORE_SHA: '${{ github.event.before }}',
      HEAD_SHA: '${{ github.event.pull_request.head.sha }}',
    });
  });

  it('stops repeated binary-only updates while the PR still contains new source', () => {
    let before = source;
    for (let build = 2; build <= 4; build++) {
      const result = runGuard({ BEFORE_SHA: before });
      expect(result.status, result.stderr).toBe(0);
      expect(result.output).toBe('any=false\nmatrix={"include":[]}\n');
      before = git('rev-parse', 'HEAD');
      write(`${vendor}/prebuilds/win32-x64/tree-sitter-zig.node`, `binary build ${build}`);
      write(`${vendor}/prebuilds/SHA256SUMS`, `checksum ${build}`);
      commit('generated prebuilds');
    }
  });

  it('builds a newly opened PR and supports manual recuts', () => {
    expectBuild({ ACTION: 'opened', BEFORE_SHA: '' });
    expectBuild({ EVENT: 'workflow_dispatch', ACTION: '', BEFORE_SHA: '', INPUT_GRAMMARS: 'zig' });
  });

  it('builds source changes even when the last commit in the push only updates binaries', () => {
    expectBuild({ BEFORE_SHA: base });
    const before = git('rev-parse', 'HEAD');
    write(`${vendor}/src/parser.c`, 'updated source without a version bump');
    commit('edit parser');
    write(`${vendor}/prebuilds/SHA256SUMS`, 'checksum 2');
    commit('generated prebuilds');
    expectBuild({ BEFORE_SHA: before });
  });

  it('still builds after unrelated updates that may have cancelled an earlier build', () => {
    const before = git('rev-parse', 'HEAD');
    write('gitnexus/package.json', '{"description":"updated"}');
    commit('update package');
    expectBuild({ BEFORE_SHA: before });
  });

  it('uses event endpoints even when the checkout contains additional base-branch changes', () => {
    const head = git('rev-parse', 'HEAD');
    write(`${vendor}/src/parser.c`, 'source from an advanced PR merge ref');
    commit('simulate merge ref changes');
    const result = runGuard({ HEAD_SHA: head });
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe('any=false\nmatrix={"include":[]}\n');
  });

  it('does not hide source removal when a source file moves into prebuilds', () => {
    const before = git('rev-parse', 'HEAD');
    git('mv', `${vendor}/src/parser.c`, `${vendor}/prebuilds/parser.c`);
    commit('move source');
    expectBuild({ BEFORE_SHA: before });
  });

  it.each(['', 'not-a-sha', '0'.repeat(40)])(
    'fails closed for an unavailable push endpoint: %s',
    (before) => {
      const result = runGuard({ BEFORE_SHA: before });
      expect(result.status).not.toBe(0);
      expect(result.output).not.toContain('any=true');
    },
  );
});
