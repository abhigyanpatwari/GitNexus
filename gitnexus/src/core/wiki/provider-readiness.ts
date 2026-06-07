import type { CLIConfig } from '../../storage/repo-manager.js';
import { validateLLMBaseUrl } from './llm-client.js';
import type { WikiAutoRefreshProviderStatus } from './auto-refresh.js';

export interface WikiProviderReadinessOptions {
  config: CLIConfig;
  env?: Record<string, string | undefined>;
}

const LOCAL_PROVIDERS = new Set(['cursor', 'claude', 'codex']);

const sourceForConfiguredProvider = (config: CLIConfig): 'saved-config' | 'none' =>
  config.provider || config.apiKey || config.baseUrl ? 'saved-config' : 'none';

export const planWikiProviderReadiness = (
  options: WikiProviderReadinessOptions,
): WikiAutoRefreshProviderStatus => {
  const env = options.env ?? process.env;
  const config = options.config;
  const provider = config.provider ?? 'openai';

  if (LOCAL_PROVIDERS.has(provider)) {
    return {
      ready: false,
      provider,
      source: sourceForConfiguredProvider(config),
      reason: 'local-cli-provider-not-server-ready',
    };
  }

  const envApiKey = env.GITNEXUS_API_KEY || env.OPENAI_API_KEY;
  const apiKey = envApiKey || config.apiKey;
  if (!apiKey) {
    return {
      ready: false,
      provider,
      source: 'none',
      reason: 'missing-api-key',
    };
  }

  const source = envApiKey ? 'environment' : 'saved-config';
  const baseUrl = env.GITNEXUS_LLM_BASE_URL || config.baseUrl || 'https://openrouter.ai/api/v1';
  try {
    validateLLMBaseUrl(baseUrl);
  } catch {
    return {
      ready: false,
      provider,
      source,
      reason: 'invalid-base-url',
    };
  }

  return {
    ready: true,
    provider,
    source,
  };
};
