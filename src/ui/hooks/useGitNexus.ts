import { useState, useEffect, useCallback, useMemo } from 'react';
import { GitNexusFacade } from '../../services/facade/gitnexus-facade';
import { useEngine } from './useEngine';
import { useProcessing } from './useProcessing';
import { useSettings } from './useSettings';
import type { KnowledgeGraph } from '../../core/graph/types';

interface GitNexusState {
  // Core data
  graph: KnowledgeGraph | null;
  fileContents: Map<string, string>;
  
  // UI state
  selectedNodeId: string | null;
  showWelcome: boolean;
  isLoading: boolean;
  showStats: boolean;
  showExportModal: boolean;
}

interface UseGitNexusReturn {
  // State
  state: GitNexusState;
  
  // Engine management
  engine: ReturnType<typeof useEngine>;
  
  // Processing operations
  processing: ReturnType<typeof useProcessing>;
  
  // Settings management
  settings: ReturnType<typeof useSettings>;
  
  // UI actions
  handleNodeSelect: (nodeId: string | null) => void;
  handleGitHubProcess: (url: string) => Promise<void>;
  handleZipProcess: (file: File) => Promise<void>;
  toggleStats: () => void;
  toggleExportModal: () => void;
  setShowWelcome: (show: boolean) => void;
  
  // Facade access
  facade: GitNexusFacade;
}

/**
 * Main GitNexus hook that combines all functionality
 */
export const useGitNexus = (): UseGitNexusReturn => {
  // Initialize facade
  const [facade] = useState(() => {
    const githubToken = localStorage.getItem('github_token') || undefined;
    return new GitNexusFacade(githubToken);
  });
  
  // Initialize hooks
  const engine = useEngine(facade);
  const processing = useProcessing(facade);
  const settings = useSettings();
  
  // Local UI state
  const [state, setState] = useState<GitNexusState>({
    graph: null,
    fileContents: new Map(),
    selectedNodeId: null,
    showWelcome: true,
    isLoading: false,
    showStats: false,
    showExportModal: false
  });
  
  // Update state helper
  const updateState = useCallback((updates: Partial<GitNexusState>) => {
    setState(prev => ({ ...prev, ...updates }));
  }, []);
  
  // Update graph when processing completes
  useEffect(() => {
    if (processing.state.result && processing.state.result.success) {
      updateState({
        graph: processing.state.result.graph || null,
        fileContents: processing.state.result.fileContents || new Map(),
        showWelcome: false
      });
    } else if (processing.state.error) {
      updateState({
        graph: null,
        fileContents: new Map(),
        showWelcome: true
      });
    }
  }, [processing.state.result, processing.state.error, updateState]);
  
  // Update facade when GitHub token changes
  useEffect(() => {
    // Note: In a real implementation, you might want to reinitialize the facade
    // when the token changes, but for now we'll assume it handles token updates
  }, [settings.settings.githubToken]);
  
  // UI action handlers
  const handleNodeSelect = useCallback((nodeId: string | null) => {
    updateState({ selectedNodeId: nodeId });
  }, [updateState]);
  
  const handleGitHubProcess = useCallback(async (url: string) => {
    updateState({ 
      isLoading: true, 
      showWelcome: false 
    });
    
    try {
      await processing.processGitHubRepo(url, {
        directoryFilter: settings.settings.directoryFilter,
        fileExtensions: settings.settings.fileExtensions,
        engine: settings.settings.processingEngine
      });
    } finally {
      updateState({ isLoading: false });
    }
  }, [processing, settings.settings, updateState]);
  
  const handleZipProcess = useCallback(async (file: File) => {
    updateState({ 
      isLoading: true, 
      showWelcome: false 
    });
    
    try {
      await processing.processZipFile(file, {
        directoryFilter: settings.settings.directoryFilter,
        fileExtensions: settings.settings.fileExtensions,
        engine: settings.settings.processingEngine
      });
    } finally {
      updateState({ isLoading: false });
    }
  }, [processing, settings.settings, updateState]);
  
  const toggleStats = useCallback(() => {
    updateState({ showStats: !state.showStats });
  }, [state.showStats, updateState]);
  
  const toggleExportModal = useCallback(() => {
    updateState({ showExportModal: !state.showExportModal });
  }, [state.showExportModal, updateState]);
  
  const setShowWelcome = useCallback((show: boolean) => {
    updateState({ showWelcome: show });
  }, [updateState]);
  
  return {
    state,
    engine,
    processing,
    settings,
    handleNodeSelect,
    handleGitHubProcess,
    handleZipProcess,
    toggleStats,
    toggleExportModal,
    setShowWelcome,
    facade
  };
};