/**
 * `gitnexus verify` — LSP read-only foundation, WI-#8.
 *
 * A read-only CLI command that compares the heuristic CALLS
 * graph to LSP-resolved definitions (Mode C, see
 * `docs/designs/159-lsp-readonly-foundation.md` §#sd-verify-mode-c).
 *
 * Flags:
 *   --lsp           Run Mode C (heuristic vs LSP)
 *   --strict        Exit non-zero when LSP is unavailable (CI use)
 *   --sample <n>    Sample size (default 200)
 *   -r, --repo <n>  Target repository (multi-repo selector)
 *
 * Behavior table (the WI's decision table):
 *
 *   | index | --lsp | server    | --strict | exit | message                     |
 *   |-------|-------|-----------|----------|------|-----------------------------|
 *   | no    | *     | *         | *        | 1    | "No indexed repository..."  |
 *   | yes   | no    | *         | *        | 0    | "verify: nothing to do"     |
 *   | yes   | yes   | absent    | no       | 0    | "LSP unavailable... (heuristic only)" |
 *   | yes   | yes   | absent    | yes      | 1    | "LSP unavailable..."        |
 *   | yes   | yes   | not-ready | no       | 0    | "LSP unavailable... (heuristic only)" |
 *   | yes   | yes   | not-ready | yes      | 1    | "LSP unavailable..."        |
 *   | yes   | yes   | ready     | *        | 0    | per-tier + overall report   |
 *
 * Invariants upheld:
 *   1. Read-only — no graph write; the only DB surface touched
 *      is `executeParameterized` (read-only MATCH…RETURN).
 *   2. Degrade-not-throw — server absent / workspace not built
 *      becomes a printed report, never a stack trace.
 *   3. Determinism — the verifier uses the seeded PRNG
 *      (`runModeCVerify`'s default seed) so two runs against the
 *      same index + server version produce byte-identical
 *      reports.
 *   4. The `source: lsp | heuristic | both` label is rendered
 *      on every report so operators can see at a glance which
 *      run produced the numbers.
 *
 * `writeSync(1, ...)` is used for stdout (not `process.stdout`
 * or `console.log`) because LadybugDB's native module captures
 * `process.stdout` during init; the underlying fd 1 remains
 * intact. This matches the `tool.ts` pattern (#324).
 */

import { writeSync } from 'node:fs';
import { LocalBackend } from '../mcp/local/local-backend.js';
import { runModeCVerify } from '../core/ingestion/lsp/mode-c-verifier.js';
import { probeWorkspaceReadiness } from '../core/ingestion/lsp/workspace-readiness-probe.js';
import { discoverServers } from '../core/ingestion/lsp/server-discovery.js';
import { mapLocationToNodeId } from '../core/ingestion/lsp/location-mapper.js';
import { LspClient } from '../core/ingestion/lsp/lsp-client.js';
import { executeParameterized } from '../mcp/core/lbug-adapter.js';

export interface VerifyCommandOptions {
  lsp?: boolean;
  strict?: boolean;
  sample?: string;
  repo?: string;
}

/**
 * Print a single line on stdout using the fd 1 path (see
 * module docstring). A helper instead of a bare `writeSync(1, ...)`
 * so the format and trailing newline are consistent.
 */
function out(line: string): void {
  writeSync(1, line + '\n');
}

/**
 * Render the verifier's per-tier + overall counters as a text
 * report. The shape mirrors the design's example output
 * (see `docs/designs/159-lsp-readonly-foundation.md` §#sd-verify-mode-c):
 *
 *   Mode C verify — sample N, server vX.Y.Z
 *
 *   same-file (n=N):
 *     precision: 95.0%
 *     recall:    90.0%
 *     false-confident: 5.0% (1/N)
 *
 *   ...
 *   overall (n=N):
 *     ...
 *
 *   source: lsp | heuristic | both
 */
function renderReport(report: {
  perTier: Record<string, {
    precision: number;
    recall: number;
    falseConfidentRate: number;
    falseConfident: number;
    n: number;
  }>;
  overall: {
    precision: number;
    recall: number;
    falseConfidentRate: number;
    falseConfident: number;
    n: number;
  };
  sampleSize: number;
  serverVersion: string | null;
}): void {
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
  const ver = report.serverVersion ?? '?';

  out(`Mode C verify — sample ${report.sampleSize}, server v${ver}`);
  out('');

  const tierOrder = ['same-file', 'import-scoped', 'global', 'external'] as const;
  for (const tier of tierOrder) {
    const m = report.perTier[tier];
    if (!m || m.n === 0) continue;
    out(`${tier} (n=${m.n}):`);
    out(`  precision: ${pct(m.precision)}`);
    out(`  recall:    ${pct(m.recall)}`);
    out(`  false-confident: ${pct(m.falseConfidentRate)} (${m.falseConfident}/${m.n})`);
  }
  out(`overall (n=${report.overall.n}):`);
  out(`  precision: ${pct(report.overall.precision)}`);
  out(`  recall:    ${pct(report.overall.recall)}`);
  out(`  false-confident: ${pct(report.overall.falseConfidentRate)} (${report.overall.falseConfident}/${report.overall.n})`);
  out('');
  out('source: lsp | heuristic | both');
}

/**
 * Run `gitnexus verify`. The contract is documented at the top
 * of this file. Exported for tests (so a unit suite can drive
 * it without spawning a subprocess).
 *
 * @param options Parsed CLI flags. Undefined values fall through
 *                to the spec's defaults.
 */
export async function verifyCommand(options?: VerifyCommandOptions): Promise<void> {
  // ── 1) Precondition: indexed repo must exist ────────────────────
  // Reuse `LocalBackend.init()` exactly like `tool.ts` does — the
  // same `init` -> resolve -> "not found" path. Failure here is
  // a hard error (no graceful degradation: the user's intent is
  // to verify *something*, and without an index there's nothing
  // to verify).
  const backend = new LocalBackend();
  const ok = await backend.init();
  if (!ok) {
    out('No indexed repository found. Run: gitnexus analyze');
    process.exit(1);
  }

  // ── 2) Resolve repo (explicit `--repo` or default) ──────────────
  // `resolveRepo` throws on miss with a helpful "Available: …"
  // message. We propagate the throw as a non-zero exit — the
  // user's intent is explicit, so a wrong name is a user error,
  // not a degraded mode.
  let repoHandle: Awaited<ReturnType<typeof backend.resolveRepo>>;
  try {
    repoHandle = await backend.resolveRepo(options?.repo);
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    out(`Error: repository not found: ${msg}`);
    process.exit(1);
  }

  // ── 3) Without `--lsp`: nothing to do ───────────────────────────
  // The spec's "verify: nothing to do (pass --lsp to run Mode C)"
  // branch. We intentionally exit 0 — this is a non-error.
  if (!options?.lsp) {
    out('verify: nothing to do (pass --lsp to run Mode C)');
    process.exit(0);
  }

  // ── 4) Parse --sample (BVA: must be a positive integer) ─────────
  // BVA: `--sample 0` and `--sample 1` are the boundaries. `0`
  // is invalid (we want at least one sample). Non-integer or
  // negative inputs are also invalid. We accept strings (the
  // CLI default comes in as a string) and parse defensively.
  const DEFAULT_SAMPLE = 200;
  const sampleSize = options?.sample !== undefined ? parseInt(options.sample, 10) : DEFAULT_SAMPLE;
  if (!Number.isFinite(sampleSize) || sampleSize < 1) {
    out('Error: --sample must be a positive integer');
    process.exit(1);
  }

  // ── 5) Discover the LSP server (degrade/strict on absence) ──────
  // Server discovery never throws (per WI-#2 contract). A null
  // result is the "absent" verdict. We treat absent and
  // not-ready symmetrically: both yield a "LSP unavailable"
  // message, with strict controlling the exit code.
  const servers = await discoverServers();
  if (!servers.typescript) {
    const msg = 'LSP unavailable: typescript-language-server not found (install to enable --lsp)';
    if (options?.strict) {
      out(msg);
      process.exit(1);
    }
    out(`${msg} — using heuristic only`);
    return;
  }

  // ── 6) Start the LSP client + probe workspace readiness ─────────
  // The client is per-invocation (per the warm-singleton contract
  // of WI-#3). We MUST stop it on every code path, including the
  // error paths — hence the try/finally. The probe uses a single
  // canary request against the workspace's `package.json` so we
  // don't have to enumerate real TS files up-front.
  const client = new LspClient({
    binaryPath: servers.typescript.path,
    workspaceRoot: repoHandle.repoPath,
  });

  try {
    await client.start();
    const samples = [{
      textDocument: { uri: `file://${repoHandle.repoPath}/package.json` },
      position: { line: 0, character: 0 },
    }];
    const probe = await probeWorkspaceReadiness(client, samples, {
      perRequestTimeoutMs: 3000,
    });
    if (!probe.ready) {
      const msg = `LSP unavailable: ${probe.reason ?? 'workspace not ready'}`;
      if (options?.strict) {
        out(msg);
        process.exit(1);
      }
      out(`${msg} — using heuristic only`);
      return;
    }

    // ── 7) Run Mode C ───────────────────────────────────────────
    // We hand the verifier the real `mapLocationToNodeId` and
    // the real `executeParameterized` — both are read-only. The
    // `probe` we already ran is reused (we don't double-probe).
    // The seed is the verifier's default, which keeps the
    // report byte-stable across runs (Invariant 7).
    const report = await runModeCVerify({
      repoId: repoHandle.id,
      client,
      mapLocationToNodeId,
      executeParameterized,
      probe: async () => probe, // already probed above
      sampleSize,
      serverVersion: servers.typescript.version,
    });

    // ── 8) Render the report + exit 0 ───────────────────────────
    renderReport(report);
  } finally {
    // The LspClient's stop is idempotent + non-throwing; the
    // try/finally guarantees we never leak a subprocess even
    // on the success / render-error paths.
    try {
      await client.stop();
    } catch {
      /* swallow — `stop` is contractually non-throwing */
    }
  }
}
