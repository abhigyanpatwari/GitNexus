// Centralized UI and provider defaults to reduce magic numbers and duplicated URLs.
export const ERROR_RESET_DELAY_MS = 3000;
export const BACKEND_URL_DEBOUNCE_MS = 500;

export const DEFAULT_BACKEND_URL =
  (typeof window !== 'undefined' && window.__GITNEXUS_CONFIG__?.backendUrl) ||
  'http://localhost:4747';
export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';
export const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Default node-count above which the WebUI connects in chat-only mode (skips
 * the full graph download). Grounded in sigma.js/graphology prior art: ~10K
 * nodes render smoothly, complex-styled rendering struggles past ~5K, and the
 * force-layout degrades beyond ~50K edges. GitNexus renders labeled nodes with
 * force layout and has ~1.7x more edges than nodes, so the edge cliff is crossed
 * around ~25-30K nodes. Override at deploy time via
 * window.__GITNEXUS_CONFIG__.largeGraphNodeThreshold. See issue #2178.
 */
const DEFAULT_LARGE_GRAPH_NODE_THRESHOLD = 25_000;

/**
 * Default edge-count above which the WebUI connects in chat-only mode. The
 * browser force-layout cliff is edge-driven (degrades beyond ~50K edges), and
 * GitNexus graphs carry more edges than nodes, so an edge-heavy but node-light
 * repo can still hang even when under the node threshold. Override via
 * window.__GITNEXUS_CONFIG__.largeGraphEdgeThreshold. See issue #2178.
 */
const DEFAULT_LARGE_GRAPH_EDGE_THRESHOLD = 50_000;

const resolveThreshold = (override: number | undefined, fallback: number): number =>
  // Ignore non-finite, NaN, or non-positive overrides — fall back to the default.
  typeof override === 'number' && Number.isFinite(override) && override > 0 ? override : fallback;

export const LARGE_GRAPH_NODE_THRESHOLD = resolveThreshold(
  typeof window !== 'undefined' ? window.__GITNEXUS_CONFIG__?.largeGraphNodeThreshold : undefined,
  DEFAULT_LARGE_GRAPH_NODE_THRESHOLD,
);

export const LARGE_GRAPH_EDGE_THRESHOLD = resolveThreshold(
  typeof window !== 'undefined' ? window.__GITNEXUS_CONFIG__?.largeGraphEdgeThreshold : undefined,
  DEFAULT_LARGE_GRAPH_EDGE_THRESHOLD,
);

/** Minimum Node.js version required by the gitnexus CLI (injected by Vite from package.json engines). */
declare const __REQUIRED_NODE_VERSION__: string;
export const REQUIRED_NODE_VERSION = __REQUIRED_NODE_VERSION__;
