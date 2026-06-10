import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Regression guard for #2130.
 *
 * `Dockerfile.cli`'s runtime stage hand-copies a SUBSET of the package's
 * published assets (`package.json` `files` = dist, hooks, scripts, skills,
 * vendor, web) out of the builder. npm ships all of `files`, but the Docker
 * image copies only what it thinks it needs — so when compiled `dist/**` gains a
 * `require()`/`createRequire()` into a sibling directory that the runtime stage
 * does NOT copy, the image crashes with `MODULE_NOT_FOUND` at module load while
 * the npm package keeps working. That is exactly #2130: `dist/cli/
 * resolve-invocation.js` does `require('../../hooks/claude/resolve-analyze-cmd.cjs')`
 * (statically imported by `analyze.ts`), but the runtime stage never copied
 * `hooks/`, so `gitnexus analyze` inside the image died before doing any work.
 *
 * This test derives, from the SOURCE tree, every out-of-`dist` asset that
 * compiled code `require()`s AT MODULE LOAD, then asserts each one is covered by
 * a runtime-stage `COPY --from=builder`. It is deliberately scoped to
 * `require`/`createRequire` (hard module resolution — a missing target throws):
 * an asset reached only via `fs.access`/`fs.readFile`/`new URL(...)` (e.g. `web/`)
 * degrades gracefully when absent and is intentionally not copied, so it is out of
 * scope here. `skills/` is also fs-accessed but IS shipped (covered by its own
 * `it('copies skills/…')` below), because the CLI must stay fully usable.
 */

const UNIT_DIR = path.dirname(fileURLToPath(import.meta.url));
const GITNEXUS_ROOT = path.resolve(UNIT_DIR, '..', '..');
const REPO_ROOT = path.resolve(GITNEXUS_ROOT, '..');
const SRC_DIR = path.join(GITNEXUS_ROOT, 'src');
const DOCKERFILE = path.join(REPO_ROOT, 'Dockerfile.cli');

const toPosix = (p: string): string => p.split(path.sep).join('/');

/**
 * Source paths (relative to the gitnexus package root) copied into the image by
 * the RUNTIME stage of Dockerfile.cli — e.g. `hooks`,
 * `scripts/install-duckdb-extension.mjs`. The builder stage's full-tree
 * `COPY gitnexus ./gitnexus` is ignored on purpose: it would mask every gap.
 */
function runtimeStageCopiedSources(dockerfile: string): string[] {
  const lines = dockerfile.split('\n');
  // `i` flag: Docker accepts lowercase `as`, so a future reformat to
  // `FROM … as runtime` must not silently lose the stage (which would empty the
  // copied set and trip the named assertions below).
  const runtimeStart = lines.findIndex((l) => /^FROM\s.*\bAS\s+runtime\b/i.test(l));
  expect(runtimeStart, 'Dockerfile.cli must declare a `... AS runtime` stage').toBeGreaterThan(-1);
  const sources: string[] = [];
  // Scan only the runtime stage: start after its FROM and stop at the next
  // stage boundary, so COPY lines from any stage added AFTER runtime are never
  // misattributed to it.
  for (const line of lines.slice(runtimeStart + 1)) {
    if (/^FROM\b/.test(line)) break;
    if (!/^COPY\s+--from=builder\b/.test(line)) continue;
    // The source operand is the `/app/gitnexus/<path>` token (the dest is
    // `./gitnexus/<path>`). There is exactly one per COPY line here.
    const m = line.match(/\s\/app\/gitnexus\/(\S+)/);
    if (m) sources.push(m[1]);
  }
  return sources;
}

const isCovered = (assetPath: string, copied: string[]): boolean =>
  copied.some((c) => assetPath === c || assetPath.startsWith(c + '/'));

/** Recursively list non-test `.ts` files under a directory. */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === '__mocks__') continue;
      out.push(...listSourceFiles(full));
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.spec.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

// The `createRequire(...)('../x')` IIFE form (e.g. resolve-invocation.ts).
// Captures the relative specifier (starting with '.'). The built-in
// `require`/`_require` and aliased-binding literal forms are matched separately
// in `scanContent` from the file's discovered require-family identifiers, and
// computed (non-literal) module-load requires are handled there too. Dynamic/
// static ESM `import` is excluded — TS keeps those inside `dist/`.
const CREATE_REQUIRE_IIFE_RE = /createRequire\([\s\S]*?\)\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;

/**
 * Strip `//` line comments and block comments so commented-out or documented
 * requires (e.g. a JSDoc `require(computedPath)`, or a `// require('../../web/x')`)
 * cannot spuriously trip the parity guard — a false-fail for the literal scan
 * and a false "unverifiable computed require" for the broadened scan below.
 *
 * This is a small string-aware pass rather than a naive regex strip: it tracks
 * `'`/`"`/`` ` `` string state so a slash-star or `//` INSIDE a string or glob
 * literal (e.g. a `node_modules/` glob, a `thrift::x/` template) is never
 * mistaken for a comment delimiter and used to mangle real code. Newlines are
 * preserved so brace-depth accounting stays meaningful. (Verified: the real-tree
 * literal-scan output is byte-identical with and without this pass.)
 */
function stripComments(content: string): string {
  let out = '';
  type State = 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl';
  let state: State = 'code';
  for (let i = 0; i < content.length; i += 1) {
    const c = content[i];
    const c2 = content[i + 1];
    if (state === 'code') {
      if (c === '/' && c2 === '/') {
        state = 'line';
        i += 1;
      } else if (c === '/' && c2 === '*') {
        state = 'block';
        i += 1;
      } else if (c === "'") {
        state = 'sq';
        out += c;
      } else if (c === '"') {
        state = 'dq';
        out += c;
      } else if (c === '`') {
        state = 'tpl';
        out += c;
      } else {
        out += c;
      }
    } else if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        out += c;
      }
    } else if (state === 'block') {
      if (c === '*' && c2 === '/') {
        state = 'code';
        i += 1;
      } else if (c === '\n') {
        out += c;
      }
    } else {
      // inside a string/template literal — copy verbatim, honoring escapes
      out += c;
      if (c === '\\' && i + 1 < content.length) {
        out += content[i + 1];
        i += 1;
      } else if (
        (state === 'sq' && c === "'") ||
        (state === 'dq' && c === '"') ||
        (state === 'tpl' && c === '`')
      ) {
        state = 'code';
      }
    }
  }
  return out;
}

/**
 * Vetted module-load requires whose target is a COMPUTED (non-literal) path the
 * scanner cannot resolve statically. Maps a source file (relative to `src/`) to
 * the package-relative asset it loads at module load. The asset is still run
 * through the COPY-coverage check like any literal — this allowlist only
 * suppresses the "unverifiable computed require" hard-fail; it never exempts the
 * asset from `isCovered` (so deleting the covering COPY still fails the guard,
 * enforced by the coverage-not-trust test below).
 */
const KNOWN_COMPUTED_REQUIRES: { source: string; asset: string }[] = [
  // community-processor.ts: `const leidenPath = resolve(__dirname,'..','..','..',
  //  'vendor','leiden','index.cjs'); const leiden = _require(leidenPath);`
  { source: 'core/ingestion/community-processor.ts', asset: 'vendor/leiden/index.cjs' },
];

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Identifiers that behave like `require` in a file: the built-ins plus any
 * `const X = createRequire(...)` binding (e.g. `requireCJS`, `_require`).
 */
function requireFamilyIds(content: string): string[] {
  const ids = new Set(['require', '_require']);
  for (const m of content.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*createRequire\s*\(/g,
  )) {
    ids.add(m[1]);
  }
  return [...ids];
}

/** Net `{` minus `}` before `index`; 0 means the call sits at module top-level. */
function braceDepthBefore(content: string, index: number): number {
  let depth = 0;
  for (let i = 0; i < index; i += 1) {
    const ch = content[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
  }
  return depth;
}

interface RequireScan {
  assets: { asset: string; source: string }[];
  unresolvedComputed: { source: string; arg: string }[];
}

/**
 * What one source file require()s OUTSIDE `dist/` at module load:
 *  - `assets`: statically-resolvable relative literals (built-in `require`/
 *    `_require`, aliased `createRequire` bindings, and the `createRequire(...)
 *    ('…')` IIFE) plus the resolved asset of each vetted `KNOWN_COMPUTED_REQUIRES`
 *    entry.
 *  - `unresolvedComputed`: MODULE-LOAD (brace-depth 0) requires with a computed /
 *    non-literal arg that are NOT in the allowlist — the guard fails closed on
 *    these for manual review.
 * The module-load gate applies ONLY to the computed branch: in-function computed
 * requires (e.g. `_require(g.pkg)`, `requireCJS(c)`) target `node_modules`/
 * `package.json`, are out of the "module-load" charter, and are ignored. Literal
 * requires stay ungated — an in-function `require('../x')` still resolves to the
 * same `dist`-relative target, so gating them would only risk dropping real
 * coverage. Residual limit: a truly dynamic require whose target is assembled
 * across functions / from config is caught only via the fail-closed gate.
 */
function scanContent(relUnderSrc: string, rawContent: string): RequireScan {
  const content = stripComments(rawContent);
  const distDir = path.posix.join('dist', path.posix.dirname(relUnderSrc));
  const assets: { asset: string; source: string }[] = [];
  const unresolvedComputed: { source: string; arg: string }[] = [];

  const addResolved = (spec: string): void => {
    const resolved = path.posix.normalize(path.posix.join(distDir, spec));
    if (resolved === 'dist' || resolved.startsWith('dist/')) return; // internal
    assets.push({ asset: resolved, source: relUnderSrc });
  };

  // (a) Literal relative requires: createRequire IIFE …
  for (const m of content.matchAll(CREATE_REQUIRE_IIFE_RE)) addResolved(m[1]);
  // … plus built-ins and aliased createRequire bindings called with a literal
  // (`require('../x')`, `_require('../x')`, `requireCJS('../x')`).
  const idAlt = requireFamilyIds(content).map(escapeRegExp).join('|');
  const aliasLiteralRe = new RegExp(
    `(?<![.\\w$])(?:${idAlt})\\s*\\(\\s*['"](\\.[^'"]+)['"]\\s*\\)`,
    'g',
  );
  for (const m of content.matchAll(aliasLiteralRe)) addResolved(m[1]);

  // (b) Module-load computed requires (non-literal first arg, brace-depth 0).
  // `<id>.resolve(...)` is excluded — `\s*\(` must follow the identifier, but
  // `.resolve(` sits between, so it never matches (it is a path lookup, not a load).
  const computedRe = new RegExp(`(?<![.\\w$])(?:${idAlt})\\s*\\(\\s*([^'"\`)\\s][^)]*)\\)`, 'g');
  for (const m of content.matchAll(computedRe)) {
    if (braceDepthBefore(content, m.index ?? 0) !== 0) continue; // in-function → out of charter
    const known = KNOWN_COMPUTED_REQUIRES.find((k) => k.source === relUnderSrc);
    if (known) assets.push({ asset: known.asset, source: relUnderSrc });
    else unresolvedComputed.push({ source: relUnderSrc, arg: m[1].trim() });
  }

  return { assets, unresolvedComputed };
}

/**
 * Aggregate {@link scanContent} over the whole `src/` tree. `src/<rel>.ts`
 * compiles to `dist/<rel>.js`, so a specifier resolved against `dist/<dir>`
 * reproduces the runtime layout exactly.
 */
function requiredExternalAssets(): RequireScan {
  const assets: { asset: string; source: string }[] = [];
  const unresolvedComputed: { source: string; arg: string }[] = [];
  for (const file of listSourceFiles(SRC_DIR)) {
    const relUnderSrc = toPosix(path.relative(SRC_DIR, file));
    const scan = scanContent(relUnderSrc, readFileSync(file, 'utf-8'));
    assets.push(...scan.assets);
    unresolvedComputed.push(...scan.unresolvedComputed);
  }
  return { assets, unresolvedComputed };
}

/**
 * Hand-written shipped assets the runtime image executes directly (hook and
 * installer `.cjs`/`.mjs`), derived from the runtime COPY set minus dependency/
 * data roots (`node_modules`, `vendor`, `dist`, `skills`, `package.json`).
 * Unlike `src/**` these are not compiled, so they require siblings at their OWN
 * package-relative location.
 */
function shippedAssetFiles(copiedSources: string[]): string[] {
  const SKIP = new Set(['dist', 'node_modules', 'vendor', 'skills', 'web', 'package.json']);
  const out: string[] = [];
  const walk = (absDir: string, relDir: string): void => {
    for (const e of readdirSync(absDir, { withFileTypes: true })) {
      const abs = path.join(absDir, e.name);
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, rel);
      else if (/\.(cjs|mjs|js)$/.test(e.name)) out.push(rel);
    }
  };
  for (const entry of new Set(copiedSources)) {
    if (SKIP.has(entry)) continue;
    if (/\.(cjs|mjs|js)$/.test(entry)) {
      out.push(entry); // a single shipped script (e.g. scripts/install-duckdb-extension.mjs)
    } else {
      walk(path.join(GITNEXUS_ROOT, entry), entry); // a directory of shipped assets (e.g. hooks)
    }
  }
  return out;
}

/**
 * Relative `require()`s of shipped `.cjs`/`.mjs` assets, resolved against the
 * asset's OWN package-relative dir (not the `dist` mapping). Coverage is checked
 * by COPY prefix, never on-disk existence: `hooks/antigravity/*.cjs` does
 * `require('./hook-lock.cjs')`, which resolves to `hooks/antigravity/hook-lock.cjs`
 * — a path that need not physically exist but IS covered by the whole-`hooks` COPY.
 */
function shippedAssetRequiredAssets(copiedSources: string[]): { asset: string; source: string }[] {
  const found: { asset: string; source: string }[] = [];
  for (const rel of shippedAssetFiles(copiedSources)) {
    const baseDir = path.posix.dirname(rel);
    const content = stripComments(readFileSync(path.join(GITNEXUS_ROOT, rel), 'utf-8'));
    for (const m of content.matchAll(/\brequire\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      found.push({ asset: path.posix.normalize(path.posix.join(baseDir, m[1])), source: rel });
    }
  }
  return found;
}

describe('Dockerfile.cli runtime-stage asset parity (#2130)', () => {
  const dockerfile = readFileSync(DOCKERFILE, 'utf-8');
  const copied = runtimeStageCopiedSources(dockerfile);

  it('parses at least one runtime-stage COPY (guards against a vacuous pass)', () => {
    // If the runtime `FROM` or the `/app/gitnexus/` source prefix ever stops
    // matching, `copied` goes empty and the parity assertion below would pass
    // vacuously (an empty copied set yields zero uncovered assets). Fail loud.
    expect(copied.length, 'runtime stage must contain COPY --from=builder lines').toBeGreaterThan(
      0,
    );
  });

  it('copies hooks/ — resolve-invocation.ts require()s it at module load (#2130)', () => {
    // The exact regression: without this COPY, `gitnexus analyze` crashes inside
    // the image with `Cannot find module '../../hooks/claude/resolve-analyze-cmd.cjs'`.
    expect(copied).toContain('hooks');
  });

  it('copies skills/ — CLI reads the bundled SKILL.md templates at runtime', () => {
    // Degradation class (not a crash): `gitnexus analyze --skills` (ai-context.ts)
    // and `gitnexus setup`/`uninstall` read `<pkg>/skills/*.md`. Absent, they
    // silently emit placeholder content / install nothing. The image ships it to
    // stay fully usable as a CLI. `web/` (also in `files`) is intentionally NOT
    // shipped — this image never builds gitnexus-web, so it is API-only.
    expect(copied).toContain('skills');
  });

  it('sanity-checks the scanner sees both literal and vetted-computed module-load deps', () => {
    const assets = requiredExternalAssets().assets.map((a) => a.asset);
    // literal IIFE require (resolve-invocation.ts → hooks) …
    expect(assets).toContain('hooks/claude/resolve-analyze-cmd.cjs');
    // … and the vetted COMPUTED require (community-processor.ts → vendor/leiden).
    expect(assets).toContain('vendor/leiden/index.cjs');
  });

  it('copies every out-of-dist asset reached by a resolvable or vetted module-load require', () => {
    // Coverage = statically-resolvable relative literals (built-in / aliased /
    // IIFE createRequire) + vetted KNOWN_COMPUTED_REQUIRES; any UNRECOGNIZED
    // module-load computed require fails closed for manual review. Truly dynamic
    // requires (target assembled across functions / from config) are caught only
    // via that fail-closed gate, never statically resolved.
    const { assets, unresolvedComputed } = requiredExternalAssets();
    expect(
      unresolvedComputed,
      `Unverifiable module-load computed require(s) — statically confirm each target is ` +
        `COPY'd into the image and add it to KNOWN_COMPUTED_REQUIRES:\n` +
        unresolvedComputed.map((u) => `  - src/${u.source}: require(${u.arg})`).join('\n'),
    ).toEqual([]);
    const uncovered = assets.filter(({ asset }) => !isCovered(asset, copied));
    expect(
      uncovered,
      `Dockerfile.cli runtime stage is missing COPY lines for module-load require() targets ` +
        `outside dist/. Each will crash with MODULE_NOT_FOUND inside the image (cf. #2130). ` +
        `Add a \`COPY --from=builder /app/gitnexus/<dir> ./gitnexus/<dir>\`:\n` +
        uncovered.map((u) => `  - ${u.asset}  (required by src/${u.source})`).join('\n'),
    ).toEqual([]);
  });

  it('coverage-checks allowlisted computed requires instead of trusting them', () => {
    // vendor/leiden is contributed by KNOWN_COMPUTED_REQUIRES. Removing the
    // `vendor` COPY must make it surface as uncovered — proving the allowlist
    // suppresses only the unresolvable hard-fail, NOT the COPY check (else
    // deleting a COPY would silently pass, recreating the #2130 class).
    const assets = requiredExternalAssets().assets.map((a) => a.asset);
    expect(assets).toContain('vendor/leiden/index.cjs');
    const copiedWithoutVendor = copied.filter((c) => c !== 'vendor');
    expect(isCovered('vendor/leiden/index.cjs', copied)).toBe(true);
    expect(isCovered('vendor/leiden/index.cjs', copiedWithoutVendor)).toBe(false);
  });

  it('fails closed on an unrecognized module-load computed require', () => {
    const scan = scanContent(
      'fake/widget.ts',
      'const r = createRequire(import.meta.url);\nconst mod = r(somethingComputed);\n',
    );
    expect(scan.unresolvedComputed).toHaveLength(1);
    expect(scan.unresolvedComputed[0]).toMatchObject({
      source: 'fake/widget.ts',
      arg: 'somethingComputed',
    });
  });

  it('resolves aliased createRequire literals and ignores in-function computed requires', () => {
    // Aliased binding with a relative literal → resolved like require('../x').
    const aliased = scanContent(
      'cli/widget.ts',
      "const requireCJS = createRequire(import.meta.url);\nconst x = requireCJS('../../hooks/z.cjs');\n",
    );
    expect(aliased.assets.map((a) => a.asset)).toContain('hooks/z.cjs');
    expect(aliased.unresolvedComputed).toEqual([]);
    // A computed require INSIDE a function is out of the module-load charter.
    const inFn = scanContent('cli/widget.ts', 'function f(pkg) {\n  return require(pkg);\n}\n');
    expect(inFn.unresolvedComputed).toEqual([]);
    expect(inFn.assets).toEqual([]);
  });

  it('covers sibling requires of shipped .cjs/.mjs assets (coverage, not existence)', () => {
    const shipped = shippedAssetRequiredAssets(copied);
    // Sanity: the hand-written hook .cjs sibling requires are actually scanned
    // (e.g. gitnexus-hook.cjs → ./hook-lock.cjs); guards against a silent no-op.
    expect(shipped.length).toBeGreaterThan(0);
    const uncovered = shipped.filter(({ asset }) => !isCovered(asset, copied));
    expect(
      uncovered,
      `Shipped .cjs/.mjs assets require siblings not COPY'd into the image:\n` +
        uncovered.map((u) => `  - ${u.asset}  (required by ${u.source})`).join('\n'),
    ).toEqual([]);
    // The antigravity hook's `require('./hook-lock.cjs')` resolves to a path that
    // does NOT physically exist (hook-lock.cjs lives under hooks/claude), yet is
    // covered by the whole-`hooks` COPY — coverage-check, not existence-check.
    expect(isCovered('hooks/antigravity/hook-lock.cjs', copied)).toBe(true);
  });
});
