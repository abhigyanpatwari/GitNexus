import type { CLIConfig } from '../../storage/repo-manager.js';
import { validateLLMBaseUrl } from './llm-client.js';
import type { WikiAutoRefreshProviderStatus } from './auto-refresh.js';
import { detectCursorCLI } from './cursor-client.js';
import { detectLocalCLI } from './local-cli-client.js';

export interface WikiProviderReadinessOptions {
  config: CLIConfig;
  env?: Record<string, string | undefined>;
  mode?: 'server' | 'cli';
}

const LOCAL_PROVIDERS = new Set(['cursor', 'claude', 'codex']);

const sourceForConfiguredProvider = (config: CLIConfig): 'saved-config' | 'none' =>
  config.provider || config.apiKey || config.baseUrl ? 'saved-config' : 'none';

export const planWikiProviderReadiness = (
  options: WikiProviderReadinessOptions,
): WikiAutoRefreshProviderStatus => {
  const env = options.env ?? process.env;
  const config = options.config;
  const mode = options.mode ?? 'server';
  const provider = config.provider ?? 'openai';

  if (LOCAL_PROVIDERS.has(provider)) {
    if (mode === 'cli') {
      const available =
        provider === 'cursor' ? detectCursorCLI() : detectLocalCLI(provider as 'claude' | 'codex');
      if (available) {
        return {
          ready: true,
          provider,
          source: sourceForConfiguredProvider(config),
        };
      }
      return {
        ready: false,
        provider,
        source: sourceForConfiguredProvider(config),
        reason: 'local-cli-not-available',
      };
    }

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
