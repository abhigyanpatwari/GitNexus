/**
 * Trace Overlay Service
 *
 * Fetches a Langfuse trace from the GitNexus backend server (/api/trace)
 * and returns resolved node IDs for graph highlighting.
 */

export interface TraceSpan {
  name: string;
  level: 'DEFAULT' | 'WARNING' | 'ERROR';
  latency_ms: number;
  mapped_nodes: string[];
  status_message?: string;
  type?: 'SPAN' | 'GENERATION' | 'EVENT';
  model?: string;
  input?: unknown;
  output?: unknown;
  metadata?: unknown;
  usage?: { input: number; output: number; total: number };
  start_time?: string;
}

export interface TraceOverlayResult {
  hit_node_ids: string[];
  failed_node_ids: string[];
  spans: TraceSpan[];
  scores?: Record<string, number>;
}

export interface LangfuseConfig {
  host: string;
  publicKey: string;
  secretKey: string;
}

const LANGFUSE_CONFIG_KEY = 'gitnexus_langfuse_config';

export const saveLangfuseConfig = (config: LangfuseConfig): void => {
  try {
    localStorage.setItem(LANGFUSE_CONFIG_KEY, JSON.stringify(config));
  } catch {
    // ignore storage errors
  }
};

export const loadLangfuseConfig = (): LangfuseConfig => {
  try {
    const stored = localStorage.getItem(LANGFUSE_CONFIG_KEY);
    if (stored) return JSON.parse(stored);
  } catch {
    // ignore parse errors
  }
  return {
    host: import.meta.env.VITE_LANGFUSE_HOST || 'https://us.cloud.langfuse.com',
    publicKey: import.meta.env.VITE_LANGFUSE_PUBLIC_KEY || '',
    secretKey: import.meta.env.VITE_LANGFUSE_SECRET_KEY || '',
  };
};

export const fetchTraceOverlay = async (
  baseUrl: string,
  traceId: string,
  config: LangfuseConfig,
  repo?: string,
): Promise<TraceOverlayResult> => {
  const url = `${baseUrl.replace(/\/$/, '').replace(/\/api$/, '')}/api/trace`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      trace_id: traceId,
      langfuse_host: config.host,
      public_key: config.publicKey,
      secret_key: config.secretKey,
      repo,
    }),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error((body as any).error || `Server returned ${response.status}`);
  }

  return response.json() as Promise<TraceOverlayResult>;
};
