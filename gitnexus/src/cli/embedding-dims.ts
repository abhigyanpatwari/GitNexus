/**
 * Strict positive-integer normalization for the `--embedding-dims` flag /
 * `GITNEXUS_EMBEDDING_DIMS` value.
 *
 * Single source of truth shared by two write paths:
 *   1. the `analyze` `preAction` hook (CLI path) — it must set the env var
 *      BEFORE `schema.ts` reads `GITNEXUS_EMBEDDING_DIMS` at module-load time
 *      (the static import chain `analyze.ts → run-analyze.ts → schema.ts`
 *      bakes `FLOAT[dims]` into the vector-table DDL), and
 *   2. `analyzeCommandImpl` (direct / programmatic-call path, which bypasses
 *      the commander hook).
 *
 * Keep this module dependency-free. `index.ts` imports it eagerly, so pulling
 * in anything that transitively loads `schema.ts` (e.g. `analyze.ts`) — or
 * even `cli-message.ts`, which drags in the logger + i18n — would defeat the
 * lazy `import('./analyze.js')` the hook exists to enable. Callers print the
 * error themselves (the hook to stderr, the impl via `cliError`).
 *
 * Trim-then-validate, matching the sibling URL/MODEL/TOKEN flags: surrounding
 * whitespace is tolerated, but the remaining value must be all digits and
 * `> 0`. This rejects scientific notation (`1e3`), hex (`0x10`), fractions
 * (`3.5`), signs (`+5`/`-5`), and trailing junk (`4096x`) so the three
 * downstream readers — `schema.ts` (`parseInt`), `http-client.ts` (`/^\d+$/`),
 * and this helper — all agree on one canonical value. Without it, `1e3` parsed
 * to `FLOAT[1]` at module-load but requested 1000-dim vectors at runtime.
 */

/** Shared error message so both call sites surface identical wording. */
export const EMBEDDING_DIMS_ERROR = '--embedding-dims must be a positive integer.';

/**
 * Returns the canonical positive-integer string (e.g. `"007"` → `"7"`), or
 * `null` when the input is not a strict positive integer.
 */
export const normalizeEmbeddingDims = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed) || parseInt(trimmed, 10) <= 0) {
    return null;
  }
  return String(parseInt(trimmed, 10));
};
