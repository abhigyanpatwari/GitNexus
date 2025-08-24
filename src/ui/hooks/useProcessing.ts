import { useState, useCallback } from 'react';
import { GitNexusFacade, type GitNexusResult, type GitNexusProcessingOptions } from '../../services/facade/gitnexus-facade';
import type { ProcessingEngineType } from '../../core/engines/engine-interface';

interface ProcessingState {
  isProcessing: boolean;
  progress: string;
  error: string;
  result: GitNexusResult | null;
  hadFallback: boolean;
  fallbackEngine?: ProcessingEngineType;
}

interface UseProcessingReturn {
  state: ProcessingState;
  processGitHubRepo: (url: string, options?: GitNexusProcessingOptions) => Promise<void>;
  processZipFile: (file: File, options?: GitNexusProcessingOptions) => Promise<void>;
  clearError: () => void;
  clearResult: () => void;
}

/**
 * Custom hook for managing processing operations
 */
export const useProcessing = (facade: GitNexusFacade): UseProcessingReturn => {
  const [state, setState] = useState<ProcessingState>({
    isProcessing: false,
    progress: '',
    error: '',
    result: null,
    hadFallback: false
  });
  
  const updateState = useCallback((updates: Partial<ProcessingState>) => {
    setState(prev => ({ ...prev, ...updates }));
  }, []);
  
  const processGitHubRepo = useCallback(async (
    url: string, 
    options: GitNexusProcessingOptions = {}
  ) => {
    try {
      updateState({
        isProcessing: true,
        progress: 'Starting GitHub repository processing...',
        error: '',
        result: null,
        hadFallback: false
      });
      
      console.log('🚀 useProcessing: Starting GitHub processing for:', url);
      
      const processingOptions: GitNexusProcessingOptions = {
        ...options,
        onProgress: (progress) => {
          updateState({ progress });
          options.onProgress?.(progress);
        },
        onEngineSwitch: (from, to) => {
          updateState({ 
            hadFallback: true, 
            fallbackEngine: to,
            progress: `Engine fallback: ${from} → ${to}` 
          });
          options.onEngineSwitch?.(from, to);
        }
      };
      
      const result = await facade.processGitHubRepository(url, processingOptions);
      
      if (result.success) {
        updateState({
          isProcessing: false,
          progress: '',
          result,
          hadFallback: result.hadFallback
        });
        console.log('✅ useProcessing: GitHub processing completed successfully');
      } else {
        updateState({
          isProcessing: false,
          progress: '',
          error: result.error || 'Processing failed',
          hadFallback: result.hadFallback
        });
        console.error('❌ useProcessing: GitHub processing failed:', result.error);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      updateState({
        isProcessing: false,
        progress: '',
        error: errorMessage
      });
      console.error('❌ useProcessing: GitHub processing error:', error);
    }
  }, [facade, updateState]);
  
  const processZipFile = useCallback(async (
    file: File, 
    options: GitNexusProcessingOptions = {}
  ) => {
    try {
      updateState({
        isProcessing: true,
        progress: 'Starting ZIP file processing...',
        error: '',
        result: null,
        hadFallback: false
      });
      
      console.log('🚀 useProcessing: Starting ZIP processing for:', file.name);
      
      const processingOptions: GitNexusProcessingOptions = {
        ...options,
        onProgress: (progress) => {
          updateState({ progress });
          options.onProgress?.(progress);
        },
        onEngineSwitch: (from, to) => {
          updateState({ 
            hadFallback: true, 
            fallbackEngine: to,
            progress: `Engine fallback: ${from} → ${to}` 
          });
          options.onEngineSwitch?.(from, to);
        }
      };
      
      const result = await facade.processZipFile(file, processingOptions);
      
      if (result.success) {
        updateState({
          isProcessing: false,
          progress: '',
          result,
          hadFallback: result.hadFallback
        });
        console.log('✅ useProcessing: ZIP processing completed successfully');
      } else {
        updateState({
          isProcessing: false,
          progress: '',
          error: result.error || 'Processing failed',
          hadFallback: result.hadFallback
        });
        console.error('❌ useProcessing: ZIP processing failed:', result.error);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      updateState({
        isProcessing: false,
        progress: '',
        error: errorMessage
      });
      console.error('❌ useProcessing: ZIP processing error:', error);
    }
  }, [facade, updateState]);
  
  const clearError = useCallback(() => {
    updateState({ error: '' });
  }, [updateState]);
  
  const clearResult = useCallback(() => {
    updateState({ 
      result: null, 
      error: '', 
      progress: '', 
      hadFallback: false,
      fallbackEngine: undefined 
    });
  }, [updateState]);
  
  return {
    state,
    processGitHubRepo,
    processZipFile,
    clearError,
    clearResult
  };
};