import { useState, useCallback, useEffect } from 'react';
import { featureFlagManager } from '../../config/feature-flags';
import type { ProcessingEngineType } from '../../core/engines/engine-interface';
import type { LLMProvider } from '../../ai/llm-service';

interface SettingsState {
  // Processing settings
  directoryFilter: string;
  fileExtensions: string;
  processingEngine: ProcessingEngineType;
  autoFallback: boolean;
  performanceComparison: boolean;
  
  // LLM settings
  llmProvider: LLMProvider;
  llmApiKey: string;
  azureOpenAIEndpoint: string;
  azureOpenAIDeploymentName: string;
  azureOpenAIApiVersion: string;
  
  // GitHub settings
  githubToken: string;
  
  // UI settings
  showSettings: boolean;
}

interface UseSettingsReturn {
  settings: SettingsState;
  updateSetting: <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => void;
  updateSettings: (updates: Partial<SettingsState>) => void;
  showSettings: () => void;
  hideSettings: () => void;
  resetSettings: () => void;
  saveSettings: () => void;
}

const DEFAULT_SETTINGS: SettingsState = {
  // Processing settings
  directoryFilter: 'src,lib,components,pages,utils',
  fileExtensions: '.ts,.tsx,.js,.jsx,.py,.java,.cpp,.c,.cs,.php,.rb,.go,.rs,.swift,.kt,.scala,.clj,.hs,.ml,.fs,.elm,.dart,.lua,.r,.m,.sh,.sql,.html,.css,.scss,.less,.vue,.svelte',
  processingEngine: 'legacy',
  autoFallback: true,
  performanceComparison: false,
  
  // LLM settings
  llmProvider: 'openai',
  llmApiKey: '',
  azureOpenAIEndpoint: '',
  azureOpenAIDeploymentName: '',
  azureOpenAIApiVersion: '2024-02-01',
  
  // GitHub settings
  githubToken: '',
  
  // UI settings
  showSettings: false
};

/**
 * Custom hook for managing application settings
 */
export const useSettings = (): UseSettingsReturn => {
  const [settings, setSettings] = useState<SettingsState>(() => {
    // Load settings from localStorage
    const loadedSettings = { ...DEFAULT_SETTINGS };
    
    try {
      // Load individual settings from localStorage
      const stored = {
        llmProvider: localStorage.getItem('llm_provider') as LLMProvider,
        llmApiKey: localStorage.getItem('llm_api_key') || '',
        azureOpenAIEndpoint: localStorage.getItem('azure_openai_endpoint') || '',
        azureOpenAIDeploymentName: localStorage.getItem('azure_openai_deployment') || '',
        azureOpenAIApiVersion: localStorage.getItem('azure_openai_api_version') || '2024-02-01',
        githubToken: localStorage.getItem('github_token') || '',
        processingEngine: featureFlagManager.getProcessingEngine(),
        autoFallback: featureFlagManager.getFlag('autoFallbackOnError'),
        performanceComparison: featureFlagManager.getFlag('enablePerformanceComparison')
      };
      
      Object.assign(loadedSettings, stored);
    } catch (error) {
      console.warn('Failed to load settings from localStorage:', error);
    }
    
    return loadedSettings;
  });
  
  // Listen to feature flag changes
  useEffect(() => {
    const handleFlagChanges = (flags: any) => {
      setSettings(prev => ({
        ...prev,
        processingEngine: flags.processingEngine,
        autoFallback: flags.autoFallbackOnError,
        performanceComparison: flags.enablePerformanceComparison
      }));
    };
    
    featureFlagManager.addListener(handleFlagChanges);
    
    return () => {
      featureFlagManager.removeListener(handleFlagChanges);
    };
  }, []);
  
  const updateSetting = useCallback(<K extends keyof SettingsState>(
    key: K, 
    value: SettingsState[K]
  ) => {
    setSettings(prev => {
      const newSettings = { ...prev, [key]: value };
      
      // Persist certain settings to localStorage
      try {
        switch (key) {
          case 'llmProvider':
            localStorage.setItem('llm_provider', value as string);
            break;
          case 'llmApiKey':
            if (value) localStorage.setItem('llm_api_key', value as string);
            break;
          case 'azureOpenAIEndpoint':
            if (value) localStorage.setItem('azure_openai_endpoint', value as string);
            break;
          case 'azureOpenAIDeploymentName':
            if (value) localStorage.setItem('azure_openai_deployment', value as string);
            break;
          case 'azureOpenAIApiVersion':
            if (value) localStorage.setItem('azure_openai_api_version', value as string);
            break;
          case 'githubToken':
            if (value) localStorage.setItem('github_token', value as string);
            break;
          case 'processingEngine':
            if (value === 'legacy') {
              featureFlagManager.switchToLegacyEngine();
            } else {
              featureFlagManager.switchToNextGenEngine();
            }
            break;
          case 'autoFallback':
            featureFlagManager.setFlag('autoFallbackOnError', value as boolean);
            break;
          case 'performanceComparison':
            featureFlagManager.setFlag('enablePerformanceComparison', value as boolean);
            break;
        }
      } catch (error) {
        console.warn('Failed to persist setting:', key, error);
      }
      
      return newSettings;
    });
  }, []);
  
  const updateSettings = useCallback((updates: Partial<SettingsState>) => {
    Object.entries(updates).forEach(([key, value]) => {
      updateSetting(key as keyof SettingsState, value);
    });
  }, [updateSetting]);
  
  const showSettings = useCallback(() => {
    updateSetting('showSettings', true);
  }, [updateSetting]);
  
  const hideSettings = useCallback(() => {
    updateSetting('showSettings', false);
  }, [updateSetting]);
  
  const resetSettings = useCallback(() => {
    setSettings({ ...DEFAULT_SETTINGS });
    
    // Clear localStorage
    try {
      localStorage.removeItem('llm_api_key');
      localStorage.removeItem('llm_provider');
      localStorage.removeItem('azure_openai_endpoint');
      localStorage.removeItem('azure_openai_deployment');
      localStorage.removeItem('azure_openai_api_version');
      localStorage.removeItem('github_token');
    } catch (error) {
      console.warn('Failed to clear settings from localStorage:', error);
    }
    
    // Reset feature flags
    featureFlagManager.resetFlags();
  }, []);
  
  const saveSettings = useCallback(() => {
    // Force save all settings to localStorage
    try {
      if (settings.llmApiKey) localStorage.setItem('llm_api_key', settings.llmApiKey);
      localStorage.setItem('llm_provider', settings.llmProvider);
      if (settings.azureOpenAIEndpoint) localStorage.setItem('azure_openai_endpoint', settings.azureOpenAIEndpoint);
      if (settings.azureOpenAIDeploymentName) localStorage.setItem('azure_openai_deployment', settings.azureOpenAIDeploymentName);
      if (settings.azureOpenAIApiVersion) localStorage.setItem('azure_openai_api_version', settings.azureOpenAIApiVersion);
      if (settings.githubToken) localStorage.setItem('github_token', settings.githubToken);
      
      console.log('✅ Settings saved successfully');
    } catch (error) {
      console.error('❌ Failed to save settings:', error);
    }
  }, [settings]);
  
  return {
    settings,
    updateSetting,
    updateSettings,
    showSettings,
    hideSettings,
    resetSettings,
    saveSettings
  };
};