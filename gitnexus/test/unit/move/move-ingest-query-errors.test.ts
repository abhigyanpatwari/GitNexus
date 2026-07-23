/**
 * Package-query failure classification in the moveIngest phase.
 *
 * Required facts/call-graph failures abort ingestion after the client's
 * transport retry. Supplemental function-usage failures are reported without
 * discarding the compiler graph.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  MoveFlowTimeoutError,
  MoveFlowToolCallError,
  type MoveFlowClient,
} from '../../../src/core/move/mcp-client.js';
import {
  makeMoveFlowClientStub,
  moveFunctionFact,
  runMoveIngestPhase,
} from '../../helpers/move-ingest-harness.js';

const REPO_ROOT = path.resolve('/repo');

const runPhase = (client: MoveFlowClient) =>
  runMoveIngestPhase(client, REPO_ROOT, ['pkg/Move.toml', 'pkg/sources/t.move']);

describe('moveIngest package-query failure classification', () => {
  it('queries move-flow again on every ingest run', async () => {
    let factsCall = 0;
    const client = makeMoveFlowClientStub({
      callGraph: async () => ({}),
      facts: async () => {
        factsCall += 1;
        return {
          '0xa::t': {
            file: path.join(REPO_ROOT, 'pkg/sources/t.move'),
            functions: [
              moveFunctionFact(factsCall === 1 ? 'first' : 'second', { visibility: 'public' }),
            ],
          },
        };
      },
    });

    const first = await runPhase(client);
    const second = await runPhase(client);

    expect(client.counts).toMatchObject({ capabilities: 2, callGraph: 2, facts: 2 });
    expect(first.functionNodeMap.has('0xa::t::first')).toBe(true);
    expect(second.functionNodeMap.has('0xa::t::second')).toBe(true);
  });

  it('reports supplemental function-usage failures without aborting ingestion', async () => {
    const client = makeMoveFlowClientStub({
      facts: async () => ({
        '0xa::t': {
          file: path.join(REPO_ROOT, 'pkg/sources/t.move'),
          functions: [
            moveFunctionFact('with_callback', {
              visibility: 'public',
              params: [],
              returnTypes: ['|u64|u64'],
            }),
            moveFunctionFact('after_failure', { visibility: 'public', params: [] }),
          ],
        },
      }),
      functionUsage: async () => {
        throw new MoveFlowToolCallError('function usage unavailable');
      },
    });

    const output = await runPhase(client);

    expect(output.functionNodeMap.has('0xa::t::with_callback')).toBe(true);
    expect(client.counts.functionUsage).toBeLessThanOrEqual(2);
    expect(output.functionUsageFailures).toHaveLength(1);
    expect(output.consistencyIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'function-usage-query-failed',
          severity: 'warning',
        }),
      ]),
    );
  });

  it('disables supplemental queries for later packages after the first failure', async () => {
    const client = makeMoveFlowClientStub({
      facts: async (packageRoot) => {
        const moduleName = path.basename(packageRoot);
        return {
          [`0xa::${moduleName}`]: {
            file: path.join(packageRoot, 'sources/t.move'),
            functions: [moveFunctionFact('run', { visibility: 'public', params: [] })],
          },
        };
      },
      functionUsage: async () => {
        throw new MoveFlowToolCallError('function usage unavailable');
      },
    });

    await runMoveIngestPhase(client, REPO_ROOT, [
      'pkg_a/Move.toml',
      'pkg_a/sources/t.move',
      'pkg_b/Move.toml',
      'pkg_b/sources/t.move',
    ]);

    expect(client.counts.functionUsage).toBe(1);
  });

  it('marks a timeout operator-actionable without a phase-level retry', async () => {
    const client = makeMoveFlowClientStub({
      callGraph: async () => {
        throw new MoveFlowTimeoutError(
          "move-flow 'move_package_query' timed out after 300000ms " +
            '(raise GITNEXUS_MOVE_FLOW_TIMEOUT_MS for large packages)',
        );
      },
    });
    await expect(runPhase(client)).rejects.toMatchObject({
      userActionable: true,
      message: expect.stringContaining('timed out'),
    });
    expect(client.counts.callGraph).toBe(1);
  });

  it('marks a package build failure operator-actionable', async () => {
    const client = makeMoveFlowClientStub({
      callGraph: async () => {
        throw new MoveFlowToolCallError('failed to build package `pkg`: missing dependency');
      },
    });
    await expect(runPhase(client)).rejects.toMatchObject({
      userActionable: true,
      message: expect.stringContaining('could not build Move package'),
    });
    expect(client.counts.callGraph).toBe(1);
  });

  it('skips isNative functions in the function_usage scan', async () => {
    const client = makeMoveFlowClientStub({
      facts: async () => ({
        '0xa::m': {
          file: 'a.move',
          functions: [moveFunctionFact('nat', { isNative: true }), moveFunctionFact('reg')],
          structs: [],
          constants: [],
        },
      }),
      callGraph: async () => ({}),
    });
    await runMoveIngestPhase(client, '/repo', ['a.move', 'Move.toml']);
    expect(client.counts.functionUsage).toBe(1);
  });

  it('propagates a transport crash unchanged (the client already retried)', async () => {
    const crash = new Error('move-flow exited unexpectedly (code 137)');
    const client = makeMoveFlowClientStub({
      callGraph: async () => {
        throw crash;
      },
    });
    await expect(runPhase(client)).rejects.toBe(crash);
    expect(client.counts.callGraph).toBe(1);
  });
});
