/// <reference types="vite/client" />

interface Window {
  __GITNEXUS_CONFIG__?: {
    backendUrl?: string;
    /**
     * Node-count above which the WebUI connects in chat-only mode by default
     * (skips the full graph download to avoid hanging the browser on very
     * large projects). Override at deploy time; falls back to
     * LARGE_GRAPH_NODE_THRESHOLD in config/ui-constants.ts. See issue #2178.
     */
    largeGraphNodeThreshold?: number;
  };
}
