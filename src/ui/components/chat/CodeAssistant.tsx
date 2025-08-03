import React, { useState } from 'react';
import ChatInterface from './ChatInterface.tsx';
import { GraphExplorer } from '../graph/index.ts';
import type { KnowledgeGraph } from '../../../core/graph/types.ts';

interface CodeAssistantProps {
  graph: KnowledgeGraph;
  fileContents: Map<string, string>;
  className?: string;
  style?: React.CSSProperties;
}

type ViewMode = 'chat' | 'graph' | 'split';

const CodeAssistant: React.FC<CodeAssistantProps> = ({
  graph,
  fileContents,
  className = '',
  style = {}
}) => {
  const [viewMode, setViewMode] = useState<ViewMode>('split');

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    height: '800px',
    backgroundColor: '#f5f5f5',
    borderRadius: '8px',
    overflow: 'hidden',
    ...style
  };

  const headerStyle: React.CSSProperties = {
    padding: '16px',
    backgroundColor: '#fff',
    borderBottom: '1px solid #ddd',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center'
  };

  const contentStyle: React.CSSProperties = {
    flex: 1,
    display: 'flex',
    overflow: 'hidden'
  };

  const panelStyle: React.CSSProperties = {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden'
  };

  const buttonStyle = (active: boolean): React.CSSProperties => ({
    padding: '8px 16px',
    border: 'none',
    borderRadius: '4px',
    backgroundColor: active ? '#007bff' : '#6c757d',
    color: '#fff',
    cursor: 'pointer',
    fontSize: '14px',
    marginLeft: '8px'
  });

  const renderContent = () => {
    switch (viewMode) {
      case 'chat':
        return (
          <div style={panelStyle}>
            <ChatInterface
              graph={graph}
              fileContents={fileContents}
              style={{ height: '100%' }}
            />
          </div>
        );

      case 'graph':
        return (
          <div style={panelStyle}>
            <GraphExplorer
              graph={graph}
              style={{ height: '100%' }}
            />
          </div>
        );

      case 'split':
        return (
          <>
            <div style={{ ...panelStyle, marginRight: '8px' }}>
              <div style={{
                fontSize: '14px',
                fontWeight: '600',
                padding: '8px 12px',
                backgroundColor: '#e9ecef',
                borderRadius: '4px 4px 0 0',
                marginBottom: '8px'
              }}>
                💬 AI Assistant
              </div>
              <ChatInterface
                graph={graph}
                fileContents={fileContents}
                style={{ height: 'calc(100% - 40px)' }}
              />
            </div>
            
            <div style={{ ...panelStyle, marginLeft: '8px' }}>
              <div style={{
                fontSize: '14px',
                fontWeight: '600',
                padding: '8px 12px',
                backgroundColor: '#e9ecef',
                borderRadius: '4px 4px 0 0',
                marginBottom: '8px'
              }}>
                🕸️ Knowledge Graph
              </div>
              <GraphExplorer
                graph={graph}
                style={{ height: 'calc(100% - 40px)' }}
              />
            </div>
          </>
        );

      default:
        return null;
    }
  };

  const getStatsText = () => {
    const nodeCount = graph.nodes.length;
    const relationshipCount = graph.relationships.length;
    const fileCount = fileContents.size;
    
    return `${nodeCount} nodes • ${relationshipCount} relationships • ${fileCount} files`;
  };

  return (
    <div className={`code-assistant ${className}`} style={containerStyle}>
      {/* Header */}
      <div style={headerStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '20px', fontWeight: '600' }}>🤖</span>
          <div>
            <div style={{ fontSize: '18px', fontWeight: '600' }}>
              GitNexus Code Assistant
            </div>
            <div style={{ fontSize: '12px', color: '#666' }}>
              {getStatsText()}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center' }}>
          <span style={{ fontSize: '14px', color: '#666', marginRight: '12px' }}>
            View:
          </span>
          <button
            onClick={() => setViewMode('chat')}
            style={buttonStyle(viewMode === 'chat')}
          >
            💬 Chat Only
          </button>
          <button
            onClick={() => setViewMode('graph')}
            style={buttonStyle(viewMode === 'graph')}
          >
            🕸️ Graph Only
          </button>
          <button
            onClick={() => setViewMode('split')}
            style={buttonStyle(viewMode === 'split')}
          >
            📱 Split View
          </button>
        </div>
      </div>

      {/* Content */}
      <div style={contentStyle}>
        {renderContent()}
      </div>

      {/* Help Text */}
      {graph.nodes.length === 0 && (
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          textAlign: 'center',
          color: '#666',
          fontSize: '16px',
          zIndex: 10
        }}>
          <div style={{ fontSize: '64px', marginBottom: '16px', opacity: 0.3 }}>
            🤖
          </div>
          <div style={{ marginBottom: '8px' }}>
            No knowledge graph loaded
          </div>
          <div style={{ fontSize: '14px', color: '#999' }}>
            Please load a project to start using the AI assistant
          </div>
        </div>
      )}
    </div>
  );
};

export default CodeAssistant; 
