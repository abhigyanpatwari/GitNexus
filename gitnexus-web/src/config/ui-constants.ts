// Centralized UI and provider defaults to reduce magic numbers and duplicated URLs.
export const ERROR_RESET_DELAY_MS = 3000;
export const BACKEND_URL_DEBOUNCE_MS = 500;

export const DEFAULT_BACKEND_URL = 'http://localhost:4747';
export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';
export const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** Minimum Node.js version required by the gitnexus CLI (injected by Vite from package.json engines). */
declare const __REQUIRED_NODE_VERSION__: string;
export const REQUIRED_NODE_VERSION = __REQUIRED_NODE_VERSION__;
