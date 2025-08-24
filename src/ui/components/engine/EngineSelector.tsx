import React, { useState, useEffect } from 'react';
import type { ProcessingEngineType } from '../../../core/engines/engine-interface';
import type { EngineInfo } from '../../../services/facade/gitnexus-facade';
import { EngineConfigHelper } from '../../../config/engine-config.helper';

interface EngineSelectorProps {
  currentEngine: ProcessingEngineType;
  availableEngines: EngineInfo[];
  onEngineChange: (engine: ProcessingEngineType, reason?: string) => void;
  disabled?: boolean;
  showPerformanceInfo?: boolean;
}

const EngineSelector: React.FC<EngineSelectorProps> = ({
  currentEngine,
  availableEngines,
  onEngineChange,
  disabled = false,
  showPerformanceInfo = false
}) => {
  const [isChanging, setIsChanging] = useState(false);
  
  const handleEngineChange = async (event: React.ChangeEvent<HTMLSelectElement>) => {
    const newEngine = event.target.value as ProcessingEngineType;
    
    if (newEngine === currentEngine || isChanging) {
      return;
    }
    
    setIsChanging(true);
    try {
      await onEngineChange(newEngine, 'User selection');
    } finally {
      setIsChanging(false);
    }
  };
  
  const getEngineDisplayName = (engine: EngineInfo) => {
    const statusIcon = engine.healthy ? '✅' : '⚠️';
    const configInfo = EngineConfigHelper.getEngineDisplayInfo(engine.type);
    const enabledIcon = configInfo?.enabled ? '' : '🚫';
    return `${statusIcon}${enabledIcon} ${engine.name} (${engine.version})`;
  };
  
  const getEngineDescription = (engine: EngineInfo) => {
    const configInfo = EngineConfigHelper.getEngineDisplayInfo(engine.type);
    return configInfo?.description || engine.capabilities.join(', ');
  };
  
  const getEngineFeatures = (engine: EngineInfo) => {
    const configInfo = EngineConfigHelper.getEngineDisplayInfo(engine.type);
    return configInfo?.features || engine.capabilities;
  };
  
  const isEngineEnabled = (engineType: ProcessingEngineType) => {
    return EngineConfigHelper.isEngineEnabled(engineType);
  };
  
  return (
    <div style={{
      marginBottom: '1rem',
      padding: '1rem',
      border: '1px solid #e0e0e0',
      borderRadius: '8px',
      backgroundColor: '#f9f9f9'
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
        marginBottom: '0.5rem'
      }}>
        <label htmlFor="engine-select" style={{
          fontWeight: 600,
          color: '#333'
        }}>
          🚀 Processing Engine:
        </label>
        {isChanging && (
          <span style={{
            fontSize: '0.8rem',
            color: '#666',
            opacity: 0.7
          }}>
            🔄 Switching...
          </span>
        )}
        {EngineConfigHelper.isFallbackEnabled() && (
          <span style={{
            fontSize: '0.75rem',
            color: '#007bff',
            backgroundColor: '#e7f3ff',
            padding: '0.2rem 0.4rem',
            borderRadius: '4px',
            border: '1px solid #b3d9ff'
          }}>
            🔄 Fallback Enabled
          </span>
        )}
      </div>
      
      <select
        id="engine-select"
        value={currentEngine}
        onChange={handleEngineChange}
        disabled={disabled || isChanging}
        style={{
          width: '100%',
          padding: '0.5rem',
          border: '1px solid #ccc',
          borderRadius: '4px',
          fontSize: '1rem',
          backgroundColor: disabled || isChanging ? '#f5f5f5' : 'white',
          cursor: disabled || isChanging ? 'not-allowed' : 'pointer'
        }}
      >
        {availableEngines.map((engine) => (
          <option 
            key={engine.type} 
            value={engine.type}
            disabled={!isEngineEnabled(engine.type)}
          >
            {getEngineDisplayName(engine)}
          </option>
        ))}
      </select>
      
      {showPerformanceInfo && (
        <div style={{
          marginTop: '1rem',
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '0.5rem'
        }}>
          {availableEngines.map((engine) => (
            <div key={engine.type} style={{
              padding: '0.5rem',
              border: '1px solid #ddd',
              borderRadius: '4px',
              backgroundColor: 'white',
              ...(engine.type === currentEngine ? {
                borderColor: '#007bff',
                backgroundColor: '#e7f3ff'
              } : {})
            }}>
              <div style={{
                fontWeight: 600,
                color: '#333',
                marginBottom: '0.2rem'
              }}>{engine.name}</div>
              <div style={{
                fontSize: '0.8rem',
                color: '#666',
                marginBottom: '0.3rem'
              }}>{getEngineDescription(engine)}</div>
              <div style={{
                fontSize: '0.75rem',
                color: '#555'
              }}>
                Features: {getEngineFeatures(engine).join(', ')}
              </div>
              {!isEngineEnabled(engine.type) && (
                <div style={{
                  fontSize: '0.8rem',
                  color: '#f57c00',
                  marginTop: '0.2rem',
                  fontWeight: 600
                }}>🚫 Disabled in configuration</div>
              )}
              {engine.lastError && (
                <div style={{
                  fontSize: '0.8rem',
                  color: '#d32f2f',
                  marginTop: '0.2rem'
                }}>⚠️ {engine.lastError}</div>
              )}
            </div>
          ))}
        </div>
      )}
      

    </div>
  );
};

export default EngineSelector;