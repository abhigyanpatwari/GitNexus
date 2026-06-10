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

// Matches the relative specifier of a module-load require:
//   require('..x')            _require('..x')          createRequire(...)('..x')
// Captures specifiers starting with '.' (relative). Dynamic/static ESM
// `import` is excluded — TS keeps those inside `dist/`, so they cannot escape.
const REQUIRE_SPEC_RE =
  /(?:\b_?require\s*\(|createRequire\([\s\S]*?\)\s*\()\s*['"](\.[^'"]+)['"]\s*\)/g;

/**
 * Every out-of-`dist` asset that compiled `dist/**` require()s at module load,
 * as `{ asset, source }` (source = `src/...` file that triggers it).
 * `src/<rel>.ts` compiles to `dist/<rel>.js`, so a specifier resolved against
 * `dist/<dir>` reproduces the runtime layout exactly.
 */
function requiredExternalAssets(): { asset: string; source: string }[] {
  const found: { asset: string; source: string }[] = [];
  for (const file of listSourceFiles(SRC_DIR)) {
    const relUnderSrc = toPosix(path.relative(SRC_DIR, file));
    const distDir = path.posix.join('dist', path.posix.dirname(relUnderSrc));
    const content = readFileSync(file, 'utf-8');
    for (const match of content.matchAll(REQUIRE_SPEC_RE)) {
      const spec = match[1];
      const resolved = path.posix.normalize(path.posix.join(distDir, spec));
      if (resolved === 'dist' || resolved.startsWith('dist/')) continue; // internal
      found.push({ asset: resolved, source: relUnderSrc });
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
    // vacuously (empty set ∩ anything = no uncovered assets). Fail loudly here.
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

  it('sanity-checks the require scanner actually sees the hooks dependency', () => {
    const assets = requiredExternalAssets().map((a) => a.asset);
    expect(assets).toContain('hooks/claude/resolve-analyze-cmd.cjs');
  });

  it('copies every out-of-dist asset that dist require()s at module load', () => {
    const uncovered = requiredExternalAssets().filter(({ asset }) => !isCovered(asset, copied));
    expect(
      uncovered,
      `Dockerfile.cli runtime stage is missing COPY lines for module-load require() targets ` +
        `outside dist/. Each will crash with MODULE_NOT_FOUND inside the image (cf. #2130). ` +
        `Add a \`COPY --from=builder /app/gitnexus/<dir> ./gitnexus/<dir>\`:\n` +
        uncovered.map((u) => `  - ${u.asset}  (required by src/${u.source})`).join('\n'),
    ).toEqual([]);
  });
});
