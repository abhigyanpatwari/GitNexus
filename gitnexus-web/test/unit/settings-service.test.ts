import { describe, expect, it } from 'vitest';
import {
  loadSettings,
  saveSettings,
  setActiveProvider,
  getActiveProviderConfig,
  isProviderConfigured,
  clearSettings,
  getProviderDisplayName,
  getAvailableModels,
} from '../../src/core/llm/settings-service';

describe('loadSettings', () => {
  it('returns defaults when nothing is stored', () => {
    const settings = loadSettings();
    expect(settings.activeProvider).toBeDefined();
    expect(settings.openai).toBeDefined();
    expect(settings.ollama).toBeDefined();
  });

  it('merges stored values with defaults', () => {
    sessionStorage.setItem(
      'gitnexus-llm-settings',
      JSON.stringify({
        activeProvider: 'ollama',
        ollama: { model: 'qwen3-coder:30b' },
      }),
    );

    const settings = loadSettings();
    expect(settings.activeProvider).toBe('ollama');
    expect(settings.ollama.model).toBe('qwen3-coder:30b');
    // Should still have other provider defaults
    expect(settings.openai).toBeDefined();
  });

  it('returns defaults on corrupted JSON', () => {
    sessionStorage.setItem('gitnexus-llm-settings', 'not-json{{{');
    const settings = loadSettings();
    expect(settings.activeProvider).toBeDefined();
  });

  it('migrates legacy localStorage to sessionStorage', () => {
    localStorage.setItem(
      'gitnexus-llm-settings',
      JSON.stringify({
        activeProvider: 'ollama',
        ollama: { model: 'migrated-model' },
      }),
    );

    const settings = loadSettings();
    expect(settings.ollama.model).toBe('migrated-model');
    expect(sessionStorage.getItem('gitnexus-llm-settings')).not.toBeNull();
    expect(localStorage.getItem('gitnexus-llm-settings')).toBeNull();
  });
});

describe('saveSettings / clearSettings', () => {
  it('persists settings to sessionStorage', () => {
    const settings = loadSettings();
    settings.activeProvider = 'anthropic';
    saveSettings(settings);
    expect(loadSettings().activeProvider).toBe('anthropic');
  });

  it('clearSettings removes settings from both storages', () => {
    saveSettings({ ...loadSettings(), activeProvider: 'anthropic' });
    expect(sessionStorage.getItem('gitnexus-llm-settings')).not.toBeNull();
    clearSettings();
    expect(sessionStorage.getItem('gitnexus-llm-settings')).toBeNull();
    expect(localStorage.getItem('gitnexus-llm-settings')).toBeNull();
  });
});

describe('setActiveProvider', () => {
  it('changes the active provider and persists', () => {
    setActiveProvider('gemini');
    expect(loadSettings().activeProvider).toBe('gemini');
  });
});

describe('getActiveProviderConfig', () => {
  it('returns null for unconfigured providers requiring API keys', () => {
    setActiveProvider('openai');
    expect(getActiveProviderConfig()).toBeNull();
  });

  it('returns config for ollama without API key', () => {
    setActiveProvider('ollama');
    const config = getActiveProviderConfig();
    expect(config).not.toBeNull();
    expect(config!.provider).toBe('ollama');
  });

  it('returns config for openai when API key is set', () => {
    const settings = loadSettings();
    settings.activeProvider = 'openai';
    settings.openai = { ...settings.openai, apiKey: 'sk-test-123' };
    saveSettings(settings);

    const config = getActiveProviderConfig();
    expect(config).not.toBeNull();
    expect(config!.provider).toBe('openai');
  });

  it('returns null for openrouter with empty API key', () => {
    const settings = loadSettings();
    settings.activeProvider = 'openrouter';
    settings.openrouter = { ...settings.openrouter, apiKey: '  ' };
    saveSettings(settings);

    expect(getActiveProviderConfig()).toBeNull();
  });
});

describe('isProviderConfigured', () => {
  it('returns false when provider requires API key and none is set', () => {
    // Manually build a clean openai config with no API key
    saveSettings({
      ...loadSettings(),
      activeProvider: 'openai',
      openai: { apiKey: '', model: 'gpt-4o', temperature: 0.1 },
    });
    expect(isProviderConfigured()).toBe(false);
  });

  it('returns true for ollama (no key required)', () => {
    setActiveProvider('ollama');
    expect(isProviderConfigured()).toBe(true);
  });
});

describe('getProviderDisplayName', () => {
  it('returns human-readable names', () => {
    expect(getProviderDisplayName('openai')).toBe('OpenAI');
    expect(getProviderDisplayName('azure-openai')).toBe('Azure OpenAI');
    expect(getProviderDisplayName('gemini')).toBe('Google Gemini');
    expect(getProviderDisplayName('anthropic')).toBe('Anthropic');
    expect(getProviderDisplayName('ollama')).toBe('Ollama (Local)');
    expect(getProviderDisplayName('openrouter')).toBe('OpenRouter');
  });
});

describe('getAvailableModels', () => {
  it('returns models for known providers', () => {
    expect(getAvailableModels('openai').length).toBeGreaterThan(0);
    expect(getAvailableModels('ollama').length).toBeGreaterThan(0);
    expect(getAvailableModels('anthropic')).toContain('claude-sonnet-4-20250514');
  });

  it('returns empty array for unknown provider', () => {
    expect(getAvailableModels('unknown' as any)).toEqual([]);
  });
});
