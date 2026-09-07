/**
 * The fold that decides when an open dispatch round closes.
 *
 * Extracted so the decision is a shared, inspectable unit rather than four
 * loose statements inside `runChunkedParseAndResolve`. The parse loop is
 * STREAMING — it reads chunk contents lazily, so it cannot know every chunk's
 * size up front and cannot "plan" rounds ahead. That makes an accumulator, not
 * a planner, the honest shape: feed it each chunk as it is queued and it tells
 * you whether the round is now full.
 *
 * Being a real unit is what makes round cadence observable. Round boundaries
 * are otherwise invisible from outside the parse phase: they change no graph
 * output (that is the point of batching) and surface only in a log line, which
 * is why `bench/parse-dispatch-rounds` measures this directly rather than
 * inferring cadence from a full analyze.
 */

/** Bytes a file contributes to the open round's retained total. */
export const roundFileBytes = (content: string): number => Buffer.byteLength(content, 'utf8');

export interface RoundBudget {
  /**
   * Add one queued chunk's files. Returns true when the round is now full and
   * the caller should close it. Closing resets the accumulator.
   */
  addChunk(contents: readonly string[]): boolean;
  /** Bytes currently held by the open round. */
  readonly bufferedBytes: number;
  /** Reset without closing — used when the caller closes for another reason. */
  reset(): void;
}

/**
 * `budgetBytes` bounds what the main thread HOLDS, counting cache hits as well
 * as misses. Counting only cache-missing bytes would bound just the work sent
 * to workers, so a warm run — where nothing misses — would never reach the
 * close condition and would buffer every chunk's cached output until the tail
 * drain. That is the #2649 heap failure on a large repo.
 *
 * Measured in UTF-8 bytes, matching `estimateItemBytes` in the worker pool.
 * `String.length` would return UTF-16 code units, undercounting non-ASCII
 * source by up to 3x and letting a CJK-heavy repo hold well past its nominal
 * budget before draining.
 */
export const createRoundBudget = (budgetBytes: number): RoundBudget => {
  let bufferedBytes = 0;
  return {
    addChunk(contents) {
      for (const content of contents) bufferedBytes += roundFileBytes(content);
      if (bufferedBytes >= budgetBytes) {
        bufferedBytes = 0;
        return true;
      }
      return false;
    },
    get bufferedBytes() {
      return bufferedBytes;
    },
    reset() {
      bufferedBytes = 0;
    },
  };
};
