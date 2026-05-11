import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  initMetrics,
  observe,
  shutdownMetrics,
  isMetricsEnabled,
  DURATION_BUCKETS_SECONDS,
  RESULT_BYTES_BUCKETS,
} from '../../../src/mcp/metrics.js';

const prevEnv = { ...process.env };

function clearMetricsEnv(): void {
  delete process.env['GITNEXUS_OTEL_METRICS'];
  delete process.env['GITNEXUS_OTEL_METRICS_PORT'];
  delete process.env['GITNEXUS_OTEL_METRICS_HOST'];
  delete process.env['GITNEXUS_OTEL_METRICS_ENDPOINT'];
}

async function withRandomPort<T>(fn: () => Promise<T>): Promise<T> {
  // Exporter needs a concrete port number, not 0 — pre-bind to discover one.
  const net = await import('node:net');
  const srv = net.createServer();
  const port = await new Promise<number>((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') resolve(addr.port);
      else reject(new Error('bad addr'));
    });
  });
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  process.env['GITNEXUS_OTEL_METRICS_PORT'] = String(port);
  process.env['GITNEXUS_OTEL_METRICS_HOST'] = '127.0.0.1';
  return fn();
}

beforeEach(() => {
  clearMetricsEnv();
});

afterEach(async () => {
  await shutdownMetrics();
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, prevEnv);
});

describe('initMetrics gating', () => {
  it('is a no-op when GITNEXUS_OTEL_METRICS is unset', async () => {
    const result = await initMetrics();
    expect(result.enabled).toBe(false);
    expect(isMetricsEnabled()).toBe(false);
  });

  it('is a no-op for off/false/0/empty', async () => {
    for (const v of ['off', 'OFF', 'false', '0', '', '   ']) {
      process.env['GITNEXUS_OTEL_METRICS'] = v;
      const result = await initMetrics();
      expect(result.enabled, `value=${JSON.stringify(v)}`).toBe(false);
      expect(isMetricsEnabled()).toBe(false);
    }
  });

  it('initializes for on/true/1', async () => {
    process.env['GITNEXUS_OTEL_METRICS'] = 'on';
    await withRandomPort(async () => {
      const result = await initMetrics();
      expect(result.enabled).toBe(true);
      expect(isMetricsEnabled()).toBe(true);
    });
  });

  it('idempotent re-init returns the originally bound values, not current env', async () => {
    process.env['GITNEXUS_OTEL_METRICS'] = 'on';
    await withRandomPort(async () => {
      const first = await initMetrics();
      process.env['GITNEXUS_OTEL_METRICS_PORT'] = '65535';
      process.env['GITNEXUS_OTEL_METRICS_HOST'] = '0.0.0.0';
      process.env['GITNEXUS_OTEL_METRICS_ENDPOINT'] = '/changed';
      const second = await initMetrics();
      expect(second.port).toBe(first.port);
      expect(second.host).toBe(first.host);
      expect(second.endpoint).toBe(first.endpoint);
    });
  });

  it('honors forceEnabled regardless of env', async () => {
    delete process.env['GITNEXUS_OTEL_METRICS'];
    await withRandomPort(async () => {
      const result = await initMetrics({ forceEnabled: true });
      expect(result.enabled).toBe(true);
      expect(isMetricsEnabled()).toBe(true);
    });
  });
});

describe('observe() — success path', () => {
  it('runs the work and returns the result when metrics are disabled', async () => {
    const result = await observe(
      'query',
      async () => ({ value: 42 }),
      (r) => JSON.stringify(r).length,
      () => false,
    );
    expect(result).toEqual({ value: 42 });
  });

  it('records a success call against the Prometheus exposition', async () => {
    process.env['GITNEXUS_OTEL_METRICS'] = 'on';
    await withRandomPort(async () => {
      const init = await initMetrics();
      expect(init.enabled).toBe(true);

      await observe(
        'list_repos',
        async () => ({ content: [{ type: 'text', text: 'ok' }] }),
        (r) => Buffer.byteLength(r.content[0]!.text, 'utf8'),
        (r) => (r as any).isError === true,
      );

      const text = await fetch(`http://127.0.0.1:${init.port}/metrics`).then((r) => r.text());
      expect(text).toContain(
        'gitnexus_mcp_tool_requests_total{tool="list_repos",error="false"} 1',
      );
      expect(text).toContain('gitnexus_mcp_tool_request_duration_seconds_count');
      expect(text).toContain('gitnexus_mcp_tool_result_bytes_count');
    });
  });
});

describe('observe() — error path', () => {
  it('records error=true when the result envelope has isError', async () => {
    process.env['GITNEXUS_OTEL_METRICS'] = 'on';
    await withRandomPort(async () => {
      const init = await initMetrics();
      const SECRET_ECHO = 'attacker-supplied-cypher-clause';
      await observe(
        'cypher',
        async () => ({
          content: [{ type: 'text', text: `Error: parse error near ${SECRET_ECHO}` }],
          isError: true,
        }),
        (r) => Buffer.byteLength(r.content[0]!.text, 'utf8'),
        (r) => (r as any).isError === true,
      );

      const text = await fetch(`http://127.0.0.1:${init.port}/metrics`).then((r) => r.text());
      expect(text).toContain('gitnexus_mcp_tool_requests_total{tool="cypher",error="true"} 1');
      expect(text).not.toContain(SECRET_ECHO);
      expect(text).not.toContain('parse error');
    });
  });

  it('rethrows on synchronous failures while still recording duration', async () => {
    process.env['GITNEXUS_OTEL_METRICS'] = 'on';
    await withRandomPort(async () => {
      const init = await initMetrics();
      await expect(
        observe(
          'detect_changes',
          async () => {
            throw new Error('boom');
          },
          () => 0,
          () => false,
        ),
      ).rejects.toThrow('boom');

      const text = await fetch(`http://127.0.0.1:${init.port}/metrics`).then((r) => r.text());
      expect(text).toContain(
        'gitnexus_mcp_tool_requests_total{tool="detect_changes",error="true"} 1',
      );
    });
  });
});

describe('observe() — in-flight balance', () => {
  it('decrements the gauge in finally even when the work throws', async () => {
    process.env['GITNEXUS_OTEL_METRICS'] = 'on';
    await withRandomPort(async () => {
      const init = await initMetrics();
      for (let i = 0; i < 3; i++) {
        await expect(
          observe(
            'impact',
            async () => {
              throw new Error('x');
            },
            () => 0,
            () => false,
          ),
        ).rejects.toThrow('x');
      }

      const text = await fetch(`http://127.0.0.1:${init.port}/metrics`).then((r) => r.text());
      expect(text).toMatch(/gitnexus_mcp_tool_inflight\{tool="impact"\} 0\b/);
    });
  });
});

describe('privacy: target_info / scope_info suppression', () => {
  it('does not emit target_info or otel_scope_info series', async () => {
    process.env['GITNEXUS_OTEL_METRICS'] = 'on';
    await withRandomPort(async () => {
      const init = await initMetrics();
      await observe(
        'context',
        async () => ({ content: [{ type: 'text', text: 'x' }] }),
        (r) => Buffer.byteLength(r.content[0]!.text, 'utf8'),
        () => false,
      );

      const text = await fetch(`http://127.0.0.1:${init.port}/metrics`).then((r) => r.text());
      expect(text).not.toMatch(/^target_info/m);
      expect(text).not.toMatch(/otel_scope_info/);
      const labelLines = text.split('\n').filter((l) => l.includes('gitnexus_mcp_'));
      for (const line of labelLines) {
        const match = line.match(/\{([^}]*)\}/);
        if (!match) continue;
        const labels = match[1]!.split(',').map((s) => s.split('=')[0]!.trim());
        for (const k of labels) {
          expect(['tool', 'error', 'le']).toContain(k);
        }
      }
    });
  });
});

describe('bucket boundary contract', () => {
  it('publishes the documented duration buckets verbatim', () => {
    expect(DURATION_BUCKETS_SECONDS).toEqual([0.001, 0.005, 0.025, 0.1, 0.5, 2.5, 10, 30]);
  });

  it('publishes the documented result-size buckets verbatim', () => {
    expect(RESULT_BYTES_BUCKETS).toEqual([512, 2048, 8192, 32768, 131072, 524288, 2097152]);
  });
});
