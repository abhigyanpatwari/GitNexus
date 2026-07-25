import { describe, expect, it } from 'vitest';
import { collectClosureCaptureCalls } from '../../../src/core/move/function-usage.js';
import { makeMoveFlowClientStub, moveFunctionFact } from '../../helpers/move-ingest-harness.js';

describe('collectClosureCaptureCalls', () => {
  it('bounds concurrency and emits only closure-captured calls missing from ordinary call data', async () => {
    let inFlight = 0;
    let peak = 0;
    const client = makeMoveFlowClientStub({
      functionUsage: async (_packageRoot, functionName) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return functionName === 'm::capture'
          ? {
              called: ['0xa::dep::direct'],
              used: [
                '0xa::dep::direct',
                '0xa::dep::ordinary',
                '0xa::dep::captured',
                '0xa::dep::captured',
              ],
            }
          : { called: [], used: [] };
      },
    });
    const facts = {
      '0xa::m': {
        functions: [
          moveFunctionFact('capture'),
          moveFunctionFact('other'),
          moveFunctionFact('native', { isNative: true }),
          moveFunctionFact('lifted', { isLambdaLifted: true }),
        ],
      },
    };

    const result = await collectClosureCaptureCalls(
      client,
      '/repo/pkg',
      facts,
      { '0xa::m::capture': ['0xa::dep::ordinary'] },
      2,
    );

    expect(peak).toBe(2);
    expect(client.counts.functionUsage).toBe(2);
    expect(result.failures).toEqual([]);
    expect(result.calls).toEqual({
      '0xa::m::capture': ['0xa::dep::captured'],
    });
  });
});
