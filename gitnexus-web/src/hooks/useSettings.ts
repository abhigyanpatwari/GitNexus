import { useAppState } from './useAppState';

export const useSettings = () => {
  const { llmSettings, updateLLMSettings } = useAppState();

  return {
    settings: llmSettings,
    updateSettings: updateLLMSettings,
  };
};
