import { useState, useEffect, useCallback } from 'react';
import { GitNexusFacade } from '../../services/facade/gitnexus-facade';
import type { 
  ProcessingEngineType, 
  EngineInfo 
} from '../../core/engines/engine-interface';

interface UseEngineReturn {
  currentEngine: ProcessingEngineType;
  availableEngines: EngineInfo[];
  isValidating: boolean;
  engineStatus: any;
  switchEngine: (engine: ProcessingEngineType, reason?: string) => Promise<void>;
  validateEngines: () => Promise<void>;
  getRecommendedEngine: () => ProcessingEngineType;
  performanceComparison: any;
}

/**
 * Custom hook for managing processing engines
 */
export const useEngine = (facade: GitNexusFacade): UseEngineReturn => {
  const [currentEngine, setCurrentEngine] = useState<ProcessingEngineType>('legacy');
  const [availableEngines, setAvailableEngines] = useState<EngineInfo[]>([]);
  const [isValidating, setIsValidating] = useState(false);
  const [engineStatus, setEngineStatus] = useState<any>(null);
  const [performanceComparison, setPerformanceComparison] = useState<any>(null);
  
  // Load initial engine state
  useEffect(() => {
    const initializeEngines = async () => {
      try {
        // Get current engine
        const current = facade.getCurrentEngine();
        setCurrentEngine(current.type);
        
        // Get available engines
        const engines = facade.getAvailableEngines();
        setAvailableEngines(engines);
        
        // Get engine status
        setEngineStatus(current);
        
        console.log('🔧 useEngine: Initialized with', current.type, 'engine');
      } catch (error) {
        console.error('❌ useEngine: Failed to initialize:', error);
      }
    };
    
    initializeEngines();
  }, [facade]);
  
  // Update performance comparison when engines change
  useEffect(() => {
    const comparison = facade.getPerformanceComparison();
    setPerformanceComparison(comparison);
  }, [facade, currentEngine]);
  
  const switchEngine = useCallback(async (engine: ProcessingEngineType, reason?: string) => {
    try {
      console.log(`🔄 useEngine: Switching to ${engine} engine`);
      
      await facade.switchEngine(engine, reason);
      
      // Update state
      setCurrentEngine(engine);
      const updatedStatus = facade.getCurrentEngine();
      setEngineStatus(updatedStatus);
      
      console.log(`✅ useEngine: Successfully switched to ${engine} engine`);
    } catch (error) {
      console.error(`❌ useEngine: Failed to switch to ${engine}:`, error);
      throw error;
    }
  }, [facade]);
  
  const validateEngines = useCallback(async () => {
    setIsValidating(true);
    try {
      console.log('🔍 useEngine: Validating all engines...');
      
      const validation = await facade.validateEngines();
      
      // Update engine availability based on validation
      setAvailableEngines(prev => prev.map(engine => ({
        ...engine,
        available: validation[engine.type as keyof typeof validation],
        healthy: validation[engine.type as keyof typeof validation]
      })));
      
      console.log('✅ useEngine: Engine validation completed:', validation);
    } catch (error) {
      console.error('❌ useEngine: Engine validation failed:', error);
    } finally {
      setIsValidating(false);
    }
  }, [facade]);
  
  const getRecommendedEngine = useCallback(() => {
    return facade.getRecommendedEngine();
  }, [facade]);
  
  return {
    currentEngine,
    availableEngines,
    isValidating,
    engineStatus,
    switchEngine,
    validateEngines,
    getRecommendedEngine,
    performanceComparison
  };
};