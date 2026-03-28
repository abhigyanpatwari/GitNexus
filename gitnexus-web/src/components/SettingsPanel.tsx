import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  X,
  Key,
  Server,
  Brain,
  Check,
  AlertCircle,
  Eye,
  EyeOff,
  RefreshCw,
  ChevronDown,
  Loader2,
  Search,
} from '@/lib/lucide-icons';
import {
  loadSettings,
  saveSettings,
  getProviderDisplayName,
  getAvailableModels,
  fetchOpenRouterModels,
} from '../core/llm/settings-service';
import type { LLMSettings, LLMProvider } from '../core/llm/types';
import { DEFAULT_OLLAMA_BASE_URL } from '../config/ui-constants';
import { ProviderConfigCard } from './settings/ProviderConfigCard';

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onSettingsSaved?: () => void;
  backendUrl?: string;
  isBackendConnected?: boolean;
  onBackendUrlChange?: (url: string) => void;
}

/**
 * Searchable combobox for OpenRouter model selection
 */
interface OpenRouterModelComboboxProps {
  value: string;
  onChange: (model: string) => void;
  models: Array<{ id: string; name: string }>;
  isLoading: boolean;
  onLoadModels: () => void;
}

const OpenRouterModelCombobox = ({
  value,
  onChange,
  models,
  isLoading,
  onLoadModels,
}: OpenRouterModelComboboxProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Filter models based on search term
  const filteredModels = useMemo(() => {
    if (!searchTerm.trim()) return models;
    const lower = searchTerm.toLowerCase();
    return models.filter(
      (m) => m.id.toLowerCase().includes(lower) || m.name.toLowerCase().includes(lower),
    );
  }, [models, searchTerm]);

  // Find display name for current value
  const displayValue = useMemo(() => {
    if (!value) return '';
    const found = models.find((m) => m.id === value);
    return found ? found.name : value;
  }, [value, models]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setSearchTerm('');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Load models when opening
  const handleOpen = () => {
    setIsOpen(true);
    if (models.length === 0 && !isLoading) {
      onLoadModels();
    }
    setTimeout(() => inputRef.current?.focus(), 10);
  };

  const handleSelect = (modelId: string) => {
    onChange(modelId);
    setIsOpen(false);
    setSearchTerm('');
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setSearchTerm(val);
    // Also allow direct typing of model ID
    if (val && models.length === 0) {
      onChange(val);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && searchTerm) {
      // If exact match in filtered, select it; otherwise use raw input
      const exact = filteredModels.find((m) => m.id.toLowerCase() === searchTerm.toLowerCase());
      if (exact) {
        handleSelect(exact.id);
      } else if (filteredModels.length === 1) {
        handleSelect(filteredModels[0].id);
      } else {
        // Allow custom model ID input
        onChange(searchTerm);
        setIsOpen(false);
        setSearchTerm('');
      }
    } else if (e.key === 'Escape') {
      setIsOpen(false);
      setSearchTerm('');
    }
  };

  return (
    <div ref={containerRef} className="relative">
      {/* Main input/button */}
      <div
        onClick={handleOpen}
        className={`flex w-full cursor-pointer items-center gap-2 rounded-xl border bg-elevated px-4 py-3 transition-all ${isOpen ? 'border-accent ring-2 ring-accent/20' : 'border-border-subtle hover:border-accent/50'}`}
      >
        {isOpen ? (
          <input
            ref={inputRef}
            type="text"
            value={searchTerm}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="Search or type model ID..."
            className="flex-1 bg-transparent font-mono text-sm text-text-primary outline-none placeholder:text-text-muted"
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span
            className={`flex-1 truncate font-mono text-sm ${value ? 'text-text-primary' : 'text-text-muted'}`}
          >
            {displayValue || 'Select or type a model...'}
          </span>
        )}
        <div className="flex items-center gap-1">
          {isLoading && <Loader2 className="h-4 w-4 animate-spin text-text-muted" />}
          <ChevronDown
            className={`h-4 w-4 text-text-muted transition-transform ${isOpen ? 'rotate-180' : ''}`}
          />
        </div>
      </div>

      {/* Dropdown */}
      {isOpen && (
        <div className="absolute z-50 mt-1 w-full overflow-hidden rounded-xl border border-border-subtle bg-elevated shadow-xl">
          {isLoading ? (
            <div className="flex items-center justify-center gap-2 px-4 py-6 text-center text-sm text-text-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading models...
            </div>
          ) : filteredModels.length === 0 ? (
            <div className="px-4 py-4 text-center">
              {models.length === 0 ? (
                <div className="text-sm text-text-muted">
                  <Search className="mx-auto mb-2 h-5 w-5 opacity-50" />
                  <p>Type a model ID or press Enter</p>
                  <p className="mt-1 text-xs">e.g. openai/gpt-4o</p>
                </div>
              ) : (
                <div className="text-sm text-text-muted">
                  <p>No models match "{searchTerm}"</p>
                  <p className="mt-1 text-xs">Press Enter to use as custom ID</p>
                </div>
              )}
            </div>
          ) : (
            <div className="max-h-64 overflow-y-auto">
              {filteredModels.slice(0, 50).map((model) => (
                <button
                  key={model.id}
                  onClick={() => handleSelect(model.id)}
                  className={`flex w-full flex-col px-4 py-2.5 text-left transition-colors hover:bg-hover ${model.id === value ? 'bg-accent/10' : ''}`}
                >
                  <span className="truncate text-sm text-text-primary">{model.name}</span>
                  <span className="truncate font-mono text-xs text-text-muted">{model.id}</span>
                </button>
              ))}
              {filteredModels.length > 50 && (
                <div className="border-t border-border-subtle px-4 py-2 text-center text-xs text-text-muted">
                  +{filteredModels.length - 50} more • Refine your search
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Check connection to local Ollama instance
 */
const checkOllamaStatus = async (
  baseUrl: string,
): Promise<{ ok: boolean; error: string | null }> => {
  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      if (response.status === 0 || response.status === 404) {
        return {
          ok: false,
          error: "Cannot connect to Ollama. Make sure it's running with `ollama serve`",
        };
      }
      return { ok: false, error: `Ollama API error: ${response.status}` };
    }

    return { ok: true, error: null };
  } catch (error) {
    return {
      ok: false,
      error: "Cannot connect to Ollama. Make sure it's running with `ollama serve`",
    };
  }
};

export const SettingsPanel = ({
  isOpen,
  onClose,
  onSettingsSaved,
  backendUrl,
  isBackendConnected,
  onBackendUrlChange,
}: SettingsPanelProps) => {
  const [settings, setSettings] = useState<LLMSettings>(loadSettings);
  const [showApiKey, setShowApiKey] = useState<Record<string, boolean>>({});
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Ollama connection state
  const [ollamaError, setOllamaError] = useState<string | null>(null);
  const [isCheckingOllama, setIsCheckingOllama] = useState(false);
  // OpenRouter models state
  const [openRouterModels, setOpenRouterModels] = useState<Array<{ id: string; name: string }>>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);

  // Clean up save timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  // Load settings when panel opens
  useEffect(() => {
    if (isOpen) {
      setSettings(loadSettings());
      setSaveStatus('idle');
      setOllamaError(null);
    }
  }, [isOpen]);

  // Check Ollama connection when provider is selected or base URL changes
  const checkOllamaConnection = useCallback(async (baseUrl: string) => {
    setIsCheckingOllama(true);
    setOllamaError(null);

    const { error } = await checkOllamaStatus(baseUrl);
    setIsCheckingOllama(false);
    setOllamaError(error);
  }, []);

  // Load OpenRouter models
  const loadOpenRouterModels = useCallback(async () => {
    setIsLoadingModels(true);
    const models = await fetchOpenRouterModels();
    setOpenRouterModels(models);
    setIsLoadingModels(false);
  }, []);

  useEffect(() => {
    if (settings.activeProvider === 'ollama') {
      const baseUrl = settings.ollama?.baseUrl ?? DEFAULT_OLLAMA_BASE_URL;
      const timer = setTimeout(() => {
        checkOllamaConnection(baseUrl);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [settings.ollama?.baseUrl, settings.activeProvider, checkOllamaConnection]);

  const handleProviderChange = (provider: LLMProvider) => {
    setSettings((prev) => ({ ...prev, activeProvider: provider }));
  };

  const handleSave = () => {
    try {
      saveSettings(settings);
      setSaveStatus('saved');
      onSettingsSaved?.();
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2000);
    } catch {
      setSaveStatus('error');
    }
  };

  const toggleApiKeyVisibility = (key: string) => {
    setShowApiKey((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  if (!isOpen) return null;

  const providers: LLMProvider[] = [
    'openai',
    'gemini',
    'anthropic',
    'azure-openai',
    'ollama',
    'openrouter',
    'minimax',
    'glm',
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Panel */}
      <div className="relative mx-4 flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border-subtle bg-surface shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border-subtle bg-elevated/50 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/20">
              <Brain className="h-5 w-5 text-accent" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-text-primary">AI Settings</h2>
              <p className="text-xs text-text-muted">Configure your LLM provider</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-text-muted transition-colors hover:bg-hover hover:text-text-primary"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 space-y-6 overflow-y-auto p-6">
          {/* Local Server */}
          {backendUrl !== undefined && onBackendUrlChange && (
            <div className="space-y-3">
              <label className="block text-sm font-medium text-text-secondary">Local Server</label>
              <div className="space-y-2">
                <div className="mb-2 flex items-center gap-2">
                  <Server className="h-4 w-4 text-text-muted" />
                  <span className="text-sm text-text-secondary">Backend URL</span>
                  <span
                    className={`h-2 w-2 rounded-full ${isBackendConnected ? 'bg-green-400' : 'bg-red-400'}`}
                  />
                  <span className="text-xs text-text-muted">
                    {isBackendConnected ? 'Connected' : 'Not connected'}
                  </span>
                </div>
                <input
                  type="url"
                  value={backendUrl}
                  onChange={(e) => onBackendUrlChange(e.target.value)}
                  placeholder="http://localhost:4747"
                  className="w-full rounded-xl border border-border-subtle bg-elevated px-4 py-3 font-mono text-sm text-text-primary transition-all outline-none placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
                />
                <p className="text-xs text-text-muted">
                  Run <code className="rounded bg-elevated px-1 py-0.5">gitnexus serve</code> to
                  start the local server
                </p>
              </div>
            </div>
          )}

          {/* Provider Selection */}
          <div className="space-y-3">
            <label className="block text-sm font-medium text-text-secondary">Provider</label>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {providers.map((provider) => (
                <button
                  key={provider}
                  onClick={() => handleProviderChange(provider)}
                  className={`flex items-center gap-3 rounded-xl border-2 p-4 transition-all ${
                    settings.activeProvider === provider
                      ? 'border-accent bg-accent/10 text-text-primary'
                      : 'border-border-subtle bg-elevated text-text-secondary hover:border-accent/50'
                  } `}
                >
                  <div
                    className={`flex h-8 w-8 items-center justify-center rounded-lg text-lg ${settings.activeProvider === provider ? 'bg-accent/20' : 'bg-surface'} `}
                  >
                    {provider === 'openai'
                      ? '🤖'
                      : provider === 'gemini'
                        ? '💎'
                        : provider === 'anthropic'
                          ? '🧠'
                          : provider === 'ollama'
                            ? '🦙'
                            : provider === 'openrouter'
                              ? '🌐'
                              : provider === 'minimax'
                                ? '⚡'
                                : provider === 'glm'
                                  ? '🔮'
                                  : '☁️'}
                  </div>
                  <span className="font-medium">{getProviderDisplayName(provider)}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
            API keys are stored in session storage and will be cleared when you close this tab.
          </div>

          {/* OpenAI Settings */}
          {settings.activeProvider === 'openai' && (
            <ProviderConfigCard
              title="OpenAI"
              apiKey={{
                value: settings.openai?.apiKey ?? '',
                placeholder: 'Enter your OpenAI API key',
                helperText: 'Get your API key from',
                helperLink: 'https://platform.openai.com/api-keys',
                helperLinkLabel: 'OpenAI Platform',
                isVisible: !!showApiKey['openai'],
                onChange: (value) =>
                  setSettings((prev) => ({
                    ...prev,
                    openai: { ...prev.openai!, apiKey: value },
                  })),
                onToggleVisibility: () => toggleApiKeyVisibility('openai'),
              }}
              model={{
                value: settings.openai?.model ?? 'gpt-5.2-chat',
                placeholder: 'e.g., gpt-4o, gpt-4-turbo, gpt-3.5-turbo',
                onChange: (value) =>
                  setSettings((prev) => ({
                    ...prev,
                    openai: { ...prev.openai!, model: value },
                  })),
              }}
            >
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm font-medium text-text-secondary">
                  <Server className="h-4 w-4" />
                  Base URL <span className="font-normal text-text-muted">(optional)</span>
                </label>
                <input
                  type="url"
                  value={settings.openai?.baseUrl ?? ''}
                  onChange={(e) =>
                    setSettings((prev) => ({
                      ...prev,
                      openai: { ...prev.openai!, baseUrl: e.target.value },
                    }))
                  }
                  placeholder="https://api.openai.com/v1 (default)"
                  className="w-full rounded-xl border border-border-subtle bg-elevated px-4 py-3 text-text-primary transition-all outline-none placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
                />
                <p className="text-xs text-text-muted">
                  Leave empty to use the default OpenAI API. Set a custom URL for proxies or
                  compatible APIs.
                </p>
              </div>
            </ProviderConfigCard>
          )}

          {/* Gemini Settings */}
          {settings.activeProvider === 'gemini' && (
            <ProviderConfigCard
              title="Google Gemini"
              apiKey={{
                value: settings.gemini?.apiKey ?? '',
                placeholder: 'Enter your Google AI API key',
                helperText: 'Get your API key from',
                helperLink: 'https://aistudio.google.com/app/apikey',
                helperLinkLabel: 'Google AI Studio',
                isVisible: !!showApiKey['gemini'],
                onChange: (value) =>
                  setSettings((prev) => ({
                    ...prev,
                    gemini: { ...prev.gemini!, apiKey: value },
                  })),
                onToggleVisibility: () => toggleApiKeyVisibility('gemini'),
              }}
              model={{
                value: settings.gemini?.model ?? 'gemini-2.0-flash',
                placeholder: 'e.g., gemini-2.0-flash, gemini-1.5-pro',
                onChange: (value) =>
                  setSettings((prev) => ({
                    ...prev,
                    gemini: { ...prev.gemini!, model: value },
                  })),
              }}
            />
          )}

          {/* Anthropic Settings */}
          {settings.activeProvider === 'anthropic' && (
            <ProviderConfigCard
              title="Anthropic"
              apiKey={{
                value: settings.anthropic?.apiKey ?? '',
                placeholder: 'Enter your Anthropic API key',
                helperText: 'Get your API key from',
                helperLink: 'https://console.anthropic.com/settings/keys',
                helperLinkLabel: 'Anthropic Console',
                isVisible: !!showApiKey['anthropic'],
                onChange: (value) =>
                  setSettings((prev) => ({
                    ...prev,
                    anthropic: { ...prev.anthropic!, apiKey: value },
                  })),
                onToggleVisibility: () => toggleApiKeyVisibility('anthropic'),
              }}
              model={{
                value: settings.anthropic?.model ?? 'claude-sonnet-4-20250514',
                placeholder: 'e.g., claude-sonnet-4-20250514, claude-3-opus',
                onChange: (value) =>
                  setSettings((prev) => ({
                    ...prev,
                    anthropic: { ...prev.anthropic!, model: value },
                  })),
              }}
            />
          )}

          {/* Azure OpenAI Settings */}
          {settings.activeProvider === 'azure-openai' && (
            <div className="animate-fade-in space-y-4">
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm font-medium text-text-secondary">
                  <Key className="h-4 w-4" />
                  API Key
                </label>
                <div className="relative">
                  <input
                    type={showApiKey['azure'] ? 'text' : 'password'}
                    value={settings.azureOpenAI?.apiKey ?? ''}
                    onChange={(e) =>
                      setSettings((prev) => ({
                        ...prev,
                        azureOpenAI: { ...prev.azureOpenAI!, apiKey: e.target.value },
                      }))
                    }
                    placeholder="Enter your Azure OpenAI API key"
                    className="w-full rounded-xl border border-border-subtle bg-elevated px-4 py-3 pr-12 text-text-primary transition-all outline-none placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
                  />
                  <button
                    type="button"
                    onClick={() => toggleApiKeyVisibility('azure')}
                    className="absolute top-1/2 right-3 -translate-y-1/2 p-1 text-text-muted transition-colors hover:text-text-primary"
                  >
                    {showApiKey['azure'] ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm font-medium text-text-secondary">
                  <Server className="h-4 w-4" />
                  Endpoint
                </label>
                <input
                  type="url"
                  value={settings.azureOpenAI?.endpoint ?? ''}
                  onChange={(e) =>
                    setSettings((prev) => ({
                      ...prev,
                      azureOpenAI: { ...prev.azureOpenAI!, endpoint: e.target.value },
                    }))
                  }
                  placeholder="https://your-resource.openai.azure.com"
                  className="w-full rounded-xl border border-border-subtle bg-elevated px-4 py-3 text-text-primary transition-all outline-none placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-text-secondary">Deployment Name</label>
                <input
                  type="text"
                  value={settings.azureOpenAI?.deploymentName ?? ''}
                  onChange={(e) =>
                    setSettings((prev) => ({
                      ...prev,
                      azureOpenAI: { ...prev.azureOpenAI!, deploymentName: e.target.value },
                    }))
                  }
                  placeholder="e.g., gpt-4o-deployment"
                  className="w-full rounded-xl border border-border-subtle bg-elevated px-4 py-3 text-text-primary transition-all outline-none placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-text-secondary">Model</label>
                  <input
                    type="text"
                    value={settings.azureOpenAI?.model ?? 'gpt-4o'}
                    onChange={(e) =>
                      setSettings((prev) => ({
                        ...prev,
                        azureOpenAI: { ...prev.azureOpenAI!, model: e.target.value },
                      }))
                    }
                    placeholder="gpt-4o"
                    className="w-full rounded-xl border border-border-subtle bg-elevated px-4 py-3 text-text-primary transition-all outline-none placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium text-text-secondary">API Version</label>
                  <input
                    type="text"
                    value={settings.azureOpenAI?.apiVersion ?? '2024-08-01-preview'}
                    onChange={(e) =>
                      setSettings((prev) => ({
                        ...prev,
                        azureOpenAI: { ...prev.azureOpenAI!, apiVersion: e.target.value },
                      }))
                    }
                    placeholder="2024-08-01-preview"
                    className="w-full rounded-xl border border-border-subtle bg-elevated px-4 py-3 text-text-primary transition-all outline-none placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
                  />
                </div>
              </div>

              <p className="text-xs text-text-muted">
                Configure your Azure OpenAI service in the{' '}
                <a
                  href="https://portal.azure.com/#view/Microsoft_Azure_ProjectOxford/CognitiveServicesHub/~/OpenAI"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline"
                >
                  Azure Portal
                </a>
              </p>
            </div>
          )}

          {/* Ollama Settings */}
          {settings.activeProvider === 'ollama' && (
            <div className="animate-fade-in space-y-4">
              {/* How to run Ollama */}
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
                <p className="text-xs leading-relaxed text-amber-300">
                  <span className="font-medium">📋 Quick Start:</span> Install Ollama from{' '}
                  <a
                    href="https://ollama.ai"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent hover:underline"
                  >
                    ollama.ai
                  </a>
                  , then run:
                </p>
                <code className="mt-2 block rounded-lg bg-black/30 px-3 py-2 font-mono text-sm text-amber-200">
                  ollama serve
                </code>
              </div>

              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm font-medium text-text-secondary">
                  <Server className="h-4 w-4" />
                  Base URL
                </label>
                <div className="flex gap-2">
                  <input
                    type="url"
                    value={settings.ollama?.baseUrl ?? DEFAULT_OLLAMA_BASE_URL}
                    onChange={(e) =>
                      setSettings((prev) => ({
                        ...prev,
                        ollama: { ...prev.ollama!, baseUrl: e.target.value },
                      }))
                    }
                    placeholder={DEFAULT_OLLAMA_BASE_URL}
                    className="flex-1 rounded-xl border border-border-subtle bg-elevated px-4 py-3 font-mono text-sm text-text-primary transition-all outline-none placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      checkOllamaConnection(settings.ollama?.baseUrl ?? DEFAULT_OLLAMA_BASE_URL)
                    }
                    disabled={isCheckingOllama}
                    className="rounded-xl border border-border-subtle bg-elevated px-3 py-3 text-text-secondary transition-colors hover:border-accent/50 hover:text-text-primary disabled:opacity-50"
                    title="Check connection"
                  >
                    <RefreshCw className={`h-4 w-4 ${isCheckingOllama ? 'animate-spin' : ''}`} />
                  </button>
                </div>
                <p className="text-xs text-text-muted">
                  Default port is <code className="rounded bg-elevated px-1 py-0.5">11434</code>.
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-text-secondary">Model</label>

                {ollamaError && !isCheckingOllama && (
                  <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-2">
                    <p className="flex items-center gap-1 text-xs text-red-400">
                      <AlertCircle className="h-3 w-3" />
                      {ollamaError}
                    </p>
                  </div>
                )}

                <input
                  type="text"
                  value={settings.ollama?.model ?? ''}
                  onChange={(e) =>
                    setSettings((prev) => ({
                      ...prev,
                      ollama: { ...prev.ollama!, model: e.target.value },
                    }))
                  }
                  placeholder="e.g., llama3.2, mistral, codellama"
                  className="w-full rounded-xl border border-border-subtle bg-elevated px-4 py-3 font-mono text-sm text-text-primary transition-all outline-none placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
                />
                <p className="text-xs text-text-muted">
                  Pull a model with{' '}
                  <code className="rounded bg-elevated px-1 py-0.5">ollama pull llama3.2</code>
                </p>
              </div>
            </div>
          )}

          {/* OpenRouter Settings */}
          {settings.activeProvider === 'openrouter' && (
            <ProviderConfigCard
              title="OpenRouter"
              apiKey={{
                value: settings.openrouter?.apiKey ?? '',
                placeholder: 'Enter your OpenRouter API key',
                helperText: 'Get your API key from',
                helperLink: 'https://openrouter.ai/keys',
                helperLinkLabel: 'OpenRouter Keys',
                isVisible: !!showApiKey['openrouter'],
                onChange: (value) =>
                  setSettings((prev) => ({
                    ...prev,
                    openrouter: { ...prev.openrouter!, apiKey: value },
                  })),
                onToggleVisibility: () => toggleApiKeyVisibility('openrouter'),
              }}
            >
              <div className="space-y-2">
                <label className="text-sm font-medium text-text-secondary">Model</label>
                <OpenRouterModelCombobox
                  value={settings.openrouter?.model ?? ''}
                  onChange={(model) =>
                    setSettings((prev) => ({
                      ...prev,
                      openrouter: { ...prev.openrouter!, model },
                    }))
                  }
                  models={openRouterModels}
                  isLoading={isLoadingModels}
                  onLoadModels={loadOpenRouterModels}
                />
                <p className="text-xs text-text-muted">
                  Browse all models at{' '}
                  <a
                    href="https://openrouter.ai/models"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent hover:underline"
                  >
                    OpenRouter Models
                  </a>
                </p>
              </div>
            </ProviderConfigCard>
          )}

          {/* MiniMax Settings */}
          {settings.activeProvider === 'minimax' && (
            <ProviderConfigCard
              title="MiniMax"
              apiKey={{
                value: settings.minimax?.apiKey ?? '',
                placeholder: 'Enter your MiniMax API key',
                helperText: 'Get your API key from',
                helperLink: 'https://platform.minimax.io',
                helperLinkLabel: 'MiniMax Platform',
                isVisible: !!showApiKey['minimax'],
                onChange: (value) =>
                  setSettings((prev) => ({
                    ...prev,
                    minimax: { ...prev.minimax!, apiKey: value },
                  })),
                onToggleVisibility: () => toggleApiKeyVisibility('minimax'),
              }}
              model={{
                value: settings.minimax?.model ?? 'MiniMax-M2.5',
                placeholder: 'e.g., MiniMax-M2.5, MiniMax-M2.5-highspeed',
                onChange: (value) =>
                  setSettings((prev) => ({
                    ...prev,
                    minimax: { ...prev.minimax!, model: value },
                  })),
                helperText: 'Available: MiniMax-M2.5 (default), MiniMax-M2.5-highspeed (faster)',
              }}
            />
          )}

          {/* GLM Settings */}
          {settings.activeProvider === 'glm' && (
            <div className="animate-fade-in space-y-4">
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm font-medium text-text-secondary">
                  <Key className="h-4 w-4" />
                  API Key
                </label>
                <div className="relative">
                  <input
                    type={showApiKey['glm'] ? 'text' : 'password'}
                    value={settings.glm?.apiKey ?? ''}
                    onChange={(e) =>
                      setSettings((prev) => ({
                        ...prev,
                        glm: { ...prev.glm!, apiKey: e.target.value },
                      }))
                    }
                    placeholder="Enter your Z.AI API key"
                    className="w-full rounded-xl border border-border-subtle bg-elevated px-4 py-3 pr-12 text-text-primary transition-all outline-none placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
                  />
                  <button
                    type="button"
                    onClick={() => toggleApiKeyVisibility('glm')}
                    className="absolute top-1/2 right-3 -translate-y-1/2 p-1 text-text-muted transition-colors hover:text-text-primary"
                  >
                    {showApiKey['glm'] ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
                <p className="text-xs text-text-muted">
                  Get your API key from{' '}
                  <a
                    href="https://docs.z.ai"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent hover:underline"
                  >
                    Z.AI Platform
                  </a>
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-text-secondary">Model</label>
                <select
                  value={settings.glm?.model ?? 'GLM-5'}
                  onChange={(e) =>
                    setSettings((prev) => ({
                      ...prev,
                      glm: { ...prev.glm!, model: e.target.value },
                    }))
                  }
                  className="w-full rounded-xl border border-border-subtle bg-elevated px-4 py-3 font-mono text-sm text-text-primary transition-all outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                >
                  {getAvailableModels('glm').map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-text-secondary">Base URL</label>
                <input
                  type="text"
                  value={settings.glm?.baseUrl ?? 'https://api.z.ai/api/coding/paas/v4'}
                  onChange={(e) =>
                    setSettings((prev) => ({
                      ...prev,
                      glm: { ...prev.glm!, baseUrl: e.target.value },
                    }))
                  }
                  placeholder="https://api.z.ai/api/coding/paas/v4"
                  className="w-full rounded-xl border border-border-subtle bg-elevated px-4 py-3 font-mono text-sm text-text-primary transition-all outline-none placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
                />
                <p className="text-xs text-text-muted">
                  Coding API (default). Use https://api.z.ai/api/paas/v4 for the general API.
                </p>
              </div>
            </div>
          )}

          {/* Privacy Note */}
          <div className="rounded-xl border border-border-subtle bg-elevated/50 p-4">
            <div className="flex gap-3">
              <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-green-500/20 text-green-400">
                🔒
              </div>
              <div className="text-xs leading-relaxed text-text-muted">
                <span className="font-medium text-text-secondary">Privacy:</span> Your API keys are
                stored only in your browser's session storage and are cleared when the tab closes.
                They're sent directly to the LLM provider when you chat. Your code never leaves your
                machine.
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-border-subtle bg-elevated/30 px-6 py-4">
          <div className="flex items-center gap-2 text-sm">
            {saveStatus === 'saved' && (
              <span className="flex animate-fade-in items-center gap-1.5 text-green-400">
                <Check className="h-4 w-4" />
                Settings saved
              </span>
            )}
            {saveStatus === 'error' && (
              <span className="flex animate-fade-in items-center gap-1.5 text-red-400">
                <AlertCircle className="h-4 w-4" />
                Failed to save
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-text-secondary transition-colors hover:text-text-primary"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-dim"
            >
              Save Settings
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
