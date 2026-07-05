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
    /**
     * Edge-count above which the WebUI connects in chat-only mode by default.
     * The browser force-layout cliff is edge-driven, so this guards edge-heavy
     * repos that fall under the node threshold. Falls back to
     * LARGE_GRAPH_EDGE_THRESHOLD in config/ui-constants.ts. See issue #2178.
     */
    largeGraphEdgeThreshold?: number;
  };
}
