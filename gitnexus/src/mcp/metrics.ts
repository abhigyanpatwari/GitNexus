/**
 * Error messages from MCP tool handlers (notably cypher parse errors) echo
 * user input, so `observe()` accepts a boolean error detector only — never
 * the error string. Exporter is configured to suppress target_info /
 * otel_scope_info so the label set stays bounded to {tool, error, le}.
 */

import type { Counter, Histogram, UpDownCounter } from '@opentelemetry/api';
import { MeterProvider, AggregationType } from '@opentelemetry/sdk-metrics';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';

const METER_NAME = 'gitnexus.mcp';

// Bucket boundaries are a published dashboard contract; do not recut without
// coordinating with scrape consumers.
export const DURATION_BUCKETS_SECONDS = [0.001, 0.005, 0.025, 0.1, 0.5, 2.5, 10, 30];
export const RESULT_BYTES_BUCKETS = [512, 2048, 8192, 32768, 131072, 524288, 2097152];

let provider: MeterProvider | null = null;
let exporter: PrometheusExporter | null = null;
let requestsCounter: Counter | null = null;
let durationHistogram: Histogram | null = null;
let resultBytesHistogram: Histogram | null = null;
let inflightGauge: UpDownCounter | null = null;
let boundConfig: { port: number; host: string; endpoint: string } | null = null;

function envFlag(value: string | undefined): boolean {
  if (typeof value !== 'string') return false;
  const v = value.trim().toLowerCase();
  return v === 'on' || v === 'true' || v === '1';
}

export interface InitMetricsOptions {
  forceEnabled?: boolean;
}

export interface InitMetricsResult {
  enabled: boolean;
  port?: number;
  host?: string;
  endpoint?: string;
}

/** Idempotent: subsequent calls return the bound state without re-binding. */
export async function initMetrics(
  opts: InitMetricsOptions = {},
): Promise<InitMetricsResult> {
  const env = process.env;
  const enabled = opts.forceEnabled ?? envFlag(env['GITNEXUS_OTEL_METRICS']);
  if (!enabled) return { enabled: false };

  if (provider !== null && boundConfig !== null) {
    return { enabled: true, ...boundConfig };
  }

  const port = Number(env['GITNEXUS_OTEL_METRICS_PORT'] ?? 9464);
  const host = env['GITNEXUS_OTEL_METRICS_HOST'] ?? '127.0.0.1';
  const endpoint = env['GITNEXUS_OTEL_METRICS_ENDPOINT'] ?? '/metrics';

  exporter = new PrometheusExporter({
    host,
    port,
    endpoint,
    // target_info would publish every resource attribute as its own series —
    // keep the label set bounded.
    withoutTargetInfo: true,
    withoutScopeInfo: true,
    appendTimestamp: false,
  });

  provider = new MeterProvider({
    readers: [exporter],
    views: [
      {
        instrumentName: 'gitnexus_mcp_tool_request_duration_seconds',
        aggregation: {
          type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
          options: { boundaries: DURATION_BUCKETS_SECONDS, recordMinMax: false },
        },
      },
      {
        instrumentName: 'gitnexus_mcp_tool_result_bytes',
        aggregation: {
          type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
          options: { boundaries: RESULT_BYTES_BUCKETS, recordMinMax: false },
        },
      },
    ],
  });

  // Provider stays local — global registration would leak state across
  // repeat init/shutdown cycles.
  const meter = provider.getMeter(METER_NAME);

  requestsCounter = meter.createCounter('gitnexus_mcp_tool_requests_total', {
    description: 'Total MCP tool invocations, labelled by tool name and error outcome.',
  });

  durationHistogram = meter.createHistogram('gitnexus_mcp_tool_request_duration_seconds', {
    description: 'End-to-end MCP tool handler latency in seconds.',
    unit: 's',
  });

  resultBytesHistogram = meter.createHistogram('gitnexus_mcp_tool_result_bytes', {
    description: 'Size of the MCP tool result text payload in bytes.',
    unit: 'By',
  });

  inflightGauge = meter.createUpDownCounter('gitnexus_mcp_tool_inflight', {
    description: 'Currently executing MCP tool handlers, labelled by tool.',
  });

  await exporter.startServer();
  boundConfig = { port, host, endpoint };

  return { enabled: true, port, host, endpoint };
}

export async function shutdownMetrics(): Promise<void> {
  const p = provider;
  const e = exporter;
  provider = null;
  exporter = null;
  requestsCounter = null;
  durationHistogram = null;
  resultBytesHistogram = null;
  inflightGauge = null;
  boundConfig = null;
  if (e) {
    await e.shutdown().catch((err) => {
      process.stderr.write(`[gitnexus metrics] exporter shutdown error: ${err?.message ?? err}\n`);
    });
  }
  if (p) {
    await p.shutdown().catch((err) => {
      process.stderr.write(`[gitnexus metrics] provider shutdown error: ${err?.message ?? err}\n`);
    });
  }
}

/** hasError must be a boolean; never accept the error string — cypher errors echo user input. */
export async function observe<T>(
  tool: string,
  fn: () => Promise<T>,
  sizer: (result: T) => number,
  hasError: (result: T) => boolean,
): Promise<T> {
  if (provider === null) return fn();

  const attrs = { tool };
  inflightGauge?.add(1, attrs);
  const start = process.hrtime.bigint();
  try {
    const result = await fn();
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
    const errored = hasError(result);
    const labels = { tool, error: errored ? 'true' : 'false' };
    requestsCounter?.add(1, labels);
    durationHistogram?.record(durationSeconds, labels);
    if (!errored) {
      let bytes = 0;
      try {
        bytes = sizer(result);
      } catch {
        bytes = 0;
      }
      resultBytesHistogram?.record(bytes, { tool });
    }
    return result;
  } catch (err) {
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
    const labels = { tool, error: 'true' };
    requestsCounter?.add(1, labels);
    durationHistogram?.record(durationSeconds, labels);
    throw err;
  } finally {
    inflightGauge?.add(-1, attrs);
  }
}

export function isMetricsEnabled(): boolean {
  return provider !== null;
}
