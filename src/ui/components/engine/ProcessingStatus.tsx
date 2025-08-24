import React from 'react';
import type { ProcessingEngineType } from '../../../core/engines/engine-interface';
import { EngineConfigHelper } from '../../../config/engine-config.helper';

interface ProcessingStatusProps {
  isProcessing: boolean;
  progress: string;
  error: string;
  currentEngine: ProcessingEngineType;
  hadFallback?: boolean;
  fallbackEngine?: ProcessingEngineType;
  processingTime?: number;
  nodeCount?: number;
  relationshipCount?: number;
}

const ProcessingStatus: React.FC<ProcessingStatusProps> = ({
  isProcessing,
  progress,
  error,
  currentEngine,
  hadFallback = false,
  fallbackEngine,
  processingTime,
  nodeCount,
  relationshipCount
}) => {
  const getEngineIcon = (engine: ProcessingEngineType) => {
    return engine === 'nextgen' ? '🚀' : '🔧';
  };
  
  const getEngineLabel = (engine: ProcessingEngineType) => {
    const displayInfo = EngineConfigHelper.getEngineDisplayInfo(engine);
    return displayInfo?.name || (engine === 'nextgen' ? 'Next-Gen Engine' : 'Legacy Engine');
  };
  
  const getEngineDescription = (engine: ProcessingEngineType) => {
    const displayInfo = EngineConfigHelper.getEngineDisplayInfo(engine);
    return displayInfo?.description || '';
  };
  
  const getProcessingOptions = (engine: ProcessingEngineType) => {
    return EngineConfigHelper.getProcessingOptions(engine);
  };
  
  if (error) {
    return (
      <div style={{
        padding: '1rem',
        borderRadius: '8px',
        marginBottom: '1rem',
        backgroundColor: '#ffebee',
        border: '1px solid #e57373',
        color: '#c62828'
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem'
        }}>
          <span style={{ fontSize: '1.2rem' }}>❌</span>
          <span style={{ fontWeight: 600, fontSize: '1rem' }}>Processing Failed</span>
        </div>
        <div style={{
          marginTop: '0.5rem',
          fontWeight: 500
        }}>{error}</div>
        {hadFallback && (
          <div style={{
            marginTop: '0.5rem',
            fontSize: '0.9rem',
            color: '#f57c00'
          }}>
            🔄 Attempted fallback from {getEngineLabel(currentEngine)} to {fallbackEngine && getEngineLabel(fallbackEngine)}
          </div>
        )}
      </div>
    );
  }
  
  if (isProcessing) {
    return (
      <div style={{
        padding: '1rem',
        borderRadius: '8px',
        marginBottom: '1rem',
        backgroundColor: '#e3f2fd',
        border: '1px solid #42a5f5',
        color: '#1976d2'
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem'
        }}>
          <span style={{ fontSize: '1.2rem', animation: 'spin 1s linear infinite' }}>⚙️</span>
          <span style={{ fontWeight: 600, fontSize: '1rem' }}>
            {getEngineIcon(currentEngine)} Processing with {getEngineLabel(currentEngine)}
          </span>
        </div>
        <div style={{
          fontSize: '0.8rem',
          color: '#1565c0',
          marginTop: '0.2rem'
        }}>
          {getEngineDescription(currentEngine)}
        </div>
        {progress && (
          <div style={{
            marginTop: '0.5rem',
            fontSize: '0.9rem'
          }}>{progress}</div>
        )}
        
        {/* Show engine-specific processing info */}
        {(() => {
          const options = getProcessingOptions(currentEngine);
          return (
            <div style={{
              marginTop: '0.5rem',
              fontSize: '0.75rem',
              color: '#1976d2',
              opacity: 0.8
            }}>
              {currentEngine === 'nextgen' ? (
                `Workers: ${options.maxWorkers}, Batch: ${options.batchSize}, Parallel: ${options.enableParallelParsing ? 'Yes' : 'No'}`
              ) : (
                `Batch: ${options.batchSize}, Workers: ${options.useWorkers ? 'Yes' : 'No'}, Memory: ${options.maxMemoryMB}MB`
              )}
            </div>
          );
        })()}
        <div style={{ marginTop: '1rem' }}>
          <div style={{
            width: '100%',
            height: '4px',
            backgroundColor: '#bbdefb',
            borderRadius: '2px',
            overflow: 'hidden'
          }}>
            <div style={{
              height: '100%',
              backgroundColor: '#2196f3',
              animation: 'progress 2s ease-in-out infinite'
            }}></div>
          </div>
        </div>
        <style>{`
          @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
          @keyframes progress {
            0% { width: 0%; }
            50% { width: 70%; }
            100% { width: 100%; }
          }
        `}</style>
      </div>
    );
  }
  
  // Success state with results
  if (nodeCount !== undefined && relationshipCount !== undefined) {
    return (
      <div style={{
        padding: '1rem',
        borderRadius: '8px',
        marginBottom: '1rem',
        backgroundColor: '#e8f5e8',
        border: '1px solid #66bb6a',
        color: '#2e7d32'
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem'
        }}>
          <span style={{ fontSize: '1.2rem' }}>✅</span>
          <span style={{ fontWeight: 600, fontSize: '1rem' }}>
            {getEngineIcon(currentEngine)} Processing Complete - {getEngineLabel(currentEngine)}
          </span>
        </div>
        <div style={{
          fontSize: '0.8rem',
          color: '#2e7d32',
          marginTop: '0.2rem'
        }}>
          {getEngineDescription(currentEngine)}
        </div>
        
        {hadFallback && fallbackEngine && (
          <div style={{
            marginTop: '0.5rem',
            padding: '0.5rem',
            backgroundColor: '#fff3e0',
            border: '1px solid #ffb74d',
            borderRadius: '4px',
            color: '#f57c00',
            fontSize: '0.9rem'
          }}>
            🔄 Used fallback engine: {getEngineLabel(fallbackEngine)}
          </div>
        )}
        
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
          gap: '1rem',
          marginTop: '1rem'
        }}>
          <div style={{
            textAlign: 'center',
            padding: '0.5rem',
            backgroundColor: 'white',
            borderRadius: '4px',
            border: '1px solid #c8e6c9'
          }}>
            <span style={{
              display: 'block',
              fontSize: '1.5rem',
              fontWeight: 600,
              color: '#1b5e20'
            }}>{nodeCount.toLocaleString()}</span>
            <span style={{
              display: 'block',
              fontSize: '0.8rem',
              color: '#4caf50',
              marginTop: '0.2rem'
            }}>Nodes</span>
          </div>
          <div style={{
            textAlign: 'center',
            padding: '0.5rem',
            backgroundColor: 'white',
            borderRadius: '4px',
            border: '1px solid #c8e6c9'
          }}>
            <span style={{
              display: 'block',
              fontSize: '1.5rem',
              fontWeight: 600,
              color: '#1b5e20'
            }}>{relationshipCount.toLocaleString()}</span>
            <span style={{
              display: 'block',
              fontSize: '0.8rem',
              color: '#4caf50',
              marginTop: '0.2rem'
            }}>Relationships</span>
          </div>
          {processingTime && (
            <div style={{
              textAlign: 'center',
              padding: '0.5rem',
              backgroundColor: 'white',
              borderRadius: '4px',
              border: '1px solid #c8e6c9'
            }}>
              <span style={{
                display: 'block',
                fontSize: '1.5rem',
                fontWeight: 600,
                color: '#1b5e20'
              }}>{(processingTime / 1000).toFixed(1)}s</span>
              <span style={{
                display: 'block',
                fontSize: '0.8rem',
                color: '#4caf50',
                marginTop: '0.2rem'
              }}>Processing Time</span>
            </div>
          )}
          
          {/* Performance indicator based on engine type */}
          <div style={{
            textAlign: 'center',
            padding: '0.5rem',
            backgroundColor: 'white',
            borderRadius: '4px',
            border: '1px solid #c8e6c9'
          }}>
            <span style={{
              display: 'block',
              fontSize: '1.2rem',
              fontWeight: 600,
              color: '#1b5e20'
            }}>{currentEngine === 'nextgen' ? '🚀' : '🔧'}</span>
            <span style={{
              display: 'block',
              fontSize: '0.8rem',
              color: '#4caf50',
              marginTop: '0.2rem'
            }}>{currentEngine === 'nextgen' ? 'Parallel' : 'Sequential'}</span>
          </div>
        </div>
      </div>
    );
  }
  
  // Default state
  return null;
};

export default ProcessingStatus;