/**
 * Resolved-callee-id capture sink (#2227 follow-up plan U2).
 *
 * During Phase-4 scope-resolution CALLS-edge emission, each resolved call
 * site's `(callSiteLine, callSiteCol) → resolvedCalleeId` mapping is
 * accumulated here — across ALL THREE CALLS emit paths
 * (`emitReceiverBoundCalls` via `tryEmitEdge`/`tryEmitEdgeWithExplicitTargetId`,
 * and the inline `graph.addRelationship` in `emitFreeCallFallback` and
 * `emitReferencesViaLookup`), each BEFORE its dedup (KTD6/R8). A later unit
 * (U3) joins this map to CFG `BasicBlock`s by exact call-site position and
 * emits a `BasicBlock.calleeIds` set.
 *
 * KEY ALIGNMENT (plan KTD7 — load-bearing): the key is the call/new
 * expression node's start position — `line` 1-based (`startPosition.row + 1`),
 * `col` 0-based (`startPosition.column`). This MUST equal the U1
 * `SiteRecord.at` so the U3 position join lands. The CALLS resolution exposes
 * the same node's range via `site.atRange` (`atRange: anchor.range`,
 * scope-extractor.ts:1030), whose `startLine`/`startCol` are built by
 * `nodeToCapture` as `row + 1` / `column` (1-based line, 0-based col — see the
 * `Range` doc in gitnexus-shared). So a capture keyed on
 * `(atRange.startLine, atRange.startCol)` is byte-equal to U1's `at` — no
 * normalization needed.
 *
 * Gating (R4): the concrete sink is created in `run.ts` only when
 * `input.pdg === true`; otherwise `undefined` is threaded through, so off-mode
 * does zero work and emits byte-identical output.
 *
 * Multi-target dispatch (R2/KTD8): one site → multiple emit calls → the `Set`
 * accumulates every resolved target. Capture is per-emit-call, so the
 * candidate set is complete and a real target is never dropped.
 */

/** Encoded position key: `${line}:${col}` (1-based line, 0-based col). */
export type CalleeIdPosKey = string;

/** Build the position key from a call-site anchor. Single source of truth so
 *  producer (this sink) and consumer (U3's CFG join) encode positions
 *  identically. */
export function calleeIdPosKey(line: number, col: number): CalleeIdPosKey {
  return `${line}:${col}`;
}

/**
 * Write-side contract handed to the three CALLS emitters. Each resolved CALLS
 * edge feeds one `add` BEFORE its dedup, keyed on the call-site anchor.
 */
export interface CalleeIdSink {
  /**
   * Record that the call site at `(line, col)` in `filePath` resolved to
   * `calleeId`. Idempotent per `(filePath, line, col, calleeId)` — the
   * underlying value is a `Set`, so repeat targets collapse.
   */
  add(filePath: string, line: number, col: number, calleeId: string): void;
}

/**
 * Read-side accessor consumed by U3's CFG-emit join. Returns the per-file
 * `posKey → Set<calleeId>` map (or `undefined` when the file produced no
 * captures). Kept separate from the write interface so the emitters only see
 * the narrow `add` surface.
 */
export interface CalleeIdMapView {
  /** Per-file position→ids map, or `undefined` if nothing was captured for it. */
  get(filePath: string): ReadonlyMap<CalleeIdPosKey, ReadonlySet<string>> | undefined;
  /**
   * Release a file's captured map once its CFG emit has consumed it (R6). The
   * three CALLS passes fully precede the CFG-emit loop and each file is read
   * exactly once, so releasing after consumption bounds the accumulator to one
   * file's call sites instead of holding the whole repo's for the full phase.
   */
  delete(filePath: string): void;
}

/** The concrete accumulator: a write sink that also exposes the read view. */
export interface CalleeIdAccumulator extends CalleeIdSink, CalleeIdMapView {}

/**
 * Create the concrete nested-`Map` accumulator. Call ONLY when
 * `input.pdg === true` (else thread `undefined` for byte-identity / zero
 * overhead — R4).
 */
export function createCalleeIdAccumulator(): CalleeIdAccumulator {
  const byFile = new Map<string, Map<CalleeIdPosKey, Set<string>>>();
  return {
    add(filePath: string, line: number, col: number, calleeId: string): void {
      let byPos = byFile.get(filePath);
      if (byPos === undefined) {
        byPos = new Map<CalleeIdPosKey, Set<string>>();
        byFile.set(filePath, byPos);
      }
      const key = calleeIdPosKey(line, col);
      let ids = byPos.get(key);
      if (ids === undefined) {
        ids = new Set<string>();
        byPos.set(key, ids);
      }
      ids.add(calleeId);
    },
    get(filePath: string): ReadonlyMap<CalleeIdPosKey, ReadonlySet<string>> | undefined {
      return byFile.get(filePath);
    },
    delete(filePath: string): void {
      byFile.delete(filePath);
    },
  };
}
