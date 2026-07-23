/**
 * Empty-facts discrimination in the moveIngest phase.
 *
 * move-flow returns facts `{}` with isError:false BOTH for a valid package
 * whose every item is `#[test_only]` (facts elide test items) AND for a
 * syntax-broken package. The phase must cross-check `move_package_status` to
 * tell them apart: compiling -> warning (likely test-only), failing -> error
 * (with the compiler diagnostics), status unavailable -> error (old behavior).
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import type { MoveFlowClient } from '../../../src/core/move/mcp-client.js';
import { runMoveIngestPhase } from '../../helpers/move-ingest-harness.js';

const REPO_ROOT = path.resolve('/repo');

function makeClient(overrides: Partial<MoveFlowClient> = {}): MoveFlowClient {
  return {
    facts: async () => ({}),
    callGraph: async () => ({}),
    packageStatus: async () => ({ ok: true, diagnostics: 'no errors or warnings' }),
    capabilities: async () => ({ hasFactsQuery: true, hasStatusTool: true }),
    shutdown: async () => {},
    ...overrides,
  };
}

/** Run the phase against a fake repo with one package holding one .move file. */
async function runPhase(client: MoveFlowClient) {
  return runMoveIngestPhase(client, REPO_ROOT, ['pkg/Move.toml', 'pkg/sources/t.move']);
}

function emptyFactsIssues(output: Awaited<ReturnType<typeof runPhase>>) {
  return output.consistencyIssues.filter((i) => i.code === 'empty-package-facts');
}

describe('moveIngest empty-facts discrimination', () => {
  it('downgrades to a warning when the package compiles (test-only package)', async () => {
    const output = await runPhase(makeClient());

    const issues = emptyFactsIssues(output);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toContain('compiles but produced no facts');
    expect(issues[0].message).toContain('test-only');
    expect(output.consistencyIssues.filter((i) => i.severity === 'error')).toHaveLength(0);
    // The package's files must stay un-ingested (acceptable for test-only).
    expect(output.ingestedFiles.size).toBe(0);
  });

  it('keeps the error and folds in the diagnostics when the build fails', async () => {
    const diagnostics = "error: unexpected token\n3 | }\nUnexpected '}'";
    const output = await runPhase(
      makeClient({ packageStatus: async () => ({ ok: false, diagnostics }) }),
    );

    const issues = emptyFactsIssues(output);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
    expect(issues[0].message).toContain('does not compile');
    expect(issues[0].message).toContain('error: unexpected token');
    expect(issues[0].details?.diagnostics).toBe(diagnostics);
  });

  it('falls back to the error-level issue when move_package_status is unavailable', async () => {
    const output = await runPhase(
      makeClient({
        capabilities: async () => ({ hasFactsQuery: true, hasStatusTool: false }),
      }),
    );

    const issues = emptyFactsIssues(output);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
    expect(issues[0].message).toContain('does it compile?');
  });

  it('falls back to the error-level issue when the status probe itself fails', async () => {
    const output = await runPhase(
      makeClient({
        packageStatus: async () => {
          throw new Error('move-flow exited unexpectedly');
        },
      }),
    );

    const issues = emptyFactsIssues(output);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
    expect(issues[0].message).toContain('does it compile?');
  });

  it('probes status once even when facts are non-empty (degraded-build detection, #2624)', async () => {
    // Contract change from the original "never probe on success": move-flow
    // serves complete-looking facts for erroring builds while silently dropping
    // `acquiresInferred`, so the ONLY way to detect degraded fidelity is a
    // status probe after ingestion. A clean status must stay warning-free.
    let statusCalls = 0;
    const output = await runPhase(
      makeClient({
        facts: async () => ({
          '0xa::t': {
            file: path.join(REPO_ROOT, 'pkg', 'sources', 't.move'),
            span: [1, 3] as [number, number],
            friends: [],
            attributes: [],
            functions: [],
            structs: [],
            constants: [],
          },
        }),
        packageStatus: async () => {
          statusCalls += 1;
          return { ok: true, diagnostics: '' };
        },
      }),
    );

    expect(statusCalls).toBe(1);
    expect(emptyFactsIssues(output)).toHaveLength(0);
    expect(
      output.consistencyIssues.filter((i) => i.code === 'degraded-package-facts'),
    ).toHaveLength(0);
    expect(output.ingestedFiles.has('pkg/sources/t.move')).toBe(true);
  });
});
