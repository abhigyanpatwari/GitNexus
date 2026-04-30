import { describe, expect, it } from 'vitest';
import {
  importJsonlLogs,
  importOtlpJson,
  importStackTrace,
  mergeRuntimeSignalStores,
  parseStackFrames,
} from '../../../src/core/runtime/overlay.js';

describe('runtime overlay importer', () => {
  it('normalizes structured JSONL logs into runtime routes, errors, and patterns', () => {
    const store = importJsonlLogs(
      [
        JSON.stringify({
          service: 'api',
          level: 'error',
          message: 'failed user 123',
          timestamp: '2026-04-30T10:00:00.000Z',
          route: '/users/123?debug=1',
          method: 'get',
          statusCode: 500,
          durationMs: 42,
          filePath: 'src/users.ts',
          symbolName: 'loadUser',
          stack: 'Error: failed\n    at loadUser (src/users.ts:12:5)',
        }),
        JSON.stringify({
          service: 'api',
          level: 'info',
          message: 'loaded user 456',
          timestamp: '2026-04-30T10:00:01.000Z',
          route: '/users/123',
          method: 'get',
          statusCode: 200,
          durationMs: 18,
        }),
      ].join('\n'),
      'logs.jsonl',
    );

    expect(store.logs).toHaveLength(2);
    expect(store.routes[0]).toMatchObject({
      service: 'api',
      method: 'GET',
      callCount: 2,
      errorCount: 1,
      errorRate: 0.5,
    });
    expect(store.errors[0]).toMatchObject({
      service: 'api',
      symbolName: 'loadUser',
      filePath: 'src/users.ts',
    });
    expect(store.logPatterns[0].pattern).toContain('{num}');
  });

  it('imports OTLP spans and exception events with route and code mapping hints', () => {
    const store = importOtlpJson(
      JSON.stringify({
        resourceSpans: [
          {
            resource: {
              attributes: [
                { key: 'service.name', value: { stringValue: 'checkout' } },
                { key: 'deployment.environment', value: { stringValue: 'prod' } },
              ],
            },
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: 'trace-1',
                    spanId: 'span-1',
                    name: 'POST /orders',
                    startTimeUnixNano: 1_000_000_000,
                    endTimeUnixNano: 1_150_000_000,
                    attributes: [
                      { key: 'http.route', value: { stringValue: '/orders' } },
                      { key: 'http.request.method', value: { stringValue: 'POST' } },
                      { key: 'http.response.status_code', value: { intValue: '500' } },
                      { key: 'code.filepath', value: { stringValue: 'src/orders.ts' } },
                      { key: 'code.function', value: { stringValue: 'createOrder' } },
                    ],
                    events: [
                      {
                        name: 'exception',
                        timeUnixNano: 1_150_000_000,
                        attributes: [
                          { key: 'exception.message', value: { stringValue: 'boom' } },
                          { key: 'exception.type', value: { stringValue: 'OrderError' } },
                          {
                            key: 'exception.stacktrace',
                            value: { stringValue: 'at createOrder (src/orders.ts:20:9)' },
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
      'otlp.json',
    );

    expect(store.services[0]).toMatchObject({ service: 'checkout', errorCount: 1 });
    expect(store.routes[0]).toMatchObject({ route: '/orders', method: 'POST', p95LatencyMs: 150 });
    expect(store.spans[0]).toMatchObject({
      filePath: 'src/orders.ts',
      symbolName: 'createOrder',
      errorRate: 1,
    });
    expect(store.errors[0].stackFrames?.[0]).toMatchObject({
      filePath: 'src/orders.ts',
      symbolName: 'createOrder',
    });
  });

  it('parses stack traces and merges stores without duplicating ids', () => {
    const frames = parseStackFrames('at run (src/main.ts:4:2)\nFile "app.py", line 9, in handle');
    expect(frames).toHaveLength(2);

    const one = importStackTrace('TypeError: broken\nat run (src/main.ts:4:2)', 'one.stack');
    const two = importStackTrace('TypeError: broken\nat run (src/main.ts:4:2)', 'one.stack');
    const merged = mergeRuntimeSignalStores([one, two]);

    expect(merged.errors).toHaveLength(1);
    expect(merged.sourceFiles).toEqual(['one.stack']);
  });
});
