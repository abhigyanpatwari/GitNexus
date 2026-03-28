/**
 * Settings Service
 *
 * Handles localStorage persistence for LLM provider settings.
 * All API keys are stored locally - never sent to any server except the LLM provider.
 */

import {
  LLMSettings,
  DEFAULT_LLM_SETTINGS,
  LLMProvider,
  OpenAIConfig,
  AzureOpenAIConfig,
  GeminiConfig,
  AnthropicConfig,
  OllamaConfig,
  OpenRouterConfig,
  MiniMaxConfig,
  GLMConfig,
  ProviderConfig,
} from './types';
import { DEFAULT_OPENROUTER_BASE_URL, DEFAULT_OLLAMA_BASE_URL } from '../../config/ui-constants';

const STORAGE_KEY = 'gitnexus-llm-settings';

const mergeWithDefaults = (parsed?: Partial<LLMSettings> | null): LLMSettings => ({
  ...DEFAULT_LLM_SETTINGS,
  ...parsed,
  openai: {
    ...DEFAULT_LLM_SETTINGS.openai,
    ...parsed?.openai,
  },
  azureOpenAI: {
    ...DEFAULT_LLM_SETTINGS.azureOpenAI,
    ...parsed?.azureOpenAI,
  },
  gemini: {
    ...DEFAULT_LLM_SETTINGS.gemini,
    ...parsed?.gemini,
  },
  anthropic: {
    ...DEFAULT_LLM_SETTINGS.anthropic,
    ...parsed?.anthropic,
  },
  ollama: {
    ...DEFAULT_LLM_SETTINGS.ollama,
    ...parsed?.ollama,
  },
  openrouter: {
    ...DEFAULT_LLM_SETTINGS.openrouter,
    ...parsed?.openrouter,
  },
  minimax: {
    ...DEFAULT_LLM_SETTINGS.minimax,
    ...parsed?.minimax,
  },
  glm: {
    ...DEFAULT_LLM_SETTINGS.glm,
    ...parsed?.glm,
  },
});

const readSettings = (storage: Storage): Partial<LLMSettings> | null => {
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Partial<LLMSettings>;
  } catch (error) {
    console.warn('Failed to parse LLM settings:', error);
    return null;
  }
};

const writeSettings = (storage: Storage, settings: LLMSettings): void => {
  storage.setItem(STORAGE_KEY, JSON.stringify(settings));
};

/**
 * Load settings from sessionStorage (migrates legacy localStorage once).
 */
export const loadSettings = (): LLMSettings => {
  try {
    const sessionData = typeof sessionStorage !== 'undefined' ? readSettings(sessionStorage) : null;
    if (sessionData) {
      return mergeWithDefaults(sessionData);
    }

    const legacyData = typeof localStorage !== 'undefined' ? readSettings(localStorage) : null;
    if (legacyData) {
      const merged = mergeWithDefaults(legacyData);
      try {
        if (typeof sessionStorage !== 'undefined') {
          writeSettings(sessionStorage, merged);
        }
        if (typeof localStorage !== 'undefined') {
          localStorage.removeItem(STORAGE_KEY);
        }
      } catch (error) {
        console.warn('Failed to migrate legacy LLM settings to sessionStorage:', error);
      }
      return merged;
    }

    return DEFAULT_LLM_SETTINGS;
  } catch (error) {
    console.warn('Failed to load LLM settings:', error);
    return DEFAULT_LLM_SETTINGS;
  }
};

/**
 * Save settings to sessionStorage
 */
export const saveSettings = (settings: LLMSettings): void => {
  try {
    if (typeof sessionStorage !== 'undefined') {
      writeSettings(sessionStorage, settings);
    }
  } catch (error) {
    console.error('Failed to save LLM settings:', error);
  }
};

/**
 * Update a specific provider's settings
 */
export const updateProviderSettings = <T extends LLMProvider>(
  provider: T,
  updates: Partial<
    T extends 'openai'
      ? Partial<Omit<OpenAIConfig, 'provider'>>
      : T extends 'azure-openai'
        ? Partial<Omit<AzureOpenAIConfig, 'provider'>>
        : T extends 'gemini'
          ? Partial<Omit<GeminiConfig, 'provider'>>
          : T extends 'anthropic'
            ? Partial<Omit<AnthropicConfig, 'provider'>>
            : T extends 'ollama'
              ? Partial<Omit<OllamaConfig, 'provider'>>
              : T extends 'openrouter'
                ? Partial<Omit<OpenRouterConfig, 'provider'>>
                : T extends 'minimax'
                  ? Partial<Omit<MiniMaxConfig, 'provider'>>
                  : T extends 'glm'
                    ? Partial<Omit<GLMConfig, 'provider'>>
                    : never
  >,
): LLMSettings => {
  const current = loadSettings();

  // Avoid spreading unions like LLMSettings[keyof LLMSettings] (can be string/undefined)
  switch (provider) {
    case 'openai': {
      const updated: LLMSettings = {
        ...current,
        openai: {
          ...(current.openai ?? {}),
          ...(updates as Partial<Omit<OpenAIConfig, 'provider'>>),
        },
      };
      saveSettings(updated);
      return updated;
    }
    case 'azure-openai': {
      const updated: LLMSettings = {
        ...current,
        azureOpenAI: {
          ...(current.azureOpenAI ?? {}),
          ...(updates as Partial<Omit<AzureOpenAIConfig, 'provider'>>),
        },
      };
      saveSettings(updated);
      return updated;
    }
    case 'gemini': {
      const updated: LLMSettings = {
        ...current,
        gemini: {
          ...(current.gemini ?? {}),
          ...(updates as Partial<Omit<GeminiConfig, 'provider'>>),
        },
      };
      saveSettings(updated);
      return updated;
    }
    case 'anthropic': {
      const updated: LLMSettings = {
        ...current,
        anthropic: {
          ...(current.anthropic ?? {}),
          ...(updates as Partial<Omit<AnthropicConfig, 'provider'>>),
        },
      };
      saveSettings(updated);
      return updated;
    }
    case 'ollama': {
      const updated: LLMSettings = {
        ...current,
        ollama: {
          ...(current.ollama ?? {}),
          ...(updates as Partial<Omit<OllamaConfig, 'provider'>>),
        },
      };
      saveSettings(updated);
      return updated;
    }
    case 'openrouter': {
      const updated: LLMSettings = {
        ...current,
        openrouter: {
          ...(current.openrouter ?? {}),
          ...(updates as Partial<Omit<OpenRouterConfig, 'provider'>>),
        },
      };
      saveSettings(updated);
      return updated;
    }
    case 'minimax': {
      const updated: LLMSettings = {
        ...current,
        minimax: {
          ...(current.minimax ?? {}),
          ...(updates as Partial<Omit<MiniMaxConfig, 'provider'>>),
        },
      };
      saveSettings(updated);
      return updated;
    }
    case 'glm': {
      const updated: LLMSettings = {
        ...current,
        glm: {
          ...(current.glm ?? {}),
          ...(updates as Partial<Omit<GLMConfig, 'provider'>>),
        },
      };
      saveSettings(updated);
      return updated;
    }
    default: {
      // Should be unreachable due to T extends LLMProvider, but keep a safe fallback
      const updated: LLMSettings = { ...current };
      saveSettings(updated);
      return updated;
    }
  }
};

/**
 * Set the active provider
 */
export const setActiveProvider = (provider: LLMProvider): LLMSettings => {
  const current = loadSettings();
  const updated: LLMSettings = {
    ...current,
    activeProvider: provider,
  };
  saveSettings(updated);
  return updated;
};

/**
 * Get the current provider configuration
 */
type ProviderBuilder = (settings: LLMSettings) => ProviderConfig | null;

const providerBuilders: Record<LLMProvider, ProviderBuilder> = {
  openai: (settings) => {
    if (!settings.openai?.apiKey) return null;
    return { provider: 'openai', ...settings.openai } as OpenAIConfig;
  },
  'azure-openai': (settings) => {
    if (!settings.azureOpenAI?.apiKey || !settings.azureOpenAI?.endpoint) return null;
    return { provider: 'azure-openai', ...settings.azureOpenAI } as AzureOpenAIConfig;
  },
  gemini: (settings) => {
    if (!settings.gemini?.apiKey) return null;
    return { provider: 'gemini', ...settings.gemini } as GeminiConfig;
  },
  anthropic: (settings) => {
    if (!settings.anthropic?.apiKey) return null;
    return { provider: 'anthropic', ...settings.anthropic } as AnthropicConfig;
  },
  ollama: (settings) => {
    return {
      provider: 'ollama',
      ...settings.ollama,
      baseUrl: settings.ollama?.baseUrl ?? DEFAULT_OLLAMA_BASE_URL,
    } as OllamaConfig;
  },
  openrouter: (settings) => {
    if (!settings.openrouter?.apiKey || settings.openrouter.apiKey.trim() === '') return null;
    return {
      provider: 'openrouter',
      apiKey: settings.openrouter.apiKey,
      model: settings.openrouter.model || '',
      baseUrl: settings.openrouter.baseUrl || DEFAULT_OPENROUTER_BASE_URL,
      temperature: settings.openrouter.temperature,
      maxTokens: settings.openrouter.maxTokens,
    } as OpenRouterConfig;
  },
  minimax: (settings) => {
    if (!settings.minimax?.apiKey) return null;
    return { provider: 'minimax', ...settings.minimax } as MiniMaxConfig;
  },
  glm: (settings) => {
    if (!settings.glm?.apiKey) return null;
    return {
      provider: 'glm',
      apiKey: settings.glm.apiKey,
      model: settings.glm.model || 'GLM-5',
      baseUrl: settings.glm.baseUrl || 'https://api.z.ai/api/coding/paas/v4',
      temperature: settings.glm.temperature,
      maxTokens: settings.glm.maxTokens,
    } as GLMConfig;
  },
};

export const getActiveProviderConfig = (): ProviderConfig | null => {
  const settings = loadSettings();
  const builder = providerBuilders[settings.activeProvider];
  return builder ? builder(settings) : null;
};

/**
 * Check if the active provider is properly configured
 */
export const isProviderConfigured = (): boolean => {
  return getActiveProviderConfig() !== null;
};

/**
 * Clear all settings (reset to defaults)
 */
export const clearSettings = (): void => {
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(STORAGE_KEY);
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch (error) {
    console.warn('Failed to clear LLM settings:', error);
  }
};

/**
 * Get display name for a provider
 */
export const getProviderDisplayName = (provider: LLMProvider): string => {
  switch (provider) {
    case 'openai':
      return 'OpenAI';
    case 'azure-openai':
      return 'Azure OpenAI';
    case 'gemini':
      return 'Google Gemini';
    case 'anthropic':
      return 'Anthropic';
    case 'ollama':
      return 'Ollama (Local)';
    case 'openrouter':
      return 'OpenRouter';
    case 'minimax':
      return 'MiniMax';
    case 'glm':
      return 'GLM (Z.AI)';
    default:
      return provider;
  }
};

/**
 * Get available models for a provider
 */
export const getAvailableModels = (provider: LLMProvider): string[] => {
  switch (provider) {
    case 'openai':
      return ['gpt-4.5-preview', 'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo'];
    case 'azure-openai':
      // Azure models depend on deployment, so we show common ones
      return ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4', 'gpt-35-turbo'];
    case 'gemini':
      return ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-1.0-pro'];
    case 'anthropic':
      return [
        'claude-sonnet-4-20250514',
        'claude-3-5-sonnet-20241022',
        'claude-3-5-haiku-20241022',
        'claude-3-opus-20240229',
      ];
    case 'ollama':
      return ['llama3.2', 'llama3.1', 'mistral', 'codellama', 'deepseek-coder'];
    case 'minimax':
      return ['MiniMax-M2.5', 'MiniMax-M2.5-highspeed'];
    case 'glm':
      return ['GLM-5', 'GLM-5-Turbo', 'GLM-4.7', 'GLM-4.5'];
    default:
      return [];
  }
};

/**
 * Fetch available models from OpenRouter API
 */
export const fetchOpenRouterModels = async (): Promise<Array<{ id: string; name: string }>> => {
  try {
    const response = await fetch(`${DEFAULT_OPENROUTER_BASE_URL}/models`);
    if (!response.ok) throw new Error('Failed to fetch models');
    const data = await response.json();
    return data.data.map((model: any) => ({
      id: model.id,
      name: model.name || model.id,
    }));
  } catch (error) {
    console.error('Error fetching OpenRouter models:', error);
    return [];
  }
};
