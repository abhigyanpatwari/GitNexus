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
  ProviderConfig,
} from './types';

const STORAGE_KEY = 'gitnexus-llm-settings';

/**
 * Load settings from localStorage
 */
export const loadSettings = (): LLMSettings => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return DEFAULT_LLM_SETTINGS;
    }
    
    const parsed = JSON.parse(stored) as Partial<LLMSettings>;
    
    // Merge with defaults to handle new fields
    return {
      ...DEFAULT_LLM_SETTINGS,
      ...parsed,
      openai: {
        ...DEFAULT_LLM_SETTINGS.openai,
        ...parsed.openai,
      },
      azureOpenAI: {
        ...DEFAULT_LLM_SETTINGS.azureOpenAI,
        ...parsed.azureOpenAI,
      },
      gemini: {
        ...DEFAULT_LLM_SETTINGS.gemini,
        ...parsed.gemini,
      },
      anthropic: {
        ...DEFAULT_LLM_SETTINGS.anthropic,
        ...parsed.anthropic,
      },
      ollama: {
        ...DEFAULT_LLM_SETTINGS.ollama,
        ...parsed.ollama,
      },
      openrouter: {
        ...DEFAULT_LLM_SETTINGS.openrouter,
        ...parsed.openrouter,
      },
      minimax: {
        ...DEFAULT_LLM_SETTINGS.minimax,
        ...parsed.minimax,
      },
    };
  } catch (error) {
    console.warn('Failed to load LLM settings:', error);
    return DEFAULT_LLM_SETTINGS;
  }
};

/**
 * Save settings to localStorage
 */
export const saveSettings = (settings: LLMSettings): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
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
    T extends 'openai' ? Partial<Omit<OpenAIConfig, 'provider'>> :
    T extends 'azure-openai' ? Partial<Omit<AzureOpenAIConfig, 'provider'>> :
    T extends 'gemini' ? Partial<Omit<GeminiConfig, 'provider'>> :
    T extends 'anthropic' ? Partial<Omit<AnthropicConfig, 'provider'>> :
    T extends 'ollama' ? Partial<Omit<OllamaConfig, 'provider'>> :
    T extends 'minimax' ? Partial<Omit<MiniMaxConfig, 'provider'>> :
    never
  >
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
export const getActiveProviderConfig = (): ProviderConfig | null => {
  const settings = loadSettings();
  
  switch (settings.activeProvider) {
    case 'openai':
      if (!settings.openai?.apiKey) {
        return null;
      }
      return {
        provider: 'openai',
        ...settings.openai,
      } as OpenAIConfig;
      
    case 'azure-openai':
      if (!settings.azureOpenAI?.apiKey || !settings.azureOpenAI?.endpoint) {
        return null;
      }
      return {
        provider: 'azure-openai',
        ...settings.azureOpenAI,
      } as AzureOpenAIConfig;
      
    case 'gemini':
      if (!settings.gemini?.apiKey) {
        return null;
      }
      return {
        provider: 'gemini',
        ...settings.gemini,
      } as GeminiConfig;
      
    case 'anthropic':
      if (!settings.anthropic?.apiKey) {
        return null;
      }
      return {
        provider: 'anthropic',
        ...settings.anthropic,
      } as AnthropicConfig;
      
    case 'ollama':
      return {
        provider: 'ollama',
        ...settings.ollama,
      } as OllamaConfig;
      
    case 'openrouter':
      if (!settings.openrouter?.apiKey || settings.openrouter.apiKey.trim() === '') {
        return null;
      }
      return {
        provider: 'openrouter',
        apiKey: settings.openrouter.apiKey,
        model: settings.openrouter.model || '',
        baseUrl: settings.openrouter.baseUrl || 'https://openrouter.ai/api/v1',
        temperature: settings.openrouter.temperature,
        maxTokens: settings.openrouter.maxTokens,
      } as OpenRouterConfig;

    case 'minimax':
      if (!settings.minimax?.apiKey) {
        return null;
      }
      return {
        provider: 'minimax',
        ...settings.minimax,
      } as MiniMaxConfig;

    default:
      return null;
  }
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
  localStorage.removeItem(STORAGE_KEY);
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
      return ['claude-sonnet-4-20250514', 'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'];
    case 'ollama':
      return ['llama3.2', 'llama3.1', 'mistral', 'codellama', 'deepseek-coder'];
    case 'minimax':
      return ['MiniMax-M2.5', 'MiniMax-M2.5-highspeed'];
    default:
      return [];
  }
};

/**
 * Fetch available models from OpenRouter API
 */
export const fetchOpenRouterModels = async (): Promise<Array<{ id: string; name: string }>> => {
  try {
    const response = await fetch('https://openrouter.ai/api/v1/models');
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

