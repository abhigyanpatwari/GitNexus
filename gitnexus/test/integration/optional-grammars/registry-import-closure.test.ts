/**
 * Optional-grammar static-import-closure regression test (#2091, #2093).
 *
 * The scope-resolution registry (`scope-resolution/pipeline/registry.ts`) and
 * the language-provider index statically import all 16 language providers. Each
 * per-language `query.ts` used to do a top-level `import X from 'tree-sitter-Y'`.
 * For the prebuild-only / optional grammars (swift/dart/kotlin, and — since
 * #2116 — vendored-prebuild-only C) that import resolved — and on a default
 * install where the binding is absent, THREW `ERR_MODULE_NOT_FOUND` — at
 * module-load on the main thread, before any runtime gate, crashing
 * `gitnexus analyze` regardless of the repo's actual languages.
 *
 * The fix routes those `query.ts` modules through the lazy, guarded
 * `parser-loader.getLanguageGrammar()` so the grammar binding is only required
 * at first use (inside the worker, for a file of that language) — never at
 * module-load. (C joined this set when it became vendored prebuild-only; it used
 * to be an always-present npm dependency.)
 *
 * This test locks the fix in WITHOUT needing to simulate a missing grammar:
 * import the built scope-resolution `registry.js` (the crash-chain root) in a
 * child process and assert no OPTIONAL tree-sitter binding (swift/dart/kotlin/c)
 * appears in the loaded-module set. Pre-fix the static imports loaded those
 * bindings at import time (this assertion fails); post-fix they are lazy (it
 * passes). Required grammars (python/typescript/...) still load eagerly via
 * their own `query.ts` — that is expected and NOT asserted against.
 *
 * The probe is `test/helpers/module-load-probe.ts`. This file used to carry its
 * own copy that diffed Node's CJS module cache and nothing else. That is the
 * right channel for the headline — a grammar binding is native CJS and always
 * surfaces there — but it was structurally BLIND to the ESM `dist/**` graph the
 * registry actually is, which is why its non-vacuity guard had to be indirect
 * ("at least one REQUIRED binding loaded"). The shared probe adds the ESM
 * channel, so this file can now anchor DIRECTLY on
 * `dist/core/ingestion/languages/swift/query.js`: the module that must be
 * reached-but-lazy, whose disappearance would make the swift half of the
 * headline vacuous. Both guards are kept — one pins the ESM chain to an
 * optional language, the other pins the native channel to a required one.
 *
 * Characterization-first: this MUST fail against the pre-fix code (run against
 * the parent commit to verify the regression signal works).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { probeModuleLoad, type ModuleLoadProbe } from '../../helpers/module-load-probe.js';

// `tree-sitter-c[\\/]` matches only the exact `tree-sitter-c/` package — NOT
// `tree-sitter-cpp/` or `tree-sitter-c-sharp/` (those need a non-separator after
// the `c`), so the required C++/C# eager loads are unaffected.
const OPTIONAL_GRAMMAR_RE = /tree-sitter-(swift|dart|kotlin|c)[\\/]/;

/** Any tree-sitter grammar package — required ones included. */
const ANY_GRAMMAR_RE = /tree-sitter-[a-z-]+[\\/]/;

describe('optional-grammar static-import closure (#2091/#2093, #2116)', () => {
  let probe: ModuleLoadProbe;

  beforeAll(async () => {
    probe = await probeModuleLoad({
      entry: 'core/ingestion/scope-resolution/pipeline/registry.js',
      // The registry's closure MUST still reach the OPTIONAL languages'
      // query.ts modules — that is precisely what makes "no optional binding
      // loaded" meaningful rather than trivially true. If a refactor severs
      // registry → swift/query.js, this fails loudly instead of letting the
      // assertion below pass green on a no-longer-exercised path.
      anchor: 'dist/core/ingestion/languages/swift/query.js',
      // Observed on Node 22.18 against a clean build: 553 distinct modules.
      minModules: 100,
      // Cleared so install state — not a skip flag inherited from the caller —
      // is what the child probes.
      env: { GITNEXUS_SKIP_OPTIONAL_GRAMMARS: '' },
    });
  }, 90_000);

  it('importing the scope-resolution registry loads NO lazy grammar binding (swift/dart/kotlin/c)', () => {
    // Second non-vacuity guard, on the native channel: the REQUIRED grammars
    // (python/typescript/…) still import their binding eagerly in their own
    // query.ts, so at least one non-optional tree-sitter binding must appear.
    // Losing this would mean the probe no longer observes grammar loads at all,
    // which the module-count floor alone would not catch.
    const requiredLoaded = probe
      .matching(ANY_GRAMMAR_RE)
      .filter((p) => !OPTIONAL_GRAMMAR_RE.test(p));
    expect(
      requiredLoaded.length,
      `Expected the registry import closure to load at least one REQUIRED tree-sitter ` +
        `binding (proving the chain still reaches the per-language query.ts modules). ` +
        `Loaded (${probe.modules.length}):\n${probe.modules.join('\n')}`,
    ).toBeGreaterThan(0);

    // Headline assertion: no lazy grammar binding (swift/dart/kotlin/c) is
    // loaded at registry static-import time — they must load lazily.
    const optionalLoaded = probe.matching(OPTIONAL_GRAMMAR_RE);
    expect(
      optionalLoaded,
      `Lazy tree-sitter grammar binding(s) loaded at registry static-import time. ` +
        `query.ts must load swift/dart/kotlin/c lazily via parser-loader, not via a ` +
        `top-level \`import\`. Offending paths:\n${optionalLoaded.join('\n')}`,
    ).toEqual([]);
  });
});
