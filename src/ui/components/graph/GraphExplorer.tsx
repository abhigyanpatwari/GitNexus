import React, { useState, useEffect } from 'react';
import GraphVisualization from './Visualization.tsx';
import type { KnowledgeGraph } from '../../../core/graph/types.ts';

interface GraphExplorerProps {
  graph: KnowledgeGraph;
  fileContents?: Map<string, string>;
  className?: string;
  style?: React.CSSProperties;
  onNodeSelect?: (nodeId: string | null) => void;
  selectedNodeId?: string | null;
}

const GraphExplorer: React.FC<GraphExplorerProps> = ({
  graph,
  fileContents,
  className = '',
  style = {},
  onNodeSelect,
  selectedNodeId
}) => {
  const [internalSelectedNodeId, setInternalSelectedNodeId] = useState<string | null>(null);

  // Use external selectedNodeId if provided, otherwise use internal state
  const currentSelectedNodeId = selectedNodeId !== undefined ? selectedNodeId : internalSelectedNodeId;

  const handleNodeSelect = (nodeId: string | null) => {
    if (onNodeSelect) {
      onNodeSelect(nodeId);
    } else {
      setInternalSelectedNodeId(nodeId);
    }
  };

  const handleDownloadKG = () => {
    if (!graph) return;

    const kgData = {
      nodes: graph.nodes,
      relationships: graph.relationships,
      metadata: {
        exportDate: new Date().toISOString(),
        nodeCount: graph.nodes.length,
        relationshipCount: graph.relationships.length,
        version: "1.0"
      }
    };

    const jsonString = JSON.stringify(kgData, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const link = document.createElement('a');
    link.href = url;
    link.download = `knowledge-graph-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // Warm tone colors to match the new theme
  const colors = {
    background: '#FEF9F0', // Slightly warm white
    surface: '#FFFFFF',
    text: '#451A03', // Dark brown
    textSecondary: '#78350F', // Medium brown
    textMuted: '#A16207', // Light brown
    border: '#FED7AA', // Light orange
    borderLight: '#FEF3C7', // Very light orange
    primary: '#D97706' // Warm orange
  };

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    width: '100%',
    backgroundColor: colors.background,
    overflow: 'hidden',
    ...style
  };

  const headerStyle: React.CSSProperties = {
    padding: '24px 24px 16px 24px',
    backgroundColor: colors.surface,
    borderBottom: `1px solid ${colors.borderLight}`
  };

  const titleStyle: React.CSSProperties = {
    fontSize: '20px',
    fontWeight: '700',
    color: colors.text,
    marginBottom: '16px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%'
  };

  const titleLeftStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '12px'
  };

  const downloadButtonStyle: React.CSSProperties = {
    padding: '8px 16px',
    backgroundColor: colors.primary,
    color: '#FFFFFF',
    border: 'none',
    borderRadius: '6px',
    fontSize: '14px',
    fontWeight: '500',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    transition: 'all 0.2s ease',
    boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
  };

  const statsContainerStyle: React.CSSProperties = {
    display: 'flex',
    gap: '24px',
    flexWrap: 'wrap'
  };

  const statItemStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 16px',
    backgroundColor: colors.background,
    borderRadius: '8px',
    border: `1px solid ${colors.borderLight}`,
    fontSize: '14px',
    fontWeight: '500',
    color: colors.textSecondary
  };

  const graphContainerStyle: React.CSSProperties = {
    flex: 1,
    overflow: 'hidden',
    position: 'relative'
  };

  const selectedNodeInfoStyle: React.CSSProperties = {
    position: 'absolute',
    top: '16px',
    left: '16px',
    backgroundColor: 'rgba(255, 255, 255, 0.95)',
    backdropFilter: 'blur(8px)',
    padding: '12px 16px',
    borderRadius: '8px',
    border: `1px solid ${colors.borderLight}`,
    fontSize: '14px',
    fontWeight: '500',
    color: colors.text,
    zIndex: 10,
    boxShadow: '0 4px 12px rgba(0,0,0,0.1)'
  };

  // Calculate graph statistics
  const nodeStats = graph?.nodes?.reduce((acc, node) => {
    acc[node.label] = (acc[node.label] || 0) + 1;
    return acc;
  }, {} as Record<string, number>) || {};

  function getSelectedNodeName(): string {
    if (!currentSelectedNodeId || !graph?.nodes) return '';
    const node = graph.nodes.find(n => n.id === currentSelectedNodeId);
    return node?.properties.name as string || node?.id || '';
  }

  function getNodeTypeIcon(nodeType: string): string {
    switch (nodeType.toLowerCase()) {
      case 'project': return '📁';
      case 'folder': return '📂';
      case 'file': return '📄';
      case 'module': return '📦';
      case 'function': return '⚡';
      case 'method': return '🔧';
      case 'class': return '🏗️';
      case 'variable': return '📊';
      default: return '📄';
    }
  }

  return (
    <div className={`graph-explorer ${className}`} style={containerStyle}>
      {/* Header with Statistics */}
      <div style={headerStyle}>
        <div style={titleStyle}>
          <div style={titleLeftStyle}>
            <span>🕸️</span>
            <span>Knowledge Graph</span>
          </div>
          <button 
            onClick={handleDownloadKG}
            style={downloadButtonStyle}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = '#B45309';
              e.currentTarget.style.transform = 'translateY(-1px)';
              e.currentTarget.style.boxShadow = '0 4px 8px rgba(0,0,0,0.15)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = colors.primary;
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';
            }}
            title="Download Knowledge Graph as JSON"
          >
            <span>💾</span>
            <span>Download KG</span>
          </button>
        </div>
        
        <div style={statsContainerStyle}>
          <div style={statItemStyle}>
            <span>📊</span>
            <span>{graph?.nodes?.length || 0} nodes</span>
          </div>
          <div style={statItemStyle}>
            <span>🔗</span>
            <span>{graph?.relationships?.length || 0} relationships</span>
          </div>
          {Object.entries(nodeStats).slice(0, 4).map(([type, count]) => (
            <div key={type} style={statItemStyle}>
              <span>{getNodeTypeIcon(type)}</span>
              <span>{count} {type.toLowerCase()}s</span>
            </div>
          ))}
        </div>
      </div>

      {/* Graph Visualization */}
      <div style={graphContainerStyle}>
        <GraphVisualization
          graph={graph}
          selectedNodeId={currentSelectedNodeId}
          onNodeSelect={handleNodeSelect}
          style={{ height: '100%' }}
        />
        
        {/* Selected Node Info Overlay */}
        {currentSelectedNodeId && (
          <div style={selectedNodeInfoStyle}>
            <strong>Selected:</strong> {getSelectedNodeName()}
          </div>
        )}
      </div>
    </div>
  );
};

export default GraphExplorer; 
