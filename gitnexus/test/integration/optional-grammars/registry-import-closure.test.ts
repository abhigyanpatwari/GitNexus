/**
 * Optional-grammar static-import-closure regression test (#2091, #2093).
 *
 * The scope-resolution registry (`scope-resolution/pipeline/registry.ts`) and
 * the language-provider index statically import all 16 language providers. Each
 * per-language `query.ts` used to do a top-level `import X from 'tree-sitter-Y'`.
 * For the OPTIONAL grammars (swift/dart/kotlin) that import resolved — and on a
 * default install where the vendored/optional binding is absent, THREW
 * `ERR_MODULE_NOT_FOUND` — at module-load on the main thread, before any runtime
 * gate, crashing `gitnexus analyze` regardless of the repo's actual languages.
 *
 * The fix routes those three `query.ts` modules through the lazy, guarded
 * `parser-loader.getLanguageGrammar()` so the grammar binding is only required
 * at first use (inside the worker, for a file of that language) — never at
 * module-load.
 *
 * This test locks the fix in WITHOUT needing to simulate a missing grammar:
 * spawn a child Node process, import the built scope-resolution `registry.js`
 * (the crash-chain root), and assert no OPTIONAL tree-sitter binding
 * (swift/dart/kotlin) appears in the module cache. Pre-fix the static imports
 * loaded those bindings at import time (this assertion fails); post-fix they
 * are lazy (it passes). Required grammars (python/typescript/...) still load
 * eagerly via their own `query.ts` — that is expected and NOT asserted against.
 *
 * Characterization-first: this MUST fail against the pre-fix code (run against
 * the parent commit to verify the regression signal works).
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DIST_REGISTRY = path.join(
  REPO_ROOT,
  'dist',
  'core',
  'ingestion',
  'scope-resolution',
  'pipeline',
  'registry.js',
);
const DIST_REGISTRY_URL = pathToFileURL(DIST_REGISTRY).href;

// Import the registry, then report every newly-loaded CJS-cache key. The cache
// tracks native/.node bindings loaded by either ESM or CJS importers, which is
// exactly how a tree-sitter grammar binding surfaces.
const PROBE = `
  import { createRequire } from 'node:module';
  const req = createRequire(import.meta.url);
  const before = new Set(Object.keys(req.cache));
  await import(process.env.PROBE_TARGET);
  const after = new Set(Object.keys(req.cache));
  process.stdout.write(JSON.stringify([...after].filter((k) => !before.has(k))));
`;

const OPTIONAL_GRAMMAR_RE = /tree-sitter-(swift|dart|kotlin)[\\/]/;

describe('optional-grammar static-import closure (#2091/#2093)', () => {
  it('importing the scope-resolution registry loads NO optional grammar binding', () => {
    if (!fs.existsSync(DIST_REGISTRY)) {
      throw new Error(
        `${DIST_REGISTRY} missing — run \`npm run build\` first (or \`npm run test:integration\`, ` +
          `which builds via pretest:integration).`,
      );
    }

    const result = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE], {
      cwd: REPO_ROOT,
      // NODE_OPTIONS cleared so a session-pinned --max-old-space-size etc. can't
      // perturb the child. The skip env is cleared so install state is probed.
      env: {
        ...process.env,
        PROBE_TARGET: DIST_REGISTRY_URL,
        NODE_OPTIONS: '',
        GITNEXUS_SKIP_OPTIONAL_GRAMMARS: '',
      },
      timeout: 60_000,
      encoding: 'utf8',
    });

    // Post-fix, importing the registry must not throw even though the chain
    // reaches swift/dart/kotlin query.ts. (Pre-fix on a machine missing a
    // grammar this would be ERR_MODULE_NOT_FOUND; here the grammar is present
    // so pre-fix it would instead surface as a loaded binding below.)
    if (result.status !== 0) {
      // status is null when the child was killed by a signal (e.g. a native
      // addon SIGSEGV) — surface the signal so that's distinguishable from a
      // non-zero exit / module-not-found.
      const exit =
        result.status !== null ? `status ${result.status}` : `signal ${result.signal ?? 'unknown'}`;
      throw new Error(
        `importing the scope-resolution registry failed (${exit}):\n` +
          `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`,
      );
    }

    const newlyLoaded = JSON.parse(result.stdout) as string[];

    // Non-vacuity guard: the registry's static-import closure MUST still reach
    // the per-language query.ts modules (which is what makes "no optional
    // binding loaded" meaningful). The REQUIRED grammars (python/typescript/…)
    // still import their binding eagerly in their own query.ts, so at least one
    // non-optional tree-sitter binding must appear. If a future refactor severs
    // the registry→query.ts edge, this fails loudly instead of letting the
    // optional-binding assertion pass green on a no-longer-exercised path.
    const requiredLoaded = newlyLoaded.filter(
      (p) => /tree-sitter-[a-z-]+[\\/]/.test(p) && !OPTIONAL_GRAMMAR_RE.test(p),
    );
    expect(
      requiredLoaded.length,
      `Expected the registry import closure to load at least one REQUIRED tree-sitter ` +
        `binding (proving the chain still reaches the per-language query.ts modules). ` +
        `Newly-loaded (${newlyLoaded.length}):\n${newlyLoaded.join('\n')}`,
    ).toBeGreaterThan(0);

    // Headline assertion: no OPTIONAL grammar binding (swift/dart/kotlin) is
    // loaded at registry static-import time — they must load lazily.
    const optionalLoaded = newlyLoaded.filter((p) => OPTIONAL_GRAMMAR_RE.test(p));
    expect(
      optionalLoaded,
      `Optional tree-sitter grammar binding(s) loaded at registry static-import time. ` +
        `query.ts must load swift/dart/kotlin lazily via parser-loader, not via a ` +
        `top-level \`import\`. Offending paths:\n${optionalLoaded.join('\n')}`,
    ).toEqual([]);
  });
});
