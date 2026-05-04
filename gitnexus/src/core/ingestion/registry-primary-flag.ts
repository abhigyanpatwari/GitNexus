/**
 * `REGISTRY_PRIMARY_<LANG>` per-language feature flags for the scope-based
 * resolution rollout (RFC §6.1 Ring 3; Ring 2 PKG #924).
 *
 * This module is the single source of truth for whether a given language
 * has been flipped to registry-primary call resolution. When a language's
 * flag is true, its files route through `Registry.lookup` (RFC §4) instead
 * of the legacy call-resolution DAG; when false (the default), the legacy
 * DAG runs unchanged.
 *
 * ## Contract
 *
 *   - Env-var name per language: `REGISTRY_PRIMARY_<UPPER(enum-value)>`.
 *     Example: `SupportedLanguages.Python` → `REGISTRY_PRIMARY_PYTHON`;
 *     `SupportedLanguages.CPlusPlus` (value `'cpp'`) → `REGISTRY_PRIMARY_CPP`.
 *   - Truthy values: `'true'`, `'1'`, `'yes'` (case-insensitive,
 *     whitespace-trimmed). Anything else — including `undefined`, empty
 *     string, or unknown tokens — is `false`.
 *   - No per-process caching. `process.env` is read on every call. The
 *     flag is consulted once per file at call-resolution time, so the
 *     overhead is negligible; skipping caching keeps test isolation
 *     trivial (no `resetFlagCache()` coordination needed).
 *
 * ## Integration site
 *
 * `call-processor.ts` integration lands in **#921** (`finalize-orchestrator`)
 * where the `SemanticModel` becomes accessible and `Registry.lookup` can
 * actually be called with a populated context. This module ships the flag
 * primitive in isolation so #921 has a clean, tested utility to consult.
 *
 * ## Shadow mode is orthogonal
 *
 * Shadow mode (`GITNEXUS_SHADOW_MODE=1`, introduced in #923) runs BOTH
 * legacy and registry paths regardless of the per-language flag, so the
 * parity dashboard has signal even for un-flipped languages. That logic
 * lives in `shadow-harness.ts` (#923), not here.
 */

import { SupportedLanguages } from 'gitnexus-shared';

/**
 * Languages whose RFC #909 Ring 3 scope-resolution migration is complete.
 *
 * This is the single source of truth for "migrated" — the list drives:
 *
 *   1. **Production default behavior.** `isRegistryPrimary(lang)` returns
 *      `true` by default for languages in this set (env-var override to
 *      any falsy value still wins — e.g. `REGISTRY_PRIMARY_PYTHON=0`).
 *   2. **CI parity gate.** `.github/workflows/ci-scope-parity.yml` auto-
 *      discovers this set and, for every language in it, runs the
 *      resolver integration test at `test/integration/resolvers/<slug>.test.ts`
 *      TWICE on every PR — once with the legacy DAG (flag forced off)
 *      and once with the registry-primary path (flag forced on). BOTH
 *      must pass. Adding a language is automatic — no workflow edit,
 *      no JSON registry.
 *   3. **Legacy-path gating.** `call-processor.ts` / `import-processor.ts`
 *      skip per-language work when `isRegistryPrimary(lang)` is `true`,
 *      so this set also controls what gets silenced in the legacy DAG.
 *
 * Add a language here ONLY after shadow parity ≥ 99% fixtures / ≥ 98%
 * corpus per RFC §6.4. TypeScript is temporarily accepted under the
 * Ring 3 CI parity gate while corpus-level shadow-mode wiring is tracked
 * in #927 for this migration.
 *
 * The set is intentionally a static TypeScript literal (not a JSON import,
 * not an env lookup) so CI can discover it via `tsx` without a build step
 * and reviewers see the change inline with the code that consumes it.
 */
export const MIGRATED_LANGUAGES: ReadonlySet<SupportedLanguages> = new Set<SupportedLanguages>([
  SupportedLanguages.Python,
  SupportedLanguages.CSharp,
  SupportedLanguages.TypeScript,
  SupportedLanguages.Go,
]);

/**
 * Return the env-var name that controls a given language's registry-
 * primary flag. Exported for test assertions and for the PR-labeling
 * CI job that cross-references per-language flag changes.
 */
export function envVarNameFor(lang: SupportedLanguages): string {
  return `REGISTRY_PRIMARY_${lang.toUpperCase()}`;
}

/**
 * Whether `lang` runs through the registry-primary call-resolution path.
 *
 * Resolution order: an explicit env-var value wins (so operators and CI
 * can force either path for a given run), and the default falls back to
 * `MIGRATED_LANGUAGES.has(lang)` — so languages whose migration is
 * complete default to registry-primary without touching any env.
 */
export function isRegistryPrimary(lang: SupportedLanguages): boolean {
  const raw = process.env[envVarNameFor(lang)];
  if (raw !== undefined) return parseFlag(raw);
  return MIGRATED_LANGUAGES.has(lang);
}

/**
 * All languages whose registry-primary flag is currently on. Useful for
 * startup-time logging + the shadow-harness dashboard, which wants to
 * distinguish "primary: legacy" from "primary: registry" rows.
 */
export function primaryLanguages(): ReadonlySet<SupportedLanguages> {
  const out = new Set<SupportedLanguages>();
  for (const lang of Object.values(SupportedLanguages)) {
    if (isRegistryPrimary(lang)) out.add(lang);
  }
  return out;
}

// ─── Internal ───────────────────────────────────────────────────────────────

/** Accepted truthy strings (case-insensitive, trimmed). */
const TRUTHY_VALUES: ReadonlySet<string> = new Set(['true', '1', 'yes']);

function parseFlag(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  return TRUTHY_VALUES.has(raw.trim().toLowerCase());
}
