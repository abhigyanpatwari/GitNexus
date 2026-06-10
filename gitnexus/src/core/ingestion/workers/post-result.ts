/**
 * Worker → main result delivery with clone-safety (#2112).
 *
 * Extracted from `parse-worker.ts` into its own side-effect-free module so it
 * can be imported and exercised directly (the parse worker is an entry module:
 * importing it would construct the parser, post `ready`, and attach the real
 * message handler). The integration test imports `postResultCloneSafe` from
 * here to cover the production wiring end to end rather than re-implementing it.
 */
import { parentPort } from 'node:worker_threads';

import { makeWorkerResultCloneSafe } from './clone-safety.js';
import type { ParseWorkerResult } from './parse-worker.js';

/**
 * Strict mode (opt-in via `GITNEXUS_STRICT_CLONE=1`, inherited by workers). When
 * on, a clone failure THROWS with the offending key path instead of silently
 * sanitizing + delivering — so a leak introduced by a future provider/extractor
 * change fails LOUDLY (in CI / dev) at its origin rather than being quietly
 * stripped in production. The silent-recovery behavior is exactly what hid the
 * original #2112 leak; strict mode removes the silence where we want loudness.
 * Off in production, where the net's job is to keep the run alive.
 */
const STRICT_CLONE = process.env.GITNEXUS_STRICT_CLONE === '1';

/**
 * Deliver the accumulated result to the pool, surviving a non-cloneable value
 * (#2112). Fast path: post as-is — on a healthy result this is the only thing
 * that runs, so clone-safety adds zero overhead to normal runs. If structured
 * clone rejects the payload (a function/symbol leaked into an extraction
 * record — the reporter's case was a node `properties` value pointing at a
 * native `toString`), rewrite the boundary-crossing arrays so the result is
 * cloneable, record the affected paths on `result.skippedPaths`, warn the
 * operator naming the offending field + file (so the still-unpinned leak is
 * diagnosable from logs and fixable at source), and re-post.
 *
 * Recovery is attempted for ANY first-post failure, not only a `DataCloneError`.
 * structuredClone invokes getters, and a getter that THROWS surfaces its own
 * error (a `RangeError`, etc.) — NOT a `DataCloneError` (confirmed against a
 * real MessageChannel). Gating recovery on `DataCloneError` let such a throw
 * re-throw past the sanitizer and re-arm, under `POOL_SIZE=1`, the worker-death
 * cascade this net prevents. The recovery path is wrapped in its own try/catch
 * so a still-uncloneable re-post fails closed to a primitive-only
 * `{type:'error'}` DELIBERATELY rather than escaping the worker.
 */
export function postResultCloneSafe(result: ParseWorkerResult): void {
  try {
    parentPort!.postMessage({ type: 'result', data: result });
    return;
  } catch {
    // Fall through to recovery on ANY failure (DataCloneError OR a throwing
    // getter's own error). A healthy post returned above and never reaches here.
  }
  try {
    // `as unknown as Record<string, unknown>` is the standard widening for a
    // no-index-signature interface (TS rejects a single-step `as`). The field
    // sets are typed to `keyof ParseWorkerResult` so renaming a field is a
    // compile error here, not a silent loss of the drop-whole / skip protection.
    const { skipped } = makeWorkerResultCloneSafe(result as unknown as Record<string, unknown>, {
      dropWholeElement: new Set<keyof ParseWorkerResult>(['parsedFiles']),
      skipFields: new Set<keyof ParseWorkerResult>(['skippedPaths']),
    });
    if (skipped.length > 0) {
      if (STRICT_CLONE) {
        // Surface the leak loudly with its exact key path(s) instead of
        // delivering a sanitized result. Routes to the catch below → a
        // primitive-only {type:'error'} the pool reports, failing CI.
        const detail = skipped.map((s) => `${s.path}: ${s.reason}`).join('; ');
        throw new Error(
          `GITNEXUS_STRICT_CLONE: worker result was not structured-cloneable — ${detail}`,
        );
      }
      result.skippedPaths = [...(result.skippedPaths ?? []), ...skipped];
      const sample = skipped
        .slice(0, 5)
        .map((s) => `${s.path} (${s.reason})`)
        .join('; ');
      const more = skipped.length > 5 ? ` …and ${skipped.length - 5} more` : '';
      if (parentPort) {
        parentPort.postMessage({
          type: 'warning',
          message: `Sanitized ${skipped.length} file(s) with non-serializable parse output before delivery: ${sample}${more}`,
        });
      }
    }
    parentPort!.postMessage({ type: 'result', data: result });
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    parentPort!.postMessage({ type: 'error', error: e.message, errorStack: e.stack });
  }
}
