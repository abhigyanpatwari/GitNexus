import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface RuntimeTimeWindow {
  start?: string;
  end?: string;
}

export interface RuntimeServiceSignal {
  id: string;
  service: string;
  environment?: string;
  callCount: number;
  errorCount: number;
  errorRate: number;
  p95LatencyMs?: number;
  timeWindow?: RuntimeTimeWindow;
}

export interface RuntimeRouteSignal {
  id: string;
  service?: string;
  route: string;
  method?: string;
  environment?: string;
  callCount: number;
  errorCount: number;
  errorRate: number;
  p95LatencyMs?: number;
  timeWindow?: RuntimeTimeWindow;
}

export interface RuntimeSpanSignal {
  id: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  service?: string;
  name: string;
  spanKind?: string;
  route?: string;
  method?: string;
  statusCode?: number;
  durationMs?: number;
  callCount: number;
  errorCount: number;
  errorRate: number;
  p95LatencyMs?: number;
  environment?: string;
  timeWindow?: RuntimeTimeWindow;
  filePath?: string;
  symbolName?: string;
  symbolUid?: string;
}

export interface RuntimeStackFrame {
  filePath?: string;
  symbolName?: string;
  line?: number;
  column?: number;
  raw: string;
}

export interface RuntimeErrorSignal {
  id: string;
  service?: string;
  type?: string;
  message: string;
  count: number;
  lastSeen?: string;
  environment?: string;
  route?: string;
  method?: string;
  filePath?: string;
  symbolName?: string;
  symbolUid?: string;
  stackHash?: string;
  stackFrames?: RuntimeStackFrame[];
}

export interface RuntimeLogPatternSignal {
  id: string;
  service?: string;
  level?: string;
  pattern: string;
  count: number;
  lastSeen?: string;
  route?: string;
  method?: string;
  filePath?: string;
  symbolName?: string;
}

export interface RuntimeLogRecord {
  id: string;
  service?: string;
  level?: string;
  message: string;
  timestamp?: string;
  route?: string;
  method?: string;
  statusCode?: number;
  durationMs?: number;
  filePath?: string;
  symbolName?: string;
}

export interface RuntimeSignalStore {
  schemaVersion: 1;
  generatedAt: string;
  sourceFiles: string[];
  services: RuntimeServiceSignal[];
  routes: RuntimeRouteSignal[];
  spans: RuntimeSpanSignal[];
  errors: RuntimeErrorSignal[];
  logPatterns: RuntimeLogPatternSignal[];
  logs: RuntimeLogRecord[];
}

export type RuntimeImportFormat = 'auto' | 'otlp-json' | 'logs-jsonl' | 'stacktrace';

interface AggregateStats {
  callCount: number;
  errorCount: number;
  latencies: number[];
  start?: string;
  end?: string;
}

const emptyStats = (): AggregateStats => ({ callCount: 0, errorCount: 0, latencies: [] });

export const createEmptyRuntimeSignalStore = (sourceFiles: string[] = []): RuntimeSignalStore => ({
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sourceFiles,
  services: [],
  routes: [],
  spans: [],
  errors: [],
  logPatterns: [],
  logs: [],
});

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function toStringValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function toNumberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function readAttr(attrs: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = toStringValue(attrs[key]);
    if (value) return value;
  }
  return undefined;
}

function readNumAttr(attrs: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = toNumberValue(attrs[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function attrsArrayToObject(attrs: unknown): Record<string, unknown> {
  if (!Array.isArray(attrs)) return {};
  const out: Record<string, unknown> = {};
  for (const attr of attrs) {
    if (!attr || typeof attr !== 'object') continue;
    const key = toStringValue((attr as any).key);
    if (!key) continue;
    const value = (attr as any).value;
    if (value && typeof value === 'object') {
      if ('stringValue' in value) out[key] = (value as any).stringValue;
      else if ('intValue' in value) out[key] = Number((value as any).intValue);
      else if ('doubleValue' in value) out[key] = Number((value as any).doubleValue);
      else if ('boolValue' in value) out[key] = Boolean((value as any).boolValue);
      else out[key] = value;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function msFromUnixNano(start: unknown, end: unknown): number | undefined {
  const s = toNumberValue(start);
  const e = toNumberValue(end);
  if (s === undefined || e === undefined || e <= s) return undefined;
  return (e - s) / 1_000_000;
}

function isoFromUnixNano(value: unknown): string | undefined {
  const n = toNumberValue(value);
  if (n === undefined || n <= 0) return undefined;
  return new Date(n / 1_000_000).toISOString();
}

function isErrorStatus(statusCode: number | undefined): boolean {
  return statusCode !== undefined && statusCode >= 500;
}

function addStats(
  map: Map<string, AggregateStats>,
  key: string,
  args: { latency?: number; error?: boolean; start?: string; end?: string },
): void {
  const stats = map.get(key) ?? emptyStats();
  stats.callCount += 1;
  if (args.error) stats.errorCount += 1;
  if (args.latency !== undefined) stats.latencies.push(args.latency);
  if (args.start && (!stats.start || args.start < stats.start)) stats.start = args.start;
  if (args.end && (!stats.end || args.end > stats.end)) stats.end = args.end;
  map.set(key, stats);
}

function p95(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return Number(sorted[idx].toFixed(2));
}

function statsToRate(stats: AggregateStats): number {
  return stats.callCount > 0 ? Number((stats.errorCount / stats.callCount).toFixed(4)) : 0;
}

function mergeTimeWindows(
  a?: RuntimeTimeWindow,
  b?: RuntimeTimeWindow,
): RuntimeTimeWindow | undefined {
  const start = [a?.start, b?.start].filter(Boolean).sort()[0];
  const end = [a?.end, b?.end].filter(Boolean).sort().at(-1);
  return start || end ? { start, end } : undefined;
}

function normalizeMessagePattern(message: string): string {
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '{uuid}')
    .replace(/\b[0-9a-f]{12,}\b/gi, '{hex}')
    .replace(/\b\d+\b/g, '{num}')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function normalizeRoutePath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    if (/^https?:\/\//i.test(value)) return new URL(value).pathname || '/';
  } catch {
    return value;
  }
  return value.split('?')[0] || '/';
}

function mergeUnique<T extends { id: string }>(items: T[]): T[] {
  const map = new Map<string, T>();
  for (const item of items) map.set(item.id, { ...(map.get(item.id) as any), ...item });
  return [...map.values()];
}

function aggregateSignals(store: RuntimeSignalStore): RuntimeSignalStore {
  const serviceStats = new Map<string, AggregateStats>();
  const routeStats = new Map<string, AggregateStats>();
  const spanStats = new Map<string, AggregateStats>();

  for (const span of store.spans) {
    const service = span.service || 'unknown-service';
    const route = span.route || span.name;
    const error = span.errorCount > 0 || isErrorStatus(span.statusCode);
    addStats(serviceStats, service, {
      latency: span.durationMs,
      error,
      start: span.timeWindow?.start,
      end: span.timeWindow?.end,
    });
    addStats(routeStats, `${service}|${span.method || 'GET'}|${route}`, {
      latency: span.durationMs,
      error,
      start: span.timeWindow?.start,
      end: span.timeWindow?.end,
    });
    addStats(spanStats, `${service}|${span.name}`, {
      latency: span.durationMs,
      error,
      start: span.timeWindow?.start,
      end: span.timeWindow?.end,
    });
  }

  for (const log of store.logs) {
    const service = log.service || 'unknown-service';
    const error = (log.level || '').toLowerCase() === 'error' || isErrorStatus(log.statusCode);
    addStats(serviceStats, service, {
      latency: log.durationMs,
      error,
      start: log.timestamp,
      end: log.timestamp,
    });
    if (log.route) {
      addStats(routeStats, `${service}|${log.method || 'GET'}|${log.route}`, {
        latency: log.durationMs,
        error,
        start: log.timestamp,
        end: log.timestamp,
      });
    }
  }

  const services: RuntimeServiceSignal[] = [...serviceStats.entries()].map(([service, stats]) => ({
    id: `RuntimeService:${hashText(service)}`,
    service,
    callCount: stats.callCount,
    errorCount: stats.errorCount,
    errorRate: statsToRate(stats),
    p95LatencyMs: p95(stats.latencies),
    timeWindow: mergeTimeWindows({ start: stats.start, end: stats.end }),
  }));

  const routes: RuntimeRouteSignal[] = [...routeStats.entries()].map(([key, stats]) => {
    const [service, method, route] = key.split('|');
    return {
      id: `RuntimeRoute:${hashText(key)}`,
      service,
      method,
      route,
      callCount: stats.callCount,
      errorCount: stats.errorCount,
      errorRate: statsToRate(stats),
      p95LatencyMs: p95(stats.latencies),
      timeWindow: mergeTimeWindows({ start: stats.start, end: stats.end }),
    };
  });

  for (const span of store.spans) {
    const key = `${span.service || 'unknown-service'}|${span.name}`;
    const stats = spanStats.get(key);
    if (!stats) continue;
    span.callCount = stats.callCount;
    span.errorCount = stats.errorCount;
    span.errorRate = statsToRate(stats);
    span.p95LatencyMs = p95(stats.latencies);
  }

  return {
    ...store,
    services: mergeUnique([...store.services, ...services]),
    routes: mergeUnique([...store.routes, ...routes]),
  };
}

export function importOtlpJson(raw: string, sourceFile: string): RuntimeSignalStore {
  const parsed = JSON.parse(raw);
  const store = createEmptyRuntimeSignalStore([sourceFile]);
  const resourceSpans = Array.isArray(parsed.resourceSpans) ? parsed.resourceSpans : [];

  for (const resourceSpan of resourceSpans) {
    const resourceAttrs = attrsArrayToObject(resourceSpan?.resource?.attributes);
    const service =
      readAttr(resourceAttrs, ['service.name', 'serviceName', 'service']) ?? 'unknown-service';
    const environment = readAttr(resourceAttrs, [
      'deployment.environment',
      'deployment.environment.name',
      'environment',
    ]);
    const scopeSpans = Array.isArray(resourceSpan?.scopeSpans)
      ? resourceSpan.scopeSpans
      : Array.isArray(resourceSpan?.instrumentationLibrarySpans)
        ? resourceSpan.instrumentationLibrarySpans
        : [];

    for (const scopeSpan of scopeSpans) {
      const spans = Array.isArray(scopeSpan?.spans) ? scopeSpan.spans : [];
      for (const span of spans) {
        const attrs = attrsArrayToObject(span?.attributes);
        const name = toStringValue(span?.name) ?? 'span';
        const route = normalizeRoutePath(
          readAttr(attrs, ['http.route', 'url.path', 'http.target', 'rpc.method']),
        );
        const method = readAttr(attrs, ['http.request.method', 'http.method'])?.toUpperCase();
        const statusCode = readNumAttr(attrs, [
          'http.response.status_code',
          'http.status_code',
          'rpc.grpc.status_code',
        ]);
        const durationMs = msFromUnixNano(span?.startTimeUnixNano, span?.endTimeUnixNano);
        const start = isoFromUnixNano(span?.startTimeUnixNano);
        const end = isoFromUnixNano(span?.endTimeUnixNano);
        const filePath = readAttr(attrs, ['code.filepath', 'code.file.path', 'filePath', 'file']);
        const symbolName = readAttr(attrs, [
          'code.function',
          'function.name',
          'symbolName',
          'methodName',
        ]);
        const error = isErrorStatus(statusCode) || String(span?.status?.code ?? '') === '2';

        store.spans.push({
          id: `RuntimeSpan:${hashText(`${span?.traceId ?? ''}:${span?.spanId ?? ''}:${name}`)}`,
          traceId: toStringValue(span?.traceId),
          spanId: toStringValue(span?.spanId),
          parentSpanId: toStringValue(span?.parentSpanId),
          service,
          name,
          spanKind: toStringValue(span?.kind),
          route,
          method,
          statusCode,
          durationMs,
          callCount: 1,
          errorCount: error ? 1 : 0,
          errorRate: error ? 1 : 0,
          p95LatencyMs: durationMs,
          environment,
          timeWindow: start || end ? { start, end } : undefined,
          filePath,
          symbolName,
        });

        const events = Array.isArray(span?.events) ? span.events : [];
        for (const event of events) {
          if (toStringValue(event?.name) !== 'exception') continue;
          const eventAttrs = attrsArrayToObject(event?.attributes);
          const message =
            readAttr(eventAttrs, ['exception.message', 'message']) ??
            readAttr(attrs, ['error.message']) ??
            name;
          const type = readAttr(eventAttrs, ['exception.type', 'error.type']);
          const stack = readAttr(eventAttrs, ['exception.stacktrace', 'stack']);
          const frames = stack ? parseStackFrames(stack) : [];
          store.errors.push({
            id: `RuntimeError:${hashText(`${service}:${type ?? ''}:${message}:${stack ?? ''}`)}`,
            service,
            type,
            message,
            count: 1,
            lastSeen: isoFromUnixNano(event?.timeUnixNano) ?? end ?? start,
            environment,
            route,
            method,
            filePath: frames[0]?.filePath ?? filePath,
            symbolName: frames[0]?.symbolName ?? symbolName,
            stackHash: stack ? hashText(stack) : undefined,
            stackFrames: frames,
          });
        }
      }
    }
  }

  return aggregateSignals(store);
}

export function importJsonlLogs(raw: string, sourceFile: string): RuntimeSignalStore {
  const store = createEmptyRuntimeSignalStore([sourceFile]);
  const patternCounts = new Map<string, RuntimeLogPatternSignal>();
  const errorCounts = new Map<string, RuntimeErrorSignal>();

  raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line, index) => {
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(line);
      } catch {
        row = { message: line };
      }

      const message = readAttr(row, ['message', 'msg', 'error.message']) ?? line;
      const service = readAttr(row, ['service', 'serviceName', 'service.name']);
      const level = readAttr(row, ['level', 'severity', 'severityText'])?.toLowerCase();
      const timestamp = readAttr(row, ['timestamp', 'time', '@timestamp', 'observedAt']);
      const route = normalizeRoutePath(readAttr(row, ['route', 'path', 'http.route', 'url.path']));
      const method = readAttr(row, ['method', 'http.method', 'http.request.method'])?.toUpperCase();
      const statusCode = readNumAttr(row, ['statusCode', 'status', 'http.status_code']);
      const durationMs = readNumAttr(row, ['durationMs', 'latencyMs', 'elapsedMs']);
      const filePath = readAttr(row, ['filePath', 'file', 'code.filepath']);
      const symbolName = readAttr(row, [
        'symbolName',
        'functionName',
        'methodName',
        'code.function',
      ]);

      store.logs.push({
        id: `RuntimeLog:${hashText(`${sourceFile}:${index}:${message}`)}`,
        service,
        level,
        message,
        timestamp,
        route,
        method,
        statusCode,
        durationMs,
        filePath,
        symbolName,
      });

      const pattern = normalizeMessagePattern(message);
      const patternKey = `${service ?? ''}|${level ?? ''}|${pattern}`;
      const current = patternCounts.get(patternKey) ?? {
        id: `RuntimeLogPattern:${hashText(patternKey)}`,
        service,
        level,
        pattern,
        count: 0,
        route,
        method,
        filePath,
        symbolName,
      };
      current.count += 1;
      if (timestamp && (!current.lastSeen || timestamp > current.lastSeen))
        current.lastSeen = timestamp;
      patternCounts.set(patternKey, current);

      if (level === 'error' || isErrorStatus(statusCode)) {
        const stack = readAttr(row, ['stack', 'stacktrace', 'exception.stacktrace']);
        const frames = stack ? parseStackFrames(stack) : [];
        const type = readAttr(row, ['error.type', 'exception.type', 'type']);
        const key = `${service ?? ''}|${type ?? ''}|${pattern}|${stack ? hashText(stack) : ''}`;
        const currentError = errorCounts.get(key) ?? {
          id: `RuntimeError:${hashText(key)}`,
          service,
          type,
          message,
          count: 0,
          route,
          method,
          filePath: frames[0]?.filePath ?? filePath,
          symbolName: frames[0]?.symbolName ?? symbolName,
          stackHash: stack ? hashText(stack) : undefined,
          stackFrames: frames,
        };
        currentError.count += 1;
        if (timestamp && (!currentError.lastSeen || timestamp > currentError.lastSeen)) {
          currentError.lastSeen = timestamp;
        }
        errorCounts.set(key, currentError);
      }
    });

  store.logPatterns = [...patternCounts.values()];
  store.errors = [...errorCounts.values()];
  return aggregateSignals(store);
}

export function parseStackFrames(stack: string): RuntimeStackFrame[] {
  const frames: RuntimeStackFrame[] = [];
  for (const raw of stack.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    let match = line.match(/^at\s+(.*?)\s+\((.*?):(\d+):(\d+)\)$/);
    if (match) {
      frames.push({
        symbolName: match[1],
        filePath: match[2],
        line: Number(match[3]),
        column: Number(match[4]),
        raw: line,
      });
      continue;
    }

    match = line.match(/^at\s+(.*?):(\d+):(\d+)$/);
    if (match) {
      frames.push({
        filePath: match[1],
        line: Number(match[2]),
        column: Number(match[3]),
        raw: line,
      });
      continue;
    }

    match = line.match(/^File\s+"([^"]+)",\s+line\s+(\d+),\s+in\s+(.+)$/);
    if (match) {
      frames.push({
        filePath: match[1],
        line: Number(match[2]),
        symbolName: match[3],
        raw: line,
      });
      continue;
    }

    match = line.match(/^at\s+(.+)\(([^():]+):(\d+)\)$/);
    if (match) {
      frames.push({
        symbolName: match[1],
        filePath: match[2],
        line: Number(match[3]),
        raw: line,
      });
    }
  }
  return frames;
}

export function importStackTrace(raw: string, sourceFile: string): RuntimeSignalStore {
  const store = createEmptyRuntimeSignalStore([sourceFile]);
  const chunks = raw
    .split(/\n\s*\n/g)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  for (const chunk of chunks.length > 0 ? chunks : [raw]) {
    const lines = chunk
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) continue;
    const first = lines[0];
    const firstMatch = first.match(/^([A-Za-z0-9_.:$-]+(?:Error|Exception|Panic)?):?\s*(.*)$/);
    const type = firstMatch?.[1];
    const message = firstMatch?.[2] || first;
    const frames = parseStackFrames(lines.slice(1).join('\n'));
    store.errors.push({
      id: `RuntimeError:${hashText(chunk)}`,
      type,
      message,
      count: 1,
      filePath: frames[0]?.filePath,
      symbolName: frames[0]?.symbolName,
      stackHash: hashText(chunk),
      stackFrames: frames,
    });
  }
  return store;
}

export function detectRuntimeImportFormat(filePath: string, raw: string): RuntimeImportFormat {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.jsonl') || lower.endsWith('.ndjson')) return 'logs-jsonl';
  if (lower.endsWith('.log') || lower.endsWith('.trace') || lower.endsWith('.stack'))
    return 'stacktrace';
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.resourceSpans))
      return 'otlp-json';
    if (Array.isArray(parsed)) return 'logs-jsonl';
  } catch {
    if (raw.split(/\r?\n/).some((line) => line.trim().startsWith('{'))) return 'logs-jsonl';
  }
  return 'stacktrace';
}

export function mergeRuntimeSignalStores(stores: RuntimeSignalStore[]): RuntimeSignalStore {
  const merged = createEmptyRuntimeSignalStore(
    Array.from(new Set(stores.flatMap((store) => store.sourceFiles ?? []))),
  );
  for (const store of stores) {
    merged.services.push(...(store.services ?? []));
    merged.routes.push(...(store.routes ?? []));
    merged.spans.push(...(store.spans ?? []));
    merged.errors.push(...(store.errors ?? []));
    merged.logPatterns.push(...(store.logPatterns ?? []));
    merged.logs.push(...(store.logs ?? []));
  }

  merged.services = mergeUnique(merged.services);
  merged.routes = mergeUnique(merged.routes);
  merged.spans = mergeUnique(merged.spans);
  merged.errors = mergeUnique(merged.errors);
  merged.logPatterns = mergeUnique(merged.logPatterns);
  merged.logs = mergeUnique(merged.logs);
  merged.generatedAt = new Date().toISOString();
  return aggregateSignals(merged);
}

export async function importRuntimeFile(
  inputPath: string,
  format: RuntimeImportFormat = 'auto',
): Promise<RuntimeSignalStore> {
  const resolved = path.resolve(inputPath);
  const raw = await fs.readFile(resolved, 'utf-8');
  const picked = format === 'auto' ? detectRuntimeImportFormat(resolved, raw) : format;
  if (picked === 'otlp-json') return importOtlpJson(raw, resolved);
  if (picked === 'logs-jsonl') return importJsonlLogs(raw, resolved);
  return importStackTrace(raw, resolved);
}

export async function readRuntimeSignalStore(
  signalPath: string,
): Promise<RuntimeSignalStore | null> {
  try {
    const raw = await fs.readFile(signalPath, 'utf-8');
    const parsed = JSON.parse(raw) as RuntimeSignalStore;
    if (parsed.schemaVersion !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeRuntimeSignalStore(
  signalPath: string,
  store: RuntimeSignalStore,
): Promise<void> {
  await fs.mkdir(path.dirname(signalPath), { recursive: true });
  await fs.writeFile(signalPath, JSON.stringify(store, null, 2), 'utf-8');
}
