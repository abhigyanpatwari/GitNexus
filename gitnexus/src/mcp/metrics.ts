/**
 * MCP server-side observability — OpenTelemetry metrics with Prometheus exposition.
 *
 * Answers issue #1351: provides ground-truth "is this MCP server being used?"
 * for operators who scrape `/metrics`.
 *
 * Design constraints from the maintainer's framing:
 * - OpenTelemetry format (not custom JSON, not pino).
 * - Anonymous: no per-call identifiers, no input data, no error message text.
 *   Cypher parse errors echo user input, so error is recorded as a boolean only.
 * - Prometheus: pull model via `/metrics`. No collector required.
 * - Quantized: histograms with explicit buckets. No raw per-call values escape.
 *
 * Privacy boundary is type-enforced: observe() takes `(result) => boolean`,
 * never a message-returning detector. The error label is `error="true|false"`,
 * never a message.
 *
 * Initialization is opt-in via GITNEXUS_OTEL_METRICS=on. Bound to 127.0.0.1 by
 * default. The exporter is configured to suppress `target_info` and scope info
 * so the only labels emitted are `tool` (closed set) and `error` (boolean).
 *
 * Stdio mode emits no metrics by default — each agent host spawns its own
 * process and binding ephemeral ports is operationally useless. Supported
 * scrape target is `gitnexus serve`.
 */

import type { Counter, Histogram, UpDownCounter } from '@opentelemetry/api';
import { MeterProvider, AggregationType } from '@opentelemetry/sdk-metrics';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';

const METER_NAME = 'gitnexus.mcp';

// Quantized buckets. Once published, these become a dashboard contract;
// boundaries are intentionally coarse so we don't have to recut them.
//
// Duration: tools that hit the in-memory graph (`context`, `query` on a small
// repo) commonly return in 1–30ms; `impact` / `detect_changes` on a large repo
// can run multiple seconds. 1ms..30s covers cold-cache outliers.
export const DURATION_BUCKETS_SECONDS = [0.001, 0.005, 0.025, 0.1, 0.5, 2.5, 10, 30];

// Result size: tool responses range from a few-hundred-byte error envelopes to
// multi-megabyte `context`/`cypher` payloads. The modal `context`/`route_map`
// answer lands in 2–8 KB; boundaries are chosen so that range straddles a
// boundary rather than collapsing into one bucket.
export const RESULT_BYTES_BUCKETS = [512, 2048, 8192, 32768, 131072, 524288, 2097152];

let provider: MeterProvider | null = null;
let exporter: PrometheusExporter | null = null;
let requestsCounter: Counter | null = null;
let durationHistogram: Histogram | null = null;
let resultBytesHistogram: Histogram | null = null;
let inflightGauge: UpDownCounter | null = null;

function envFlag(value: string | undefined): boolean {
  if (typeof value !== 'string') return false;
  const v = value.trim().toLowerCase();
  return v === 'on' || v === 'true' || v === '1';
}

export interface InitMetricsOptions {
  /**
   * Override the env-driven master switch. Use in tests to force initialization
   * without setting process env.
   */
  forceEnabled?: boolean;
}

export interface InitMetricsResult {
  enabled: boolean;
  port?: number;
  host?: string;
  endpoint?: string;
}

/**
 * Initialize the OTel meter provider and start the Prometheus exporter HTTP
 * server. No-op when GITNEXUS_OTEL_METRICS is unset, empty, off, false, or 0.
 *
 * Safe to call multiple times — second and later calls return the existing
 * state without re-binding the port.
 */
export async function initMetrics(
  opts: InitMetricsOptions = {},
): Promise<InitMetricsResult> {
  const env = process.env;
  const enabled = opts.forceEnabled ?? envFlag(env['GITNEXUS_OTEL_METRICS']);
  if (!enabled) return { enabled: false };

  if (provider !== null) {
    return {
      enabled: true,
      port: Number(env['GITNEXUS_OTEL_METRICS_PORT'] ?? 9464),
      host: env['GITNEXUS_OTEL_METRICS_HOST'] ?? '127.0.0.1',
      endpoint: env['GITNEXUS_OTEL_METRICS_ENDPOINT'] ?? '/metrics',
    };
  }

  const port = Number(env['GITNEXUS_OTEL_METRICS_PORT'] ?? 9464);
  const host = env['GITNEXUS_OTEL_METRICS_HOST'] ?? '127.0.0.1';
  const endpoint = env['GITNEXUS_OTEL_METRICS_ENDPOINT'] ?? '/metrics';

  exporter = new PrometheusExporter({
    host,
    port,
    endpoint,
    // Privacy: suppress target_info (would ship every resource attribute as a
    // separate metric series) and otel_scope_info. Only labels we want to
    // expose are `tool` and `error`.
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

  // Use the provider directly rather than the global registration. Each
  // process gets exactly one provider (init is idempotent above); skipping the
  // global avoids state-leak across vitest fork boundaries when tests cycle
  // init/shutdown repeatedly.
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

  // Wait until the exporter HTTP server is actually accepting connections so
  // callers can integration-test the endpoint immediately after init.
  await exporter.startServer();

  return { enabled: true, port, host, endpoint };
}

/**
 * Shut down the meter provider and exporter HTTP server. Safe to call when
 * init was a no-op (resets nothing). Use in graceful-shutdown paths.
 */
export async function shutdownMetrics(): Promise<void> {
  const p = provider;
  const e = exporter;
  provider = null;
  exporter = null;
  requestsCounter = null;
  durationHistogram = null;
  resultBytesHistogram = null;
  inflightGauge = null;
  if (e) await e.shutdown().catch(() => {});
  if (p) await p.shutdown().catch(() => {});
}

/**
 * Wrap an MCP tool handler with metric instrumentation. Records:
 *   - requests counter (incremented once per call, with `error` label)
 *   - duration histogram (in seconds)
 *   - result bytes histogram (only on success — error-path size is meaningless)
 *   - in-flight up/down counter
 *
 * The `hasError` detector returns a boolean only. The result's error message
 * is intentionally not accepted at this seam — error messages echo user input
 * (cypher parse errors include the offending clause) and are an anonymity
 * leak.
 *
 * No-op when init was disabled: the metric handles are null, calls are
 * skipped, work runs untouched.
 */
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
    // Thrown errors are converted to error envelopes by the MCP handler upstream,
    // so this branch is reached only on truly exceptional failures (transport,
    // sentinel, programming errors). Record as error=true with zero bytes.
    const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
    const labels = { tool, error: 'true' };
    requestsCounter?.add(1, labels);
    durationHistogram?.record(durationSeconds, labels);
    throw err;
  } finally {
    inflightGauge?.add(-1, attrs);
  }
}

/**
 * Returns true if metrics are currently initialized. Test helper.
 */
export function isMetricsEnabled(): boolean {
  return provider !== null;
}
