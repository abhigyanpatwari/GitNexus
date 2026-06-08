/**
 * Workspace Readiness Probe — LSP read-only foundation, WI-#5.
 *
 * The **sole gate** (Invariant 4) that authorizes any downstream
 * LSP verdict. Given an `LspClient` and a set of "canary" samples
 * (URI + 0-indexed line/character positions in known TS files),
 * the probe asks the server for a `textDocument/definition` for
 * each one. The number of non-empty resolves vs. the requested
 * threshold determines whether downstream commands may compare
 * heuristic vs LSP results.
 *
 * Trust boundary: every downstream consumer in #sd-verify-mode-c
 * and #sd-lsp-doctor MUST treat `ready:false` as a hard stop.
 * Specifically:
 *   - `gitnexus verify --lsp` must NOT publish a heuristic-vs-LSP
 *     diff unless the probe says `ready:true`.
 *   - `gitnexus lsp doctor` must surface the probe's `reason`
 *     string verbatim so the operator can see *why* the workspace
 *     is not yet resolvable.
 *
 * Why this lives in a separate module (vs. an inlined helper):
 *   The probe is a *policy* — it is the spec's explicit "only
 *   trust LSP when the workspace can answer a definition query"
 *   rule. That policy is testable in isolation (mock LspClient,
 *   decision table), and it is the only piece of the #159
 *   foundation that gets re-exercised on every CLI invocation
 *   (the `verify` flow runs it on every run). Keeping it small
 *   and pure makes the test surface trivial.
 *
 * KD-2: pure async function. No I/O outside the injected client.
 * KD-3: never throws into the caller. A request that throws is
 *       treated as a fail (defensive — the LspClient contract is
 *       "never throws", but a bug in the LspClient should not
 *       take down the CLI command).
 */

import type { LspClient } from './lsp-client.js';

// ─── Public types ──────────────────────────────────────────────────────

/**
 * The verdict the probe returns. `ready:true` is the sole signal
 * downstream code uses to authorize an LSP comparison. `ready:false`
 * MUST always carry a non-empty `reason` so operators can
 * diagnose the failure from `gitnexus lsp doctor` output.
 */
export interface ProbeResult {
  ready: boolean;
  reason?: string;
}

/**
 * A single "canary" definition request. The caller is expected
 * to pick positions in known TS files (cross-file imports, call
 * sites of indexed functions, etc.) — the exact choice is
 * up to the verification policy, not the probe.
 */
export interface Sample {
  /** LSP textDocument URI, e.g. `file:///abs/path/to/foo.ts`. */
  textDocument: { uri: string };
  /** 0-indexed line/character per LSP convention. */
  position: { line: number; character: number };
}

export interface ProbeOptions {
  /**
   * Minimum number of samples that must resolve to a non-null,
   * non-empty result. Defaults to `1` — the probe's "is the
   * workspace usable" question needs only one positive signal.
   *
   * Setting to `0` is a degenerate but valid value: the probe
   * short-circuits to `ready:true` (state is still gated) without
   * calling `request()` at all. Useful for callers that want a
   * "the LSP client is up and willing" check without spending
   * the round-trip.
   */
  minResolves?: number;
  /**
   * Per-request timeout forwarded to `LspClient.request()`. The
   * LspClient races the request against a timeout + a connection-
   * close listener, so a slow or crashed server resolves to
   * `null` within this budget. Defaults to 3000 ms.
   */
  perRequestTimeoutMs?: number;
}

// ─── Defaults ─────────────────────────────────────────────────────────

/** Per-request timeout default (ms). */
const DEFAULT_PER_REQUEST_TIMEOUT_MS = 3000;

/** minResolves default — one positive signal is enough. */
const DEFAULT_MIN_RESOLVES = 1;

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Run the workspace-readiness probe. See file-level docstring for
 * the trust model.
 *
 * Algorithm (mirrors the WI spec step-by-step):
 *
 *   1. If `samples.length === 0` → `{ready:false, reason:'no samples provided'}`.
 *   2. If the client's state is not `ready` → `{ready:false, reason:'LSP client not started'}`.
 *      (Note: any non-ready state surfaces this reason, including
 *      `degraded`, `stopping`, `stopped`, `idle`, `starting`, and
 *      `restarting`. The `degraded` case is the most operationally
 *      important — it's the post-budget-exhaustion dead-end that
 *      must NEVER be crossed by downstream code.)
 *   3. For each sample: call `client.request('textDocument/definition', ...)`.
 *      - null       → fail
 *      - []         → fail
 *      - non-empty  → resolve
 *   4. If `resolves >= minResolves` (default 1) → `{ready:true}`.
 *      Otherwise → `{ready:false, reason:'workspace not built/resolved — R/N samples resolved'}`.
 *
 * The probe does NOT call the location-mapper. The mapper is a
 * downstream concern (a `[]` result from the server already means
 * "no definition here", which is enough to fail this sample).
 * Whether a non-empty resolve maps to a real graph node is the
 * mapper's job — not the probe's. The probe is deliberately
 * minimal: "is the LSP server answering us at all?"
 */
export async function probeWorkspaceReadiness(
  client: LspClient,
  samples: Sample[],
  opts: ProbeOptions = {},
): Promise<ProbeResult> {
  // ── 1) Empty-samples guard (defensive — caller may pass []) ───────
  // The probe must NEVER crash on a degenerate input. This is the
  // "no crash" contract the spec calls out.
  if (!Array.isArray(samples) || samples.length === 0) {
    return { ready: false, reason: 'no samples provided' };
  }

  // ── 2) State gate — the sole precondition for "is LSP up?" ────────
  // The LspClient's contract is: `getState()` is the source of
  // truth. A non-ready state means `request()` resolves to `null`
  // without doing work. We surface this with a specific reason
  // string so operators can grep their `lsp doctor` output.
  //
  // The LspClient is allowed to be in any state at probe time;
  // what we MUST guarantee is that the probe does not pretend
  // LSP is ready when it isn't.
  if (client.getState() !== 'ready') {
    return { ready: false, reason: 'LSP client not started' };
  }

  // ── 3) Threshold + timeout resolution ─────────────────────────────
  const minResolves = opts.minResolves ?? DEFAULT_MIN_RESOLVES;
  const perRequestTimeoutMs = opts.perRequestTimeoutMs ?? DEFAULT_PER_REQUEST_TIMEOUT_MS;

  // ── 3a) minResolves=0 short-circuit ───────────────────────────────
  // Degenerate but valid: a caller wants "is the client up and
  // willing?" without spending the round-trip. We trust the call
  // and return `ready:true` without invoking `request()`. State
  // has already been gated above, so this is a meaningful
  // answer, not a stale one.
  if (minResolves <= 0) {
    return { ready: true };
  }

  // ── 4) Iterate samples, count resolves ────────────────────────────
  // The loop runs to the end of the samples list — we do NOT
  // short-circuit on a fail (only on a resolve). The reason is
  // diagnostic: the `R/N` count in the final reason is the most
  // useful number to surface, and a partial pass with
  // `minResolves=2` needs the second sample to know the count.
  //
  // We also do NOT short-circuit once the threshold is met (when
  // `resolves >= minResolves`). A caller that wants to bound the
  // work can pass fewer samples.
  let resolves = 0;
  for (const sample of samples) {
    let result: any;
    try {
      // The LspClient contract: `request()` always resolves to a
      // value or `null`. We never expect this to throw — the
      // `try/catch` is defensive belt-and-braces (KD-3).
      result = await client.request(
        'textDocument/definition',
        {
          textDocument: sample.textDocument,
          position: sample.position,
        },
        perRequestTimeoutMs,
      );
    } catch {
      // Treat a thrown request as a sample fail. The CLI command
      // must not crash because the probe did.
      continue;
    }

    // ── 4a) Classify the result ─────────────────────────────────────
    // null            → timeout / error / crash → fail
    // []              → "no definition here"  → fail
    // non-empty array → at least one resolve  → resolve
    if (result === null) {
      continue;
    }
    if (Array.isArray(result) && result.length === 0) {
      continue;
    }
    if (Array.isArray(result) && result.length > 0) {
      resolves += 1;
      continue;
    }
    // Defensive: a non-null, non-array result is treated as a
    // resolve (the spec doesn't require an array shape; some
    // LSP servers return a single Location for a 1-1 case).
    // This is the "definition resolves but maps to NO_NODE (after
    // mapping) → ready:false" case from DT-4 — the probe does NOT
    // call the mapper, so we cannot detect NO_NODE here. A
    // non-null, non-empty result is a resolve at this layer.
    // The mapper is the right downstream gate for NO_NODE.
    if (!Array.isArray(result)) {
      resolves += 1;
      continue;
    }
  }

  // ── 5) Verdict ────────────────────────────────────────────────────
  if (resolves >= minResolves) {
    return { ready: true };
  }
  return {
    ready: false,
    reason: `workspace not built/resolved — ${resolves}/${samples.length} samples resolved`,
  };
}
