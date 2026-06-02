/**
 * U2 (A2 from PR #1773 review) — regression guard for the E1 enrichment
 * log dual-emission shape.
 *
 * The E1 line at the top of `runChunkedParseAndResolve`'s post-chunk band
 * has two independent emission targets:
 *   - `logger.info('🔗 E1: Seeded …')` for the `isDev` path (dev-mode log
 *     scrapers still match the original emoji marker).
 *   - `logDeferredProfile('E1: seeded …')` for the `GITNEXUS_PROFILE_DEFERRED`
 *     path (operators grepping the [deferred-profile] prefix see no gap
 *     between wildcard-synth and heritage timings).
 *
 * When both flags are set, BOTH lines must fire. The original code used
 * `if (isDev) { ... } else if (deferredProfile) { ... }` which is mutually
 * exclusive and silently swallowed the [deferred-profile] line on combined-
 * flag runs. This pin guards against the regression returning.
 *
 * Driving the four-case truth table via the real pipeline requires the
 * worker path (`deferredWorkerCalls` only populates from chunk-worker
 * extraction), which is slow and harness-dependent. A source-shape pin is
 * the right test scope for a purely structural change — and is exactly
 * how downstream readers grep for the regression anyway.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PARSE_IMPL_PATH = path.resolve(
  __dirname,
  '../../src/core/ingestion/pipeline-phases/parse-impl.ts',
);

describe('parse-impl E1 dual-emission shape (U2)', () => {
  const source = fs.readFileSync(PARSE_IMPL_PATH, 'utf-8');

  it('has a standalone `if (isDev)` branch emitting the original emoji line', () => {
    expect(/if \(isDev\) \{\s*logger\.info\(`🔗 E1: Seeded \$\{enrichedCount\}/.test(source)).toBe(
      true,
    );
  });

  it('has a standalone `if (deferredProfile)` branch emitting the [deferred-profile] line', () => {
    expect(
      /if \(deferredProfile\) \{\s*logDeferredProfile\(`E1: seeded \$\{enrichedCount\}/.test(
        source,
      ),
    ).toBe(true);
  });

  it('does not chain the E1 branches via `else if`', () => {
    // Tight regex anchored to the closing `}` of the isDev branch — confirms
    // the very next token is `if` (independent branch) not `else if` (mutually
    // exclusive). Unrelated `else if (deferredProfile)` later in the file
    // (e.g., the buildHeritageMap-skipped log) is outside this window.
    expect(
      /if \(isDev\) \{\s*logger\.info\(`🔗 E1: Seeded[^`]+`\);\s*\}\s*if \(deferredProfile\)/.test(
        source,
      ),
    ).toBe(true);
  });
});
