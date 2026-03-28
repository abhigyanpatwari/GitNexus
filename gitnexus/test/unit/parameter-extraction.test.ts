import { describe, it, expect } from 'vitest';
import type { ExtractedParameter } from '../../src/core/ingestion/workers/parse-worker.js';

describe('ExtractedParameter interface', () => {
  it('accepts valid parameter data', () => {
    const param: ExtractedParameter = {
      filePath: 'route.ts',
      functionName: 'handlePOST',
      functionId: 'Function:route.ts:handlePOST',
      paramName: 'request',
      paramIndex: 0,
      declaredType: 'NextRequest',
      isRest: false,
    };
    expect(param.paramName).toBe('request');
    expect(param.paramIndex).toBe(0);
    expect(param.declaredType).toBe('NextRequest');
    expect(param.isRest).toBe(false);
  });

  it('accepts rest parameter', () => {
    const param: ExtractedParameter = {
      filePath: 'utils.ts',
      functionName: 'merge',
      functionId: 'Function:utils.ts:merge',
      paramName: 'args',
      paramIndex: 0,
      isRest: true,
    };
    expect(param.isRest).toBe(true);
    expect(param.declaredType).toBeUndefined();
  });

  it('accepts parameter without type annotation', () => {
    const param: ExtractedParameter = {
      filePath: 'handler.js',
      functionName: 'process',
      functionId: 'Function:handler.js:process',
      paramName: 'data',
      paramIndex: 0,
      isRest: false,
    };
    expect(param.declaredType).toBeUndefined();
  });
});
